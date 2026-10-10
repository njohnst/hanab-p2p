/**
 * Wire protocol: JSON messages exchanged over one Trystero action (or the
 * BroadcastChannel / in-memory transports).
 *
 * Every message carries `protocol`. Bump PROTOCOL whenever peers running the
 * old code could misread the new messages or documents: peers with another
 * protocol are ignored and reported to the player ("reload").
 *
 * Everything received is untrusted: parseMessage validates the shape and the
 * size of every field before the sync engine looks at it, and never throws.
 */
import { IGameStatus } from "~/lib/state";
import { GameDocument } from "./document";
import { PublicGame } from "./types";

export const PROTOCOL = 1;

/** Messages larger than this (serialised) are dropped. A long game is ~20KB. */
export const MAX_MESSAGE_CHARS = 512 * 1024;
/** Recent proposal ids carried by every state (idempotency of re-sent proposals). */
export const MAX_APPLIED_IDS = 1024;

const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 200;
const MAX_TEXT_CHARS = 10000;
const MAX_TURNS = 1000;
const MAX_MESSAGES = 5000;
const MAX_REVIEW_COMMENTS = 5000;

/** Sent to each peer on connection, periodically, and when this tab's authority changes. */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  gameId: string;
  /** Random per tab, stable for the page's lifetime: identifies the sender for elections. */
  authorKey: string;
  playerId: string | null;
  /** (version, author) of the sender's replica; 0 and "" without one. */
  version: number;
  author: string;
  hasState: boolean;
  isAuthority: boolean;
  /** authorKey of the authority the sender follows (its own when it is the authority), if any. */
  following?: string | null;
}

/** A full replica: broadcast by the authority after every write, or sent to a peer that is behind. */
export interface StateMessage {
  type: "state";
  protocol: number;
  gameId: string;
  authorKey: string;
  version: number;
  /** authorKey of the authority that stamped this version. */
  author: string;
  /** Ids of the most recent proposals included in this state (oldest first). */
  applied: string[];
  game: GameDocument;
  isAuthority: boolean;
}

/** A write sent to the authority: merged with mergeGame(base, current, proposed). */
export interface ProposeMessage {
  type: "propose";
  protocol: number;
  gameId: string;
  authorKey: string;
  proposalId: string;
  baseVersion: number;
  base: GameDocument;
  proposed: GameDocument;
}

/** The authority accepted a proposal that changed nothing. */
export interface AckMessage {
  type: "ack";
  protocol: number;
  gameId: string;
  proposalId: string;
}

/** The authority refused a proposal; the current state follows. */
export interface RejectMessage {
  type: "reject";
  protocol: number;
  gameId: string;
  proposalId: string;
  reason: string;
}

/** Public-lobby announcement ("open: false" withdraws the game). */
export interface PublicGameMessage {
  type: "public-game";
  protocol: number;
  game: PublicGame;
  open: boolean;
}

export type GameMessage = HelloMessage | StateMessage | ProposeMessage | AckMessage | RejectMessage;
export type WireMessage = GameMessage | PublicGameMessage;

export type ParsedMessage =
  | { kind: "ok"; message: WireMessage }
  | { kind: "protocol-mismatch"; protocol: number }
  | { kind: "invalid"; reason: string };

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max: number, min = 0): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptional(value: unknown, check: (value: unknown) => boolean) {
  return value === undefined || value === null || check(value);
}

function isArrayOf(value: unknown, max: number, check: (item: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.length <= max && value.every(check);
}

const isId = (value: unknown) => isString(value, MAX_ID_CHARS, 1);
const isTimestamp = (value: unknown) => isFiniteNumber(value) && value >= 0;

function isOptions(value: unknown): boolean {
  return (
    isObject(value) &&
    isInteger(value.playersCount, 2, 5) &&
    isString(value.seed, 1024) &&
    isOptional(value.id, isId) &&
    isOptional(value.variant, (v) => isString(v, 64)) &&
    isOptional(value.gameMode, (v) => isString(v, 64)) &&
    isOptional(value.botsWait, (v) => isFiniteNumber(v) && v >= 0 && v <= 600000)
  );
}

function isPlayer(value: unknown): boolean {
  return (
    isObject(value) &&
    isId(value.id) &&
    isString(value.name, MAX_NAME_CHARS) &&
    isOptional(value.bot, (v) => typeof v === "boolean") &&
    isOptional(value.reaction, (v) => isString(v, 64)) &&
    isOptional(value.notified, (v) => typeof v === "boolean")
  );
}

function isTurn(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.action)) {
    return false;
  }
  const action = value.action;
  if (!isInteger(action.from, 0, 4)) {
    return false;
  }
  if (action.action === "hint") {
    return (
      isInteger(action.to, 0, 4) &&
      (action.type === "color" || action.type === "number") &&
      (isString(action.value, 32) || isInteger(action.value, 0, 5))
    );
  }
  return (action.action === "play" || action.action === "discard") && isInteger(action.cardIndex, 0, 9);
}

