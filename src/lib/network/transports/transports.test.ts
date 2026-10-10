import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkNode } from "../node";
import { createMemoryStorage } from "../storage";
import { lobbyGame, TEST_TIMINGS } from "../testing";
import { createBroadcastChannelTransport } from "./broadcast";
import { createTrysteroTransport } from "./trystero";
import { isTransportUnavailable } from "./types";

interface FakeRoom {
  config: Record<string, unknown>;
  roomId: string;
  sent: Array<{ data: unknown; target?: unknown }>;
  action: { onMessage: ((data: unknown, context: { peerId: string }) => void) | null };
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  leaveCalls: number;
  finishLeave: () => void;
}

const rooms: FakeRoom[] = [];

vi.mock("trystero", () => ({
  selfId: "self-peer",
  joinRoom: (config: Record<string, unknown>, roomId: string) => {
    let finishLeave: () => void = () => undefined;
    const room: FakeRoom = {
      config,
      roomId,
      sent: [],
      action: { onMessage: null },
      onPeerJoin: null,
      onPeerLeave: null,
      leaveCalls: 0,
      finishLeave: () => finishLeave(),
    };
    rooms.push(room);
    return {
      makeAction: () => ({
        send: async (data: unknown, options?: { target?: unknown }) => {
          room.sent.push({ data, target: options?.target });
        },
        get onMessage() {
          return room.action.onMessage;
        },
        set onMessage(handler) {
          room.action.onMessage = handler;
        },
      }),
      getPeers: () => ({ "peer-1": {} }),
      leave: () => {
        room.leaveCalls++;
        return new Promise<void>((resolve) => (finishLeave = resolve));
      },
      set onPeerJoin(handler: (peerId: string) => void) {
        room.onPeerJoin = handler;
      },
      set onPeerLeave(handler: (peerId: string) => void) {
        room.onPeerLeave = handler;
      },
    };
  },
}));

afterEach(() => {
  rooms.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Trystero transport", () => {
  it("joins with the room password and extra ICE servers, and queues events until the room is returned", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const events: string[] = [];
    const transport = createTrysteroTransport({ iceServers: [{ urls: ["turn:turn.example:3478"], username: "u" }] });
    const room = await transport.join(
      "SomeGame",
      { password: "SomeGame" },
      {
        onMessage: (data, peerId) => events.push(`message ${JSON.stringify(data)} from ${peerId}`),
        onPeerJoin: (peerId) => events.push(`join ${peerId}`),
        onPeerLeave: (peerId) => events.push(`leave ${peerId}`),
      }
    );

    const fake = rooms[0];
    expect(fake.roomId).toBe("SomeGame");
    expect(fake.config).toMatchObject({
      appId: "hanab-p2p",
      password: "SomeGame",
      turnConfig: [{ urls: ["turn:turn.example:3478"], username: "u" }],
    });
    fake.onPeerJoin("peer-1");
    fake.action.onMessage({ hello: 1 }, { peerId: "peer-1" });
    expect(events).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(["join peer-1", 'message {"hello":1} from peer-1']);

    room.send({ a: 1 }, "peer-1");
    room.send({ b: 2 });
    expect(fake.sent).toEqual([
      { data: { a: 1 }, target: "peer-1" },
      { data: { b: 2 }, target: undefined },
    ]);
    expect(room.selfId).toBe("self-peer");
    expect(room.getPeers()).toEqual(["peer-1"]);
  });

  it("waits for a room to be left before joining it again", async () => {
    vi.stubGlobal("RTCPeerConnection", class {});
    const transport = createTrysteroTransport();
    const handlers = { onMessage: () => undefined, onPeerJoin: () => undefined, onPeerLeave: () => undefined };
    const first = await transport.join("G", { password: "G" }, handlers);
    expect(rooms[0].config.turnConfig).toBeUndefined();

    const leaving = first.leave();
    let joinedAgain = false;
    const second = transport.join("G", { password: "G" }, handlers).then((room) => {
      joinedAgain = true;
      return room;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(joinedAgain).toBe(false);
    expect(rooms).toHaveLength(1);

    rooms[0].finishLeave();
    await leaving;
    await second;
    expect(joinedAgain).toBe(true);
    expect(rooms).toHaveLength(2);
    // Events of the room that was left are not delivered anymore.
    expect(rooms[0].onPeerJoin).toBeNull();
  });

  it("reports browsers without WebRTC as unavailable", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const transport = createTrysteroTransport();
    const handlers = { onMessage: () => undefined, onPeerJoin: () => undefined, onPeerLeave: () => undefined };
    const error = await transport.join("G", { password: "G" }, handlers).catch((e) => e);
    expect(isTransportUnavailable(error)).toBe(true);
  });
});

describe("BroadcastChannel transport", () => {
  it("syncs a game between two tabs of the same browser", async () => {
    const storage = createMemoryStorage();
    const timings = { ...TEST_TIMINGS, syncWindowMs: 100 };
    const first = new NetworkNode({ transport: createBroadcastChannelTransport(), storage, timings });
    const second = new NetworkNode({
      transport: createBroadcastChannelTransport(),
      storage: createMemoryStorage(),
      timings,
    });
    try {
      const game = lobbyGame({ id: "TabsGame" });
      await first.updateGame(game);
      const stopFirst = first.subscribeToGame("TabsGame", () => undefined);

      const received = await new Promise<string>((resolve) => {
        second.subscribeToGame("TabsGame", (delivered) => resolve(delivered.id));
      });
      expect(received).toBe("TabsGame");
      expect(second.getConnection("TabsGame")).toMatchObject({ status: "connected", isAuthority: false });
      expect(first.getConnection("TabsGame")).toMatchObject({ status: "connected", isAuthority: true });
      stopFirst();
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
