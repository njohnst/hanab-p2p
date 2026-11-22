import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MatchHistory from "~/components/matchHistory";
import { forfeitProposal } from "~/lib/actions";
import { play } from "~/lib/ai";
import { i18n } from "~/lib/i18n";
import { documentOf } from "~/lib/network/document";
import { NetworkNode } from "~/lib/network/node";
import { createMemoryStorage } from "~/lib/network/storage";
import { createPeer, lobbyGame, rollbackTo, startedGame, TEST_TIMINGS, TestPeer } from "~/lib/network/testing";
import { MemoryNetwork } from "~/lib/network/transports/memory";
import type { TransportHandlers } from "~/lib/network/transports/types";
import IGameState, { GameVariant, IGameStatus } from "~/lib/state";
import { durationBetween, entryFromGame, formatElapsed, HistoryEntry, readEntry, seatedGroup } from "./result";
import { HISTORY_ROOM_PREFIX, HistoryRooms } from "./rooms";
import { summarizeHistory } from "./statistics";
import { HistoryStore } from "./store";

function finish(game: IGameState): IGameState {
  while (game.status !== IGameStatus.OVER) game = play(game);
  return game;
}

function result(seats = ["a", "b"], options: Parameters<typeof startedGame>[1] = {}): HistoryEntry {
  const game = finish(startedGame(seats, options));
  return entryFromGame({ ...game, synced: true }, seatedGroup(game), { version: 1, author: "a" });
}

