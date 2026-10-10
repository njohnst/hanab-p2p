import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinGame, sendMessage } from "~/lib/actions";
import { play } from "~/lib/ai";
import IGameState, { GameMode, IGameStatus } from "~/lib/state";
import { documentOf, materialize } from "./document";
import { PROTOCOL } from "./protocol";
import { createMemoryStorage, REPLICA_PREFIX } from "./storage";
import {
  createPeer,
  lobbyGame,
  move,
  replicaOf,
  rollbackTo,
  runBots,
  someMove,
  startedGame,
  TestPeer,
} from "./testing";
import { MemoryNetwork } from "./transports/memory";
import { TransportRoom } from "./transports/types";
import { PublicGame } from "./types";

const G = "TestGame";

let network: MemoryNetwork;
let peers: TestPeer[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  network = new MemoryNetwork({ latencyMs: 10 });
  peers = [];
});

afterEach(() => {
  peers.forEach((peer) => peer.node.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

function peer(name: string, options: Parameters<typeof createPeer>[2] = {}): TestPeer {
  const created = createPeer(network, name, options);
  peers.push(created);
  return created;
}

async function settle(ms = 2000) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Create the game on `host` like the new-game page does, then open it like the game page does. */
async function host(name: string, game: IGameState, options: Parameters<typeof createPeer>[2] = {}) {
  const created = peer(name, options);
  await created.node.updateGame(game);
  created.follow(game.id);
  return created;
}

async function joinAll(...names: string[]) {
  return joinGameAs(G, ...names);
}

async function joinGameAs(gameId: string, ...names: string[]) {
  const joined = names.map((name) => peer(name));
  joined.forEach((p) => p.follow(gameId));
  await settle(1000);
  return joined;
}

function seat(p: TestPeer, id = p.name): Promise<void> {
  return p.node.updateGame(joinGame(p.game(G), { id, name: id.toUpperCase(), bot: false }));
}

function chat(p: TestPeer, id: string): Promise<void> {
  const game = p.game(G);
  return p.node.updateGame(sendMessage(game, { id, content: id, from: 0, turn: game.turnsHistory.length }));
}

/** All peers hold the same replica (version, author, document) and deliver the same rebuilt game. */
function expectConverged(group: TestPeer[], gameId = G) {
  const [first, ...others] = group;
  const reference = replicaOf(first, gameId);
  expect(reference).not.toBeNull();
  others.forEach((other) => {
    const replica = replicaOf(other, gameId);
    expect({ peer: other.name, version: replica.version, author: replica.author }).toEqual({
      peer: other.name,
      version: reference.version,
      author: reference.author,
    });
    expect(replica.game).toEqual(reference.game);
  });
  const rebuilt = materialize(reference.game);
  group.forEach((p) => {
    const delivered = p.game(gameId);
    expect(documentOf(delivered)).toEqual(reference.game);
    expect(delivered.players.map((player) => player.hand)).toEqual(rebuilt.players.map((player) => player.hand));
    expect(delivered.drawPile).toEqual(rebuilt.drawPile);
  });
}

function authorities(group: TestPeer[], gameId = G) {
  return group.filter((p) => p.node.isAuthority(gameId)).map((p) => p.name);
}

/** A raw peer speaking directly on the network, for hostile and incompatible messages. */
async function rawPeer(name: string, roomId = G) {
  const received: unknown[] = [];
  const room: TransportRoom = await network.transport(name).join(
    roomId,
    { password: roomId },
    {
      onMessage: (data) => received.push(data),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
    }
  );
  return { room, received };
}

/**
 * A started game whose first turn is a bot's. The AI memoises past states per
 * game id (getStateAtTurn), so every game it plays in the tests gets its own id.
 */
function botToPlay(id: string, human = "alice"): IGameState {
  const probe = startedGame(["p0", "p1"], { id });
  const seats = probe.currentPlayer === 0 ? ["robot-bot", human] : [human, "robot-bot"];
  return startedGame(seats, { id });
}

describe("creating and sharing a game", () => {
  it("makes the creating tab the first authority and serves the game to newcomers", async () => {
    const a = await host("a", lobbyGame());
    await settle(50);
    expect(a.connections.get(G)).toMatchObject({ isAuthority: true, hasState: true });
    expect(a.game(G).synced).toBe(true);

    const [b] = await joinAll("b");
    expect(b.game(G)).not.toBeNull();
    expect(b.connections.get(G)).toMatchObject({
      status: "connected",
      isAuthority: false,
      hasState: true,
      peers: [{ peerId: "a", playerId: "a" }],
    });
    expect(a.connections.get(G)).toMatchObject({ status: "connected", peers: [{ peerId: "b", playerId: "b" }] });
    expect(await b.node.loadGame(G)).toMatchObject({ id: G, synced: true });
    expectConverged([a, b]);
  });

  it("loadGame waits for a peer to share the game, or resolves null after the timeout", async () => {
    await host("a", lobbyGame());
    const b = peer("b");
    const loading = b.node.loadGame(G);
    const missing = b.node.loadGame("Unknown", { timeoutMs: 1000 });
    await settle(1500);
    await expect(loading).resolves.toMatchObject({ id: G });
    await expect(missing).resolves.toBeNull();
  });

  it("is alone (and the authority of its replica) when nobody else is in the room", async () => {
    const a = await host("a", lobbyGame());
    await settle(1000);
    expect(a.connections.get(G)).toMatchObject({ status: "alone", isAuthority: true, peers: [] });
  });
});

describe("concurrent writes", () => {
  it.each([
    ["b, c, d", { b: 10, c: 20, d: 30 }],
    ["d, b, c", { b: 30, c: 50, d: 10 }],
    ["c, d, b", { b: 50, c: 10, d: 30 }],
  ])("lobby joins arriving in the order %s all converge, nobody lost", async (_order, latencies) => {
    const a = await host("a", lobbyGame({ playersCount: 4 }));
    await seat(a);
    const others = await joinAll("b", "c", "d");
    Object.entries(latencies).forEach(([name, ms]) => network.setLatency(ms, "a", name));

    await Promise.all(others.map((p) => seat(p)));
    await settle(2000);

    const all = [a, ...others];
    const arrival = Object.entries(latencies)
      .sort((x, y) => x[1] - y[1])
      .map(([name]) => name);
    expect(a.game(G).players.map((p) => p.id)).toEqual(["a", ...arrival]);
    expect(all.flatMap((p) => p.rejections)).toEqual([]);
    expectConverged(all);
  });

  it("refuses a join beyond the seats; the late writer gets the authoritative state", async () => {
    const a = await host("a", lobbyGame({ playersCount: 2 }));
    await seat(a);
    const [b, c] = await joinAll("b", "c");
    network.setLatency(40, "a", "c");

    await Promise.all([seat(b), seat(c)]);
    await settle(2000);

    expect(a.game(G).players.map((p) => p.id)).toEqual(["a", "b"]);
    expect(c.rejections).toEqual([{ gameId: G, proposalId: expect.any(String), reason: "game-full" }]);
    expect(c.game(G).players.map((p) => p.id)).toEqual(["a", "b"]);
    expectConverged([a, b, c]);
  });

  it("keeps every chat message, in the same order everywhere", async () => {
    const a = await host("a", lobbyGame());
    const [b, c] = await joinAll("b", "c");
    network.setLatency(25, "a", "c");

    // Each peer sends two messages from the game it has (the second before the first comes back).
    await Promise.all([a, b, c].flatMap((p) => [chat(p, `${p.name}-1`)]));
    await Promise.all([a, b, c].map((p) => chat(p, `${p.name}-2`)));
    await settle(2000);

    const ids = a.game(G).messages.map((m) => m.id);
    expect(ids.sort()).toEqual(["a-1", "a-2", "b-1", "b-2", "c-1", "c-2"]);
    expectConverged([a, b, c]);
  });

  it("never loses reactions and notifications to concurrent updates", async () => {
    const a = await host("a", startedGame(["a", "b", "c"]));
    const [b, c] = await joinAll("b", "c");
    const stale = a.game(G);
    const mover = [a, b, c][stale.currentPlayer];

    await Promise.all([
      b.node.setReaction(b.game(G), b.game(G).players[1], "👍"),
      c.node.setNotification(c.game(G), c.game(G).players[0], true),
      a.node.setReaction(stale, stale.players[2], "🧠"),
      mover.node.updateGame(move(mover.game(G))),
      a.node.updateGame(sendMessage(stale, { id: "m1", content: "hi", from: 0, turn: 0 })),
    ]);
    await settle(2000);

    const game = a.game(G);
    expect(game.players.map((p) => [p.id, p.reaction ?? null, p.notified ?? false])).toEqual([
      ["a", null, true],
      ["b", "👍", false],
      ["c", "🧠", false],
    ]);
    expect(game.turnsHistory).toHaveLength(1);
    expect(game.messages.map((m) => m.id)).toEqual(["m1"]);
    expectConverged([a, b, c]);

    // A write built from a game that predates the reactions does not revert them.
    await b.node.updateGame(sendMessage(stale, { id: "m2", content: "late", from: 1, turn: 0 }));
    await c.node.setReaction(stale, stale.players[2], null);
    await settle(1000);
    expect(a.game(G).players.map((p) => p.reaction ?? null)).toEqual([null, "👍", null]);
    expect(a.game(G).turnsHistory).toHaveLength(1);
    expectConverged([a, b, c]);
  });

  it.each([
    ["the authority's first", "BotTwiceA", 0],
    ["the follower's first", "BotTwiceB", 100],
  ])("does not play a bot's turn twice when it is proposed twice (%s)", async (_order, id, gap) => {
    const a = await host("a", botToPlay(id));
    const [b] = await joinGameAs(id, "b");
    const seen = a.game(id);
    const versionBefore = replicaOf(a, id).version;

    if (gap) {
      await b.node.updateGame(play(b.game(id)));
      await settle(gap);
      await a.node.updateGame(play(seen));
    } else {
      await Promise.all([a.node.updateGame(play(seen)), b.node.updateGame(play(b.game(id)))]);
    }
    await settle(1000);

    expect(a.game(id).turnsHistory).toHaveLength(1);
    expect(replicaOf(a, id).version).toBe(versionBefore + 1);
    expect([...a.rejections, ...b.rejections]).toEqual([]);
    expect(b.node.snapshot(id).pendingWrites).toBe(0);
    expectConverged([a, b], id);
  });

  it("rejects the second of two different moves for the same turn; its writer converges", async () => {
    const seats = ["alice", "bob", "carol"];
    const game = startedGame(seats);
    const mover = seats[game.currentPlayer];
    const a = await host("a", game);
    const first = peer("m1", { playerId: mover });
    const second = peer("m2", { playerId: mover });
    first.follow(G);
    second.follow(G);
    await settle(1000);
    network.setLatency(40, "a", "m2");

    const deliveriesBefore = second.deliveries.get(G);
    await Promise.all([
      first.node.updateGame(move(first.game(G), "hint")),
      second.node.updateGame(move(second.game(G), "other")),
    ]);
    await settle(85);
    // The reject arrived: the writer already holds the authoritative state.
    expect(second.rejections).toEqual([{ gameId: G, proposalId: expect.any(String), reason: "turn-conflict" }]);
    expect(second.deliveries.get(G)).toBeGreaterThan(deliveriesBefore);
    await settle(1000);

    expect(a.game(G).turnsHistory.map((t) => t.action.action)).toEqual(["hint"]);
    expect(first.rejections).toEqual([]);
    expectConverged([a, first, second]);
  });

  it("refuses a move from a game the UI had not refreshed yet (the turn moved on meanwhile)", async () => {
    const seats = ["alice", "bob", "carol"];
    const game = startedGame(seats);
    const a = await host("a", game, { playerId: seats[game.currentPlayer] });
    const [b] = await joinAll("b");
    const staleOnAuthority = a.game(G);

    await b.node.updateGame(move(b.game(G), "hint"));
    await settle(100);
    await a.node.updateGame(move(staleOnAuthority, "other"));
    await settle(500);

    expect(a.rejections).toEqual([{ gameId: G, proposalId: expect.any(String), reason: "turn-conflict" }]);
    expect(a.game(G).turnsHistory.map((t) => t.action.action)).toEqual(["hint"]);

    // A chat sent from that stale game keeps the move (it is not mistaken for a rollback).
    await a.node.updateGame(sendMessage(staleOnAuthority, { id: "m1", content: "gg", from: 0, turn: 0 }));
    await settle(500);
    expect(a.game(G).turnsHistory).toHaveLength(1);
    expect(a.game(G).messages.map((m) => m.id)).toEqual(["m1"]);
    expectConverged([a, b]);
  });
});

describe("authority changes", () => {
  it("hands over to exactly one peer when the authority leaves mid-game; bots keep playing", async () => {
    const id = "BotHandover";
    const a = await host("a", startedGame(["x-bot", "y-bot", "z-bot"], { id }));
    const [b, c] = await joinGameAs(id, "b", "c");
    const runners = { a: runBots(a, id), b: runBots(b, id), c: runBots(c, id) };

    await settle(1000);
    const playedByA = runners.a.moves;
    expect(playedByA).toBeGreaterThan(3);
    expect(runners.b.moves + runners.c.moves).toBe(0);

    runners.a.stop();
    a.node.dispose();
    await settle(30000);

    expect(authorities([b, c], id)).toEqual(["b"]);
    expect(runners.b.moves).toBeGreaterThan(0);
    expect(runners.c.moves).toBe(0);
    expect(b.game(id).status).toBe(IGameStatus.OVER);

    // Every turn was proposed exactly once, by one peer.
    const proposed = [...runners.a.turnsPlayed, ...runners.b.turnsPlayed].sort((x, y) => x - y);
    expect(proposed).toEqual(b.game(id).turnsHistory.map((_, i) => i));
    runners.b.stop();
    runners.c.stop();
    expectConverged([b, c], id);
  });

  it("re-sends proposals lost with a departing authority to the new one", async () => {
    const a = await host("a", lobbyGame());
    const [b, c] = await joinAll("b", "c");
    network.dropWhen = (m) => m.from === "c" && (m.data as { type: string }).type === "propose";

    await chat(c, "lost-in-transit");
    await settle(200);
    expect(a.game(G).messages).toEqual([]);

    network.dropWhen = null;
    a.node.dispose();
    await settle(3000);

    expect(authorities([b, c])).toEqual(["b"]);
    expect(b.game(G).messages.map((m) => m.id)).toEqual(["lost-in-transit"]);
    expect(c.node.snapshot(G).pendingWrites).toBe(0);
    expectConverged([b, c]);
  });

  it("lets a stale peer rejoin: it catches up and never regresses the others", async () => {
    const a = await host("a", startedGame(["a", "b", "c"]));
    const [b, c] = await joinAll("b", "c");
    const staleStorage = c.storage;
    c.node.dispose();
    peers = peers.filter((p) => p !== c);
    await settle(500);

    for (let i = 0; i < 3; i++) {
      await a.node.updateGame(move(a.game(G)));
      await chat(b, `while-away-${i}`);
      await settle(200);
    }
    const before = replicaOf(a, G);

    const back = peer("c", { storage: staleStorage });
    expect(back.node.store.read(G).version).toBeLessThan(before.version);
    back.follow(G);
    await settle(2000);

    expect(replicaOf(a, G)).toEqual(before);
    expect(back.game(G).turnsHistory).toHaveLength(3);
    expect(authorities([a, b, back])).toEqual(["a"]);
    expectConverged([a, b, back]);
  });

  it("keeps the writes a stale peer made alone, once it meets the others again", async () => {
    const a = await host("a", startedGame(["a", "b", "c"]));
    const [b, c] = await joinAll("b", "c");
    const staleStorage = c.storage;
    c.node.dispose();
    peers = peers.filter((p) => p !== c);
    // The others move on further than the stale peer will on its own.
    for (let i = 0; i < 3; i++) {
      await a.node.updateGame(move(a.game(G)));
      await settle(100);
    }

    // c comes back cut off from the others: after the sync window it is alone, so its own authority.
    network.partition(["c"], ["a", "b"]);
    const back = peer("c", { storage: staleStorage });
    back.follow(G);
    await settle(1000);
    expect(back.connections.get(G)).toMatchObject({ status: "alone", isAuthority: true });
    await chat(back, "written-alone");
    await back.node.updateGame(move(back.game(G), "other"));
    await settle(200);

    network.heal();
    await settle(3000);

    const game = a.game(G);
    expect(game.messages.map((m) => m.id)).toEqual(["written-alone"]);
    expect(game.turnsHistory.map((t) => t.action.action)).toEqual(["hint", "hint", "hint"]);
    expect(back.rejections.map((r) => r.reason)).toEqual(["turn-conflict"]);
    expect(authorities([a, b, back])).toEqual(["a"]);
    expectConverged([a, b, back]);
  });

  async function splitBrain() {
    const seats = ["a", "b", "c", "d"];
    const a = await host("a", startedGame(seats));
    const [b, c, d] = await joinAll("b", "c", "d");
    const all = [a, b, c, d];

    network.partition(["a", "b"], ["c", "d"]);
    await settle(2000);
    const sidesAuthorities = authorities(all);

    await chat(a, "left-a");
    await chat(b, "left-b");
    await a.node.updateGame(move(a.game(G), "hint"));
    await chat(c, "right-c");
    await d.node.setReaction(d.game(G), d.game(G).players[3], "🔥");
    await c.node.updateGame(move(c.game(G), "other"));
    await settle(1000);

    network.heal();
    await settle(5000);
    return { all, sidesAuthorities, final: replicaOf(a, G) };
  }

  it("heals a partition with writes on both sides: one authority, every compatible write kept", async () => {
    const { all, sidesAuthorities, final } = await splitBrain();

    expect(sidesAuthorities).toEqual(["a", "c"]);
    expect(authorities(all)).toHaveLength(1);
    const game = all[0].game(G);
    expect(game.messages.map((m) => m.id).sort()).toEqual(["left-a", "left-b", "right-c"]);
    expect(game.players[3].reaction).toBe("🔥");
    // Both sides moved for the same turn: exactly one move survives.
    expect(game.turnsHistory).toHaveLength(1);
    const rejected = all.flatMap((p) => p.rejections.map((r) => r.reason));
    expect(rejected).toEqual(["turn-conflict"]);
    expect(final.game).toEqual(documentOf(game));
    expectConverged(all);
  });

  it("heals the same partition to the same game every time", async () => {
    const first = (await splitBrain()).final.game;
    peers.forEach((p) => p.node.dispose());
    vi.clearAllTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    network = new MemoryNetwork({ latencyMs: 10 });
    peers = [];
    const second = (await splitBrain()).final.game;
    expect(second).toEqual(first);
  });
});

describe("hostile and incompatible peers", () => {
  it("reports a peer running another protocol, and ignores it", async () => {
    const a = await host("a", lobbyGame());
    await settle(500);
    const intruder = await rawPeer("x");
    await settle(50);
    intruder.room.send({ type: "hello", protocol: PROTOCOL + 1, gameId: G, whatever: true });
    await settle(50);

    expect(a.connections.get(G)).toMatchObject({ peers: [], isAuthority: true });
    expect(a.connections.get(G).error).toMatch(/newer version/);

    await intruder.room.leave();
    await settle(50);
    expect(a.connections.get(G).error).toBeNull();
  });

  it("ignores malformed and hostile messages and keeps working", async () => {
    const a = await host("a", startedGame(["a", "b"]));
    const [b] = await joinAll("b");
    const before = replicaOf(a, G);
    const intruder = await rawPeer("x");
    await settle(50);

    const legit = documentOf(a.game(G));
    const outOfTurn = {
      ...legit,
      turnsHistory: [
        { action: { action: "hint", from: 1 - a.game(G).currentPlayer, to: 0, type: "number", value: 1 } },
      ],
    };
    const garbage: unknown[] = [
      null,
      "garbage",
      42,
      { protocol: PROTOCOL },
      { type: "state", protocol: PROTOCOL, gameId: G },
      {
        type: "state",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k",
        version: 999,
        author: "zzz",
        applied: [],
        isAuthority: false,
        game: outOfTurn,
      },
      {
        type: "state",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k",
        version: 999,
        author: "zzz",
        applied: [],
        isAuthority: false,
        game: { ...legit, id: "Other" },
      },
      {
        type: "state",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k",
        version: 999,
        author: "zzz",
        applied: [],
        isAuthority: false,
        game: { ...legit, options: { ...legit.options, gameMode: GameMode.PASS_AND_PLAY } },
      },
      {
        type: "propose",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k",
        proposalId: "evil",
        baseVersion: 1,
        base: legit,
        proposed: outOfTurn,
      },
      {
        type: "propose",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k",
        proposalId: "junk",
        baseVersion: 1,
        base: "x",
        proposed: {},
      },
      { type: "reject", protocol: PROTOCOL, gameId: G, proposalId: "anything", reason: "turn-conflict" },
      {
        type: "hello",
        protocol: PROTOCOL,
        gameId: G,
        authorKey: "k".repeat(500),
        playerId: null,
        version: 1,
        author: "",
        hasState: false,
        isAuthority: false,
      },
      {
        type: "public-game",
        protocol: PROTOCOL,
        open: true,
        game: { id: G, playersNames: [], playersCount: 2, variant: "classic", createdAt: 1 },
      },
      { type: "state", protocol: PROTOCOL, gameId: G, padding: "x".repeat(600 * 1024) },
    ];
    garbage.forEach((message) => intruder.room.send(message));
    await settle(500);

    expect(replicaOf(a, G)).toEqual(before);
    expect(a.game(G).turnsHistory).toHaveLength(0);
    expect(authorities([a, b])).toEqual(["a"]);
    // The intruder got a reject for its illegal proposal, and the state.
    expect(intruder.received.some((m) => (m as { type: string }).type === "reject")).toBe(true);

    await chat(b, "still-working");
    await settle(500);
    expect(a.game(G).messages.map((m) => m.id)).toEqual(["still-working"]);
    expectConverged([a, b]);
  });
});

describe("local games", () => {
  it.each([
    ["pass & play", lobbyGame({ gameMode: GameMode.PASS_AND_PLAY, playersCount: 2 })],
    ["tutorial", lobbyGame({ tutorial: true, private: true, playersCount: 2 })],
  ])("never touch the transport (%s)", async (_kind, game) => {
    const a = await host("a", game);
    await settle(100);
    await a.node.updateGame(
      joinGame(joinGame(a.game(G), { id: "p1", name: "P1", bot: false }), { id: "p2", name: "P2", bot: true })
    );
    await settle(10);
    await a.node.updateGame({ ...a.game(G), status: IGameStatus.ONGOING, startedAt: 5 });
    await settle(10);
    await a.node.updateGame(move(a.game(G)));
    await a.node.setReaction(a.game(G), a.game(G).players[0], "🎉");
    await settle(2000);

    expect(a.game(G).turnsHistory).toHaveLength(1);
    expect(a.game(G).players[0].reaction).toBe("🎉");
    expect(a.connections.get(G)).toMatchObject({ status: "local", isAuthority: true, peers: [] });
    expect(a.node.getConnection(G).status).toBe("local");
    expect(network.joins).toEqual([]);
    expect(network.sent).toEqual([]);
    expect(replicaOf(a, G).version).toBeGreaterThan(3);
  });
});

describe("room lifecycle", () => {
  it("keeps the room across a quick resubscribe (React remounts, route changes)", async () => {
    const a = peer("a");
    await a.node.updateGame(lobbyGame());
    const first = a.node.subscribeToGame(G, () => undefined);
    await settle(100);
    const joins = network.joins.length;
    first();
    await settle(500);
    const second = a.node.subscribeToGame(G, () => undefined);
    await settle(2000);
    expect(network.joins.length).toBe(joins);
    expect(network.members(G)).toEqual(["a"]);
    second();
  });

  it("leaves the room a grace period after the last unsubscribe", async () => {
    const a = peer("a");
    await a.node.updateGame(lobbyGame());
    const stop = a.follow(G);
    await settle(100);
    expect(network.members(G)).toEqual(["a"]);
    stop();
    await settle(500);
    expect(network.members(G)).toEqual(["a"]);
    await settle(1000);
    expect(network.members(G)).toEqual([]);
    expect(a.node.openGames()).toEqual([]);
  });

  it("re-joins when brought back with nobody connected, not when peers are there", async () => {
    const a = await host("a", lobbyGame());
    await settle(500);
    const joinsOf = (name: string) => network.joins.filter((j) => j.roomId === G && j.nodeId === name).length;
    expect(joinsOf("a")).toBe(1);
    a.node.revive();
    await settle(500);
    expect(joinsOf("a")).toBe(2);
    expect(a.connections.get(G)).toMatchObject({ status: "alone", isAuthority: true });

    await joinAll("b");
    a.node.revive();
    await settle(500);
    expect(joinsOf("a")).toBe(2);
  });
});

describe("public lobby", () => {
  it("lists public lobby games announced by their authority, and withdraws them", async () => {
    const listener = peer("listener");
    const lists: PublicGame[][] = [];
    const unsubscribe = listener.node.subscribeToPublicGames((games) => lists.push(games));

    const a = await host("a", lobbyGame({ id: "PublicOne", playersCount: 2 }));
    await a.node.updateGame(lobbyGame({ id: "PrivateOne", private: true }));
    a.node.subscribeToGame("PrivateOne", () => undefined);
    await settle(1000);

    expect(lists[lists.length - 1]).toEqual([
      { id: "PublicOne", playersNames: [], playersCount: 2, variant: "classic", createdAt: expect.any(Number) },
    ]);

    // Seats taken: no longer listed.
    const game = a.game("PublicOne");
    await a.node.updateGame(
      joinGame(joinGame(game, { id: "p1", name: "P1", bot: false }), { id: "p2", name: "P2", bot: false })
    );
    await settle(100);
    expect(lists[lists.length - 1]).toEqual([]);
    unsubscribe();
  });

  it("expires entries that stop being announced, and leaves the lobby room when unused", async () => {
    const listener = peer("listener");
    let latest: PublicGame[] = [];
    const unsubscribe = listener.node.subscribeToPublicGames((games) => (latest = games));
    await host("a", lobbyGame({ id: "Fading" }));
    await settle(1000);
    expect(latest.map((g) => g.id)).toEqual(["Fading"]);

    network.dropWhen = (m) => m.roomId === "public-lobby";
    await settle(25000);
    expect(latest.map((g) => g.id)).toEqual(["Fading"]);
    await settle(10000);
    expect(latest).toEqual([]);

    network.dropWhen = null;
    unsubscribe();
    await settle(2000);
    expect(network.members("public-lobby")).toEqual(["a"]);
  });
});

describe("helpers", () => {
  it("someMove is legal for the current player", () => {
    const game = startedGame(["a", "b"]);
    expect(someMove(game).from).toBe(game.currentPlayer);
  });
});

describe("replay view", () => {
  it("applies a chat sent while replaying to the live game instead of rolling it back", async () => {
    const a = await host("a", startedGame(["a", "b"]));
    const [b] = await joinAll("b");
    for (let i = 0; i < 3; i++) {
      await a.node.updateGame(move(a.game(G)));
      await settle(100);
    }
    const live = b.game(G);
    // What useGame returns with a replay cursor on turn 1.
    const replayView = { ...rollbackTo(live, 1), originalGame: live, reviewComments: [...live.reviewComments] };
    await b.node.updateGame(sendMessage(replayView, { id: "from-replay", content: "look", from: 1, turn: 1 }));
    await settle(500);

    expect(a.game(G).turnsHistory).toHaveLength(3);
    expect(a.game(G).messages.map((m) => m.id)).toEqual(["from-replay"]);
    expectConverged([a, b]);
  });
});

describe("partial connectivity", () => {
  it("does not claim the authority while a connected peer follows one it cannot reach yet", async () => {
    const a = await host("a", startedGame(["a", "m", "z"]));
    const [z] = await joinAll("z");
    const storage = createMemoryStorage();
    storage.setItem(`${REPLICA_PREFIX}${G}`, a.storage.getItem(`${REPLICA_PREFIX}${G}`));

    network.setLink("a", "m", false);
    const m = peer("m", { storage });
    m.follow(G);
    await settle(600);
    expect(m.connections.get(G)).toMatchObject({ status: "connected", isAuthority: false });
    expect(authorities([a, z, m])).toEqual(["a"]);

    network.setLink("a", "m", true);
    await settle(1000);
    await chat(m, "through-a");
    await settle(500);
    expect(authorities([a, z, m])).toEqual(["a"]);
    expect(a.game(G).messages.map((msg) => msg.id)).toEqual(["through-a"]);
    expectConverged([a, z, m]);
  });
});
