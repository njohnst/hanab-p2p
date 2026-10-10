/**
 * In-memory transport for tests: a simulated network of named nodes with
 * per-link latency, message drops, link cuts and partitions.
 *
 * Delivery uses setTimeout, so tests drive it with fake timers. Messages are
 * JSON round-tripped like on the wire (no shared objects between peers) and
 * stay in order per link; join/leave events travel on the same ordered link.
 * Messages in flight when a peer leaves are still delivered (like Trystero,
 * which flushes before closing); a cut link loses them.
 */
import { JoinOptions, Transport, TransportHandlers, TransportRoom } from "./types";

export interface SentMessage {
  roomId: string;
  from: string;
  to: string;
  data: unknown;
}

interface Member {
  nodeId: string;
  handlers: TransportHandlers;
}

function linkKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class MemoryNetwork {
  /** Every message handed to the network (including dropped ones). */
  readonly sent: SentMessage[] = [];
  /** Rooms joined, in order (node, room). */
  readonly joins: Array<{ nodeId: string; roomId: string }> = [];
  /** Return true to drop a message. */
  dropWhen: ((message: SentMessage) => boolean) | null = null;

  private defaultLatency: number;
  private latencies = new Map<string, number>();
  private down = new Set<string>();
  private rooms = new Map<string, Map<string, Member>>();
  private connected = new Map<string, Set<string>>();
  /** Bumped when a link connects or is cut: in-flight messages of an older epoch are lost. */
  private epochs = new Map<string, number>();
  private lastDelivery = new Map<string, number>();

  constructor(options: { latencyMs?: number } = {}) {
    this.defaultLatency = options.latencyMs ?? 10;
  }

  /** The transport a node uses; the node id is its peer id in every room. */
  transport(nodeId: string): Transport {
    return {
      kind: "memory",
      join: async (roomId: string, _options: JoinOptions, handlers: TransportHandlers) =>
        this.join(nodeId, roomId, handlers),
    };
  }

  /** Latency of the link between two nodes, or of every link without one. */
  setLatency(ms: number, a?: string, b?: string) {
    if (a && b) {
      this.latencies.set(linkKey(a, b), ms);
    } else {
      this.defaultLatency = ms;
    }
  }

  /** Cut (up = false) or restore the link between two nodes. */
  setLink(a: string, b: string, up: boolean) {
    if (up) {
      this.down.delete(linkKey(a, b));
      this.reconnectAll();
    } else {
      this.down.add(linkKey(a, b));
      this.bumpEpoch(linkKey(a, b));
      this.rooms.forEach((_, roomId) => this.disconnect(roomId, a, b));
    }
  }

  /** Cut every link between nodes of different groups. */
  partition(...groups: string[][]) {
    groups.forEach((group, i) => {
      groups.slice(i + 1).forEach((other) => {
        group.forEach((a) => other.forEach((b) => this.setLink(a, b, false)));
      });
    });
  }

  /** Restore every link. */
  heal() {
    this.down.clear();
    this.reconnectAll();
  }

  /** Nodes currently in a room. */
  members(roomId: string): string[] {
    return Array.from(this.rooms.get(roomId)?.keys() ?? []);
  }

  /** Messages of a given type sent so far (optionally in one room). */
  sentOfType(type: string, roomId?: string): SentMessage[] {
    return this.sent.filter(
      (message) =>
        (!roomId || message.roomId === roomId) &&
        typeof message.data === "object" &&
        message.data !== null &&
        (message.data as { type?: unknown }).type === type
    );
  }

  private bumpEpoch(key: string) {
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }

  private latency(a: string, b: string) {
    return this.latencies.get(linkKey(a, b)) ?? this.defaultLatency;
  }

  private isUp(a: string, b: string) {
    return !this.down.has(linkKey(a, b));
  }

  private pairs(roomId: string): Set<string> {
    let pairs = this.connected.get(roomId);
    if (!pairs) {
      pairs = new Set();
      this.connected.set(roomId, pairs);
    }
    return pairs;
  }

  /** Run `deliver` on `to` after the link latency, after anything sent earlier on the same link. */
  private schedule(from: string, to: string, deliver: () => void) {
    const now = Date.now();
    const directed = `${from}>${to}`;
    const at = Math.max(now + this.latency(from, to), this.lastDelivery.get(directed) ?? 0);
    this.lastDelivery.set(directed, at);
    setTimeout(deliver, at - now);
  }

  private join(nodeId: string, roomId: string, handlers: TransportHandlers): TransportRoom {
    const room = this.rooms.get(roomId) ?? new Map<string, Member>();
    this.rooms.set(roomId, room);
    if (room.has(nodeId)) {
      this.leave(roomId, room.get(nodeId));
    }
    const member: Member = { nodeId, handlers };
    room.set(nodeId, member);
    this.joins.push({ nodeId, roomId });

    room.forEach((_, other) => {
      if (other !== nodeId && this.isUp(nodeId, other)) {
        this.connect(roomId, nodeId, other);
      }
    });

    let left = false;
    return {
      selfId: nodeId,
      send: (data: unknown, target?: string) => {
        if (!left) {
          this.send(roomId, nodeId, data, target);
        }
      },
      getPeers: () => (left ? [] : this.peersOf(roomId, nodeId)),
      leave: async () => {
        if (!left) {
          left = true;
          this.leave(roomId, member);
        }
      },
    };
  }

  private peersOf(roomId: string, nodeId: string): string[] {
    const peers: string[] = [];
    this.pairs(roomId).forEach((pair) => {
      const [a, b] = pair.split("|");
      if (a === nodeId) peers.push(b);
      if (b === nodeId) peers.push(a);
    });
    return peers;
  }

  private memberIfCurrent(roomId: string, nodeId: string, member?: Member): Member | null {
    const current = this.rooms.get(roomId)?.get(nodeId);
    return current && (!member || current === member) ? current : null;
  }

  private connect(roomId: string, a: string, b: string) {
    const pairs = this.pairs(roomId);
    const key = linkKey(a, b);
    if (pairs.has(key)) {
      return;
    }
    pairs.add(key);
    this.bumpEpoch(key);
    const memberA = this.rooms.get(roomId).get(a);
    const memberB = this.rooms.get(roomId).get(b);
    this.schedule(a, b, () => {
      if (pairs.has(key) && this.memberIfCurrent(roomId, b, memberB)) memberB.handlers.onPeerJoin(a);
    });
    this.schedule(b, a, () => {
      if (pairs.has(key) && this.memberIfCurrent(roomId, a, memberA)) memberA.handlers.onPeerJoin(b);
    });
  }

  private disconnect(roomId: string, a: string, b: string) {
    const pairs = this.pairs(roomId);
    const key = linkKey(a, b);
    if (!pairs.has(key)) {
      return;
    }
    pairs.delete(key);
    const memberA = this.memberIfCurrent(roomId, a);
    const memberB = this.memberIfCurrent(roomId, b);
    if (memberB) {
      this.schedule(a, b, () => {
        if (!pairs.has(key) && this.memberIfCurrent(roomId, b, memberB)) memberB.handlers.onPeerLeave(a);
      });
    }
    if (memberA) {
      this.schedule(b, a, () => {
        if (!pairs.has(key) && this.memberIfCurrent(roomId, a, memberA)) memberA.handlers.onPeerLeave(b);
      });
    }
  }

  private leave(roomId: string, member: Member) {
    const room = this.rooms.get(roomId);
    if (!room || room.get(member.nodeId) !== member) {
      return;
    }
    this.peersOf(roomId, member.nodeId).forEach((other) => this.disconnect(roomId, member.nodeId, other));
    room.delete(member.nodeId);
  }

  private reconnectAll() {
    this.rooms.forEach((room, roomId) => {
      const nodes = Array.from(room.keys());
      nodes.forEach((a, i) => {
        nodes.slice(i + 1).forEach((b) => {
          if (this.isUp(a, b)) this.connect(roomId, a, b);
        });
      });
    });
  }

  private send(roomId: string, from: string, data: unknown, target?: string) {
    const recipients = this.peersOf(roomId, from).filter((peer) => !target || peer === target);
    recipients.forEach((to) => {
      const message: SentMessage = { roomId, from, to, data };
      this.sent.push(message);
      if (this.dropWhen?.(message)) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(JSON.stringify(data));
      } catch {
        return;
      }
      const receiver = this.rooms.get(roomId)?.get(to);
      const key = linkKey(from, to);
      const epoch = this.epochs.get(key);
      this.schedule(from, to, () => {
        if (this.epochs.get(key) === epoch && receiver && this.memberIfCurrent(roomId, to, receiver)) {
          receiver.handlers.onMessage(payload, from);
        }
      });
    });
  }
}
