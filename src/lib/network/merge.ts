/**
 * Three-way merge of a proposed write into the authority's current state
 * (docs/P2P_DESIGN.md, "Writes: proposals and 3-way merge").
 *
 * `base` is the replica the writer last saw, `current` the authority's state,
 * `proposed` the writer's new state. Only what the writer changed relative to
 * `base` is applied, so concurrent writes (lobby joins, chat, reactions,
 * review comments) all survive, while two different moves for the same turn
 * cannot both win.
 *
 * Pure: inputs are not modified, the result shares no object with them.
 */
import { cloneDeep, isEqual } from "lodash";
import { isGameOver } from "~/lib/actions";
import IGameState, { IGameStatus, IMessage, IPlayer, IReviewComment, ITurn } from "~/lib/state";
import { GameDocument, isLocalGame, toDocument, tryMaterialize } from "./document";
import { RejectionReason } from "./types";

export type MergeResult = { ok: true; game: GameDocument; changed: boolean } | { ok: false; reason: RejectionReason };

type Input = GameDocument | Partial<IGameState>;

function isPrefix(prefix: ITurn[], turns: ITurn[]): boolean {
  return prefix.length <= turns.length && isEqual(prefix, turns.slice(0, prefix.length));
}

function mergeTurns(base: ITurn[], current: ITurn[], proposed: ITurn[]): ITurn[] | null {
  if (isEqual(proposed, base)) {
    return current;
  }
  if (isEqual(current, base)) {
    // A move (turns added) or a rollback (turns removed) on top of the state
    // the writer saw. Anything else rewrites history: refused.
    return isPrefix(base, proposed) || isPrefix(proposed, base) ? proposed : null;
  }
  if (isEqual(current, proposed)) {
    // The same change was already applied (a move, or the same rollback).
    return current;
  }
  if (isPrefix(base, proposed) && isPrefix(proposed, current)) {
    // The same moves were already applied, maybe followed by more (e.g. a bot
    // turn proposed twice, or re-proposed after a split brain).
    return current;
  }
  if (isPrefix(base, current) && isPrefix(current, proposed)) {
    // The writer already had the turns applied since its base (e.g. its own
    // pending move) and adds more on top of them.
    return proposed;
  }
  return null;
}

function mergePlayers(
  base: GameDocument,
  current: GameDocument,
  proposed: GameDocument
): { players: IPlayer[] } | { reason: "game-full" | "game-started" } {
  const players = cloneDeep(current.players);
  const baseById = new Map(base.players.map((player) => [player.id, player]));
  const joiners: IPlayer[] = [];

  proposed.players.forEach((proposedPlayer) => {
    const player = players.find((p) => p.id === proposedPlayer.id);
    if (!player) {
      if (!joiners.some((p) => p.id === proposedPlayer.id)) {
        joiners.push(cloneDeep(proposedPlayer));
      }
      return;
    }

    // Seat type is fixed once play starts. It also determines who can vote.
    const basePlayer = baseById.get(proposedPlayer.id);
    const keys = new Set([...Object.keys(basePlayer || {}), ...Object.keys(proposedPlayer)]);
    keys.delete("id");
    if (current.status !== IGameStatus.LOBBY) keys.delete("bot");
    keys.forEach((key) => {
      const value = proposedPlayer[key];
      if (basePlayer && isEqual(value, basePlayer[key])) {
        return;
      }
      if (value === undefined) {
        delete player[key];
      } else {
        player[key] = cloneDeep(value);
      }
    });
  });

  if (joiners.length) {
    if (current.status !== IGameStatus.LOBBY) {
      return { reason: "game-started" };
    }
    if (players.length + joiners.length > current.options.playersCount) {
      return { reason: "game-full" };
    }
  }

  // Join order deals the hands: current order first, newcomers in arrival order.
  return { players: [...players, ...joiners] };
}

function messageKey(message: IMessage): string {
  return message.id ? `id:${message.id}` : `json:${JSON.stringify(message)}`;
}

