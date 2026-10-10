/**
 * WebRTC transport through Trystero (Nostr relays for signaling).
 *
 * Trystero is loaded lazily with import() so that importing ~/lib/network
 * never touches RTCPeerConnection or WebSocket (pages are pre-rendered in
 * Node by `next build`).
 */
import type { JsonValue, TurnServerConfig } from "trystero";
import { JoinOptions, Transport, TransportHandlers, TransportRoom, transportUnavailable } from "./types";

/** Fixed for the app: peers of every version meet, and detect protocol mismatches themselves. */
export const TRYSTERO_APP_ID = "hanab-p2p";
/** Action carrying every message (Trystero limits action names to 32 bytes). */
const ACTION = "hanab";

export interface TrysteroTransportOptions {
  appId?: string;
  /** Extra ICE servers, appended to Trystero's default public STUN servers. */
  iceServers?: TurnServerConfig[];
}

export function createTrysteroTransport(options: TrysteroTransportOptions = {}): Transport {
  const appId = options.appId ?? TRYSTERO_APP_ID;
  // joinRoom() returns the existing instance while a room with the same id is
  // still leaving: wait for the previous leave before joining again.
  const leaving = new Map<string, Promise<void>>();

  return {
    kind: "webrtc",
    async join(roomId: string, joinOptions: JoinOptions, handlers: TransportHandlers): Promise<TransportRoom> {
      if (typeof RTCPeerConnection === "undefined") {
        throw transportUnavailable("This browser cannot play over the internet (no WebRTC support).");
      }
      if (typeof window !== "undefined" && window.isSecureContext === false) {
        // Trystero encrypts the signaling with WebCrypto, only available on https (or localhost).
        throw transportUnavailable(
          "Playing over the internet needs a secure (https) page. Try ?net=local to play between tabs."
        );
      }
      await leaving.get(roomId);
      const { joinRoom, selfId } = await import("trystero");

      // Handlers only run once the caller has the room (see Transport.join).
      let ready = false;
      let left = false;
      const queued: Array<() => void> = [];
      const dispatch = (event: () => void) => {
        if (left) return;
        if (!ready) {
          queued.push(event);
          return;
        }
        try {
          event();
        } catch (e) {
          console.warn("[network] error in a room handler", e);
        }
      };

      const room = joinRoom(
        {
          appId,
          password: joinOptions.password,
          turnConfig: options.iceServers?.length ? options.iceServers : undefined,
          relayConfig: { warnOnRelayFailure: false },
        },
        roomId,
        {
          onJoinError: (details) => dispatch(() => handlers.onError?.(details.error)),
        }
      );

      const action = room.makeAction<JsonValue>(ACTION);
      action.onMessage = (data, context) => dispatch(() => handlers.onMessage(data, context.peerId));
      room.onPeerJoin = (peerId) => dispatch(() => handlers.onPeerJoin(peerId));
      room.onPeerLeave = (peerId) => dispatch(() => handlers.onPeerLeave(peerId));

      setTimeout(() => {
        ready = true;
        queued.splice(0).forEach(dispatch);
      }, 0);

      return {
        selfId,
        send(data: unknown, target?: string) {
          if (left) return;
          try {
            action.send(data as JsonValue, target ? { target } : undefined).catch((e) => {
              console.warn("[network] could not send to peers", e);
            });
          } catch (e) {
            console.warn("[network] could not send to peers", e);
          }
        },
        getPeers() {
          if (left) return [];
          try {
            return Object.keys(room.getPeers());
          } catch {
            return [];
          }
        },
        leave() {
          if (left) return leaving.get(roomId) ?? Promise.resolve();
          left = true;
          action.onMessage = null;
          room.onPeerJoin = null;
          room.onPeerLeave = null;
          const done = room
            .leave()
            .catch(() => undefined)
            .then(() => {
              if (leaving.get(roomId) === done) leaving.delete(roomId);
            });
          leaving.set(roomId, done);
          return done;
        },
      };
    },
  };
}
