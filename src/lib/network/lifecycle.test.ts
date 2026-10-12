import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "~/lib/actions";
import IGameState from "~/lib/state";
import { documentOf } from "./document";
import { watchPageLifecycle } from "./lifecycle";
import { PUBLIC_LOBBY_ROOM } from "./publicLobby";
import { createPeer, lobbyGame, replicaOf, runBots, startedGame, TestPeer } from "./testing";
import { MemoryNetwork } from "./transports/memory";
import { PublicGame } from "./types";

const G = "TestGame";
/** WebRTC peers notice a closed tab only when its connection times out. */
const CONNECTION_TIMEOUT_MS = 25000;

let network: MemoryNetwork;
let peers: TestPeer[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  network = new MemoryNetwork({ latencyMs: 10 });
  network.leaveNoticeMs = CONNECTION_TIMEOUT_MS;
  peers = [];
});

afterEach(() => {
  peers.forEach((p) => p.node.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

function peer(name: string): TestPeer {
  const created = createPeer(network, name);
  peers.push(created);
  return created;
}

async function settle(ms = 2000) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function host(name: string, game: IGameState) {
  const created = peer(name);
  await created.node.updateGame(game);
  created.follow(game.id);
  return created;
}

async function join(gameId: string, ...names: string[]) {
  const joined = names.map((name) => peer(name));
  joined.forEach((p) => p.follow(gameId));
  await settle(1000);
  return joined;
}

function chat(p: TestPeer, id: string): Promise<void> {
  const game = p.game(G);
  return p.node.updateGame(sendMessage(game, { id, content: id, from: 0, turn: game.turnsHistory.length }));
}

/** Peers `p` currently reports connected for the game. */
function peerIds(p: TestPeer, gameId = G) {
  return p.connections
    .get(gameId)
    .peers.map((info) => info.peerId)
    .sort();
}

function authorities(group: TestPeer[], gameId = G) {
  return group.filter((p) => p.node.isAuthority(gameId)).map((p) => p.name);
}

function joinsOf(name: string, roomId = G) {
  return network.joins.filter((j) => j.roomId === roomId && j.nodeId === name).length;
}

function messageIds(p: TestPeer) {
  return p.game(G).messages.map((m) => m.id);
}

function expectConverged(group: TestPeer[], gameId = G) {
  const [first, ...others] = group;
  const reference = replicaOf(first, gameId);
  others.forEach((other) => {
    const replica = replicaOf(other, gameId);
    expect([other.name, replica.version, replica.author, replica.game]).toEqual([
      other.name,
      reference.version,
      reference.author,
      reference.game,
    ]);
  });
  group.forEach((p) => expect(documentOf(p.game(gameId))).toEqual(reference.game));
}

describe("leaving the page", () => {
  it("is noticed by the others at once, long before the transport would", async () => {
    const a = await host("a", lobbyGame());
    const [b, c] = await join(G, "b", "c");
    expect(peerIds(a)).toEqual(["b", "c"]);

    c.node.depart();
    await settle(50);
    expect(peerIds(a)).toEqual(["b"]);
    expect(peerIds(b)).toEqual(["a"]);
    expect(network.members(G).sort()).toEqual(["a", "b"]);
    expect(c.connections.get(G)).toMatchObject({ peers: [], isAuthority: false });
    expect(authorities([a, b])).toEqual(["a"]);

    // The transport's own (late) notice changes nothing.
    await settle(CONNECTION_TIMEOUT_MS + 1000);
    expect(peerIds(a)).toEqual(["b"]);
    await chat(b, "after");
    await settle(200);
    expect(messageIds(a)).toEqual(["after"]);
    expectConverged([a, b]);
  });

  it("hands the authority over without waiting for timeouts; bots keep playing", async () => {
    const id = "ByeHandover";
    const a = await host("a", startedGame(["x-bot", "y-bot", "z-bot"], { id }));
    const [b, c] = await join(id, "b", "c");
    const runners = { a: runBots(a, id), b: runBots(b, id), c: runBots(c, id) };
    await settle(500);
    expect(runners.a.moves).toBeGreaterThan(0);
    expect(runners.b.moves + runners.c.moves).toBe(0);

    a.node.depart();
    // Well within the election timeout (800ms in the tests).
    await settle(100);
    expect(peerIds(b, id)).toEqual(["c"]);
    expect(peerIds(c, id)).toEqual(["b"]);
    expect(authorities([a, b, c], id)).toEqual(["b"]);

    await settle(1000);
    expect(runners.b.moves).toBeGreaterThan(5);
    expect(runners.c.moves).toBe(0);
    // Every turn was proposed exactly once, by one peer.
    const proposed = [...runners.a.turnsPlayed, ...runners.b.turnsPlayed].sort((x, y) => x - y);
    expect(proposed).toEqual(b.game(id).turnsHistory.map((_, i) => i));
    Object.values(runners).forEach((runner) => runner.stop());
    expectConverged([b, c], id);
  });

  it("needs the bye: without it the others wait for the transport", async () => {
    const a = await host("a", lobbyGame());
    const [b] = await join(G, "b");
    network.dropWhen = (m) => (m.data as { type?: string }).type === "bye";

    a.node.depart();
    await settle(2000);
    expect(peerIds(b)).toEqual(["a"]);
    expect(authorities([b])).toEqual([]);

    await settle(CONNECTION_TIMEOUT_MS);
    expect(peerIds(b)).toEqual([]);
    expect(authorities([b])).toEqual(["b"]);
  });

  it("sends a write applied just before leaving ahead of the bye", async () => {
    const a = await host("a", lobbyGame());
    const [b] = await join(G, "b");

    // Applied by the authority, its broadcast not sent yet.
    const written = chat(a, "last-words");
    a.node.depart();
    await written;
    await settle(100);

    expect(messageIds(b)).toEqual(["last-words"]);
    expect(authorities([a, b])).toEqual(["b"]);
    expectConverged([a, b]);
  });

  it("closes a game only kept for its grace period instead of keeping it for a restore", async () => {
    const a = peer("a");
    await a.node.updateGame(lobbyGame());
    const stop = a.follow(G);
    const [b] = await join(G, "b");
    // Left in-app: the room is kept for the grace period.
    stop();
    await settle(200);
    expect(a.node.openGames()).toEqual([G]);

    a.node.depart();
    await settle(50);
    expect(a.node.openGames()).toEqual([]);
    expect(network.members(G)).toEqual(["b"]);
    expect(peerIds(b)).toEqual([]);
    expect(authorities([b])).toEqual(["b"]);

    a.node.revive();
    await settle(1000);
    expect(joinsOf("a")).toBe(1);
  });

  it("withdraws its public games at once, and announces them again once back", async () => {
    const listener = peer("listener");
    let listed: PublicGame[] = [];
    listener.node.subscribeToPublicGames((games) => (listed = games));
    const a = await host("a", lobbyGame({ id: "PublicOne" }));
    await settle(1000);
    expect(listed.map((game) => game.id)).toEqual(["PublicOne"]);

    a.node.depart();
    await settle(50);
    expect(listed).toEqual([]);
    expect(network.members(PUBLIC_LOBBY_ROOM)).toEqual(["listener"]);

    a.node.revive();
    await settle(2000);
    expect(listed.map((game) => game.id)).toEqual(["PublicOne"]);
    expect(a.connections.get("PublicOne")).toMatchObject({ status: "alone", isAuthority: true });
  });
});

describe("coming back from the back/forward cache", () => {
  it("re-joins once, catches up on what it missed, and follows the new authority", async () => {
    const a = await host("a", lobbyGame());
    const [b] = await join(G, "b");
    a.node.depart();
    await settle(100);
    expect(authorities([a, b])).toEqual(["b"]);
    await chat(b, "while-away");
    await settle(100);
    expect(messageIds(a)).toEqual([]);

    // A restored page gets both pageshow and visibilitychange: one join.
    a.node.revive();
    a.node.revive();
    // It syncs before anything else: the others may have moved on.
    expect(a.node.isAuthority(G)).toBe(false);
    await settle(1000);
    expect(joinsOf("a")).toBe(2);
    expect(peerIds(a)).toEqual(["b"]);
    expect(peerIds(b)).toEqual(["a"]);
    expect(a.connections.get(G)).toMatchObject({ status: "connected", isAuthority: false, error: null });
    expect(authorities([a, b])).toEqual(["b"]);
    expect(messageIds(a)).toEqual(["while-away"]);

    // The transport's late notice of the departure does not drop it again.
    await settle(CONNECTION_TIMEOUT_MS + 1000);
    expect(peerIds(b)).toEqual(["a"]);
    await chat(a, "back");
    await settle(200);
    expect(messageIds(b)).toEqual(["while-away", "back"]);
    expectConverged([a, b]);
  });

  it("keeps the writes made while away, and delivers them once back", async () => {
    const a = await host("a", lobbyGame());
    const [b] = await join(G, "b");
    a.node.depart();
    await chat(a, "written-away");
    await settle(500);
    expect(messageIds(b)).toEqual([]);

    a.node.revive();
    await settle(1000);
    expect(messageIds(b)).toEqual(["written-away"]);
    expect(a.node.snapshot(G).pendingWrites).toBe(0);
    expectConverged([a, b]);
  });

  it("takes the authority again when nobody else is there", async () => {
    const a = await host("a", lobbyGame());
    a.node.depart();
    await settle(100);
    expect(a.connections.get(G)).toMatchObject({ isAuthority: false, peers: [] });

    a.node.revive();
    await settle(1000);
    expect(a.connections.get(G)).toMatchObject({ status: "alone", isAuthority: true });
    await chat(a, "alone-again");
    await settle(50);
    expect(messageIds(a)).toEqual(["alone-again"]);
  });
});

describe("page lifecycle events", () => {
  function fakePage() {
    const page = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const fire = (target: EventTarget, type: string, init: Record<string, unknown> = {}) =>
      target.dispatchEvent(Object.assign(new Event(type), init));
    return { page, doc, fire };
  }

  async function twoPeers() {
    const a = await host("a", lobbyGame());
    const [b] = await join(G, "b");
    return { a, b };
  }

  it("leaves on pagehide and comes back on pageshow from the back/forward cache", async () => {
    const { a, b } = await twoPeers();
    const { page, doc, fire } = fakePage();
    const unwatch = watchPageLifecycle(a.node, page, doc);

    doc.visibilityState = "hidden";
    fire(doc, "visibilitychange");
    fire(page, "pagehide", { persisted: true });
    await settle(50);
    expect(peerIds(b)).toEqual([]);
    expect(authorities([a, b])).toEqual(["b"]);

    doc.visibilityState = "visible";
    fire(doc, "visibilitychange");
    fire(page, "pageshow", { persisted: true });
    await settle(1000);
    expect(joinsOf("a")).toBe(2);
    expect(peerIds(a)).toEqual(["b"]);
    expect(peerIds(b)).toEqual(["a"]);
    unwatch();
  });

  it("stays gone after the pagehide of a real unload", async () => {
    const { a, b } = await twoPeers();
    const { page, doc, fire } = fakePage();
    const unwatch = watchPageLifecycle(a.node, page, doc);

    fire(page, "pagehide", { persisted: false });
    await settle(CONNECTION_TIMEOUT_MS);
    expect(joinsOf("a")).toBe(1);
    expect(peerIds(b)).toEqual([]);
    expect(authorities([b])).toEqual(["b"]);
    unwatch();
  });

  it("ignores beforeunload: a cancelled navigation or a mailto: link keeps the rooms", async () => {
    const { a, b } = await twoPeers();
    const { page, doc, fire } = fakePage();
    const unwatch = watchPageLifecycle(a.node, page, doc);

    fire(page, "beforeunload");
    await settle(CONNECTION_TIMEOUT_MS);
    expect(peerIds(b)).toEqual(["a"]);
    expect(joinsOf("a")).toBe(1);
    expect(authorities([a, b])).toEqual(["a"]);
    unwatch();
  });

  it("does not leave on a page load's pageshow or while merely hidden", async () => {
    const { a, b } = await twoPeers();
    const { page, doc, fire } = fakePage();
    const unwatch = watchPageLifecycle(a.node, page, doc);

    fire(page, "pageshow", { persisted: false });
    doc.visibilityState = "hidden";
    fire(doc, "visibilitychange");
    await settle(CONNECTION_TIMEOUT_MS);
    expect(peerIds(b)).toEqual(["a"]);
    expect(joinsOf("a")).toBe(1);
    expect(authorities([a, b])).toEqual(["a"]);
    unwatch();
  });
});