function mergeMessages(current: IMessage[], proposed: IMessage[]): IMessage[] {
  const known = new Set(current.map(messageKey));
  const added = proposed.filter((message) => {
    const key = messageKey(message);
    if (known.has(key)) {
      return false;
    }
    known.add(key);
    return true;
  });

  return cloneDeep([...current, ...added]);
}

function commentKey(comment: IReviewComment): string {
  return JSON.stringify([comment.playerId ?? null, comment.afterTurnNumber]);
}

function mergeReviewComments(
  base: IReviewComment[],
  current: IReviewComment[],
  proposed: IReviewComment[]
): IReviewComment[] {
  const baseByKey = new Map(base.map((comment) => [commentKey(comment), comment]));
  const currentByKey = new Map(current.map((comment) => [commentKey(comment), comment]));
  const proposedByKey = new Map(proposed.map((comment) => [commentKey(comment), comment]));

  // Current order, then new keys in proposed order.
  const keys = Array.from(currentByKey.keys());
  proposedByKey.forEach((_, key) => {
    if (!currentByKey.has(key)) {
      keys.push(key);
    }
  });

  const merged: IReviewComment[] = [];
  new Set(keys).forEach((key) => {
    const proposedComment = proposedByKey.get(key);
    // The writer changed (or deleted, e.g. by a rollback) this key: it wins.
    const comment = isEqual(proposedComment, baseByKey.get(key)) ? currentByKey.get(key) : proposedComment;
    if (comment) {
      merged.push(cloneDeep(comment));
    }
  });

  return merged;
}

export function isForfeitProposal(base: GameDocument, proposed: GameDocument): boolean {
  return !isEqual(base.forfeit, proposed.forfeit);
}

function mergeForfeit(
  base: GameDocument,
  current: GameDocument,
  proposed: GameDocument,
  actor: string | null,
  now: () => number
): MergeResult {
  const humans = current.players.filter((player) => !player.bot).map((player) => player.id);
  const vote = proposed.forfeit;
  const previous = current.forfeit;
  if (isLocalGame(current) || !humans.includes(actor) || !vote || !isEqual(base.turnsHistory, proposed.turnsHistory)) {
    return { ok: false, reason: "invalid" };
  }
  const unchanged = { ok: true, game: cloneDeep(current), changed: false } as const;
  if (current.status !== IGameStatus.ONGOING) return unchanged;

  const merged = cloneDeep(current);
  if (!vote.closed && vote.id !== base.forfeit?.id) {
    if (vote.requesterId !== actor || !isEqual(vote.approvedBy, [actor])) return { ok: false, reason: "invalid" };
    // A request can only replace the last closed request the requester saw.
    if (previous?.id !== base.forfeit?.id || (previous && !previous.closed)) return unchanged;
    merged.forfeit = { id: vote.id, requesterId: actor, approvedBy: [actor] };
  } else {
    if (vote.id !== base.forfeit?.id || vote.requesterId !== base.forfeit.requesterId) {
      return { ok: false, reason: "invalid" };
    }
    if (vote.id !== previous?.id || previous.closed || base.forfeit.closed) return unchanged;
    if (vote.closed) {
      if (!isEqual(vote.approvedBy, base.forfeit.approvedBy)) return { ok: false, reason: "invalid" };
      merged.forfeit.closed = true;
      return { ok: true, game: merged, changed: true };
    }
    if (!isEqual(vote.approvedBy, [...base.forfeit.approvedBy, actor]) || base.forfeit.approvedBy.includes(actor)) {
      return { ok: false, reason: "invalid" };
    }
    if (previous.approvedBy.includes(actor)) return unchanged;
    merged.forfeit.approvedBy.push(actor);
  }

  if (humans.every((id) => merged.forfeit.approvedBy.includes(id))) {
    merged.forfeit.closed = true;
    merged.status = IGameStatus.OVER;
    merged.outcome = "forfeited";
    merged.endedAt = now();
  }
  return { ok: true, game: merged, changed: true };
}

