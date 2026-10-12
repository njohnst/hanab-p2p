/**
 * GameSync: one game's replica and its room (docs/P2P_DESIGN.md, "Network layer").
 *
 * - Every peer keeps a full replica, persisted in localStorage.
 * - One peer is the authority: it merges writes (proposals) into its state,
 *   stamps a new `version` and broadcasts the result. Others adopt any state
 *   newer by (version, author), and send their writes to the authority.
 * - The authority is sticky. When it leaves, the remaining peers pick the
 *   state holder with the smallest authorKey; a (re)joining peer first syncs.
 *   When two authorities meet, the one holding the newer state wins and the
 *   other re-proposes the writes the winner lacks.
 * - Each state carries the ids of the proposals it includes, so re-sent
 *   proposals are idempotent and writes lost in a split brain are detected
 *   and re-proposed.
 * - A tab says `bye` before it leaves a room (the game is closed, or its page
 *   goes away: see depart()), so the others drop it and elect a new authority
 *   at once rather than when the transport notices (~25s for WebRTC).
 *
 * Transport messages are untrusted: they are validated (parseMessage) and no
 * handler lets an exception escape.
 */
import { cloneDeep, isEqual } from "lodash";
import IGameState from "~/lib/state";
import {
  GameDocument,
  isLocalGame,
  isPubliclyListed,
  materialize,
  publicSummary,
  SourceVersion,
  stampSource,
  toDocument,
  tryMaterialize,
} from "./document";
import { mergeGame } from "./merge";
import {
  AckMessage,
  GameMessage,
  HelloMessage,
  MAX_APPLIED_IDS,
  parseMessage,
  PROTOCOL,
  protocolMismatchError,
  ProposeMessage,
  RejectMessage,
  StateMessage,
} from "./protocol";
import { compareVersions, ReplicaStore, StoredReplica } from "./storage";
import { isTransportUnavailable, Transport, TransportRoom } from "./transports/types";
import { ConnectionInfo, ConnectionStatus, PublicGame, Rejection, RejectionReason } from "./types";

export interface SyncTimings {
  /** How long a tab joining with a replica waits for peers before acting alone (as the authority). */
  syncWindowMs: number;
  /** How long the room stays joined after the last subscriber leaves (React remounts, route changes). */
  graceMs: number;
  /** Hello refresh period while peers are connected (keeps versions known, recovers lost hellos). */
  helloIntervalMs: number;
  /** Re-send proposals the authority has not answered after this long. */
  retryMs: number;
  /** Claim the authority if the peer that should have claimed it did not after this long. */
  electionTimeoutMs: number;
  /** Housekeeping period. */
  tickMs: number;
  /** Retry joining the room after the transport failed. */
  rejoinDelayMs: number;
}

export interface SyncContext {
  authorKey: string;
  timings: SyncTimings;
  store: ReplicaStore;
  getTransport(): Transport | null;
  getPlayerId(): string | null;
  isOnline(): boolean;
  now(): number;
  newId(): string;
  /** Announce (or withdraw with null) the game on the public lobby. */
  announce(gameId: string, game: PublicGame | null): void;
  notifyRejection(rejection: Rejection): void;
  /** Games open in this tab: never evicted from storage. */
  protectedGameIds(): string[];
  onClosed(sync: GameSync): void;
}

interface Hello {
  authorKey: string;
  playerId: string | null;
  version: number;
  author: string;
  hasState: boolean;
  isAuthority: boolean;
  /** authorKey of the authority the peer follows (its own when it is the authority). */
  following: string | null;
}

interface Peer {
  peerId: string;
  hello: Hello | null;
  /** Speaks another protocol: ignored, and reported. */
  incompatible: boolean;
}

interface Claim {
  version: number;
  author: string;
  key: string;
}

/** A write: our own (until the network has it), or one this tab applied as the authority. */
interface WriteEntry {
  id: string;
  base: GameDocument;
  baseVersion: number;
  proposed: GameDocument;
  own: boolean;
  status: "pending" | "applied";
  appliedVersion: number | null;
  sentAt: number | null;
  sentTo: string | null;
  deferred: boolean;
}

/** Most writes kept for re-proposal after a split brain, and how many of them may be other peers'. */
const MAX_WRITES = 200;
const MAX_FOREIGN_WRITES = 50;
/** Recent states kept to resolve the base of a write made from a game the UI had not refreshed yet. */
const RECENT_STATES = 32;
const KNOWN_REASONS: RejectionReason[] = ["turn-conflict", "game-full", "game-started", "wrong-game", "invalid"];

/** `a` beats `b` for the authority: newer state, then smaller key. */
function claimBeats(a: Claim, b: Claim): boolean {
  const cmp = compareVersions(a, b);
  if (cmp !== 0) {
    return cmp > 0;
  }
  return a.key < b.key;
}

function claimOf(hello: Hello): Claim {
  return { version: hello.version, author: hello.author, key: hello.authorKey };
}

/** Insertion-ordered map that forgets its oldest keys. */
class RecentMap<V> {
  private map = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}

export interface SyncSnapshot {
  version: number;
  author: string;
  applied: string[];
  isAuthority: boolean;
  synced: boolean;
  pendingWrites: number;
  authorityPeerId: string | null;
}

