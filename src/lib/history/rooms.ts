import type { Transport, TransportRoom } from "~/lib/network/transports/types";
import { groupKey, HistoryEntry, readEntry } from "./result";
import { HistoryStore } from "./store";

export const HISTORY_ROOM_PREFIX = "hanab-history-v1-";
const BATCH_SIZE = 8;
const MAX_PACKET_CHARS = 32 * 1024;

interface Membership {
  games: Map<string, Set<string>>;
  sentTo: Set<string>;
  room?: TransportRoom;
  joining?: Promise<void>;
}

function eligible(entry: HistoryEntry, key: string): boolean {
  return (
    !!entry.matchId && groupKey(entry.group) === key && (!entry.result || entry.result.rules.gameMode === "network")
  );
}

function decode(data: unknown, key: string): HistoryEntry[] | null {
  if (typeof data !== "string" || data.length > MAX_PACKET_CHARS) return null;
  try {
    const packet = JSON.parse(data);
    if (
      packet?.history !== 1 ||
      !Array.isArray(packet.entries) ||
      !packet.entries.length ||
      packet.entries.length > BATCH_SIZE
    )
      return null;
    const entries = packet.entries.map(readEntry) as HistoryEntry[];
    return entries.every((entry) => entry && eligible(entry, key)) ? entries : null;
  } catch {
    return null;
  }
}

async function secret(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A history room is held only while a live game supplies authorized seat peers. */
export class HistoryRooms {
  private readonly groups = new Map<string, Membership>();
  private readonly gameGroups = new Map<string, string>();
  private readonly closing = new Map<string, Promise<void>>();

  constructor(
    private readonly store: HistoryStore,
    private readonly transport: () => Transport | null,
    private readonly reconcile: (entry: HistoryEntry) => HistoryEntry | null = (entry) => entry
  ) {}

  follow(gameId: string, group: string[] | null, peerIds: string[] = []) {
    const key = group && peerIds.length ? groupKey(group) : null;
    if (this.gameGroups.get(gameId) !== key) this.remove(gameId);
    if (!key) return;
    const membership: Membership = this.groups.get(key) ?? { games: new Map(), sentTo: new Set() };
    this.groups.set(key, membership);
    this.gameGroups.set(gameId, key);
    membership.games.set(gameId, new Set(peerIds));
    if (!membership.room && !membership.joining) this.join(key, membership);
    this.sendInitial(key, membership);
  }

  remove(gameId: string) {
    const key = this.gameGroups.get(gameId);
    if (!key) return;
    this.gameGroups.delete(gameId);
    const membership = this.groups.get(key);
    membership.games.delete(gameId);
    if (!membership.games.size) {
      this.groups.delete(key);
      const leaving = membership.room ? membership.room.leave() : membership.joining;
      const done = Promise.resolve(leaving)
        .catch(() => undefined)
        .then(() => {
          if (this.closing.get(key) === done) this.closing.delete(key);
        });
      this.closing.set(key, done);
    } else {
      this.sendInitial(key, membership);
    }
  }

  clear() {
    Array.from(this.gameGroups.keys()).forEach((gameId) => this.remove(gameId));
  }

  publish(entries: HistoryEntry[], except?: string) {
    entries.forEach((entry) => {
      const key = groupKey(entry.group);
      const membership = this.groups.get(key);
      if (membership && eligible(entry, key)) {
        membership.room?.getPeers().forEach((peerId) => {
          if (peerId !== except && this.allowed(membership, peerId)) this.send(membership.room, peerId, [entry]);
        });
      }
    });
  }

  private allowed(membership: Membership, peerId: string): boolean {
    return Array.from(membership.games.values()).some((peers) => peers.has(peerId));
  }

  private send(room: TransportRoom, peerId: string, entries: HistoryEntry[]) {
    const header = '{"history":1,"entries":[';
    let batch: string[] = [];
    let size = header.length + 2;
    const flush = () => {
      if (batch.length) room.send(header + batch.join(",") + "]}", peerId);
      batch = [];
      size = header.length + 2;
    };
    entries.forEach((entry) => {
      const encoded = JSON.stringify(entry);
      if (encoded.length + header.length + 2 > MAX_PACKET_CHARS) return;
      if (batch.length === BATCH_SIZE || size + encoded.length + 1 > MAX_PACKET_CHARS) flush();
      size += encoded.length + (batch.length ? 1 : 0);
      batch.push(encoded);
    });
    flush();
  }

  private sendInitial(key: string, membership: Membership) {
    const { room, sentTo } = membership;
    if (!room) return;
    const peers = room.getPeers().filter((peer) => this.allowed(membership, peer));
    sentTo.forEach((peer) => {
      if (!peers.includes(peer)) sentTo.delete(peer);
    });
    const newPeers = peers.filter((peer) => !sentTo.has(peer));
    if (!newPeers.length) return;
    const entries = this.store.list().filter((entry) => eligible(entry, key));
    newPeers.forEach((peer) => {
      sentTo.add(peer);
      this.send(room, peer, entries);
    });
  }

  private join(key: string, membership: Membership) {
    const current = () => this.groups.get(key) === membership;
    membership.joining = (async () => {
      await this.closing.get(key);
      const transport = this.transport();
      if (!current() || !transport) return;
      const [id, password] = await Promise.all([secret("history-room:" + key), secret("history-password:" + key)]);
      if (!current()) return;
      const room = await transport.join(
        HISTORY_ROOM_PREFIX + id,
        { password },
        {
          onMessage: (data, peerId) => {
            if (!current() || !this.allowed(membership, peerId)) return;
            const entries = decode(data, key);
            entries?.forEach((entry) => {
              const accepted = this.reconcile(entry);
              if (accepted) this.publish(this.store.merge([accepted]), accepted === entry ? peerId : undefined);
            });
          },
          onPeerJoin: () => {
            if (current()) this.sendInitial(key, membership);
          },
          onPeerLeave: (peerId) => membership.sentTo.delete(peerId),
        }
      );
      if (!current()) {
        await room.leave();
        return;
      }
      membership.room = room;
      this.sendInitial(key, membership);
    })()
      .catch(() => {
        // Local history remains available when the transport cannot join.
      })
      .then(() => {
        membership.joining = undefined;
      });
  }
}
