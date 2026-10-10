/**
 * Game synchronisation API (replaces the Firebase Realtime Database layer).
 *
 * This is the contract the UI codes against. It keeps the function names the
 * Firebase module exported (loadGame, subscribeToGame, updateGame, setReaction,
 * setNotification, ...) so call sites barely change, and adds connection
 * introspection for the peer-to-peer world.
 *
 * Games are replicated between the players' browsers over WebRTC (see
 * docs/P2P_DESIGN.md): every tab keeps a full replica in localStorage, one
 * peer per game (the authority) orders the writes, and the others propose
 * theirs to it. The engine lives in ./sync.ts (one game) and ./node.ts (one
 * tab); this module exposes the browser tab's node.
 *
 * Importing this module has no side effect: the node, its transport (Trystero,
 * or BroadcastChannel with `?net=local`) and its storage are created on first
 * use in the browser. During the static pre-render (no window) every function
 * is inert.
 */
import { cloneDeep } from "lodash";
import IGameState, { IPlayer } from "~/lib/state";
import { createBrowserNode } from "./browser";
import { NetworkNode } from "./node";
import { ConnectionInfo, PublicGame, RecentGame, Rejection } from "./types";

export type {
  ConnectionInfo,
  ConnectionStatus,
  PeerInfo,
  PublicGame,
  RecentGame,
  Rejection,
  RejectionReason,
} from "./types";

let browserNode: NetworkNode | null = null;

/** This tab's network node; null outside the browser. */
export function getNetworkNode(): NetworkNode | null {
  if (typeof window === "undefined") {
    return null;
  }
  if (!browserNode) {
    browserNode = createBrowserNode();
  }
  return browserNode;
}

/**
 * Resolve the game: immediately from this browser's replica when there is one,
 * otherwise once a peer sends it. Resolves null if nobody provided it within
 * `timeoutMs` (default 15s) -- the UI should then offer to keep waiting
 * rather than treat the game as nonexistent, since peers may join later.
 */
export async function loadGame(gameId: string, options: { timeoutMs?: number } = {}): Promise<IGameState | null> {
  const node = getNetworkNode();
  return node ? node.loadGame(gameId, options) : null;
}

/**
 * Join the game's room (reference-counted across subscribers) and call
 * `callback` with the current state and after every change, local or remote.
 * States are rebuilt (rebuildGame) and passed with `synced: true`; each call
 * gets its own copy. Returns an unsubscribe function; the room is left a few
 * seconds after the last subscriber goes (so remounts and route changes
 * don't reconnect).
 */
export function subscribeToGame(gameId: string, callback: (game: IGameState) => void): () => void {
  const node = getNetworkNode();
  return node ? node.subscribeToGame(gameId, callback) : () => undefined;
}

/**
 * Propose `game` as the new state. The authority applies it (merging
 * concurrent changes such as lobby joins and chat messages) and broadcasts
 * the result, which reaches subscribers -- including this tab -- through
 * subscribeToGame. Works for games not joined yet: the new-game page creates
 * the game here before navigating to it (it becomes this browser's replica,
 * version 1, and this tab its first authority). Resolves once the proposal is
 * applied locally (authority) or handed to the transport (non-authority).
 *
 * The write is relative to the state this tab last delivered: only what
 * `game` changes compared to it is applied. When the authority refuses it
 * (e.g. the turn already moved on), this tab's subscribers immediately get
 * the authoritative state again and subscribeToRejections is notified.
 */
export async function updateGame(game: IGameState): Promise<void> {
  const node = getNetworkNode();
  if (!node) return;
  // Debugging convenience kept from the previous backends: the last written game.
  window["hanab"] = cloneDeep(game);
  await node.updateGame(game);
}

/** Set (or clear with null) a player's emoji reaction. Never lost to concurrent updates. */
export async function setReaction(game: IGameState, player: IPlayer, reaction: string | null): Promise<void> {
  const node = getNetworkNode();
  if (node) await node.setPlayerField(game, player, "reaction", reaction);
}

/** Mark a player as notified (the "ring the bell" nudge). Never lost to concurrent updates. */
export async function setNotification(game: IGameState, player: IPlayer, notified: boolean): Promise<void> {
  const node = getNetworkNode();
  if (node) await node.setPlayerField(game, player, "notified", notified);
}

/** Snapshot of this tab's connection to the game's room. */
export function getConnection(gameId: string): ConnectionInfo {
  const node = getNetworkNode();
  if (node) {
    return node.getConnection(gameId);
  }
  return { gameId, status: "connecting", peers: [], isAuthority: false, hasState: false, error: null };
}

/** Whether this tab should order updates and play the bots' turns for the game. */
export function isAuthority(gameId: string): boolean {
  return getConnection(gameId).isAuthority;
}

/**
 * Call `callback` now and whenever the connection to the game's room changes.
 * Holds the room like subscribeToGame does.
 */
export function subscribeToConnection(gameId: string, callback: (info: ConnectionInfo) => void): () => void {
  const node = getNetworkNode();
  return node ? node.subscribeToConnection(gameId, callback) : () => undefined;
}

/**
 * Call `callback` whenever the authority refuses one of this tab's writes to
 * the game: `reason` is "turn-conflict" when the turn had already moved on
 * (another move, or a rollback, got there first), "game-full" or
 * "game-started" for a join that came too late, "invalid" for a write that
 * could not be applied. By the time it is called, subscribeToGame has already
 * delivered the authoritative state; use it to tell the player (a toast).
 * Does not join the room by itself.
 */
export function subscribeToRejections(gameId: string, callback: (rejection: Rejection) => void): () => void {
  const node = getNetworkNode();
  return node ? node.subscribeToRejections(gameId, callback) : () => undefined;
}

/**
 * Public games in their lobby, announced by peers. Calls back with the full
 * current list now and on every change (entries expire ~30s after their last
 * announcement).
 */
export function subscribeToPublicGames(callback: (games: PublicGame[]) => void): () => void {
  const node = getNetworkNode();
  if (!node) {
    queueMicrotask(() => callback([]));
    return () => undefined;
  }
  return node.subscribeToPublicGames(callback);
}

/** Games this browser holds a replica of, most recently updated first. */
export function listRecentGames(): RecentGame[] {
  const node = getNetworkNode();
  return node ? node.listRecentGames() : [];
}
