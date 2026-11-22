import { describe, expect, it } from "vitest";
import { forfeitProposal, getStateAtTurn, recreateGame } from "~/lib/actions";
import { IGameStatus, rebuildGame } from "~/lib/state";
import { documentOf, materialize, SOURCE_VERSION, sourceOf, stampSource, toDocument, tryMaterialize } from "./document";
import { MAX_MESSAGE_CHARS, parseMessage, PROTOCOL } from "./protocol";
import { move, startedGame } from "./testing";

const game = documentOf(move(move(startedGame(["alice", "bob", "carol-bot"]))));

function state(overrides: Record<string, unknown> = {}) {
  return {
    type: "state",
    protocol: PROTOCOL,
    gameId: game.id,
    authorKey: "key-a",
    version: 3,
    author: "key-a",
    applied: ["p1", "p2"],
    game,
    isAuthority: true,
    ...overrides,
  };
}

describe("parseMessage", () => {
  it("accepts every well-formed message", () => {
    const messages = [
      {
        type: "hello",
        protocol: PROTOCOL,
        gameId: "G",
        authorKey: "k",
        playerId: null,
        version: 0,
        author: "",
        hasState: false,
        isAuthority: false,
      },
      state(),
      {
        type: "propose",
        protocol: PROTOCOL,
        gameId: game.id,
        authorKey: "k",
        proposalId: "p3",
        baseVersion: 3,
        base: game,
        proposed: game,
      },
      { type: "ack", protocol: PROTOCOL, gameId: "G", proposalId: "p" },
      { type: "reject", protocol: PROTOCOL, gameId: "G", proposalId: "p", reason: "turn-conflict" },
      { type: "bye", protocol: PROTOCOL, gameId: "G" },
      {
        type: "public-game",
        protocol: PROTOCOL,
        open: true,
        game: { id: "G", playersNames: ["A"], playersCount: 3, variant: "classic", createdAt: 1 },
      },
    ];
    messages.forEach((message) => expect(parseMessage(message)).toEqual({ kind: "ok", message }));
  });

  it("reports another protocol without validating the rest", () => {
    expect(parseMessage({ type: "whatever", protocol: PROTOCOL + 1 })).toEqual({
      kind: "protocol-mismatch",
      protocol: PROTOCOL + 1,
    });
    expect(parseMessage({ type: "bye", protocol: PROTOCOL - 1, gameId: "G" })).toEqual({
      kind: "protocol-mismatch",
      protocol: PROTOCOL - 1,
    });
  });

  it("rejects malformed and hostile messages without throwing", () => {
    const cyclic: Record<string, unknown> = { type: "hello", protocol: PROTOCOL };
    cyclic.self = cyclic;
    const hostile = [
      null,
      undefined,
      42,
      "hello",
      [],
      { type: "hello" },
      { type: "nope", protocol: PROTOCOL },
      { type: "hello", protocol: PROTOCOL, gameId: "G" },
      cyclic,
      state({ version: -1 }),
      state({ version: 1.5 }),
      state({ applied: "p1" }),
      state({ applied: [42] }),
      state({ game: { ...game, players: "everyone" } }),
      state({ game: { ...game, status: "won" } }),
      state({ game: { ...game, options: { ...game.options, playersCount: 99 } } }),
      state({ game: { ...game, turnsHistory: [{ action: { action: "cheat", from: 0 } }] } }),
      state({ game: { ...game, messages: [{ id: "m", content: "x".repeat(20000), from: 0, turn: 0 }] } }),
      state({ game: { ...game, players: [...game.players, ...game.players] } }),
      state({ game: { ...game, turnsHistory: new Array(2000).fill(game.turnsHistory[0]) } }),
      state({ padding: "x".repeat(MAX_MESSAGE_CHARS) }),
      { type: "reject", protocol: PROTOCOL, gameId: "G", proposalId: "", reason: "x" },
      { type: "bye", protocol: PROTOCOL },
      { type: "bye", protocol: PROTOCOL, gameId: "" },
      { type: "bye", protocol: PROTOCOL, gameId: "G".repeat(500) },
      { type: "bye", protocol: PROTOCOL, gameId: 42 },
      { type: "public-game", protocol: PROTOCOL, open: true, game: { id: "G" } },
    ];
    hostile.forEach((message) => {
      expect(parseMessage(message).kind).toBe("invalid");
    });
  });
});

describe("game documents", () => {
  it("are JSON-normalised and idempotent", () => {
    const normalised = toDocument(game);
    expect(normalised).toEqual(game);
    expect(JSON.parse(JSON.stringify(game))).toEqual(game);
    expect(toDocument(JSON.parse(JSON.stringify(game)))).toEqual(game);
  });

  it("rebuild hands and piles while keeping the saved start and end times", () => {
    const over = { ...game, status: IGameStatus.OVER, startedAt: 111, endedAt: 222 };
    const rebuilt = materialize(over);
    expect(rebuilt.startedAt).toBe(111);
    expect(rebuilt.endedAt).toBe(222);
    expect(rebuilt.synced).toBe(true);
    expect(rebuilt.players.every((player) => player.hand.length > 0)).toBe(true);
    expect(rebuilt.turnsHistory).toHaveLength(2);

    const ongoing = materialize(game);
    expect(ongoing.startedAt).toBe(1000);
    expect("endedAt" in ongoing).toBe(false);
  });

  it("preserves the match UUID during reconstruction and assigns a fresh one to a rematch", () => {
    const live = materialize(game);
    expect(rebuildGame(game).matchId).toBe(game.matchId);
    expect(getStateAtTurn(live, 0)).toMatchObject({ matchId: game.matchId, undoCount: 0, startedAt: 1000 });
    const next = recreateGame(live);
    expect(next.matchId).not.toBe(game.matchId);
    expect(next.undoCount).toBe(0);
    expect(parseMessage(state({ game: documentOf(next) })).kind).toBe("ok");
  });

  it("validates optional match metadata and the vote shape", () => {
    const live = materialize(game);
    const pending = documentOf(forfeitProposal(live, "alice", "request"));
    expect(parseMessage(state({ game: pending })).kind).toBe("ok");
    [
      { matchId: "not-a-uuid" },
      { undoCount: -1 },
      { undoCount: 1.5 },
      { outcome: "other" },
      { outcome: "forfeited" },
      { forfeit: { ...pending.forfeit, approvedBy: ["alice", "alice"] } },
    ].forEach((metadata) => {
      expect(parseMessage(state({ game: { ...pending, ...metadata } })).kind).toBe("invalid");
    });
  });

  it("refuse to rebuild documents whose turns are not legal", () => {
    expect(tryMaterialize(game)).not.toBeNull();
    const outOfTurn = {
      ...game,
      turnsHistory: [...game.turnsHistory, { action: { ...game.turnsHistory[0].action } }],
    };
    expect(tryMaterialize(outOfTurn)).toBeNull();
    expect(tryMaterialize({ ...game, options: undefined })).toBeNull();
  });

  it("carry their source version through spreads and cloneDeep, but not JSON", () => {
    const delivered = stampSource(materialize(game), { gameId: game.id, version: 7, author: "key-a" });
    const derived = move({ ...delivered, synced: false });
    expect(sourceOf(derived)).toEqual({ gameId: game.id, version: 7, author: "key-a" });
    expect(JSON.parse(JSON.stringify(delivered))[SOURCE_VERSION]).toBeUndefined();
    expect(sourceOf({})).toBeNull();
  });
});
