import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_LOBBY_ROOM } from "../publicLobby";
import { createMemoryStorage } from "../storage";
import { isTransportUnavailable, Transport, TransportHandlers } from "../transports/types";
import { isRememberedNearbyGame, listNearbyGames, MAX_NEARBY_GAMES, NEARBY_GAMES_KEY } from "./games";
import { LinkManager } from "./links";
import { FakeLan } from "./testing";
import { createNearbyTransport } from "./transport";

let lan: FakeLan;
let tabs: LinkManager[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  lan = new FakeLan();
  tabs = [];
});

afterEach(() => {
  tabs.forEach((t) => t.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

function tab(id: string, createPeerConnection = lan.factory(id)): LinkManager {
  const manager = new LinkManager({ selfId: id, createPeerConnection, createBroadcastChannel: null });
  tabs.push(manager);
  return manager;
}

async function settle(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function link(inviter: LinkManager, guest: LinkManager) {
  const inviting = inviter.createInvite();
  await settle(100);
  const invite = await inviting;
  const answering = guest.answerInvite(invite.url);
  await settle(100);
  await invite.acceptReply((await answering).url);
  await settle(200);
  expect(inviter.links().map((l) => l.peerId)).toContain(guest.selfId);
}

function recorder() {
  const events: string[] = [];
  const handlers: TransportHandlers = {
    onMessage: (data, peerId) => events.push(`message ${JSON.stringify(data)} from ${peerId}`),
    onPeerJoin: (peerId) => events.push(`join ${peerId}`),
    onPeerLeave: (peerId) => events.push(`leave ${peerId}`),
  };
  return { events, handlers };
}

async function join(transport: Transport, roomId: string, handlers: TransportHandlers) {
  const room = await transport.join(roomId, { password: roomId }, handlers);
  await settle(50);
  return room;
}

describe("nearby transport", () => {
  it("makes the linked tabs that joined a room its peers, and reports their comings and goings", async () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => tab(id));
    await link(a, b);
    await link(a, c);
    await settle(1000);
    const [ta, tb, tc] = [a, b, c].map((manager) => createNearbyTransport(manager));
    expect(ta.kind).toBe("nearby");
    const [ra, rb, rc] = [recorder(), recorder(), recorder()];

    const roomA = await join(ta, "G", ra.handlers);
    expect(roomA.selfId).toBe("a");
    expect(roomA.getPeers()).toEqual([]);
    await join(ta, "Other", recorder().handlers);
    const roomB = await join(tb, "G", rb.handlers);
    expect(ra.events).toEqual(["join b"]);
    expect(rb.events).toEqual(["join a"]);
    const roomC = await join(tc, "G", rc.handlers);
    expect(ra.events).toEqual(["join b", "join c"]);
    expect(rc.events.sort()).toEqual(["join a", "join b"]);
    expect(roomB.getPeers().sort()).toEqual(["a", "c"]);

    roomB.send({ to: "all" });
    roomB.send({ to: "a" }, "a");
    roomB.send({ to: "nobody" }, "zz");
    await settle(50);
    expect(ra.events.slice(2)).toEqual(['message {"to":"all"} from b', 'message {"to":"a"} from b']);
    expect(rc.events.slice(2)).toEqual(['message {"to":"all"} from b']);

    await roomB.leave();
    await settle(50);
    expect(ra.events.slice(-1)).toEqual(["leave b"]);
    expect(rc.events.slice(-1)).toEqual(["leave b"]);
    expect(roomB.getPeers()).toEqual([]);
    const afterLeave = rb.events.length;
    roomA.send({ late: true });
    await settle(50);
    expect(rb.events).toHaveLength(afterLeave);

    // A tab that goes away leaves every room.
    c.depart();
    await settle(50);
    expect(ra.events.slice(-1)).toEqual(["leave c"]);
    expect(roomA.getPeers()).toEqual([]);
    await roomC.leave();
  });

  it("calls handlers only once join() resolved, starting with the members already there", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await link(a, b);
    const [ta, tb] = [a, b].map((manager) => createNearbyTransport(manager));
    await join(tb, "G", recorder().handlers);

    const recorded = recorder();
    const joining = ta.join("G", { password: "G" }, recorded.handlers);
    const room = await joining;
    expect(recorded.events).toEqual([]);
    expect(room.getPeers()).toEqual(["b"]);
    await settle(1);
    expect(recorded.events).toEqual(["join b"]);
  });

  it("re-joins a room: the new membership gets the current members, the others see a leave and a join", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await link(a, b);
    const [ta, tb] = [a, b].map((manager) => createNearbyTransport(manager));
    const rb = recorder();
    await join(tb, "G", rb.handlers);
    const first = await join(ta, "G", recorder().handlers);

    first.leave();
    const second = recorder();
    await join(ta, "G", second.handlers);
    expect(second.events).toEqual(["join b"]);
    expect(rb.events).toEqual(["join a", "leave a", "join a"]);
  });

  it("is unavailable without WebRTC", async () => {
    const transport = createNearbyTransport(tab("x", null));
    const error = await transport.join("G", { password: "G" }, recorder().handlers).catch((e) => e);
    expect(isTransportUnavailable(error)).toBe(true);
  });

  it("refuses a room id other tabs would not accept", async () => {
    const transport = createNearbyTransport(tab("x"));
    const error = await transport.join("G".repeat(129), { password: "G" }, recorder().handlers).catch((e) => e);
    expect(isTransportUnavailable(error)).toBe(true);
  });

  it("remembers the games joined (at most 50, most recent first), not the public lobby", async () => {
    const storage = createMemoryStorage();
    const transport = createNearbyTransport(tab("a"), { storage: () => storage });
    await join(transport, "First", recorder().handlers);
    await join(transport, "Second", recorder().handlers);
    await join(transport, PUBLIC_LOBBY_ROOM, recorder().handlers);
    await join(transport, "First", recorder().handlers);
    expect(listNearbyGames(storage)).toEqual(["First", "Second"]);
    expect(isRememberedNearbyGame(storage, "Second")).toBe(true);
    expect(isRememberedNearbyGame(storage, PUBLIC_LOBBY_ROOM)).toBe(false);

    for (let i = 0; i < 60; i++) await transport.join(`Game${i}`, { password: "" }, recorder().handlers);
    const games = listNearbyGames(storage);
    expect(games).toHaveLength(MAX_NEARBY_GAMES);
    expect(games[0]).toBe("Game59");
    expect(games).not.toContain("First");

    storage.setItem(NEARBY_GAMES_KEY, "{broken");
    expect(listNearbyGames(storage)).toEqual([]);
    expect(isRememberedNearbyGame(null, "First")).toBe(false);
  });
});
