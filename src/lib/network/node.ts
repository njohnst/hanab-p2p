/**
 * NetworkNode: everything one tab needs to sync games (the registry of open
 * games, the replica store, the public lobby). index.ts exposes the browser's
 * node through the public API; tests create several nodes on an in-memory
 * network to simulate several browsers.
 */
import { entryFromGame, entryKey, groupKey, HistoryEntry, seatedGroup } from "~/lib/history/result";
import { HistoryRooms } from "~/lib/history/rooms";
import { HistoryStore } from "~/lib/history/store";
import IGameState, { IGameStatus, IPlayer } from "~/lib/state";
import { GameDocument, isLocalGame, materialize, SourceVersion, sourceOf, stampSource, toDocument } from "./document";
import { LobbyTimings, PublicLobby } from "./publicLobby";
import { compareVersions, KeyValueStorage, ReplicaStore } from "./storage";
import { GameSync, SyncSnapshot, SyncTimings } from "./sync";
import { Transport } from "./transports/types";
import { ConnectionInfo, PublicGame, RecentGame, Rejection } from "./types";

export type NetworkTimings = SyncTimings & { lobby: LobbyTimings };

export const DEFAULT_TIMINGS: NetworkTimings = {
  syncWindowMs: 4000,
  graceMs: 5000,
  helloIntervalMs: 15000,
  retryMs: 3000,
  electionTimeoutMs: 4000,
  tickMs: 1000,
  rejoinDelayMs: 10000,
  lobby: {
    announceIntervalMs: 10000,
    expireMs: 30000,
    graceMs: 5000,
    tickMs: 1000,
  },
};

export const DEFAULT_LOAD_TIMEOUT_MS = 15000;

export interface NetworkNodeOptions {
  /** How this tab reaches its peers (resolved lazily, once). null: no network. */
  transport: Transport | null | (() => Transport | null);
  /** Where replicas are persisted (localStorage in browsers). null: memory only. */
  storage: KeyValueStorage | null | (() => KeyValueStorage | null);
  /** Unique per tab, stable for its lifetime. Random by default. */
  authorKey?: string;
  getPlayerId?: () => string | null;
  timings?: Partial<SyncTimings> & { lobby?: Partial<LobbyTimings> };
  isOnline?: () => boolean;
  maxReplicas?: number;
}

/**
 * What a write proposes. A game shown in replay mode (useGame with a replay
 * cursor) is the state at an earlier turn with the live game in
 * `originalGame`: what can be written from it (chat, review comments) is
 * applied to the live game rather than rolling the game back to that turn.
 */
function writtenDocument(game: IGameState): { doc: GameDocument; source: SourceVersion | null } {
  if (game.originalGame && game.originalGame.id === game.id) {
    const live = toDocument(game.originalGame);
    const view = toDocument(game);
    return {
      doc: { ...live, messages: view.messages, reviewComments: view.reviewComments },
      source: sourceOf(game.originalGame),
    };
  }
  return { doc: toDocument(game), source: sourceOf(game) };
}

export function randomId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

export class NetworkNode {
  readonly authorKey: string;
  readonly store: ReplicaStore;
  readonly history: HistoryStore;
  readonly lobby: PublicLobby;
  readonly timings: NetworkTimings;

  private readonly syncs = new Map<string, GameSync>();
  private readonly historyRooms: HistoryRooms;
  private readonly historyWatchers = new Map<
    string,
    { refresh: () => void; stopWaiting: () => void; current: () => HistoryEntry | null }
  >();
  private departed = false;
  private readonly rejectionListeners = new Map<string, Set<(rejection: Rejection) => void>>();
  /** Games created in this tab and not opened yet: this tab is their first authority. */
  private readonly fresh = new Set<string>();
  private transport: Transport | null | undefined = undefined;

  constructor(private readonly options: NetworkNodeOptions) {
    this.authorKey = options.authorKey ?? randomId(16);
    this.timings = {
      ...DEFAULT_TIMINGS,
      ...options.timings,
      lobby: { ...DEFAULT_TIMINGS.lobby, ...options.timings?.lobby },
    };
    this.store = new ReplicaStore(() => this.resolveStorage(), options.maxReplicas);
    this.history = new HistoryStore(() => this.resolveStorage());
    this.historyRooms = new HistoryRooms(
      this.history,
      () => this.getTransport(),
      (entry) => {
        const current = this.historyWatchers.get(entry.gameId)?.current();
        if (current?.matchId !== entry.matchId || groupKey(current.group) !== groupKey(entry.group)) return entry;
        // The live game is authoritative for its own result, including a
        // rollback that happened before this browser received the old finish.
        return compareVersions(current, entry) >= 0 ? current : null;
      }
    );
    this.lobby = new PublicLobby({
      getTransport: () => this.getTransport(),
      now: () => Date.now(),
      timings: this.timings.lobby,
    });
  }

  private resolveStorage(): KeyValueStorage | null {
    const storage = this.options.storage;
    return typeof storage === "function" ? storage() : storage;
  }