function isChatMessage(value: unknown): boolean {
  return (
    isObject(value) &&
    isOptional(value.id, isId) &&
    isString(value.content, MAX_TEXT_CHARS) &&
    isOptional(value.from, (v) => isInteger(v, -1, 4)) &&
    isOptional(value.turn, (v) => isInteger(v, 0, MAX_TURNS))
  );
}

function isReviewComment(value: unknown): boolean {
  return (
    isObject(value) &&
    isOptional(value.playerId, isId) &&
    isInteger(value.afterTurnNumber, -1, MAX_TURNS) &&
    isOptional(value.comment, (v) => isString(v, MAX_TEXT_CHARS))
  );
}

const STATUSES: unknown[] = [IGameStatus.LOBBY, IGameStatus.ONGOING, IGameStatus.OVER];

/** Structural check of a game document (rebuilding it is the semantic check, see tryMaterialize). */
export function isGameDocument(value: unknown): value is GameDocument {
  return (
    isObject(value) &&
    isId(value.id) &&
    STATUSES.includes(value.status) &&
    isOptions(value.options) &&
    isArrayOf(value.players, 5, isPlayer) &&
    isArrayOf(value.turnsHistory, MAX_TURNS, isTurn) &&
    isArrayOf(value.messages, MAX_MESSAGES, isChatMessage) &&
    isArrayOf(value.reviewComments, MAX_REVIEW_COMMENTS, isReviewComment) &&
    isOptional(value.createdAt, isTimestamp) &&
    isOptional(value.startedAt, isTimestamp) &&
    isOptional(value.endedAt, isTimestamp) &&
    isOptional(value.nextGameId, isId)
  );
}

export function isPublicGame(value: unknown): value is PublicGame {
  return (
    isObject(value) &&
    isId(value.id) &&
    isArrayOf(value.playersNames, 5, (name) => isString(name, MAX_NAME_CHARS)) &&
    isInteger(value.playersCount, 2, 5) &&
    isString(value.variant, 64) &&
    isTimestamp(value.createdAt)
  );
}

function isValid(message: Obj): boolean {
  switch (message.type) {
    case "hello":
      return (
        isId(message.gameId) &&
        isId(message.authorKey) &&
        isOptional(message.playerId, isId) &&
        isInteger(message.version, 0, Number.MAX_SAFE_INTEGER) &&
        isString(message.author, MAX_ID_CHARS) &&
        typeof message.hasState === "boolean" &&
        typeof message.isAuthority === "boolean" &&
        isOptional(message.following, isId)
      );
    case "state":
      return (
        isId(message.gameId) &&
        isId(message.authorKey) &&
        isInteger(message.version, 1, Number.MAX_SAFE_INTEGER) &&
        isString(message.author, MAX_ID_CHARS) &&
        isArrayOf(message.applied, MAX_APPLIED_IDS, isId) &&
        typeof message.isAuthority === "boolean" &&
        isGameDocument(message.game)
      );
    case "propose":
      return (
        isId(message.gameId) &&
        isId(message.authorKey) &&
        isId(message.proposalId) &&
        isInteger(message.baseVersion, 0, Number.MAX_SAFE_INTEGER) &&
        isGameDocument(message.base) &&
        isGameDocument(message.proposed)
      );
    case "ack":
      return isId(message.gameId) && isId(message.proposalId);
    case "reject":
      return isId(message.gameId) && isId(message.proposalId) && isString(message.reason, 200);
    case "public-game":
      return isPublicGame(message.game) && typeof message.open === "boolean";
    default:
      return false;
  }
}

/** Validate an incoming message. Never throws. */
export function parseMessage(data: unknown): ParsedMessage {
  try {
    if (!isObject(data)) {
      return { kind: "invalid", reason: "not an object" };
    }
    if (!isFiniteNumber(data.protocol)) {
      return { kind: "invalid", reason: "no protocol" };
    }
    if (data.protocol !== PROTOCOL) {
      return { kind: "protocol-mismatch", protocol: data.protocol };
    }
    const serialised = JSON.stringify(data);
    if (!serialised || serialised.length > MAX_MESSAGE_CHARS) {
      return { kind: "invalid", reason: "too large" };
    }
    if (!isValid(data)) {
      return { kind: "invalid", reason: `malformed ${String(data.type).slice(0, 32)}` };
    }
    return { kind: "ok", message: (data as unknown) as WireMessage };
  } catch {
    return { kind: "invalid", reason: "unreadable" };
  }
}

/** What the player sees when a peer runs another version of the app. */
export function protocolMismatchError(theirs: number): string {
  return theirs > PROTOCOL
    ? "Someone in this game is running a newer version of Hanab. Reload the page to update."
    : "Someone in this game is running an older version of Hanab. Ask them to reload the page.";
}