export class GameSync {
  readonly gameId: string;
  closed = false;

  private replica: StoredReplica | null = null;
  private local = false;
  private room: TransportRoom | null = null;
  private joinGen = 0;
  private joinedAt = 0;
  private joinError: string | null = null;
  private syncWindowOver = false;
  private synced: boolean;
  private authority = false;
  private authorityPeerId: string | null = null;
  private noAuthoritySince: number | null = null;
  private peers = new Map<string, Peer>();
  private lastHelloAt = 0;
  private protocolError: string | null = null;
  /** The page went away (depart()): out of the room until revive(). */
  private departed = false;
  private resumedAt: number | null = null;

  private recent: StoredReplica[] = [];
  private writes = new Map<string, WriteEntry>();
  private rejected = new RecentMap<RejectionReason>(256);
  private acked = new RecentMap<true>(256);
  private deferred: Array<{ entry: WriteEntry; peerId: string; at: number }> = [];

  private gameListeners = new Set<(game: IGameState) => void>();
  private connectionListeners = new Set<(info: ConnectionInfo) => void>();
  private stateWaiters = new Set<() => void>();
  private lastConnection: ConnectionInfo | null = null;
  private settledEmitVersion = -1;
  private broadcastScheduled = false;

  private refs = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * `fresh`: the game was just created in this tab, so nobody else can hold a
   * newer state and it is the authority right away.
   */
  constructor(gameId: string, private readonly ctx: SyncContext, options: { fresh?: boolean } = {}) {
    this.gameId = gameId;
    this.synced = !!options.fresh;
  }

  start() {
    const stored = this.ctx.store.read(this.gameId);
    if (stored) this.setReplica(stored);
    if (this.replica && isLocalGame(this.replica.game)) {
      this.becomeLocal();
      return;
    }
    this.tickTimer = setInterval(() => this.tick(), this.ctx.timings.tickMs);
    this.joinRoom();
  }

  /* ------------------------------------------------------------------ */
  /* Subscribers and reference counting                                  */
  /* ------------------------------------------------------------------ */