  private getTransport(): Transport | null {
    if (this.transport === undefined) {
      try {
        const transport = this.options.transport;
        this.transport = typeof transport === "function" ? transport() : transport;
      } catch (e) {
        console.warn("[network] no transport available", e);
        this.transport = null;
      }
    }
    return this.transport;
  }

  private acquire(gameId: string): GameSync {
    let sync = this.syncs.get(gameId);
    if (!sync || sync.closed) {
      sync = new GameSync(
        gameId,
        {
          authorKey: this.authorKey,
          timings: this.timings,
          store: this.store,
          getTransport: () => this.getTransport(),
          getPlayerId: () => this.options.getPlayerId?.() ?? null,
          isOnline: () => {
            try {
              return this.options.isOnline ? this.options.isOnline() : true;
            } catch {
              return true;
            }
          },
          now: () => Date.now(),
          newId: () => randomId(),
          announce: (id, game) => this.lobby.announce(id, game),
          notifyRejection: (rejection) => this.notifyRejection(rejection),
          protectedGameIds: () => Array.from(this.syncs.keys()),
          onClosed: (closed) => {
            if (this.syncs.get(closed.gameId) !== closed) return;
            this.syncs.delete(closed.gameId);
            this.historyWatchers.get(closed.gameId)?.stopWaiting();
            this.historyWatchers.delete(closed.gameId);
            this.historyRooms.remove(closed.gameId);
          },
        },
        { fresh: this.fresh.has(gameId) }
      );
      this.fresh.delete(gameId);
      this.syncs.set(gameId, sync);
      sync.start();
      this.watchHistory(sync);
    }
    sync.acquire();
    return sync;
  }

  private watchHistory(sync: GameSync) {
    const { gameId } = sync;
    let game: IGameState | null = null;
    let recorded: IGameState | null = null;
    let current: HistoryEntry | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      clearTimeout(timer);
      timer = undefined;
    };

    const refresh = () => {
      stopWaiting();
      if (this.departed || sync.closed || !game) return;
      const playerId = this.options.getPlayerId?.();
      const group = game.status === IGameStatus.LOBBY ? null : seatedGroup(game);
      if (!playerId || !group?.includes(playerId)) {
        this.historyRooms.remove(gameId);
        return;
      }
      const { synced, pendingWrites, version, author } = sync.snapshot();
      const source = sourceOf(game);
      if (!synced || pendingWrites || source?.version !== version || source?.author !== author) {
        this.historyRooms.remove(gameId);
        // GameSync may settle its startup window without emitting a new replica.
        timer = setTimeout(refresh, this.timings.tickMs);
        return;
      }

      let changed: HistoryEntry[] = [];
      if (game !== recorded) {
        recorded = game;
        current = entryFromGame(game, group, { version, author });
        if (current) {
          const previous = this.history.get(entryKey(current));
          if (current.result || previous?.result) changed = this.history.merge([current]);
        }
      }
      const peers = sync
        .connectionInfo()
        .peers.filter((peer) => group.includes(peer.playerId))
        .map((peer) => peer.peerId);
      this.historyRooms.follow(gameId, isLocalGame(game) ? null : group, peers);
      this.historyRooms.publish(changed);
    };

