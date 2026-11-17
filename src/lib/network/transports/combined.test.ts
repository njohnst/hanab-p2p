import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinGame, sendMessage } from "~/lib/actions";
import { createPeer, lobbyGame, TestPeer } from "../testing";
import { createCombinedTransport } from "./combined";
import { MemoryNetwork } from "./memory";
import { Transport, TransportRoom } from "./types";

let internet: MemoryNetwork;
let nearby: MemoryNetwork;
let rooms: TransportRoom[];
let nodes: TestPeer[];
beforeEach(() => {
  vi.useFakeTimers();
  internet = new MemoryNetwork();
  nearby = new MemoryNetwork();
  rooms = [];
  nodes = [];
});
afterEach(async () => {
  nodes.forEach((peer) => peer.node.dispose());
  await Promise.all(rooms.map((room) => room.leave()));
  vi.clearAllTimers();
  vi.useRealTimers();
});
const settle = (ms = 500) => vi.advanceTimersByTimeAsync(ms);
function transport(id: string, paths = [nearby, internet]) {
  return createCombinedTransport(
    id,
    paths.map((path, index) => path.transport(`${id}-${index}`))
  );
}
async function join(t: Transport, name = "Game") {
  const events = { join: vi.fn(), leave: vi.fn(), message: vi.fn(), error: vi.fn() };
  const room = await t.join(
    name,
    { password: name },
    {
      onPeerJoin: events.join,
      onPeerLeave: events.leave,
      onMessage: events.message,
      onError: events.error,
    }
  );
  rooms.push(room);
  return { room, events };
}

describe("one room over internet and QR connections", () => {
  it("shows each peer once and delivers each message once with both paths available", async () => {
    const a = await join(transport("a"));
    const b = await join(transport("b"));
    await settle();
    expect(a.room.getPeers()).toEqual(["b"]);
    expect(a.events.join).toHaveBeenCalledTimes(1);
    a.room.send({ hello: "world" });
    await settle();
    expect(b.events.message).toHaveBeenCalledExactlyOnceWith({ hello: "world" }, "a");
    await b.room.leave();
    await settle();
    expect(a.events.leave).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("keeps the peer when the internet path disappears and the QR path stays open", async () => {
    const a = await join(transport("a"));
    const b = await join(transport("b"));
    await settle();
    internet.setLink("a-1", "b-1", false);
    await settle();
    expect(a.events.leave).not.toHaveBeenCalled();
    b.room.send("still here", "a");
    await settle();
    expect(a.events.message).toHaveBeenCalledWith("still here", "b");
  });

  it("bridges a QR-only player and an internet-only player through their common participant", async () => {
    const a = await join(transport("bridge"));
    const b = await join(transport("offline", [nearby]));
    const c = await join(transport("remote", [internet]));
    await settle(5500);
    expect(b.room.getPeers().sort()).toEqual(["bridge", "remote"]);
    b.room.send("private proposal", "remote");
    await settle();
    expect(c.events.message).toHaveBeenCalledExactlyOnceWith("private proposal", "offline");
    expect(a.events.message).not.toHaveBeenCalled();
    await b.room.leave();
    await settle();
    expect(c.events.leave).toHaveBeenCalledWith("offline");
  });

  it("syncs actual joins and chat when the authority is only on the internet side", async () => {
    const host = createPeer(null, "host", { transport: transport("host", [internet]) });
    const bridge = createPeer(null, "bridge", { transport: transport("bridge") });
    const offline = createPeer(null, "offline", { transport: transport("offline", [nearby]) });
    nodes.push(host, bridge, offline);
    const game = lobbyGame();
    await host.node.updateGame(game);
    nodes.forEach((p) => p.follow(game.id));
    await settle(6000);
    expect(offline.game(game.id)?.id).toBe(game.id);
    await offline.node.updateGame(joinGame(offline.game(game.id), { id: "offline", name: "Offline", bot: false }));
    await settle();
    expect(host.game(game.id).players[0].id).toBe("offline");
    await offline.node.updateGame(
      sendMessage(offline.game(game.id), { id: "test-chat", content: "hello", from: 0, turn: 0 })
    );
    await settle();
    expect(host.game(game.id).messages).toEqual(offline.game(game.id).messages);
    expect(host.game(game.id).messages).toHaveLength(1);
  });

  it("still works when an internet join fails, and retries it later", async () => {
    const online = internet.transport("a-online");
    const joinOnline = vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementation(online.join);
    const a = await join(createCombinedTransport("a", [nearby.transport("a"), { ...online, join: joinOnline }]));
    const b = await join(transport("b", [nearby]));
    await settle();
    b.room.send("QR works");
    await settle();
    expect(a.events.message).toHaveBeenCalledWith("QR works", "b");
    await settle(5000);
    expect(joinOnline).toHaveBeenCalledTimes(2);
  });

  it("cleans up a transport that finishes joining after the room was left", async () => {
    let finish: (room: TransportRoom) => void;
    const late: Transport = {
      kind: "webrtc",
      join: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const { room, events } = await join(createCombinedTransport("a", [late]));
    await settle();
    await room.leave();
    const leave = vi.fn().mockResolvedValue(undefined);
    finish({ selfId: "a", leave, getPeers: () => [], send: vi.fn() });
    await settle();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(events.join).not.toHaveBeenCalled();
  });

  it("expires a silent peer and ignores malformed envelopes", async () => {
    const a = await join(transport("a", [nearby]));
    const b = await join(transport("b", [nearby]));
    await settle();
    nearby.dropWhen = (m) => m.from === "b-0";
    await settle(25000);
    expect(a.room.getPeers()).toEqual([]);
    const attacker = await join(nearby.transport("bad"));
    attacker.room.send({ hanabConnection: 1, from: "forged", seq: -1, hops: 999, type: "data" });
    await settle();
    expect(a.events.message).not.toHaveBeenCalled();
    expect(a.room.getPeers()).not.toContain("forged");
    expect(b.room.getPeers()).toContain("a");
  });
});
