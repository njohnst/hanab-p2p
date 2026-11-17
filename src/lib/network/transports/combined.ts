import { Transport, TransportHandlers, TransportRoom } from "./types";
import { MAX_MESSAGE_CHARS } from "../protocol";
import { PUBLIC_LOBBY_ROOM } from "../publicLobby";

const HEARTBEAT_MS = 5000;
const EXPIRE_MS = 20000;
const MAX_SEEN = 2048;
const MAX_PEERS = 128;

interface Packet {
  hanabConnection: 1;
  from: string;
  seq: number;
  hops: number;
  type: "presence" | "data" | "leave";
  target?: string;
  data?: unknown;
}

function isPacket(value: unknown): value is Packet {
  if (!value || typeof value !== "object") return false;
  const p = value as Packet;
  return (
    p.hanabConnection === 1 &&
    typeof p.from === "string" &&
    p.from.length > 0 &&
    p.from.length <= 128 &&
    Number.isSafeInteger(p.seq) &&
    p.seq >= 0 &&
    Number.isInteger(p.hops) &&
    p.hops >= 0 &&
    p.hops <= 8 &&
    (p.type === "presence" || p.type === "data" || p.type === "leave") &&
    (p.target === undefined || (typeof p.target === "string" && p.target.length <= 128))
  );
}

/**
 * One logical room over automatic internet links and QR-created links. A stable tab identity
 * deduplicates peers/messages on both paths. Forwarding lets a QR-only player reach an internet
 * player through a common participant, without depending on which participant is the authority.
 * Packets are bounded by a hop limit and a recent-id cache; normal game validation still applies.
 */
export function createCombinedTransport(selfId: string, transports: Transport[]): Transport {
  let sequence = 0;
  return {
    kind: "webrtc",
    async join(roomId, options, handlers): Promise<TransportRoom> {
      let left = false;
      let ready = false;
      const queued: Array<() => void> = [];
      const rooms = new Map<number, TransportRoom>();
      const pending = new Set<number>();
      const failures = new Map<number, string>();
      let reportedOldVersion = false;
      const seen = new Set<string>();
      const departed = new Map<string, number>();
      const peers = new Map<string, { lastSeen: number; routes: Set<string> }>();
      const dispatch = (event: () => void) => {
        if (left) return;
        if (!ready) {
          queued.push(event);
          return;
        }
        try {
          event();
        } catch (error) {
          console.warn("[network] room handler failed", error);
        }
      };
      const remember = (p: Packet) => {
        const id = `${p.from}:${p.seq}`;
        if (seen.has(id)) return false;
        seen.add(id);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
        return true;
      };
      const forward = (p: Packet, except?: string) => {
        if (left || p.hops <= 0) return;
        rooms.forEach((room, index) => {
          // Public discovery is already a mesh within each transport. Only bridge across them.
          if (roomId === PUBLIC_LOBBY_ROOM && except?.startsWith(`${index}:`)) return;
          room.getPeers().forEach((peer) => {
            if (`${index}:${peer}` !== except) room.send({ ...p, hops: p.hops - 1 }, peer);
          });
        });
      };
      const send = (type: Packet["type"], data?: unknown, target?: string) => {
        const p: Packet = { hanabConnection: 1, from: selfId, seq: ++sequence, hops: 8, type, data, target };
        remember(p);
        forward(p);
      };
      const remove = (peer: string) => {
        if (peers.delete(peer)) dispatch(() => handlers.onPeerLeave(peer));
      };
      const receive = (value: unknown, edge: string) => {
        if (left) return;
        if (!isPacket(value)) {
          if (!reportedOldVersion && value && typeof value === "object" && "protocol" in value) {
            reportedOldVersion = true;
            dispatch(() => handlers.onError?.("Another player has an older version. Reload the game on all devices."));
          }
          return;
        }
        if (value.from === selfId) return;
        try {
          if (JSON.stringify(value).length > MAX_MESSAGE_CHARS + 1024) return;
        } catch {
          return;
        }
        const p = value;
        if (p.seq <= (departed.get(p.from) ?? -1)) return;
        const peer = peers.get(p.from);
        // Keep alternate paths even when this copy of the packet is a duplicate.
        peer?.routes.add(edge);
        if (!remember(p)) return;
        if (p.type === "leave") {
          departed.set(p.from, p.seq);
          if (departed.size > MAX_PEERS) departed.delete(departed.keys().next().value);
          remove(p.from);
        } else {
          if (!peer) {
            if (peers.size >= MAX_PEERS) return;
            peers.set(p.from, { lastSeen: Date.now(), routes: new Set([edge]) });
            dispatch(() => handlers.onPeerJoin(p.from));
          } else peer.lastSeen = Date.now();
          if (p.type === "data" && (!p.target || p.target === selfId)) {
            dispatch(() => handlers.onMessage(p.data, p.from));
          }
        }
        forward(p, edge);
      };
      const attach = (transport: Transport, index: number) => {
        if (left || pending.has(index) || rooms.has(index)) return;
        pending.add(index);
        const early: Array<() => void> = [];
        const afterJoin = (event: () => void) => (rooms.has(index) ? event() : early.push(event));
        const callbacks: TransportHandlers = {
          onMessage: (data, peer) => afterJoin(() => receive(data, `${index}:${peer}`)),
          onPeerJoin: () => afterJoin(() => send("presence")),
          onPeerLeave: (peer) =>
            afterJoin(() => {
              const edge = `${index}:${peer}`;
              peers.forEach((entry, id) => {
                entry.routes.delete(edge);
                if (!entry.routes.size) remove(id);
              });
            }),
          // An internet signaling error must not disable a working QR connection.
          onError: () => undefined,
        };
        Promise.resolve()
          .then(() => transport.join(roomId, options, callbacks))
          .then((room) => {
            pending.delete(index);
            if (left) {
              void room.leave();
              return;
            }
            rooms.set(index, room);
            failures.delete(index);
            early.splice(0).forEach((event) => event());
            send("presence");
          })
          .catch((error) => {
            pending.delete(index);
            failures.set(index, error instanceof Error ? error.message : "Unable to connect.");
            if (!rooms.size && failures.size === transports.length) {
              dispatch(() => handlers.onError?.(failures.get(index)));
            }
            // Retry a failed lazy import/join when internet becomes available again.
          });
      };
      const refresh = () => {
        transports.forEach(attach);
        send("presence");
        peers.forEach((peer, id) => {
          if (Date.now() - peer.lastSeen > EXPIRE_MS) remove(id);
        });
      };
      refresh();
      const timer = setInterval(refresh, HEARTBEAT_MS);
      setTimeout(() => {
        ready = true;
        queued.splice(0).forEach(dispatch);
      }, 0);
      return {
        selfId,
        send: (data, target) => {
          if (!left) send("data", data, target);
        },
        getPeers: () => (left ? [] : Array.from(peers.keys())),
        async leave() {
          if (left) return;
          send("leave");
          left = true;
          clearInterval(timer);
          queued.length = 0;
          peers.clear();
          await Promise.all(Array.from(rooms.values(), (room) => room.leave()));
          rooms.clear();
        },
      };
    },
  };
}
