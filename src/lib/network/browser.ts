/**
 * The browser's network node: network mode, transport selection, ICE
 * servers, storage and the page-lifecycle hooks (./lifecycle.ts). Only
 * called from the browser (never at import time, never during the static
 * pre-render).
 */
import { getPlayerId } from "~/lib/playerId";
import { watchPageLifecycle, withNearbyLinks } from "./lifecycle";
import { LinkManager } from "./nearby/links";
import { createNearbyTransport } from "./nearby/transport";
import { NetworkNode, NetworkNodeOptions } from "./node";
import { KeyValueStorage } from "./storage";
import { createCombinedTransport } from "./transports/combined";
import { createBroadcastChannelTransport } from "./transports/broadcast";
import { createTrysteroTransport } from "./transports/trystero";
import { NetworkMode } from "./types";

/** Kept for existing imports: the transport follows the network mode. */
export type TransportKind = NetworkMode;

const NET_KEY = "hanab.net";

/** Unified play is the default, including old /nearby links and saved nearby sessions.
 * Explicit ?net=nearby keeps a relay-free diagnostic mode; ?net=local keeps tab tests isolated.
 */
export function selectTransportKind(): NetworkMode {
  let requested: string | null = null;
  try {
    requested = new URLSearchParams(window.location.search).get("net");
  } catch {
    /* SSR */
  }
  try {
    if (requested === "local") sessionStorage.setItem(NET_KEY, "local");
    else if (requested || sessionStorage.getItem(NET_KEY) === "nearby") sessionStorage.removeItem(NET_KEY);
    if (requested === "nearby") return "nearby";
    return sessionStorage.getItem(NET_KEY) === "local" ? "local" : "webrtc";
  } catch {
    return requested === "local" || requested === "nearby" ? requested : "webrtc";
  }
}

/**
 * ICE servers added to Trystero's defaults. Those already include public STUN
 * servers (stun:stun.l.google.com:19302, its stun1/stun2 siblings and
 * Cloudflare's), so only the optional build-time TURN relay is added.
 * process.env.NEXT_PUBLIC_* are read literally so that Next inlines them.
 */
export function turnServersFromEnv() {
  const urls = (process.env.NEXT_PUBLIC_TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) {
    return [];
  }
  const username = process.env.NEXT_PUBLIC_TURN_USERNAME || undefined;
  const credential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL || undefined;
  return [{ urls, username, credential }];
}

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const LOCAL_TIMINGS: NetworkNodeOptions["timings"] = {
  // Tabs of one browser answer within milliseconds.
  syncWindowMs: 800,
  electionTimeoutMs: 1500,
  retryMs: 1500,
};

const NEARBY_TIMINGS: NetworkNodeOptions["timings"] = {
  // Nearby links are open before any room is joined, so a room's members are
  // known one LAN round trip after joining: the internet defaults, sized for
  // Nostr relays plus a WebRTC connection per newcomer, would only slow
  // things down. Unlike LOCAL_TIMINGS (tabs of one machine), these are phones
  // on Wi-Fi, where power saving delays packets by up to a few hundred ms and
  // background tabs answer late: leave a few round trips of margin.
  syncWindowMs: 2000,
  electionTimeoutMs: 2500,
  retryMs: 2000,
};

export interface BrowserNetwork {
  mode: NetworkMode;
  node: NetworkNode;
  /** QR-created links, available alongside automatic internet connections. */
  nearby: LinkManager | null;
}

export function createBrowserNetwork(mode: NetworkMode = selectTransportKind()): BrowserNetwork {
  const nearby = mode !== "local" ? new LinkManager({ getPlayerId }) : null;

  const node = new NetworkNode({
    transport: () => {
      if (nearby) {
        const direct = createNearbyTransport(nearby);
        return createCombinedTransport(
          nearby.selfId,
          mode === "nearby" ? [direct] : [direct, createTrysteroTransport({ iceServers: turnServersFromEnv() })]
        );
      }
      return mode === "local"
        ? createBroadcastChannelTransport()
        : createTrysteroTransport({ iceServers: turnServersFromEnv() });
    },
    storage: browserStorage,
    getPlayerId,
    // The browser's online flag says nothing about the local network.
    isOnline: () => mode !== "local" || typeof navigator === "undefined" || navigator.onLine !== false,
    timings: mode === "local" ? LOCAL_TIMINGS : mode === "nearby" ? NEARBY_TIMINGS : undefined,
  });

  watchPageLifecycle(nearby ? withNearbyLinks(node, nearby) : node, window, document);
  return { mode, node, nearby };
}

export function createBrowserNode(): NetworkNode {
  return createBrowserNetwork().node;
}
