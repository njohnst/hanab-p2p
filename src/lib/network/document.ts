/**
 * The replicated game document and how it maps to and from IGameState.
 *
 * Peers replicate the same document Firebase used to store (see cleanState):
 * options, players, turnsHistory, messages, reviewComments, status, timestamps
 * and nextGameId. Everything else (hands, piles, tokens, current player...) is
 * rebuilt deterministically from it with rebuildGame, the deck coming from
 * options.seed.
 *
 * Documents are JSON-normalised (no undefined/null optional fields, turns
 * reduced to the action fields that matter) so that two peers producing the
 * same game produce deep-equal documents.
 */
import { cloneDeep, omit, pick } from "lodash";
import IGameState, {
  cleanState,
  fillEmptyValues,
  GameMode,
  IGameOptions,
  IGameStatus,
  IMessage,
  IPlayer,
  IReviewComment,
  ITurn,
  rebuildGame,
} from "~/lib/state";
import { PublicGame } from "./types";

export interface GameDocument {
  id: string;
  status: IGameStatus;
  options: IGameOptions;
  players: IPlayer[];
  turnsHistory: ITurn[];
  messages: IMessage[];
  reviewComments: IReviewComment[];
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  nextGameId?: string;
}

/** The action fields a turn is replayed from (cards and hint indexes are derived). */
const ACTION_FIELDS = ["action", "from", "to", "type", "value", "cardIndex"];
/** Player fields that are rebuilt from the join order and the deck. */
const DERIVED_PLAYER_FIELDS = ["hand", "index", "lastAction"];
const OPTIONAL_SCALARS = ["startedAt", "endedAt", "nextGameId"] as const;

function jsonClone<T>(value: T, fallback: T): T {
  if (value === undefined) {
    return fallback;
  }
  return JSON.parse(JSON.stringify(value));
}

/** Drop keys whose value is null or undefined (shallow). */
function withoutEmptyFields<T>(value: T): T {
  const result = {} as T;
  Object.keys(value).forEach((key) => {
    if (value[key] !== null && value[key] !== undefined) {
      result[key] = value[key];
    }
  });
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The replicated part of a game, JSON-normalised. Accepts a full IGameState
 * (as the UI passes to updateGame), a cleanState() output or a document.
 * Idempotent.
 */
export function toDocument(game: Partial<IGameState> | GameDocument): GameDocument {
  const source = (game || {}) as Partial<IGameState>;

  const doc: GameDocument = {
    id: source.id,
    status: source.status,
    options: jsonClone(source.options, {} as IGameOptions),
    players: (source.players || []).filter(isPlainObject).map((player) => {
      return withoutEmptyFields(jsonClone(omit(player, DERIVED_PLAYER_FIELDS) as IPlayer, {} as IPlayer));
    }),
    turnsHistory: (source.turnsHistory || []).filter(isPlainObject).map((turn) => {
      const action = isPlainObject(turn.action) ? pick(turn.action, ACTION_FIELDS) : {};
      return ({ action: withoutEmptyFields(jsonClone(action, {})) } as unknown) as ITurn;
    }),
    messages: jsonClone(source.messages || [], []),
    reviewComments: jsonClone(source.reviewComments || [], []),
    createdAt: source.createdAt,
  };

  OPTIONAL_SCALARS.forEach((field) => {
    ((doc as unknown) as Record<string, unknown>)[field] = source[field];
  });

  // Same shape whether the document went through JSON or not.
  return withoutEmptyFields(doc);
}

/** The document of a full game state, through the same cleanState the Firebase backend used. */
export function documentOf(game: IGameState): GameDocument {
  return toDocument(cleanState(game));
}

/** Pass & play and tutorial games live in one tab and never touch the network. */
export function isLocalGame(doc: Pick<GameDocument, "options"> | null | undefined): boolean {
  const options = doc?.options;
  return !!options && (options.gameMode === GameMode.PASS_AND_PLAY || !!options.tutorial);
}

/**
 * Rebuild the full game state from a document: hands, piles and tokens come
 * from replaying the joins and turns on the seeded deck. rebuildGame does not
 * carry startedAt/endedAt (and stamps a fresh endedAt when the replay ends the
 * game), so both are restored from the document.
 */
export function materialize(doc: GameDocument): IGameState {
  const game = rebuildGame(fillEmptyValues((cloneDeep(doc) as unknown) as IGameState));

  delete game.startedAt;
  delete game.endedAt;
  if (doc.startedAt !== undefined) {
    game.startedAt = doc.startedAt;
  }
  if (doc.endedAt !== undefined) {
    game.endedAt = doc.endedAt;
  }
  game.synced = true;

  return game;
}

/**
 * materialize() for untrusted documents: null when the document cannot be
 * rebuilt, or when the replay silently drops part of it (e.g. a turn played
 * out of order, more players than seats).
 */
export function tryMaterialize(doc: GameDocument): IGameState | null {
  try {
    if ((doc.players?.length ?? 0) > doc.options?.playersCount) {
      return null;
    }
    const game = materialize(doc);
    if (game.players.length !== doc.players.length || game.turnsHistory.length !== doc.turnsHistory.length) {
      return null;
    }
    return game;
  } catch {
    return null;
  }
}

/** The replica version a delivered game was rebuilt from. */
export interface SourceVersion {
  gameId: string;
  version: number;
  author: string;
}

/**
 * Games delivered to the UI carry the replica version they were rebuilt
 * from, under a symbol key: it survives the spreads and cloneDeep the UI uses
 * to derive the next state (joinGame, commitAction, sendMessage, ...) but not
 * JSON, so it never reaches documents or the wire. updateGame uses it as the
 * write's base: what the player actually saw, even when the replica moved on
 * before the UI re-rendered.
 */
export const SOURCE_VERSION: unique symbol = Symbol.for("hanab.network.sourceVersion") as never;

export function stampSource(game: IGameState, source: SourceVersion): IGameState {
  ((game as unknown) as Record<symbol, SourceVersion>)[SOURCE_VERSION] = { ...source };
  return game;
}

export function sourceOf(game: unknown): SourceVersion | null {
  if (!game || typeof game !== "object") return null;
  const source = (game as Record<symbol, unknown>)[SOURCE_VERSION] as SourceVersion | undefined;
  if (
    !source ||
    typeof source.gameId !== "string" ||
    typeof source.version !== "number" ||
    typeof source.author !== "string"
  ) {
    return null;
  }
  return source;
}

/** Lobby summary announced on the public room list. */
export function publicSummary(doc: GameDocument): PublicGame {
  return {
    id: doc.id,
    playersNames: doc.players.map((player) => player.name),
    playersCount: doc.options.playersCount,
    variant: doc.options.variant || "classic",
    createdAt: doc.createdAt,
  };
}

/** Whether the game should be listed on "Join a room" (when this tab is its authority). */
export function isPubliclyListed(doc: GameDocument): boolean {
  return (
    !isLocalGame(doc) &&
    !doc.options.private &&
    doc.status === IGameStatus.LOBBY &&
    doc.players.length < doc.options.playersCount
  );
}
