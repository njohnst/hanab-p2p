/**
 * Game synchronisation API (replaces the Firebase Realtime Database layer).
 *
 * This is the contract the UI codes against. It keeps the function names the
 * Firebase module exported (loadGame, subscribeToGame, updateGame, setReaction,
 * setNotification, ...) so call sites barely change, and adds connection
 * introspection for the peer-to-peer world.
 *
 * TEMPORARY IMPLEMENTATION: a single-browser backend (localStorage replicas +
 * BroadcastChannel between tabs), so the static-export work can run before
 * the WebRTC sync engine lands. The WebRTC implementation (see
 * docs/P2P_DESIGN.md) replaces the bodies below while keeping every exported
 * signature and its documented behaviour.
 */
import { cloneDeep } from "lodash";
import IGameState, { cleanState, fillEmptyValues, IPlayer, rebuildGame } from "~/lib/state";

/**
 * local      - pass & play / tutorial game: never touches the network.
 * connecting - joining the signaling relays, no peer seen yet.
 * alone      - signaling works but no other peer is in the room right now.
 * connected  - at least one peer connected over WebRTC.
 * offline    - the browser is offline or every signaling relay failed.
 */
export type ConnectionStatus = "local" | "connecting" | "alone" | "connected" | "offline";

export interface PeerInfo {
  /** Transport-level peer id (changes on every page load). */
  peerId: string;
  /** Player id announced by the peer (see ~/lib/playerId); null until its hello arrives. */
  playerId: string | null;
}

export interface ConnectionInfo {
  gameId: string;
  status: ConnectionStatus;
  /** Peers currently connected to this tab for this game. */
  peers: PeerInfo[];
  /**
   * This tab currently orders updates for the game (and therefore must run the
   * bots' turns). Always true for local games and when alone.
   */
  isAuthority: boolean;
  /** A replica of the game exists in this tab (local copy or received from a peer). */
  hasState: boolean;
  /** Human-readable problem worth surfacing (e.g. a peer runs an incompatible app version). */
  error: string | null;
}

/** Lobby-stage public game, as listed on the "Join a room" page. */
export interface PublicGame {
  id: string;
  playersNames: string[];
  playersCount: number;
  variant: string;
  createdAt: number;
}

/** A game this browser holds a replica of (for "resume" lists). */
export interface RecentGame {
  id: string;
  status: IGameState["status"];
  playersNames: string[];
  updatedAt: number;
}

interface StoredReplica {
  version: number;
  updatedAt: number;
  game: Partial<IGameState>;
}

const REPLICA_PREFIX = "hanab.game.";
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("hanab-local-sync") : null;
const gameListeners = new Map<string, Set<(game: IGameState) => void>>();
const connectionListeners = new Map<string, Set<(info: ConnectionInfo) => void>>();

function readReplica(gameId: string): StoredReplica | null {
  try {
    const raw = localStorage.getItem(REPLICA_PREFIX + gameId);
    return raw ? (JSON.parse(raw) as StoredReplica) : null;
  } catch {
    return null;
  }
}

function writeReplica(replica: StoredReplica) {
  try {
    localStorage.setItem(REPLICA_PREFIX + replica.game.id, JSON.stringify(replica));
  } catch (e) {
    console.warn("[network] could not persist game replica", e);
  }
}

function materialize(stored: Partial<IGameState>): IGameState {
  return rebuildGame(fillEmptyValues(cloneDeep(stored) as IGameState));
}

function emit(gameId: string) {
  const replica = readReplica(gameId);
  if (!replica) return;
  gameListeners.get(gameId)?.forEach((listener) => listener({ ...materialize(replica.game), synced: true }));
}

channel?.addEventListener("message", (event: MessageEvent<{ gameId: string }>) => emit(event.data.gameId));

/**
 * Resolve the game: immediately from this browser's replica when there is one,
 * otherwise once a peer sends it. Resolves null if nobody provided it within
 * `timeoutMs` (default 15s) -- the UI should then offer to keep waiting
 * rather than treat the game as nonexistent, since peers may join later.
 */
