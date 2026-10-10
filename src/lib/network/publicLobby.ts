/**
 * Public rooms (docs/P2P_DESIGN.md, "Public rooms").
 *
 * The authority of each public network game in its lobby (with seats left)
 * joins a shared room, `public-lobby`, and announces a PublicGame summary
 * every ~10s; the "Join a room" page listens there. Entries expire ~30s
 * after their last announcement, and are withdrawn at once when the game
 * starts, fills up, turns private, or its authority leaves. Private games are
 * never announced. The room is only joined while something announces or
 * listens.
 */
import { isEqual } from "lodash";
import { parseMessage, PROTOCOL, PublicGameMessage } from "./protocol";
import { Transport, TransportRoom } from "./transports/types";
import { PublicGame } from "./types";

export const PUBLIC_LOBBY_ROOM = "public-lobby";

export interface LobbyTimings {
  announceIntervalMs: number;
  expireMs: number;
  /** Stay in the room this long after the last announcer/listener goes. */
  graceMs: number;
  tickMs: number;
}

export interface LobbyContext {
  getTransport(): Transport | null;
  now(): number;
  timings: LobbyTimings;
}

/** Most games listed at once (a hostile peer cannot flood the page beyond this). */
const MAX_LISTED = 100;

interface Entry {
  game: PublicGame;
  peerId: string;
  expiresAt: number;
}

export class PublicLobby {
  private announced = new Map<string, PublicGame>();
  private listeners = new Set<(games: PublicGame[]) => void>();
  private entries = new Map<string, Entry>();
  private room: TransportRoom | null = null;
  private joining = false;
  private joinGen = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAnnounceAt = 0;
  private lastEmitted: PublicGame[] | null = null;
  private disposed = false;

  constructor(private readonly ctx: LobbyContext) {}

  /** Announce a game (or withdraw it with null). Cheap when nothing changed. */
  announce(gameId: string, game: PublicGame | null) {
    const previous = this.announced.get(gameId);
    if (game) {
      if (isEqual(previous, game)) return;
      this.announced.set(gameId, game);
      this.send({ type: "public-game", protocol: PROTOCOL, game, open: true });
    } else {
      if (!previous) return;
      this.announced.delete(gameId);
      this.send({ type: "public-game", protocol: PROTOCOL, game: previous, open: false });
    }
    this.update();
  }

  /** Call `callback` with the full list now and on every change. */
  subscribe(callback: (games: PublicGame[]) => void): () => void {
    this.listeners.add(callback);
    this.update();
    queueMicrotask(() => {
      if (this.listeners.has(callback)) this.deliver(callback, this.list());
    });
    return () => {
      this.listeners.delete(callback);
      this.update();
    };
  }

  /** Back to visible / online: re-join when nobody is connected, and re-announce. */
  revive() {
    if (this.disposed || !this.needed()) return;
    if (this.room && this.room.getPeers().length === 0) {
      this.leave();
    }
    if (!this.room && !this.joining) {
      this.join();
    } else {
      this.announceAll();
    }
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.announced.clear();
    this.leave();
  }

  private needed() {
    return this.announced.size > 0 || this.listeners.size > 0;
  }

  private update() {
    if (this.disposed) return;
    if (this.needed()) {
      if (this.leaveTimer) {
        clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
      }
      if (!this.room && !this.joining) this.join();
    } else if ((this.room || this.joining) && !this.leaveTimer) {
      this.leaveTimer = setTimeout(() => {
        this.leaveTimer = null;
        if (!this.needed()) this.leave();
      }, this.ctx.timings.graceMs);
    }
  }

  private join() {
    const transport = this.ctx.getTransport();
    if (!transport) return;

    const gen = ++this.joinGen;
    const live = () => gen === this.joinGen && !this.disposed;
    this.joining = true;

    let joined: Promise<TransportRoom>;
    try {
      joined = transport.join(
        PUBLIC_LOBBY_ROOM,
        { password: PUBLIC_LOBBY_ROOM },
        {
          onMessage: (data, peerId) => live() && this.onMessage(data, peerId),
          onPeerJoin: (peerId) => live() && this.onPeerJoin(peerId),
          onPeerLeave: (peerId) => live() && this.onPeerLeave(peerId),
        }
      );
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
        this.joining = false;
        this.announceAll();
      },
      (error) => {
        if (!live()) return;
        this.joining = false;
        console.warn("[network] could not join the public lobby", error);
      }
    );

    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.ctx.timings.tickMs);
    }
  }

  private leave() {
    this.joinGen++;
    this.joining = false;
    const room = this.room;
    this.room = null;
    room?.leave().catch(() => undefined);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this.entries.clear();
    this.emit();
  }

  private tick() {
    try {
      const now = this.ctx.now();
      if (now - this.lastAnnounceAt >= this.ctx.timings.announceIntervalMs) {
        this.announceAll();
      }
      this.entries.forEach((entry, id) => {
        if (entry.expiresAt <= now) this.entries.delete(id);
      });
      this.emit();
    } catch (e) {
      console.warn("[network] public lobby error", e);
    }
  }

  private send(message: PublicGameMessage, target?: string) {
    if (!this.room) return;
    try {
      this.room.send(message, target);
    } catch (e) {
      console.warn("[network] could not announce the game", e);
    }
  }

  private announceAll(target?: string) {
    if (!target) this.lastAnnounceAt = this.ctx.now();
    this.announced.forEach((game) => this.send({ type: "public-game", protocol: PROTOCOL, game, open: true }, target));
  }

  private onPeerJoin(peerId: string) {
    this.announceAll(peerId);
  }

  private onPeerLeave(peerId: string) {
    this.entries.forEach((entry, id) => {
      if (entry.peerId === peerId) this.entries.delete(id);
    });
    this.emit();
  }

  private onMessage(data: unknown, peerId: string) {
    try {
      const parsed = parseMessage(data);
      if (parsed.kind !== "ok" || parsed.message.type !== "public-game") return;
      const { game, open } = parsed.message;
      if (open) {
        if (!this.entries.has(game.id) && this.entries.size >= MAX_LISTED) return;
        this.entries.set(game.id, { game, peerId, expiresAt: this.ctx.now() + this.ctx.timings.expireMs });
      } else if (this.entries.get(game.id)?.peerId === peerId) {
        this.entries.delete(game.id);
      }
      this.emit();
    } catch (e) {
      console.warn("[network] ignored a public lobby message", e);
    }
  }

  private list(): PublicGame[] {
    return Array.from(this.entries.values())
      .map((entry) => entry.game)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private deliver(callback: (games: PublicGame[]) => void, games: PublicGame[]) {
    try {
      callback(games);
    } catch (e) {
      console.error("[network] public games subscriber failed", e);
    }
  }

  private emit() {
    const games = this.list();
    if (isEqual(games, this.lastEmitted)) return;
    this.lastEmitted = games;
    Array.from(this.listeners).forEach((callback) => this.deliver(callback, games));
  }
}