    this.historyWatchers.set(gameId, {
      refresh,
      stopWaiting,
      current: () => (game === recorded && sync.snapshot().synced ? current : null),
    });
    sync.addGameListener((accepted) => {
      game = accepted;
      refresh();
    });
    sync.addConnectionListener(refresh);
  }

  /** Hold the game's room while `run` executes (and the grace period after). */
  private async withSync<T>(gameId: string, run: (sync: GameSync) => T | Promise<T>): Promise<T> {
    const sync = this.acquire(gameId);
    try {
      return await run(sync);
    } finally {
      sync.release();
    }
  }

  private notifyRejection(rejection: Rejection) {
    Array.from(this.rejectionListeners.get(rejection.gameId) ?? []).forEach((callback) => {
      try {
        callback(rejection);
      } catch (e) {
        console.error("[network] rejection subscriber failed", e);
      }
    });
  }

  async loadGame(gameId: string, options: { timeoutMs?: number } = {}): Promise<IGameState | null> {
    const open = this.syncs.get(gameId);
    if (open?.hasState()) {
      return open.current();
    }
    const replica = this.store.read(gameId);
    if (replica) {
      try {
        const { version, author } = replica;
        return stampSource(materialize(replica.game), { gameId, version, author });
      } catch (e) {
        console.error(`[network] could not rebuild game ${gameId}`, e);
      }
    }
    return this.withSync(gameId, (sync) => sync.waitForState(options.timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS));
  }

  subscribeToGame(gameId: string, callback: (game: IGameState) => void): () => void {
    const sync = this.acquire(gameId);
    sync.addGameListener(callback);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      sync.removeGameListener(callback);
      sync.release();
    };
  }

  async updateGame(game: IGameState | GameDocument): Promise<void> {
    if (!game?.id) return;
    const { doc, source } = writtenDocument(game as IGameState);
    await this.write(game.id, doc, (sync, written) => sync.write(written, source));
  }

  setReaction(game: IGameState, player: IPlayer, reaction: string | null): Promise<void> {
    return this.setPlayerField(game, player, "reaction", reaction);
  }

  setNotification(game: IGameState, player: IPlayer, notified: boolean): Promise<void> {
    return this.setPlayerField(game, player, "notified", notified);
  }

  async setPlayerField(
    game: IGameState,
    player: IPlayer,
    field: "reaction" | "notified",
    value: string | boolean | null
  ): Promise<void> {
    if (!game?.id || !player?.id) return;
    const fallback = toDocument({
      ...game,
      players: game.players.map((p) => (p.id === player.id ? { ...p, [field]: value } : p)),
    });
    await this.write(game.id, fallback, (sync, doc) => sync.writePlayerField(player.id, field, value, doc));
  }

  private async write(gameId: string, doc: GameDocument, run: (sync: GameSync, doc: GameDocument) => void) {
    const open = this.syncs.get(gameId);
    if (open && !open.closed) {
      run(open, doc);
      return;
    }

    if (!this.store.read(gameId)) {
      // A game created here before being opened (the new-game page creates
      // it, then navigates to it): it becomes the initial replica, and this
      // tab its first authority.
      const written = this.store.write({
        version: 1,
        author: this.authorKey,
        updatedAt: Date.now(),
        applied: [],
        game: doc,
      });
      if (written && !isLocalGame(doc)) this.fresh.add(gameId);
      if (written) return;
    }

    // A known game nobody follows in this tab: open its room for the write.
    await this.withSync(gameId, (sync) => run(sync, doc));
  }

  getConnection(gameId: string): ConnectionInfo {
    const open = this.syncs.get(gameId);
    if (open && !open.closed) {
      return open.connectionInfo();
    }
    const replica = this.store.read(gameId);
    const local = isLocalGame(replica?.game);
    return {
      gameId,
      status: local ? "local" : "connecting",
      peers: [],
      isAuthority: local,
      hasState: replica !== null,
      error: null,
    };
  }

  isAuthority(gameId: string): boolean {
    return this.getConnection(gameId).isAuthority;
  }

  subscribeToConnection(gameId: string, callback: (info: ConnectionInfo) => void): () => void {
    const sync = this.acquire(gameId);
    sync.addConnectionListener(callback);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      sync.removeConnectionListener(callback);
      sync.release();
    };
  }

  subscribeToRejections(gameId: string, callback: (rejection: Rejection) => void): () => void {
    const listeners = this.rejectionListeners.get(gameId) ?? new Set();
    listeners.add(callback);
    this.rejectionListeners.set(gameId, listeners);
    return () => {
      listeners.delete(callback);
      if (!listeners.size && this.rejectionListeners.get(gameId) === listeners) {
        this.rejectionListeners.delete(gameId);
      }
    };
  }

  subscribeToPublicGames(callback: (games: PublicGame[]) => void): () => void {
    return this.lobby.subscribe(callback);
  }

  listRecentGames(): RecentGame[] {
    return this.store
      .list()
      .map((replica) => ({
        id: replica.game.id,
        status: replica.game.status,
        playersNames: replica.game.players.map((player) => player.name),
        updatedAt: replica.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Back to visible / online / from the back-forward cache: re-join the rooms
   * left by depart(), and those where nobody is connected.
   */
  revive() {
    this.departed = false;
    this.syncs.forEach((sync) => sync.revive());
    this.historyWatchers.forEach(({ refresh }) => refresh());
    this.lobby.revive();
  }

  /**
   * The page is going away (pagehide, see ./lifecycle.ts): leave every room
   * now, saying goodbye, so that the peers drop this tab and elect a new
   * authority at once instead of when WebRTC notices (~25s). Subscriptions
   * stay; revive() joins again if the page comes back. Idempotent.
   */
  depart() {
    this.departed = true;
    this.historyWatchers.forEach(({ stopWaiting }) => stopWaiting());
    this.historyRooms.clear();
    Array.from(this.syncs.values()).forEach((sync) => {
      try {
        sync.depart();
      } catch (e) {
        console.warn(`[network] could not leave the room of ${sync.gameId}`, e);
      }
    });
    this.lobby.depart();
  }

  /** Re-evaluate connection statuses (e.g. the browser went offline). */
  refresh() {
    this.syncs.forEach((sync) => sync.refresh());
  }

  /** Internal state of an open game, for tests and debugging. */
  snapshot(gameId: string): SyncSnapshot | null {
    const sync = this.syncs.get(gameId);
    return sync && !sync.closed ? sync.snapshot() : null;
  }

  /** Games whose room this tab currently holds. */
  openGames(): string[] {
    return Array.from(this.syncs.keys());
  }

  /** Leave every room right away (tests, or a tab going away for good). */
  dispose() {
    this.historyRooms.clear();
    Array.from(this.syncs.values()).forEach((sync) => sync.close());
    this.syncs.clear();
    this.lobby.dispose();
  }
}