  acquire() {
    this.refs++;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  /** The room is left `graceMs` after the last reference goes, unless one comes back. */
  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0 && !this.closed && !this.closeTimer) {
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        if (this.refs === 0) this.close();
      }, this.ctx.timings.graceMs);
    }
  }

  addGameListener(callback: (game: IGameState) => void) {
    this.gameListeners.add(callback);
    queueMicrotask(() => {
      if (this.closed || !this.replica || !this.gameListeners.has(callback)) return;
      const game = this.materializeSafe();
      if (game) this.deliver(callback, game);
    });
  }

  removeGameListener(callback: (game: IGameState) => void) {
    this.gameListeners.delete(callback);
  }

  addConnectionListener(callback: (info: ConnectionInfo) => void) {
    this.connectionListeners.add(callback);
    queueMicrotask(() => {
      if (this.closed || !this.connectionListeners.has(callback)) return;
      try {
        callback(this.connectionInfo());
      } catch (e) {
        console.error("[network] connection subscriber failed", e);
      }
    });
  }

  removeConnectionListener(callback: (info: ConnectionInfo) => void) {
    this.connectionListeners.delete(callback);
  }

  hasState(): boolean {
    return this.replica !== null;
  }

  /** The current game, rebuilt; null without a replica. */
  current(): IGameState | null {
    return this.replica ? this.materializeSafe() : null;
  }

  /** Resolves with the game once a replica exists, or null after `timeoutMs`. */
  waitForState(timeoutMs: number): Promise<IGameState | null> {
    if (this.replica) {
      return Promise.resolve(this.materializeSafe());
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.stateWaiters.delete(done);
        resolve(this.replica ? this.materializeSafe() : null);
      };
      const timer = setTimeout(done, timeoutMs);
      this.stateWaiters.add(done);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Connection                                                          */
  /* ------------------------------------------------------------------ */

  connectionInfo(): ConnectionInfo {
    return {
      gameId: this.gameId,
      status: this.status(),
      peers: this.visiblePeers().map((peer) => ({ peerId: peer.peerId, playerId: peer.hello?.playerId ?? null })),
      isAuthority: this.local || this.authority,
      hasState: this.replica !== null,
      error: this.protocolError ?? (!this.room ? this.joinError : null),
    };
  }

  isAuthority(): boolean {
    return this.local || this.authority;
  }

  /** Internal state, for tests and debugging. */
  snapshot(): SyncSnapshot {
    return {
      version: this.replica?.version ?? 0,
      author: this.replica?.author ?? "",
      applied: [...(this.replica?.applied ?? [])],
      isAuthority: this.isAuthority(),
      synced: this.synced,
      pendingWrites: Array.from(this.writes.values()).filter((entry) => entry.status === "pending").length,
      authorityPeerId: this.authorityPeerId,
    };
  }

  private status(): ConnectionStatus {
    if (this.local) return "local";
    if (!this.ctx.isOnline()) return "offline";
    if (this.visiblePeers().length) return "connected";
    if (!this.room && this.joinError) return "offline";
    if (this.room && this.syncWindowOver) return "alone";
    return "connecting";
  }

  /**
   * Back to visible / online / from the back-forward cache: re-join the room
   * left by depart(), or if nobody is connected (mobile browsers drop WebRTC).
   */
  revive() {
    if (this.closed || this.local) return;
    if (this.departed) {
      this.resume();
    } else if (this.visiblePeers().length) {
      this.broadcastHello();
    } else if (!this.justResumed()) {
      this.rejoin();
    }
    this.emitConnection();
  }

  /**
   * The page is going away (pagehide): say goodbye and leave the room now, so
   * that the peers drop this tab and hand the authority over at once. The
   * subscribers stay: if the page comes back (back/forward cache, cancelled
   * navigation), revive() joins again and syncs like a newcomer. A game only
   * kept for its grace period is closed instead.
   */
  depart() {
    if (this.closed || this.local || this.departed) return;
    if (this.refs === 0) {
      this.close();
      return;
    }
    this.sayGoodbye();
    this.departed = true;
    // The others carry on without us (and may move on): come back as a
    // follower that syncs first.
    this.authority = false;
    this.synced = false;
    this.deferred = [];
    this.noAuthoritySince = null;
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
    this.leaveRoom();
    this.updateAnnouncement();
    this.emitConnection();
  }

  private resume() {
    this.departed = false;
    this.resumedAt = this.ctx.now();
    this.joinRoom();
  }

  /**
   * The room was re-joined after a departure moments ago and is still
   * connecting: a restored page gets both pageshow and visibilitychange, and
   * the second must not restart the join.
   */
  private justResumed(): boolean {
    return (
      this.resumedAt !== null && !this.joinError && this.ctx.now() - this.resumedAt < this.ctx.timings.syncWindowMs
    );
  }

  /** Re-evaluate the connection (e.g. the browser went offline). */
  refresh() {
    this.emitConnection();
  }

  private becomeLocal() {
    this.local = true;
    this.authority = true;
    this.synced = true;
    this.leaveRoom();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.ctx.announce(this.gameId, null);
    this.emitConnection();
  }

  private joinRoom() {
    if (this.closed || this.local || this.departed) return;

    const gen = ++this.joinGen;
    this.peers.clear();
    this.authorityPeerId = null;
    this.syncWindowOver = false;
    this.joinedAt = this.ctx.now();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.onSyncWindowOver(gen), this.ctx.timings.syncWindowMs);

    const transport = this.ctx.getTransport();
    if (!transport) {
      this.joinError = "No network is available.";
      this.recomputeAuthority();
      this.emitConnection();
      return;
    }

    this.joinError = null;
    const live = () => gen === this.joinGen && !this.closed;
    const handlers = {
      onMessage: (data: unknown, peerId: string) => live() && this.onMessage(data, peerId),
      onPeerJoin: (peerId: string) => live() && this.guard(() => this.onPeerJoin(peerId)),
      onPeerLeave: (peerId: string) => live() && this.guard(() => this.onPeerLeave(peerId)),
      onError: (error: string) => live() && console.warn(`[network] ${this.gameId}: ${error}`),
    };

    let joined: Promise<TransportRoom>;
    try {
      joined = transport.join(this.gameId, { password: this.gameId }, handlers);
    } catch (e) {
      joined = Promise.reject(e);
    }

    joined.then(
      (room) => {
        if (!live()) {
          room.leave().catch(() => undefined);
          return;
        }
        this.room = room;
        this.emitConnection();
      },
      (error) => {
        if (!live()) return;
        console.warn(`[network] could not join the room of ${this.gameId}`, error);
        const unavailable = isTransportUnavailable(error);
        this.joinError = unavailable
          ? error.message
          : "Could not reach the other players (signaling relays unavailable).";
        this.emitConnection();
        if (!unavailable) {
          // Relays may come back: try again later (or when the page is visible / online again).
          if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
          this.rejoinTimer = setTimeout(() => this.rejoin(), this.ctx.timings.rejoinDelayMs);
        }
      }
    );

    this.recomputeAuthority();
    this.emitConnection();
  }

  private leaveRoom() {
    this.joinGen++;
    const room = this.room;
    this.room = null;
    this.peers.clear();
    this.authorityPeerId = null;
    // Reported for peers of this room only: they are gone.
    this.protocolError = null;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    room?.leave().catch(() => undefined);
  }

  private rejoin() {
    if (this.closed || this.local || this.departed) return;
    this.leaveRoom();
    this.joinRoom();
  }

  private onSyncWindowOver(gen: number) {
    if (gen !== this.joinGen || this.closed) return;
    this.guard(() => {
      this.syncWindowOver = true;
      if (!this.synced && !this.visiblePeers().length) {
        // Nobody answered: our replica is the best there is.
        this.synced = true;
      }
      this.recomputeAuthority();
      this.emitConnection();
    });
  }

  private tick() {
    if (this.closed || this.local || this.departed) return;
    this.guard(() => {
      const now = this.ctx.now();
      if (this.room && this.peers.size && now - this.lastHelloAt >= this.ctx.timings.helloIntervalMs) {
        this.broadcastHello();
      }
      if (
        !this.synced &&
        this.replica &&
        this.syncWindowOver &&
        now - this.joinedAt >= this.ctx.timings.syncWindowMs + this.ctx.timings.electionTimeoutMs
      ) {
        // Peers are there but never brought a newer state: stop waiting for them.
        this.synced = true;
      }
      this.sendPending();
      this.processDeferred();
      this.recomputeAuthority();
      this.emitConnection();
    });
  }

  close() {
    if (this.closed) return;
    this.sayGoodbye();
    this.closed = true;
    [this.closeTimer, this.syncTimer, this.rejoinTimer].forEach((timer) => timer && clearTimeout(timer));
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.ctx.announce(this.gameId, null);
    this.leaveRoom();
    Array.from(this.stateWaiters).forEach((resolve) => resolve());
    this.gameListeners.clear();
    this.connectionListeners.clear();
    this.ctx.onClosed(this);
  }

  /** Before leaving the room: the last state the others may lack, then `bye`. */
  private sayGoodbye() {
    if (!this.room) return;
    if (this.broadcastScheduled && this.peers.size) {
      // A write applied just before leaving must still reach the others.
      const message = this.stateMessage();
      if (message) this.send(message);
    }
    this.send({ type: "bye", protocol: PROTOCOL, gameId: this.gameId });
  }

  /* ------------------------------------------------------------------ */
  /* Local writes                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Propose a new state. `source` is the version the writer's game was built
   * from (see SourceVersion): only what the writer changed relative to it is
   * applied. Without it, or when it is too old, the current replica is the base.
   */
  write(proposed: GameDocument, source: SourceVersion | null = null) {
    if (this.closed) return;
    if (!this.replica) {
      this.createInitial(proposed);
      return;
    }

    const base = this.baseFor(source);
    const entry: WriteEntry = {
      id: this.ctx.newId(),
      base: base.game,
      baseVersion: base.version,
      proposed,
      own: true,
      status: "pending",
      appliedVersion: null,
      sentAt: null,
      sentTo: null,
      deferred: false,
    };
    this.writes.set(entry.id, entry);

    if (this.isAuthority()) {
      this.applyProposal(entry, null);
    } else {
      this.sendPending([entry]);
    }
    this.emitConnection();
  }

  /**
   * Change one field of one player on top of the latest replica, whatever
   * game object the caller holds: reactions and notifications are never lost
   * to (or never revert) concurrent updates.
   */
  writePlayerField(playerId: string, field: "reaction" | "notified", value: unknown, fallback: GameDocument) {
    const replica = this.replica;
    const player = replica?.game.players.find((p) => p.id === playerId);
    if (!replica || !player) {
      this.write(fallback);
      return;
    }

    const normalized = value === null ? undefined : value;
    const hasPending = Array.from(this.writes.values()).some((entry) => entry.own && entry.status === "pending");
    if (isEqual(player[field], normalized) && !hasPending) {
      return;
    }

    const proposed = cloneDeep(replica.game);
    const target = proposed.players.find((p) => p.id === playerId);
    if (normalized === undefined) {
      delete target[field];
    } else {
      target[field as string] = normalized;
    }
    this.write(proposed);
  }

  private baseFor(source: SourceVersion | null): StoredReplica {
    const replica = this.replica;
    if (!source || source.gameId !== this.gameId) return replica;
    if (source.version === replica.version && source.author === replica.author) return replica;
    const seen = this.recent.find((state) => state.version === source.version && state.author === source.author);
    return seen ?? replica;
  }

  private setReplica(next: StoredReplica) {
    this.replica = next;
    this.recent.push(next);
    if (this.recent.length > RECENT_STATES) this.recent.shift();
  }

  /** The first replica of a game (created in this tab): version 1, this tab is its authority. */
  private createInitial(doc: GameDocument) {
    this.setReplica({ version: 1, author: this.ctx.authorKey, updatedAt: this.ctx.now(), applied: [], game: doc });
    this.synced = true;
    this.persist();
    if (isLocalGame(doc)) {
      this.becomeLocal();
    } else {
      this.recomputeAuthority();
      this.broadcastHello();
      this.scheduleBroadcast();
    }
    this.emitGame();
    this.resolveWaiters();
    this.updateAnnouncement();
    this.emitConnection();
  }

  /* ------------------------------------------------------------------ */
  /* Authority                                                           */
  /* ------------------------------------------------------------------ */

  private myClaim(): Claim {
    return { version: this.replica?.version ?? 0, author: this.replica?.author ?? "", key: this.ctx.authorKey };
  }

  private recomputeAuthority() {
    if (this.closed || this.departed) return;
    if (this.local) {
      this.authority = true;
      return;
    }
    if (!this.replica) {
      this.authority = false;
    }

    const claimants = this.compatiblePeers().filter((peer) => peer.hello.isAuthority);

    if (this.authority && claimants.some((peer) => claimBeats(claimOf(peer.hello), this.myClaim()))) {
      this.stepDown();
    }

    if (this.authority) {
      this.authorityPeerId = null;
      this.noAuthoritySince = null;
      return;
    }

    let best: Peer | null = null;
    claimants.forEach((peer) => {
      if (!best || claimBeats(claimOf(peer.hello), claimOf(best.hello))) best = peer;
    });

    if (best) {
      this.noAuthoritySince = null;
    } else if (this.replica && this.synced) {
      this.elect();
      if (this.authority) return;
    }

    const bestId = best ? (best as Peer).peerId : null;
    if (bestId !== this.authorityPeerId) {
      this.authorityPeerId = bestId;
      // Tell the others whom we follow now (it steers their elections).
      this.broadcastHello();
      if (bestId) this.sendPending();
    }
  }

  /** No connected peer claims the authority: claim it if we are alone or the elected state holder. */
  private elect() {
    const known = this.compatiblePeers();
    const unknown = this.visiblePeers().filter((peer) => !peer.hello);
    if (!known.length && !unknown.length) {
      this.claim();
      return;
    }

    const ahead = known.some((peer) => compareVersions(peer.hello, this.replica) > 0);
    // A peer follows an authority we are not connected to (yet): it is not ours to elect one.
    const elsewhere = known.some((peer) => peer.hello.following && peer.hello.following !== this.ctx.authorKey);
    const keys = [
      this.ctx.authorKey,
      ...known.filter((peer) => peer.hello.hasState).map((peer) => peer.hello.authorKey),
    ];
    const elected = keys.sort()[0];
    if (!ahead && !elsewhere && !unknown.length && elected === this.ctx.authorKey) {
      this.claim();
      return;
    }

    // Someone else should claim it (or bring a newer state) shortly; take over if they never do.
    const now = this.ctx.now();
    if (this.noAuthoritySince === null) {
      this.noAuthoritySince = now;
    } else if (now - this.noAuthoritySince >= this.ctx.timings.electionTimeoutMs) {
      this.claim();
    }
  }

  private claim() {
    if (this.authority || !this.replica || this.closed || this.departed) return;
    this.authority = true;
    this.authorityPeerId = null;
    this.noAuthoritySince = null;
    this.broadcastHello();
    this.scheduleBroadcast();
    // Writes made while following a previous authority (or while alone) are ours to apply now.
    Array.from(this.writes.values())
      .filter((entry) => entry.status === "pending")
      .forEach((entry) => this.applyProposal(entry, null));
    this.processDeferred(true);
    this.updateAnnouncement();
  }

  private stepDown() {
    if (!this.authority) return;
    this.authority = false;
    this.deferred = [];
    this.broadcastHello();
    this.updateAnnouncement();
  }

  /**
   * Apply a write as the authority. `origin` is the peer that proposed it
   * (null for this tab's own writes and re-proposals).
   */
  private applyProposal(entry: WriteEntry, origin: string | null) {
    const replica = this.replica;
    if (!replica) return;
    const id = entry.id;

    if (replica.applied.includes(id)) {
      entry.status = "applied";
      if (origin) this.sendState(origin);
      return;
    }
    const rejection = this.rejected.get(id);
    if (rejection) {
      this.writes.delete(id);
      if (origin) this.sendReject(origin, id, rejection);
      return;
    }
    if (this.acked.has(id)) {
      this.writes.delete(id);
      if (origin) this.sendAck(origin, id);
      return;
    }
    if (origin && entry.baseVersion > replica.version && !entry.deferred) {
      // The writer saw a state newer than ours: catch up first. Our hello
      // makes it send its state; the proposal is applied when that arrives.
      entry.deferred = true;
      this.deferred.push({ entry, peerId: origin, at: this.ctx.now() });
      this.sendHello(origin);
      return;
    }

    const result = mergeGame(entry.base, replica.game, entry.proposed);
    if (result.ok === false) {
      this.refuse(entry, origin, result.reason);
      return;
    }
    if (!result.changed) {
      this.acked.set(id, true);
      this.writes.delete(id);
      if (origin) {
        this.sendAck(origin, id);
      } else if (entry.own) {
        this.onOwnWriteSettled();
      }
      return;
    }
    if (!tryMaterialize(result.game)) {
      this.refuse(entry, origin, "invalid");
      return;
    }

    entry.status = "applied";
    entry.appliedVersion = replica.version + 1;
    entry.sentAt = null;
    // Kept so that it can be re-proposed if another authority's state wins.
    this.writes.set(id, entry);
    this.pruneWrites();

    this.setReplica({
      version: replica.version + 1,
      author: this.ctx.authorKey,
      updatedAt: this.ctx.now(),
      applied: [...replica.applied, id].slice(-MAX_APPLIED_IDS),
      game: result.game,
    });
    this.persist();
    this.emitGame();
    this.resolveWaiters();
    this.scheduleBroadcast();
    this.updateAnnouncement();
  }

  private refuse(entry: WriteEntry, origin: string | null, reason: RejectionReason) {
    this.rejected.set(entry.id, reason);
    this.writes.delete(entry.id);
    if (origin) {
      this.sendReject(origin, entry.id, reason);
      this.sendState(origin);
    } else if (entry.own) {
      this.onOwnRejected(entry.id, reason);
    }
  }

  private onOwnRejected(proposalId: string, reason: RejectionReason) {
    // The UI may show an optimistic state: give it the authoritative one right away.
    this.emitGame();
    try {
      this.ctx.notifyRejection({ gameId: this.gameId, proposalId, reason });
    } catch (e) {
      console.error("[network] rejection subscriber failed", e);
    }
  }

  /**
   * One of our writes changed nothing. Re-deliver the current state once per
   * version so that an optimistic (synced: false) copy in the UI is replaced,
   * without feeding loops of effects that write on every delivery.
   */
  private onOwnWriteSettled() {
    if (this.replica && this.settledEmitVersion !== this.replica.version) {
      this.settledEmitVersion = this.replica.version;
      this.emitGame();
    }
  }

  private processDeferred(force = false) {
    if (!this.deferred.length) return;
    if (!this.authority || !this.replica) {
      // Their writers will re-send them to the new authority.
      this.deferred = [];
      return;
    }
    const now = this.ctx.now();
    const due = this.deferred.filter(
      (item) => force || item.entry.baseVersion <= this.replica.version || now - item.at >= this.ctx.timings.retryMs
    );
    this.deferred = this.deferred.filter((item) => !due.includes(item));
    due.forEach((item) => this.applyProposal(item.entry, item.peerId));
  }

  /** Send our pending writes to the authority (all of `entries`, or those not sent there recently). */
  private sendPending(entries?: WriteEntry[]) {
    if (this.isAuthority() || !this.room) return;
    const target = this.authorityPeerId;
    if (!target) return;

    const now = this.ctx.now();
    const list =
      entries ??
      Array.from(this.writes.values()).filter(
        (entry) => entry.sentAt === null || entry.sentTo !== target || now - entry.sentAt >= this.ctx.timings.retryMs
      );

    list
      .filter((entry) => entry.status === "pending")
      .forEach((entry) => {
        const message: ProposeMessage = {
          type: "propose",
          protocol: PROTOCOL,
          gameId: this.gameId,
          authorKey: this.ctx.authorKey,
          proposalId: entry.id,
          baseVersion: entry.baseVersion,
          base: entry.base,
          proposed: entry.proposed,
        };
        this.send(message, target);
        entry.sentAt = now;
        entry.sentTo = target;
      });
  }

  private pruneWrites() {
    const entries = Array.from(this.writes.values());
    let foreign = entries.filter((entry) => !entry.own && entry.status === "applied").length;
    // Oldest first; pending writes are never dropped.
    entries.forEach((entry) => {
      if (entry.status !== "applied") return;
      if (this.writes.size > MAX_WRITES || (!entry.own && foreign > MAX_FOREIGN_WRITES)) {
        this.writes.delete(entry.id);
        if (!entry.own) foreign--;
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* States                                                              */
  /* ------------------------------------------------------------------ */

  /** Replace the replica with a newer one received from a peer. */
  private adopt(next: StoredReplica) {
    this.setReplica(next);
    this.persist();
    const lost = this.reconcileWrites(next);
    this.emitGame();
    this.resolveWaiters();
    if (lost.length) {
      if (this.authority) {
        lost.forEach((entry) => this.applyProposal(entry, null));
      } else {
        this.sendPending(lost);
      }
    }
    this.processDeferred();
    this.updateAnnouncement();
  }

  /**
   * Mark the writes `next` includes as applied, and return those it lost
   * (applied in our previous state but not in this one: a split brain the
   * other side won), which must be proposed again.
   */
  private reconcileWrites(next: StoredReplica): WriteEntry[] {
    const index = new Map(next.applied.map((id, i) => [id, i] as [string, number]));
    const truncated = next.applied.length >= MAX_APPLIED_IDS;
    const floor = next.version - next.applied.length + 1;
    const lost: WriteEntry[] = [];

    this.writes.forEach((entry, id) => {
      const position = index.get(id);
      if (position !== undefined) {
        entry.status = "applied";
        entry.appliedVersion = next.version - (next.applied.length - 1 - position);
        return;
      }
      if (entry.status !== "applied") return;
      if (truncated && entry.appliedVersion !== null && entry.appliedVersion < floor) {
        // Older than the ids the state carries: assume it is in.
        return;
      }
      entry.status = "pending";
      entry.sentAt = null;
      lost.push(entry);
    });

    this.pruneWrites();
    return lost;
  }

  private checkSynced() {
    if (this.synced || !this.replica) return;
    const known = this.compatiblePeers();
    if (known.length && known.every((peer) => compareVersions(this.replica, peer.hello) >= 0)) {
      this.synced = true;
    }
  }

  private persist() {
    if (!this.replica) return;
    try {
      this.ctx.store.write(this.replica, this.ctx.protectedGameIds());
    } catch (e) {
      console.warn("[network] could not persist the game", e);
    }
  }

  private updateAnnouncement() {
    const replica = this.replica;
    const listed = !this.closed && !this.local && this.authority && replica && isPubliclyListed(replica.game);
    try {
      this.ctx.announce(this.gameId, listed ? publicSummary(replica.game) : null);
    } catch (e) {
      console.warn("[network] could not update the public lobby", e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Incoming messages                                                   */
  /* ------------------------------------------------------------------ */

  private guard(run: () => void) {
    try {
      run();
    } catch (e) {
      console.warn(`[network] ${this.gameId}: error handling a network event`, e);
    }
  }

  private visiblePeers(): Peer[] {
    return Array.from(this.peers.values()).filter((peer) => !peer.incompatible);
  }

  /** Peers we can talk to and whose hello we have. */
  private compatiblePeers(): Array<Peer & { hello: Hello }> {
    return this.visiblePeers().filter((peer): peer is Peer & { hello: Hello } => peer.hello !== null);
  }

  private ensurePeer(peerId: string): Peer {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { peerId, hello: null, incompatible: false };
      this.peers.set(peerId, peer);
      this.sendHello(peerId);
    }
    return peer;
  }

  private onPeerJoin(peerId: string) {
    if (this.peers.has(peerId)) {
      this.sendHello(peerId);
    } else {
      this.ensurePeer(peerId);
    }
    this.emitConnection();
  }

  private onPeerLeave(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (peer.incompatible && !Array.from(this.peers.values()).some((p) => p.incompatible)) {
      this.protocolError = null;
    }
    if (peer.hello?.isAuthority) {
      // Share our version for the election of the next authority.
      this.broadcastHello();
    }
    this.recomputeAuthority();
    this.emitConnection();
  }

  private onMessage(data: unknown, peerId: string) {
    this.guard(() => {
      const parsed = parseMessage(data);
      if (parsed.kind === "protocol-mismatch") {
        const peer = this.ensurePeer(peerId);
        peer.incompatible = true;
        peer.hello = null;
        this.protocolError = protocolMismatchError(parsed.protocol);
        this.recomputeAuthority();
        this.emitConnection();
        return;
      }
      if (parsed.kind !== "ok") return;

      const message = parsed.message;
      if (message.type === "public-game" || message.gameId !== this.gameId) return;
      if (message.type === "bye") {
        // It is leaving the room: same as the transport reporting it gone, only sooner.
        this.onPeerLeave(peerId);
        return;
      }
      const peer = this.ensurePeer(peerId);
      if (peer.incompatible) return;

      this.handle(peer, message);
      this.emitConnection();
    });
  }

  private handle(peer: Peer, message: GameMessage) {
    switch (message.type) {
      case "hello":
        this.handleHello(peer, message);
        break;
      case "state":
        this.handleState(peer, message);
        break;
      case "propose":
        this.handlePropose(peer, message);
        break;
      case "ack":
        this.handleAck(peer, message);
        break;
      case "reject":
        this.handleReject(peer, message);
        break;
    }
  }

  private handleHello(peer: Peer, message: HelloMessage) {
    peer.hello = {
      authorKey: message.authorKey,
      playerId: message.playerId ?? null,
      version: message.version,
      author: message.author,
      hasState: message.hasState,
      isAuthority: message.isAuthority,
      following: message.following ?? null,
    };

    // Anti-entropy: whoever holds the newer state sends it.
    if (this.replica && (!message.hasState || compareVersions(this.replica, message) > 0)) {
      this.sendState(peer.peerId);
    }
    // Two authorities: the loser must learn about our claim to step down.
    if (this.authority && message.isAuthority && claimBeats(this.myClaim(), claimOf(peer.hello))) {
      this.sendHello(peer.peerId);
    }

    this.checkSynced();
    this.recomputeAuthority();
  }

  private handleState(peer: Peer, message: StateMessage) {
    const incoming: StoredReplica = {
      version: message.version,
      author: message.author,
      updatedAt: this.ctx.now(),
      applied: message.applied.slice(-MAX_APPLIED_IDS),
      game: toDocument(message.game),
    };
    if (incoming.game.id !== this.gameId) return;

    const cmp = this.replica ? compareVersions(incoming, this.replica) : 1;
    // Local games are never shared; states that cannot be rebuilt are ignored
    // (and do not count as the peer's version either).
    if (cmp > 0 && (isLocalGame(incoming.game) || !tryMaterialize(incoming.game))) return;

    peer.hello = {
      authorKey: message.authorKey,
      playerId: peer.hello?.playerId ?? null,
      version: message.version,
      author: message.author,
      hasState: true,
      isAuthority: message.isAuthority,
      following: message.isAuthority ? message.authorKey : peer.hello?.following ?? null,
    };

    if (cmp > 0) {
      if (this.authority && message.isAuthority) {
        // Two authorities met and theirs holds the newer state: follow it, and
        // re-propose there whatever of ours it lacks.
        this.authorityPeerId = peer.peerId;
        this.stepDown();
      }
      this.adopt(incoming);
    } else if (cmp < 0) {
      this.sendState(peer.peerId);
    }

    this.checkSynced();
    this.recomputeAuthority();
  }

  private handlePropose(peer: Peer, message: ProposeMessage) {
    const proposed = toDocument(message.proposed);
    if (proposed.id !== this.gameId) return;

    if (!this.authority || !this.replica) {
      // Sent to us as the authority, which we are not (or no longer): our
      // hello lets the writer route it to the right peer.
      this.sendHello(peer.peerId);
      return;
    }

    const known = this.writes.get(message.proposalId);
    const entry: WriteEntry = known ?? {
      id: message.proposalId,
      base: toDocument(message.base),
      baseVersion: message.baseVersion,
      proposed,
      own: false,
      status: "pending",
      appliedVersion: null,
      sentAt: null,
      sentTo: null,
      deferred: false,
    };
    this.applyProposal(entry, peer.peerId);
  }

  private handleAck(peer: Peer, message: AckMessage) {
    if (!peer.hello?.isAuthority) return;
    const entry = this.writes.get(message.proposalId);
    if (!entry || entry.status !== "pending") return;
    this.writes.delete(message.proposalId);
    if (entry.own) this.onOwnWriteSettled();
  }

  private handleReject(peer: Peer, message: RejectMessage) {
    if (!peer.hello?.isAuthority) return;
    const entry = this.writes.get(message.proposalId);
    if (!entry || entry.status !== "pending") return;
    this.writes.delete(message.proposalId);
    this.rejected.set(message.proposalId, this.reason(message.reason));
    if (entry.own) this.onOwnRejected(entry.id, this.reason(message.reason));
  }

  private reason(value: string): RejectionReason {
    return KNOWN_REASONS.includes(value as RejectionReason) ? (value as RejectionReason) : "invalid";
  }

  /* ------------------------------------------------------------------ */
  /* Outgoing messages                                                   */
  /* ------------------------------------------------------------------ */

  private send(message: GameMessage, target?: string) {
    if (!this.room) return;
    try {
      this.room.send(message, target);
    } catch (e) {
      console.warn("[network] could not send", e);
    }
  }

  private helloMessage(): HelloMessage {
    let playerId: string | null = null;
    try {
      playerId = this.ctx.getPlayerId();
    } catch {
      playerId = null;
    }
    return {
      type: "hello",
      protocol: PROTOCOL,
      gameId: this.gameId,
      authorKey: this.ctx.authorKey,
      playerId,
      version: this.replica?.version ?? 0,
      author: this.replica?.author ?? "",
      hasState: this.replica !== null,
      isAuthority: this.authority,
      following: this.followingKey(),
    };
  }

  private followingKey(): string | null {
    if (this.authority) return this.ctx.authorKey;
    const followed = this.authorityPeerId ? this.peers.get(this.authorityPeerId) : null;
    return followed?.hello?.authorKey ?? null;
  }

  private sendHello(peerId: string) {
    this.send(this.helloMessage(), peerId);
  }

  private broadcastHello() {
    this.lastHelloAt = this.ctx.now();
    this.send(this.helloMessage());
  }

  private stateMessage(): StateMessage | null {
    if (!this.replica) return null;
    return {
      type: "state",
      protocol: PROTOCOL,
      gameId: this.gameId,
      authorKey: this.ctx.authorKey,
      version: this.replica.version,
      author: this.replica.author,
      applied: this.replica.applied,
      game: this.replica.game,
      isAuthority: this.authority,
    };
  }

  private sendState(peerId: string) {
    const message = this.stateMessage();
    if (message) this.send(message, peerId);
  }

  /** Broadcast the state once the current burst of changes is over. */
  private scheduleBroadcast() {
    if (this.broadcastScheduled) return;
    this.broadcastScheduled = true;
    queueMicrotask(() => {
      this.broadcastScheduled = false;
      if (this.closed || !this.room || !this.peers.size) return;
      const message = this.stateMessage();
      if (message) this.send(message);
    });
  }

  private sendAck(peerId: string, proposalId: string) {
    this.send({ type: "ack", protocol: PROTOCOL, gameId: this.gameId, proposalId }, peerId);
  }

  private sendReject(peerId: string, proposalId: string, reason: RejectionReason) {
    this.send({ type: "reject", protocol: PROTOCOL, gameId: this.gameId, proposalId, reason }, peerId);
  }

  /* ------------------------------------------------------------------ */
  /* Delivery to the UI                                                  */
  /* ------------------------------------------------------------------ */

  /** The current game rebuilt for delivery, stamped with its version (see SourceVersion). */
  private materializeSafe(): IGameState | null {
    try {
      const { version, author, game } = this.replica;
      return stampSource(materialize(game), { gameId: this.gameId, version, author });
    } catch (e) {
      console.error(`[network] could not rebuild game ${this.gameId}`, e);
      return null;
    }
  }

  private deliver(callback: (game: IGameState) => void, game: IGameState) {
    try {
      callback(game);
    } catch (e) {
      console.error("[network] game subscriber failed", e);
    }
  }

  private emitGame() {
    if (!this.replica || !this.gameListeners.size) return;
    const game = this.materializeSafe();
    if (!game) return;
    // Subscribers may mutate what they get: each one gets its own copy.
    Array.from(this.gameListeners).forEach((callback, i) => this.deliver(callback, i === 0 ? game : cloneDeep(game)));
  }

  private emitConnection() {
    if (this.closed) return;
    const info = this.connectionInfo();
    if (isEqual(info, this.lastConnection)) return;
    this.lastConnection = info;
    Array.from(this.connectionListeners).forEach((callback) => {
      try {
        callback(info);
      } catch (e) {
        console.error("[network] connection subscriber failed", e);
      }
    });
  }

  private resolveWaiters() {
    Array.from(this.stateWaiters).forEach((resolve) => resolve());
  }
}