/**
 * Merge `proposed` (written on top of `base`) into `current`:
 *
 * - turnsHistory: unchanged from base -> keep current; current still equal to
 *   base -> take proposed when it is a move (base + turns) or a rollback (a
 *   prefix of base); both changed -> no-op when current already starts with
 *   proposed (duplicate move, e.g. a bot turn proposed twice), take proposed
 *   when it extends current which extends base, else rejected
 *   ("turn-conflict": the turn already moved on).
 * - players: union by id, current order then joiners in arrival order; field
 *   changes applied where proposed differs from base. Joins after the lobby
 *   ("game-started") or beyond playersCount ("game-full") are rejected.
 * - messages: union by id, current order first.
 * - reviewComments: union keyed by (playerId, afterTurnNumber); proposed wins
 *   for the keys it changed, including deletions (rollbacks drop comments).
 * - lobby options and nextGameId: proposed where it differs from base, else current.
 * - the authority derives match metadata from the accepted transition.
 *
 * `changed` tells whether the result differs from `current`.
 */
export function mergeGame(
  baseInput: Input,
  currentInput: Input,
  proposedInput: Input,
  { actor = null, now = Date.now }: { actor?: string | null; now?: () => number } = {}
): MergeResult {
  const base = toDocument(baseInput);
  const current = toDocument(currentInput);
  const proposed = toDocument(proposedInput);

  if (proposed.id !== current.id || base.id !== current.id || (base.matchId && base.matchId !== current.matchId)) {
    return { ok: false, reason: "wrong-game" };
  }
  if (isForfeitProposal(base, proposed)) return mergeForfeit(base, current, proposed, actor, now);

  const turnsHistory = mergeTurns(base.turnsHistory, current.turnsHistory, proposed.turnsHistory);
  if (!turnsHistory) {
    return { ok: false, reason: "turn-conflict" };
  }
  const turnsChanged = !isEqual(turnsHistory, current.turnsHistory);
  const rolledBack = turnsHistory.length < current.turnsHistory.length;
  if (
    turnsChanged &&
    (base.undoCount !== current.undoCount ||
      current.outcome === "forfeited" ||
      (current.status === IGameStatus.OVER && !rolledBack) ||
      (rolledBack && current.options.allowRollback === false))
  ) {
    return { ok: false, reason: "turn-conflict" };
  }

  const players = mergePlayers(base, current, proposed);
  if ("reason" in players) {
    return { ok: false, reason: players.reason };
  }

  const merged: GameDocument = {
    ...cloneDeep(current),
    players: players.players,
    turnsHistory: cloneDeep(turnsHistory),
    messages: mergeMessages(current.messages, proposed.messages),
    reviewComments: mergeReviewComments(base.reviewComments, current.reviewComments, proposed.reviewComments),
  };

  if (current.status === IGameStatus.LOBBY && !isEqual(proposed.options, base.options)) {
    merged.options = cloneDeep(proposed.options);
  }
  if (proposed.nextGameId !== base.nextGameId) {
    if (proposed.nextGameId === undefined) delete merged.nextGameId;
    else merged.nextGameId = proposed.nextGameId;
  }

  if (
    current.status === IGameStatus.LOBBY &&
    base.status === IGameStatus.LOBBY &&
    proposed.status === IGameStatus.ONGOING
  ) {
    merged.status = IGameStatus.ONGOING;
    if (proposed.startedAt != null) merged.startedAt = proposed.startedAt;
  }
  if (rolledBack) {
    if (current.undoCount !== undefined) {
      if (current.undoCount === Number.MAX_SAFE_INTEGER) return { ok: false, reason: "invalid" };
      merged.undoCount = current.undoCount + 1;
    }
    merged.status = IGameStatus.ONGOING;
    delete merged.endedAt;
    delete merged.outcome;
  } else if (turnsChanged) {
    const state = tryMaterialize(merged);
    if (!state) return { ok: false, reason: "invalid" };
    if (isGameOver(state)) {
      merged.status = IGameStatus.OVER;
      merged.outcome = "completed";
      merged.endedAt = now();
      if (merged.forfeit) merged.forfeit.closed = true;
    }
  }
  return { ok: true, game: merged, changed: !isEqual(merged, current) };
}
