/**
 * BroadcastChannel transport (`?net=local`): tabs of the same browser play
 * together with no internet and no WebRTC. Used for development, demos and
 * playing several seats from one machine.
 *
 * Each room is a channel. Presence is announced on join, answered by the tabs
 * already there, and kept alive with ping/pong (background tabs throttle
 * timers but still answer messages); a tab that disappears without saying
 * goodbye is dropped after a while.
 */
import { JoinOptions, Transport, TransportHandlers, TransportRoom, transportUnavailable } from "./types";

type Envelope =
  | { kind: "join"; from: string }
  | { kind: "here"; from: string; to: string }
  | { kind: "leave"; from: string }
  | { kind: "ping"; from: string }
  | { kind: "pong"; from: string; to: string }
  | { kind: "data"; from: string; to?: string; data: unknown };

const CHANNEL_PREFIX = "hanab-net:";
const PING_INTERVAL_MS = 5000;
const PEER_TIMEOUT_MS = 20000;

function randomId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
}

export function createBroadcastChannelTransport(): Transport {
  // One peer id per page, like Trystero's selfId.
  const selfId = randomId();

  return {
    kind: "local",
    async join(roomId: string, _options: JoinOptions, handlers: TransportHandlers): Promise<TransportRoom> {
      if (typeof BroadcastChannel === "undefined") {
        throw transportUnavailable("This browser cannot sync games between tabs (no BroadcastChannel).");
      }

      const channel = new BroadcastChannel(CHANNEL_PREFIX + roomId);
      const lastSeen = new Map<string, number>();
      let left = false;
      let lastCheck = Date.now();

      const post = (envelope: Envelope) => {
        if (left) return;
        try {
          channel.postMessage(envelope);
        } catch (e) {
          console.warn("[network] could not post to other tabs", e);
        }
      };

      const seen = (peerId: string) => {
        const known = lastSeen.has(peerId);
        lastSeen.set(peerId, Date.now());
        if (!known) {
          handlers.onPeerJoin(peerId);
        }
        return known;
      };

      const drop = (peerId: string) => {
        if (lastSeen.delete(peerId)) {
          handlers.onPeerLeave(peerId);
        }
      };

      channel.onmessage = (event: MessageEvent<Envelope>) => {
        if (left) return;
        const envelope = event.data;
        if (!envelope || typeof envelope !== "object" || typeof envelope.from !== "string") return;
        if (envelope.from === selfId) return;

        try {
          switch (envelope.kind) {
            case "join":
              seen(envelope.from);
              post({ kind: "here", from: selfId, to: envelope.from });
              break;
            case "here":
              if (envelope.to === selfId) seen(envelope.from);
              break;
            case "leave":
              drop(envelope.from);
              break;
            case "ping":
              if (!seen(envelope.from)) {
                // We had dropped it (e.g. it was frozen): it is back.
                post({ kind: "here", from: selfId, to: envelope.from });
              }
              post({ kind: "pong", from: selfId, to: envelope.from });
              break;
            case "pong":
              if (envelope.to === selfId) seen(envelope.from);
              break;
            case "data":
              if (envelope.to && envelope.to !== selfId) break;
              if (!lastSeen.has(envelope.from)) {
                seen(envelope.from);
                post({ kind: "here", from: selfId, to: envelope.from });
              } else {
                lastSeen.set(envelope.from, Date.now());
              }
              handlers.onMessage(envelope.data, envelope.from);
              break;
          }
        } catch (e) {
          console.warn("[network] error handling a message from another tab", e);
        }
      };

      const timer = setInterval(() => {
        const now = Date.now();
        // A throttled timer means this tab was in the background: peers did
        // not get a chance to answer, so do not expire anyone this round.
        const throttled = now - lastCheck > PING_INTERVAL_MS * 2;
        lastCheck = now;
        if (!throttled) {
          lastSeen.forEach((at, peerId) => {
            if (now - at > PEER_TIMEOUT_MS) drop(peerId);
          });
        }
        post({ kind: "ping", from: selfId });
      }, PING_INTERVAL_MS);

      const onPageHide = () => post({ kind: "leave", from: selfId });
      const page = typeof window !== "undefined" ? window : null;
      page?.addEventListener("pagehide", onPageHide);

      post({ kind: "join", from: selfId });

      return {
        selfId,
        send(data: unknown, target?: string) {
          post({ kind: "data", from: selfId, to: target, data });
        },
        getPeers: () => (left ? [] : Array.from(lastSeen.keys())),
        async leave() {
          if (left) return;
          post({ kind: "leave", from: selfId });
          left = true;
          clearInterval(timer);
          page?.removeEventListener("pagehide", onPageHide);
          lastSeen.clear();
          channel.close();
        },
      };
    },
  };
}
