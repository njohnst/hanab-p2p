import { describe, expect, it } from "vitest";
import { cleanState, IGameStatus } from "~/lib/state";
import { documentOf, materialize } from "./document";
import { NetworkNode } from "./node";
import { compareVersions, createMemoryStorage, REPLICA_PREFIX, ReplicaStore, StoredReplica } from "./storage";
import { lobbyGame, move, startedGame, TEST_TIMINGS } from "./testing";

function replica(id: string, updatedAt: number, version = 1, author = "key-a"): StoredReplica {
  const game = documentOf(lobbyGame({ id }));
  return { version, author, updatedAt, applied: [], game };
}

describe("ReplicaStore", () => {
  it("round-trips a replica and rebuilds the same game", () => {
    const store = new ReplicaStore(() => createMemoryStorage());
    const storage = createMemoryStorage();
    const persistent = new ReplicaStore(() => storage);
    const game = move(move(startedGame(["alice", "bob", "carol-bot"], { id: "RoundTrip" })));
    const written: StoredReplica = {
      version: 4,
      author: "key-b",
      updatedAt: 1234,
      applied: ["p1", "p2"],
      game: documentOf(game),
    };

    expect(persistent.write(written)).toBe(true);
    const read = persistent.read("RoundTrip");
    expect(read).toEqual(written);
    expect(materialize(read.game).turnsHistory).toHaveLength(2);
    expect(materialize(read.game).players.map((p) => p.hand)).toEqual(game.players.map((p) => p.hand));
    expect(store.read("RoundTrip")).toBeNull();
  });

  it("never overwrites a newer replica (another tab of the browser)", () => {
    const storage = createMemoryStorage();
    const store = new ReplicaStore(() => storage);
    store.write(replica("G", 1, 5, "key-b"));
    expect(store.write(replica("G", 2, 4, "key-z"))).toBe(false);
    expect(store.write(replica("G", 2, 5, "key-a"))).toBe(false);
    expect(store.read("G").version).toBe(5);
    expect(store.write(replica("G", 3, 6, "key-a"))).toBe(true);
    expect(store.read("G").version).toBe(6);
  });

  it("keeps at most maxReplicas, evicting the least recently updated but never protected ones", () => {
    const storage = createMemoryStorage();
    const store = new ReplicaStore(() => storage, 50);
    for (let i = 0; i < 50; i++) {
      store.write(replica(`Game${i}`, 1000 + i));
    }
    expect(store.list()).toHaveLength(50);

    store.write(replica("Newest", 5000), ["Game0"]);
    const ids = store.list().map((r) => r.game.id);
    expect(ids).toHaveLength(50);
    expect(ids).toContain("Newest");
    expect(ids).toContain("Game0");
    expect(ids).not.toContain("Game1");
  });

  it("ignores corrupted entries and reads replicas written by the previous backend", () => {
    const storage = createMemoryStorage();
    const store = new ReplicaStore(() => storage);
    storage.setItem(`${REPLICA_PREFIX}Broken`, "{not json");
    storage.setItem(`${REPLICA_PREFIX}Wrong`, JSON.stringify({ version: 1, game: { id: "Wrong" } }));
    const legacy = cleanState(startedGame(["a", "b"], { id: "Legacy" }));
    storage.setItem(`${REPLICA_PREFIX}Legacy`, JSON.stringify({ version: 3, updatedAt: 7, game: legacy }));

    expect(store.read("Broken")).toBeNull();
    expect(store.read("Wrong")).toBeNull();
    expect(store.read("Legacy")).toMatchObject({ version: 3, author: "", updatedAt: 7, applied: [] });
    expect(store.list().map((r) => r.game.id)).toEqual(["Legacy"]);
  });

  it("survives unavailable or failing storage", () => {
    const failing = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const store = new ReplicaStore(() => failing);
    expect(store.read("G")).toBeNull();
    expect(store.write(replica("G", 1))).toBe(false);
    expect(store.list()).toEqual([]);

    const none = new ReplicaStore(() => null);
    expect(none.write(replica("G", 1))).toBe(false);
  });

  it("orders states by version, then author", () => {
    expect(compareVersions({ version: 2, author: "a" }, { version: 1, author: "z" })).toBeGreaterThan(0);
    expect(compareVersions({ version: 2, author: "b" }, { version: 2, author: "a" })).toBeGreaterThan(0);
    expect(compareVersions({ version: 2, author: "a" }, { version: 2, author: "a" })).toBe(0);
  });
});

describe("persistence through the node", () => {
  it("serves a game created in this tab after a reload, and lists recent games", async () => {
    const storage = createMemoryStorage();
    const first = new NetworkNode({ transport: null, storage, timings: TEST_TIMINGS });
    await first.updateGame(lobbyGame({ id: "Older" }));
    await first.updateGame({ ...lobbyGame({ id: "Created" }), createdAt: 42 });
    storage.setItem(
      `${REPLICA_PREFIX}Older`,
      JSON.stringify({ ...JSON.parse(storage.getItem(`${REPLICA_PREFIX}Older`)), updatedAt: 1 })
    );

    const reloaded = new NetworkNode({ transport: null, storage, timings: TEST_TIMINGS });
    const loaded = await reloaded.loadGame("Created");
    expect(loaded.id).toBe("Created");
    expect(loaded.createdAt).toBe(42);
    expect(loaded.synced).toBe(true);
    expect(loaded.status).toBe(IGameStatus.LOBBY);
    expect(reloaded.listRecentGames().map((g) => g.id)).toEqual(["Created", "Older"]);
    expect(reloaded.store.read("Created")).toMatchObject({ version: 1 });
  });
});