export async function loadGame(gameId: string, options: { timeoutMs?: number } = {}): Promise<IGameState | null> {
  void options;
  const replica = readReplica(gameId);
  return replica ? materialize(replica.game) : null;
}

/**
 * Join the game's room (reference-counted across subscribers) and call
 * `callback` with the current state and after every change, local or remote.
 * States are rebuilt (rebuildGame) and passed with `synced: true`.
 * Returns an unsubscribe function; the room is left when the last subscriber goes.
 */
export function subscribeToGame(gameId: string, callback: (game: IGameState) => void): () => void {
  const listeners = gameListeners.get(gameId) ?? new Set();
  listeners.add(callback);
  gameListeners.set(gameId, listeners);
  queueMicrotask(() => emit(gameId));
  return () => listeners.delete(callback);
}

/**
 * Propose `game` as the new state. The authority applies it (merging
 * concurrent changes such as lobby joins and chat messages) and broadcasts
 * the result, which reaches subscribers -- including this tab -- through
 * subscribeToGame. Works for games not joined yet: the new-game page creates
 * the game here before navigating to it. Resolves once the proposal is
 * applied locally (authority) or handed to the transport (non-authority).
 */
export async function updateGame(game: IGameState): Promise<void> {
  window["hanab"] = cloneDeep(game);
  const previous = readReplica(game.id);
  writeReplica({ version: (previous?.version ?? 0) + 1, updatedAt: Date.now(), game: cleanState(game) });
  emit(game.id);
  channel?.postMessage({ gameId: game.id });
}

/** Set (or clear with null) a player's emoji reaction. Never lost to concurrent updates. */
export async function setReaction(game: IGameState, player: IPlayer, reaction: string | null): Promise<void> {
  const players = game.players.map((p) => (p.id === player.id ? { ...p, reaction } : p));
  await updateGame({ ...game, players });
}

/** Mark a player as notified (the "ring the bell" nudge). Never lost to concurrent updates. */
export async function setNotification(game: IGameState, player: IPlayer, notified: boolean): Promise<void> {
  const players = game.players.map((p) => (p.id === player.id ? { ...p, notified } : p));
  await updateGame({ ...game, players });
}

/** Snapshot of this tab's connection to the game's room. */
export function getConnection(gameId: string): ConnectionInfo {
  return {
    gameId,
    status: "local",
    peers: [],
    isAuthority: true,
    hasState: readReplica(gameId) !== null,
    error: null,
  };
}

/** Whether this tab should order updates and play the bots' turns for the game. */
export function isAuthority(gameId: string): boolean {
  return getConnection(gameId).isAuthority;
}

/** Call `callback` now and whenever the connection to the game's room changes. */
export function subscribeToConnection(gameId: string, callback: (info: ConnectionInfo) => void): () => void {
  const listeners = connectionListeners.get(gameId) ?? new Set();
  listeners.add(callback);
  connectionListeners.set(gameId, listeners);
  queueMicrotask(() => callback(getConnection(gameId)));
  return () => listeners.delete(callback);
}

/** Public games in their lobby, announced by peers. Calls back with the full current list on every change. */
export function subscribeToPublicGames(callback: (games: PublicGame[]) => void): () => void {
  queueMicrotask(() => callback([]));
  return () => undefined;
}

/** Games this browser holds a replica of, most recently updated first. */
export function listRecentGames(): RecentGame[] {
  const games: RecentGame[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(REPLICA_PREFIX)) continue;
      const replica = readReplica(key.slice(REPLICA_PREFIX.length));
      if (!replica?.game?.id) continue;
      games.push({
        id: replica.game.id,
        status: replica.game.status,
        playersNames: (replica.game.players ?? []).map((p) => p.name),
        updatedAt: replica.updatedAt,
      });
    }
  } catch {
    return [];
  }
  return games.sort((a, b) => b.updatedAt - a.updatedAt);
}