describe("match history", () => {
  it("groups the same human IDs regardless of seat order and isolates substitutions and rule changes", () => {
    const first = result(["a", "b", "ai1-bot"]);
    const same = result(["ai2-bot", "b", "a"]);
    const changedRules = result(["a", "b", "ai3-bot"], { allowRollback: false });
    const changedVariant = result(["a", "b", "ai4-bot"], { variant: GameVariant.ORANGE });
    const changedDelay = result(["a", "b", "ai4-bot"], { botsWait: 5000 });
    const changedBots = result(["a", "b"]);
    const changedHuman = result(["a", "c", "ai5-bot"]);
    const groups = summarizeHistory(
      [first, same, changedRules, changedVariant, changedDelay, changedBots, changedHuman],
      "a"
    );
    expect(groups).toHaveLength(2);
    const pair = groups.find(({ humans }) => humans.some(({ id }) => id === "b"));
    expect(pair.types.map(({ completed }) => completed).sort()).toEqual([1, 1, 1, 1, 2]);
    expect(summarizeHistory([first], "someone-else")).toEqual([]);
    expect(seatedGroup(startedGame(["a", "a"]))).toBeNull();
  });

  it("excludes forfeits and unknown metrics from completed averages while keeping them in recent results", () => {
    const template = result();
    const matches = Array.from({ length: 6 }, (_, i) => {
      const endedAt = i + 5;
      return {
        ...template,
        matchId: `00000000-0000-4000-8000-00000000000${i}`,
        result: {
          ...template.result,
          outcome: i === 5 ? ("forfeited" as const) : ("completed" as const),
          score: i === 5 ? 25 : i,
          startedAt: i === 0 ? null : i,
          endedAt,
          durationMs: i === 0 ? null : 5,
          undoCount: i === 0 ? null : i,
        },
      };
    });
    const [type] = summarizeHistory(matches, "a")[0].types;
    expect(type.lastFive).toEqual(matches.slice(1).reverse());
    expect(type.best).toEqual(matches[4]);
    expect(type.completed).toBe(5);
    expect(type.forfeited).toBe(1);
    expect(type.averageScore).toEqual({ value: 2, known: 5, total: 5 });
    expect(type.averageTime).toEqual({ value: 5, known: 4, total: 5 });
    expect(type.averageUndos).toEqual({ value: 2.5, known: 4, total: 5 });
  });

  it("keeps absent legacy metrics unknown and rejects replay or optimistic inputs", () => {
    const game = finish(startedGame(["a", "b"]));
    const legacy = { ...game, matchId: undefined, undoCount: undefined, startedAt: undefined, endedAt: undefined };
    const group = seatedGroup(game);
    const revision = { version: 1, author: "a" };
    expect(entryFromGame(legacy, group, revision)).toBeNull();
    expect(entryFromGame({ ...legacy, originalGame: game, synced: true }, group, revision)).toBeNull();
    expect(entryFromGame({ ...legacy, synced: true }, group, revision)).toMatchObject({
      matchId: null,
      result: { startedAt: null, endedAt: null, durationMs: null, undoCount: null },
    });
    expect(durationBetween(5000, 4000)).toBeNull();
    expect(formatElapsed(25 * 3600000 + 1000)).toBe("25:00:01");
  });

  it("renders forfeits as partial results and labels unknown metrics", () => {
    const match = result();
    const entries: HistoryEntry[] = [
      {
        ...match,
        result: { ...match.result, outcome: "forfeited", score: 4, undoCount: null, startedAt: null, durationMs: null },
      },
    ];
    const element = React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(MatchHistory, { entries, playerId: "a" })
    );
    const markup = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(markup).toContain("4/25 partial score");
    expect(markup).toContain("Elapsed Unknown · Undos Unknown");
    expect(markup).toContain("Last five matches");
    expect(markup).not.toContain("Best match");
  });

  it("deduplicates UUIDs, rejects mismatched groups and converges on the accepted revision", () => {
    const original = result();
    const newer = { ...original, version: 2, result: null };
    const conflicting = { ...original, version: 2, author: "b" };
    const spoof = { ...result(["a", "c"]), matchId: original.matchId, version: 20 };
    const firstStorage = createMemoryStorage();
    const secondStorage = createMemoryStorage();
    const store = new HistoryStore(() => firstStorage);
    const otherStore = new HistoryStore(() => secondStorage);
    // Null storage uses the same merge rules as a persistent browser.
    const memory = new HistoryStore(() => null);
    expect(store.merge([original, original])).toEqual([original]);
    store.merge([conflicting, newer, spoof]);
    otherStore.merge([newer, conflicting, original]);
    memory.merge([original, conflicting, newer]);
    expect(store.list()).toEqual([conflicting]);
    expect(otherStore.list()).toEqual(store.list());
    expect(memory.list()).toEqual(store.list());
    expect(readEntry({ ...original, group: ["a", "c"] })).toBeNull();
    expect(readEntry({ ...original, result: { ...original.result, durationMs: 1 } })).toBeNull();
  });

  it("bounds catch-up packets and validates sender, payload and exact group", async () => {
    const store = new HistoryStore(() => null);
    const send = vi.fn();
    const leave = vi.fn(() => Promise.resolve());
    let handlers: TransportHandlers;
    let signalJoin: () => void;
    const joined = new Promise<void>((resolve) => {
      signalJoin = resolve;
    });
    const rooms = new HistoryRooms(store, () => ({
      kind: "memory",
      async join(_roomId, _options, callbacks) {
        handlers = callbacks;
        signalJoin();
        return { selfId: "self", send, leave, getPeers: () => ["allowed", "spectator"] };
      },
    }));
    const sample = result();
    const large = Array.from({ length: 10 }, (_, i) => ({
      ...sample,
      matchId: `00000000-0000-4000-8000-00000000000${i}`,
      result: {
        ...sample.result,
        roster: sample.result.roster.map((seat) => ({ ...seat, name: "\u0001".repeat(200) })),
      },
    }));
    store.merge(large);
    rooms.follow("live", sample.group, ["allowed"]);
    await joined;
    await Promise.resolve();
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(send.mock.calls.every(([data, target]) => target === "allowed" && data.length <= 32 * 1024)).toBe(true);
    const packet = (entries: HistoryEntry[]) => JSON.stringify({ history: 1, entries });
    handlers.onMessage(packet([sample]), "spectator");
    handlers.onMessage(packet([sample]).padEnd(32769), "allowed");
    handlers.onMessage(packet([sample, result(["a", "c"])]), "allowed");
    handlers.onMessage(packet(Array(9).fill(sample)), "allowed");
    expect(store.list()).toEqual(large);
    handlers.onMessage(packet([sample]), "allowed");
    expect(store.list()).toContainEqual(sample);
    rooms.clear();
    handlers.onMessage(packet([{ ...sample, version: 2 }]), "allowed");
    expect(store.get(sample.matchId)).toEqual(sample);
    await Promise.resolve();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledOnce();
  });
});

