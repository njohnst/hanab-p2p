import { getMaximumScore, getScore } from "~/lib/actions";
import IGameState, { GameMode, GameVariant, IGameHintsLevel, IGameStatus } from "~/lib/state";

type Seat = { id: string; name: string; bot: boolean };

interface Rules {
  variant: GameVariant;
  gameMode: GameMode;
  allowRollback: boolean | null;
  preventLoss: boolean | null;
  hintsLevel: IGameHintsLevel | null;
  turnsHistory: boolean | null;
  botsWait: number | null;
}

export interface MatchResult {
  roster: Seat[];
  rules: Rules;
  outcome: "completed" | "forfeited";
  score: number;
  maxScore: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  undoCount: number | null;
}

/** A null result withdraws an archived finish when a later accepted revision reopens the match. */
export interface HistoryEntry {
  matchId: string | null;
  gameId: string;
  legacyCreatedAt: number | null;
  group: string[];
  version: number;
  author: string;
  result: MatchResult | null;
}

export const groupKey = (group: string[]) => JSON.stringify(group);
export const entryKey = (entry: HistoryEntry) => entry.matchId ?? JSON.stringify([entry.gameId, entry.legacyCreatedAt]);

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => count(value) && value <= 8.64e15;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function setting(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function humanGroup(roster: Seat[]): string[] {
  const humans = roster
    .filter((seat) => !seat.bot)
    .map((seat) => seat.id)
    .sort();
  return humans.length && humans.length === new Set(humans).size ? humans : null;
}

/** Pass-and-play seats sharing one id cannot identify an exact human group. */
export function seatedGroup(game: IGameState): string[] | null {
  if (game.options.tutorial || game.players.length !== game.options.playersCount) return null;
  return humanGroup(game.players);
}

export function durationBetween(start: number | null, end: number | null): number | null {
  return timestamp(start) && timestamp(end) && end >= start ? end - start : null;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function entryFromGame(
  game: IGameState,
  group: string[],
  revision: { version: number; author: string }
): HistoryEntry | null {
  if (!game.synced || game.originalGame || !group?.length || game.status === IGameStatus.LOBBY) return null;
  // Optional shared metadata remains absent on old replicas. The room and its
  // creation time can identify those snapshots locally, but are never sent as UUIDs.
  const { matchId, undoCount, outcome } = game;
  const startedAt = timestamp(game.startedAt) ? game.startedAt : null;
  const endedAt = timestamp(game.endedAt) ? game.endedAt : null;
  const { variant, gameMode, allowRollback, preventLoss, hintsLevel, turnsHistory, botsWait } = game.options;
  return readEntry({
    matchId: isUuid(matchId) ? matchId : null,
    gameId: game.id,
    legacyCreatedAt: isUuid(matchId) ? null : game.createdAt,
    group,
    ...revision,
    result:
      game.status === IGameStatus.OVER
        ? {
            roster: game.players.map(({ id, name, bot }) => ({ id, name, bot: !!bot })),
            rules: {
              variant: variant ?? GameVariant.CLASSIC,
              gameMode: gameMode ?? GameMode.NETWORK,
              allowRollback: allowRollback ?? null,
              preventLoss: preventLoss ?? null,
              hintsLevel: hintsLevel ?? null,
              turnsHistory: turnsHistory ?? null,
              botsWait: game.players.some(({ bot }) => bot) ? botsWait ?? null : null,
            },
            outcome: outcome ?? "completed",
            score: getScore(game),
            maxScore: getMaximumScore(game),
            startedAt,
            endedAt,
            durationMs: durationBetween(startedAt, endedAt),
            undoCount: count(undoCount) ? undoCount : null,
          }
        : null,
  });
}

/** Reconstruct only known fields for storage, deterministic comparison and forwarding. */
export function readEntry(value: unknown): HistoryEntry | null {
  if (!object(value)) return null;
  const { matchId, gameId, legacyCreatedAt, group, version, author, result } = value;
  if (
    !(matchId === null ? timestamp(legacyCreatedAt) : isUuid(matchId) && legacyCreatedAt === null) ||
    !isId(gameId) ||
    !Array.isArray(group) ||
    group.length < 1 ||
    group.length > 5 ||
    !group.every((id, i) => isId(id) && (i === 0 || group[i - 1] < id)) ||
    !count(version) ||
    version < 1 ||
    typeof author !== "string" ||
    author.length > 128
  )
    return null;
  const parsed = result === null ? null : readResult(result, group);
  if (result !== null && !parsed) return null;
  return {
    matchId: typeof matchId === "string" ? matchId.toLowerCase() : null,
    gameId,
    legacyCreatedAt: typeof legacyCreatedAt === "number" ? legacyCreatedAt : null,
    group: group.slice(),
    version,
    author,
    result: parsed,
  };
}

function readResult(value: unknown, group: string[]): MatchResult | null {
  if (!object(value)) return null;
  const { roster, rules, outcome, score, maxScore, startedAt, endedAt, durationMs, undoCount } = value;
  if (
    !Array.isArray(roster) ||
    roster.length < 2 ||
    roster.length > 5 ||
    !roster.every(
      (seat) =>
        object(seat) &&
        isId(seat.id) &&
        typeof seat.name === "string" &&
        seat.name.length <= 200 &&
        typeof seat.bot === "boolean"
    ) ||
    !object(rules) ||
    (outcome !== "completed" && outcome !== "forfeited") ||
    !count(score) ||
    (maxScore !== 25 && maxScore !== 30) ||
    score > maxScore ||
    !(startedAt === null || timestamp(startedAt)) ||
    !(endedAt === null || timestamp(endedAt)) ||
    durationMs !== durationBetween(startedAt as number, endedAt as number) ||
    !(undoCount === null || count(undoCount))
  )
    return null;
  const seats: Seat[] = roster.map(({ id, name, bot }) => ({ id, name, bot }));
  const humans = humanGroup(seats);
  const { variant, gameMode, allowRollback, preventLoss, hintsLevel, turnsHistory, botsWait } = rules;
  if (
    !humans ||
    groupKey(humans) !== groupKey(group) ||
    !Object.values(GameVariant).includes(variant as GameVariant) ||
    !Object.values(GameMode).includes(gameMode as GameMode) ||
    (hintsLevel !== null && !Object.values(IGameHintsLevel).includes(hintsLevel as IGameHintsLevel)) ||
    !setting(allowRollback) ||
    !setting(preventLoss) ||
    !setting(turnsHistory) ||
    !(
      botsWait === null ||
      (typeof botsWait === "number" && botsWait >= 0 && botsWait <= 600000 && seats.some(({ bot }) => bot))
    ) ||
    maxScore !== getMaximumScore({ options: { variant } } as IGameState)
  )
    return null;
  return {
    roster: seats,
    rules: {
      variant: variant as GameVariant,
      gameMode: gameMode as GameMode,
      allowRollback,
      preventLoss,
      hintsLevel: hintsLevel as IGameHintsLevel,
      turnsHistory,
      botsWait: botsWait as number,
    },
    outcome,
    score,
    maxScore,
    startedAt: startedAt as number,
    endedAt: endedAt as number,
    durationMs: durationMs as number,
    undoCount: undoCount as number,
  };
}
