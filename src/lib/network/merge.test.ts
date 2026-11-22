import { cloneDeep } from "lodash";
import { describe, expect, it } from "vitest";
import { commitAction, forfeitProposal, joinGame, sendMessage } from "~/lib/actions";
import IGameState, { GameMode, IGameStatus, IPlayer } from "~/lib/state";
import { documentOf, GameDocument, materialize, toDocument } from "./document";
import { mergeGame } from "./merge";
import { lobbyGame, move, rollbackTo, startedGame } from "./testing";

function doc(game: IGameState): GameDocument {
  return documentOf(game);
}

function join(game: IGameState, id: string): IGameState {
  return joinGame(game, { id, name: id.toUpperCase(), bot: false });
}

function withPlayer(game: IGameState, id: string, changes: Partial<IPlayer>): IGameState {
  return { ...game, players: game.players.map((p) => (p.id === id ? { ...p, ...changes } : p)) };
}

function chat(game: IGameState, id: string, content = id): IGameState {
  return sendMessage(game, { id, content, from: 0, turn: game.turnsHistory.length });
}

function merged(base: IGameState, current: IGameState, proposed: IGameState): GameDocument {
  const result = mergeGame(doc(base), doc(current), doc(proposed));
  if (result.ok === false) throw new Error(`unexpected rejection: ${result.reason}`);
  return result.game;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("mergeGame: turnsHistory", () => {
  const base = startedGame(["alice", "bob", "carol"]);

  it("keeps current when the writer did not touch the turns", () => {
    const current = move(base);
    const proposed = chat(base, "m1");
    const result = merged(base, current, proposed);
    expect(result.turnsHistory).toEqual(doc(current).turnsHistory);
    expect(result.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("takes a move made on top of the current state", () => {
    const proposed = move(base);
    const result = merged(base, base, proposed);
    expect(result.turnsHistory).toEqual(doc(proposed).turnsHistory);
  });

  it("takes a rollback made on top of the current state", () => {
    const played = move(move(move(base)));
    const rolledBack = rollbackTo(played, 1);
    const result = merged(played, played, rolledBack);
    expect(result.turnsHistory).toHaveLength(1);
    expect(result.turnsHistory).toEqual(doc(played).turnsHistory.slice(0, 1));
    expect(result.undoCount).toBe(1);
    expect(rolledBack.undoCount).toBe(0);
  });

  it("refuses a proposal that rewrites history instead of adding or removing turns", () => {
    const played = move(base, "hint");
    const rewritten = move(base, "other");
    const result = mergeGame(doc(played), doc(played), doc(rewritten));
    expect(result).toEqual({ ok: false, reason: "turn-conflict" });
  });

  it("accepts the same move twice as a no-op (duplicate bot turn)", () => {
    const current = move(base);
    const result = mergeGame(doc(base), doc(current), doc(move(base)));
    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && result.game).toEqual(doc(current));
  });

  it("accepts a move that was already applied and followed by more as a no-op", () => {
    const current = move(move(base));
    const result = mergeGame(doc(base), doc(current), doc(move(base)));
    expect(result.ok && result.changed).toBe(false);
  });

  it("accepts the same rollback twice as a no-op", () => {
    const played = move(move(move(base)));
    const rolledBack = materialize(merged(played, played, rollbackTo(played, 1)));
    const result = mergeGame(doc(played), doc(rolledBack), doc(rollbackTo(played, 1)));
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && result.game.undoCount).toBe(1);
  });

  it("counts another rollback after replaying the same turns and ignores stale metadata", () => {
    const played = move(move(move(base)));
    const rolledBack = materialize(merged(played, played, rollbackTo(played, 1)));
    const replayed = move(move(rolledBack));
    const staleRollback = mergeGame(played, replayed, rollbackTo(played, 1));
    expect(staleRollback).toEqual({ ok: false, reason: "turn-conflict" });

    const staleChat = merged(played, replayed, { ...chat(played, "stale"), matchId: undefined, undoCount: 0 });
    expect(staleChat).toMatchObject({ matchId: base.matchId, undoCount: 1 });
    expect(merged(replayed, replayed, rollbackTo(replayed, 0)).undoCount).toBe(2);
  });

  it("keeps an unknown legacy rollback total unknown", () => {
    const legacy = { ...move(base), matchId: undefined, undoCount: undefined };
    const result = merged(legacy, legacy, rollbackTo(legacy, 0));
    expect(result.turnsHistory).toHaveLength(0);
    expect(result.undoCount).toBeUndefined();
    expect(result.matchId).toBeUndefined();
  });

  it("rejects a different move for a turn that already moved on", () => {
    const current = move(base, "hint");
    const result = mergeGame(doc(base), doc(current), doc(move(base, "other")));
    expect(result).toEqual({ ok: false, reason: "turn-conflict" });
  });

  it("takes turns added on top of the turns applied since the writer's base", () => {
    const current = move(base);
    const proposed = move(current);
    const result = merged(base, current, proposed);
    expect(result.turnsHistory).toHaveLength(2);
  });

  it("rejects a rollback of a game that moved on since", () => {
    const played = move(move(base));
    const current = move(played);
    const result = mergeGame(doc(played), doc(current), doc(rollbackTo(played, 0)));
    expect(result).toEqual({ ok: false, reason: "turn-conflict" });
  });
});

describe("mergeGame: players", () => {
  const lobby = join(lobbyGame({ playersCount: 4 }), "host");

  it("unions concurrent joins, keeping current order and appending newcomers", () => {
    const current = join(join(lobby, "bob"), "carol");
    const proposed = join(lobby, "dave");
    const result = merged(lobby, current, proposed);
    expect(result.players.map((p) => p.id)).toEqual(["host", "bob", "carol", "dave"]);
  });

  it("appends several newcomers in the proposal's order", () => {
    const proposed = join(join(lobby, "zed"), "amy");
    const result = merged(lobby, lobby, proposed);
    expect(result.players.map((p) => p.id)).toEqual(["host", "zed", "amy"]);
  });

  it("does not duplicate a player who already joined", () => {
    const current = join(lobby, "bob");
    const result = mergeGame(doc(lobby), doc(current), doc(join(lobby, "bob")));
    expect(result.ok && result.game.players.map((p) => p.id)).toEqual(["host", "bob"]);
    expect(result.ok && result.changed).toBe(false);
  });

  it("refuses joins beyond playersCount", () => {
    const full = join(join(join(lobby, "a"), "b"), "c");
    const result = mergeGame(doc(lobby), doc(full), doc(join(lobby, "late")));
    expect(result).toEqual({ ok: false, reason: "game-full" });
  });

  it("refuses joins after the lobby", () => {
    const started = { ...join(lobby, "bob"), status: IGameStatus.ONGOING };
    const result = mergeGame(doc(lobby), doc(started), doc(join(lobby, "late")));
    expect(result).toEqual({ ok: false, reason: "game-started" });
  });

  it("applies the fields the writer changed and keeps concurrent changes of others", () => {
    const base = join(lobby, "bob");
    const current = withPlayer(base, "host", { reaction: "🎉" });
    const proposed = withPlayer(base, "bob", { reaction: "👍", notified: true });
    const result = merged(base, current, proposed);
    expect(result.players.find((p) => p.id === "host").reaction).toBe("🎉");
    expect(result.players.find((p) => p.id === "bob")).toMatchObject({ reaction: "👍", notified: true });
  });

  it("never reverts a field the writer did not change", () => {
    const base = join(lobby, "bob");
    const current = withPlayer(base, "bob", { reaction: "🧠" });
    const proposed = chat(base, "m1");
    expect(merged(base, current, proposed).players.find((p) => p.id === "bob").reaction).toBe("🧠");
  });

  it("clears a field the writer removed", () => {
    const base = withPlayer(join(lobby, "bob"), "bob", { reaction: "🧠" });
    const proposed = withPlayer(base, "bob", { reaction: null });
    expect(merged(base, base, proposed).players.find((p) => p.id === "bob").reaction).toBeUndefined();
  });
});

describe("mergeGame: messages", () => {
  const base = join(lobbyGame(), "host");

  it("unions by id, current order first, without duplicates", () => {
    const current = chat(chat(base, "c1"), "c2");
    const proposed = chat(chat(base, "p1"), "c1");
    const result = merged(base, current, proposed);
    expect(result.messages.map((m) => m.id)).toEqual(["c1", "c2", "p1"]);
  });
});

describe("mergeGame: reviewComments", () => {
  const base = {
    ...startedGame(["alice", "bob"]),
    reviewComments: [
      { playerId: "alice", afterTurnNumber: 0, comment: "a0" },
      { playerId: "bob", afterTurnNumber: 0, comment: "b0" },
    ],
  };

  it("unions by (playerId, afterTurnNumber), the writer winning for the keys it changed", () => {
    const current = {
      ...base,
      reviewComments: [...base.reviewComments, { playerId: "bob", afterTurnNumber: 1, comment: "b1" }],
    };
    const proposed = {
      ...base,
      reviewComments: [
        { playerId: "alice", afterTurnNumber: 0, comment: "a0 edited" },
        base.reviewComments[1],
        { playerId: "alice", afterTurnNumber: 2, comment: "a2" },
      ],
    };
    expect(merged(base, current, proposed).reviewComments).toEqual([
      { playerId: "alice", afterTurnNumber: 0, comment: "a0 edited" },
      { playerId: "bob", afterTurnNumber: 0, comment: "b0" },
      { playerId: "bob", afterTurnNumber: 1, comment: "b1" },
      { playerId: "alice", afterTurnNumber: 2, comment: "a2" },
    ]);
  });

  it("keeps a concurrent edit of a key the writer did not change", () => {
    const current = {
      ...base,
      reviewComments: [{ playerId: "alice", afterTurnNumber: 0, comment: "edited elsewhere" }, base.reviewComments[1]],
    };
    const proposed = { ...base, reviewComments: [...base.reviewComments, { playerId: "bob", afterTurnNumber: 3 }] };
    const result = merged(base, current, proposed).reviewComments;
    expect(result[0].comment).toBe("edited elsewhere");
    expect(result).toHaveLength(3);
  });

  it("drops the comments a rollback removed", () => {
    const played = {
      ...move(move(base)),
      reviewComments: [{ playerId: "alice", afterTurnNumber: 2, comment: "late" }],
    };
    const rolledBack = { ...rollbackTo(played, 1), reviewComments: [] };
    const result = merged(played, played, rolledBack);
    expect(result.reviewComments).toEqual([]);
    expect(result.turnsHistory).toHaveLength(1);
  });
});

describe("mergeGame: status, options, timestamps, nextGameId", () => {
  const lobby = join(join(lobbyGame({ playersCount: 3 }), "host"), "bob");

  it("takes the fields the writer changed (starting the game) and keeps a concurrent join", () => {
    const current = join(lobby, "carol");
    const proposed = { ...lobby, status: IGameStatus.ONGOING, startedAt: 1234 };
    const result = merged(lobby, current, proposed);
    expect(result.status).toBe(IGameStatus.ONGOING);
    expect(result.startedAt).toBe(1234);
    expect(result.players.map((p) => p.id)).toEqual(["host", "bob", "carol"]);
  });

  it("keeps current values the writer did not change", () => {
    const current = { ...lobby, nextGameId: "NextGame", options: { ...lobby.options, botsWait: 3000 } };
    const proposed = chat(lobby, "m1");
    const result = merged(lobby, current, proposed);
    expect(result.nextGameId).toBe("NextGame");
    expect(result.options.botsWait).toBe(3000);
  });

  it("keeps start time and clears finish metadata on an actual rollback", () => {
    let completed = startedGame(["a", "b"]);
    while (completed.status !== IGameStatus.OVER) completed = move(completed, "other");
    const over = { ...completed, endedAt: 2000 };
    const proposed = { ...rollbackTo(over, over.turnsHistory.length - 1), nextGameId: "Again" };
    const result = merged(over, over, proposed);
    expect(result.status).toBe(IGameStatus.ONGOING);
    expect(result.startedAt).toBe(1000);
    expect(result.endedAt).toBeUndefined();
    expect(result.outcome).toBeUndefined();
    expect(result.undoCount).toBe(1);
    expect(result.nextGameId).toBe("Again");
  });

  it("refuses a write for another game", () => {
    const other = { ...lobby, id: "OtherGame" };
    expect(mergeGame(doc(lobby), doc(lobby), doc(other))).toEqual({ ok: false, reason: "wrong-game" });
  });
});

describe("mergeGame: forfeit", () => {
  it("allows a sole seated human to forfeit with bots and keeps the partial score", () => {
    const game = startedGame(["a", "b-bot"]);
    const cardIndex = game.players[game.currentPlayer].hand.findIndex((card) => card.number === 1);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    const scored = commitAction(game, { action: "play", from: game.currentPlayer, cardIndex });
    const proposal = forfeitProposal(scored, "a", "request");
    const result = mergeGame(scored, scored, proposal, { actor: "a", now: () => 3000 });
    expect(result.ok && result.game).toMatchObject({
      status: IGameStatus.OVER,
      outcome: "forfeited",
      endedAt: 3000,
      forfeit: { approvedBy: ["a"], closed: true },
    });
    if (!result.ok) throw new Error("Forfeit rejected");
    const finished = materialize(result.game);
    expect(finished.playedCards).toEqual(scored.playedCards);
    expect(mergeGame(scored, finished, move(scored))).toEqual({ ok: false, reason: "turn-conflict" });
    expect(mergeGame(finished, finished, rollbackTo(finished, 0))).toEqual({ ok: false, reason: "turn-conflict" });
  });

  it("finishes naturally during a pending vote and ignores the late deciding approval", () => {
    const game = startedGame(["a", "b"]);
    const request = mergeGame(game, game, forfeitProposal(game, "a", "request"), { actor: "a" });
    if (!request.ok) throw new Error("Request rejected");
    const pending = materialize(request.game);
    const approval = forfeitProposal(pending, "b", "approve");
    let current = pending;
    while (current.status !== IGameStatus.OVER) {
      const next = mergeGame(current, current, move(current, "other"), { now: () => 3000 });
      if (!next.ok) throw new Error("Move rejected");
      current = materialize(next.game);
    }
    expect(current).toMatchObject({ outcome: "completed", endedAt: 3000, forfeit: { closed: true } });
    expect(mergeGame(pending, current, approval, { actor: "b" })).toMatchObject({ changed: false });
    const legacy = {
      ...doc(current),
      matchId: undefined,
      startedAt: undefined,
      endedAt: undefined,
      outcome: undefined,
      undoCount: undefined,
    };
    const rebuilt = materialize(toDocument(legacy));
    expect(rebuilt).toMatchObject({ status: IGameStatus.OVER });
    expect(rebuilt.endedAt).toBeUndefined();
    expect(rebuilt.outcome).toBeUndefined();
  });

  it("ignores a status-only shortcut and disallows local votes", () => {
    const local = startedGame(["a", "b"], { gameMode: GameMode.PASS_AND_PLAY });
    expect(forfeitProposal(local, "a", "request")).toBeNull();
    const game = startedGame(["a", "b"]);
    expect(merged(game, game, { ...game, status: IGameStatus.OVER, outcome: "forfeited", endedAt: 3000 })).toEqual(
      doc(game)
    );
  });
});

describe("mergeGame: purity", () => {
  it("does not modify its inputs and returns a rebuildable document", () => {
    const lobby = join(lobbyGame(), "host");
    const base = deepFreeze(doc(lobby));
    const current = deepFreeze(doc(chat(lobby, "c1")));
    const proposed = deepFreeze(doc(join(lobby, "bob")));
    const snapshot = cloneDeep([base, current, proposed]);

    const result = mergeGame(base, current, proposed);
    expect([base, current, proposed]).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.game.players.push({ id: "x", name: "x", bot: false });
      expect(current.players).toHaveLength(1);
      expect(materialize(result.game).players).toHaveLength(3);
    }
  });

  it("reports no change for a proposal identical to the current state", () => {
    const game = doc(move(startedGame(["a", "b"])));
    const result = mergeGame(game, game, game);
    expect(result.ok && result.changed).toBe(false);
  });
});