describe("network history lifecycle", () => {
  let peers: TestPeer[];
  let network: MemoryNetwork;
  const settle = (time = 1100) => vi.advanceTimersByTimeAsync(time);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    network = new MemoryNetwork();
    peers = [];
  });

  afterEach(async () => {
    peers.forEach(({ node }) => node.dispose());
    await settle();
    vi.useRealTimers();
  });

  function peer(name: string) {
    const member = createPeer(network, name);
    peers.push(member);
    return member;
  }

  it("exchanges earlier matches only among seated peers and archives a settled unanimous forfeit", async () => {
    const a = peer("a");
    const b = peer("b");
    const c = peer("c");
    const before = result(["b", "a"], { id: "Earlier" });
    const differentGroup = result(["a", "c"], { id: "OtherGroup" });
    const game = startedGame(["a", "b"], { id: "Live" });
    a.node.history.merge([before, differentGroup]);
    await a.node.updateGame(game);
    [a, b, c].forEach((member) => member.follow(game.id));
    await settle();
    expect(b.node.history.list()).toEqual([before]);
    expect(c.node.history.list()).toEqual([]);
    expect(
      network.joins
        .filter(({ roomId }) => roomId.startsWith(HISTORY_ROOM_PREFIX))
        .map(({ nodeId }) => nodeId)
        .sort()
    ).toEqual(["a", "b"]);

    await a.node.updateGame(forfeitProposal(a.game(game.id), "a", "request"));
    await settle(100);
    expect(a.node.history.list()).toHaveLength(2);
    await b.node.updateGame(forfeitProposal(b.game(game.id), "b", "approve"));
    await settle();
    const live = b.node.history.get(game.matchId);
    expect(live?.result).toMatchObject({
      outcome: "forfeited",
      score: 0,
      maxScore: 25,
      startedAt: game.startedAt,
      endedAt: b.game(game.id).endedAt,
      durationMs: b.game(game.id).endedAt - game.startedAt,
      undoCount: 0,
    });
    expect(a.node.history.get(game.matchId)).toEqual(live);
    expect(c.node.history.list()).toEqual([]);
    expect(
      network.sent.filter(({ roomId }) => roomId.startsWith(HISTORY_ROOM_PREFIX)).every(({ to }) => to !== "c")
    ).toBe(true);

    const roomId = network.joins.find(({ roomId }) => roomId.startsWith(HISTORY_ROOM_PREFIX)).roomId;
    a.node.depart();
    await settle();
    expect(network.members(roomId)).toEqual([]);
    a.node.revive();
    await settle();
    expect(network.members(roomId).sort()).toEqual(["a", "b"]);
  });

  it("waits for an accepted cached finish, withdraws after rollback and survives resume eviction", async () => {
    const storage = createMemoryStorage();
    const a = new NetworkNode({
      transport: network.transport("a"),
      storage,
      getPlayerId: () => "a",
      authorKey: "a",
      maxReplicas: 1,
      timings: TEST_TIMINGS,
    });
    try {
      const game = finish(startedGame(["a", "b"], { id: "Finished" }));
      a.store.write({ game: documentOf(game), version: 1, author: "a", updatedAt: Date.now(), applied: [] });
      const stop = a.subscribeToGame(game.id, vi.fn());
      await settle(100);
      expect(a.history.get(game.matchId)).toBeNull();
      await settle(400);
      expect(a.history.get(game.matchId)?.result?.outcome).toBe("completed");

      const accepted = await a.loadGame(game.id);
      await a.updateGame(rollbackTo(accepted, accepted.turnsHistory.length - 1));
      await settle(100);
      expect(a.history.get(game.matchId)?.result).toBeNull();
      await a.updateGame(play(await a.loadGame(game.id)));
      await settle(100);
      expect(a.history.get(game.matchId)?.result).toMatchObject({ outcome: "completed", undoCount: 1 });
      stop();
      await settle(TEST_TIMINGS.graceMs + 1);
      await a.updateGame(lobbyGame({ id: "Later" }));
      expect(a.store.read(game.id)).toBeNull();
      expect(new HistoryStore(() => storage).get(game.matchId)?.result?.undoCount).toBe(1);
    } finally {
      a.dispose();
    }
  });
});
