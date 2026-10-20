/**
 * The browser's network node: network mode, transport selection, ICE
 * servers, storage and the page-lifecycle hooks (./lifecycle.ts). Only
 * called from the browser (never at import time, never during the static
 * pre-render).
 */
import { getPlayerId } from "~/lib/playerId";
import { stripBasePath } from "~/lib/routes";
import { watchPageLifecycle, withNearbyLinks } from "./lifecycle";
import { LinkManager } from "./nearby/links";
import { createNearbyTransport } from "./nearby/transport";
import { NetworkNode, NetworkNodeOptions } from "./node";
import { KeyValueStorage } from "./storage";
import { createBroadcastChannelTransport } from "./transports/broadcast";
import { createTrysteroTransport } from "./transports/trystero";
import { NetworkMode } from "./types";

/** Kept for existing imports: the transport follows the network mode. */
export type TransportKind = NetworkMode;

const NET_KEY = "hanab.net";

/** A page under /nearby/ (after the base path). */
function isNearbyPath(pathname: string): boolean {
  const path = stripBasePath(pathname);
  return path === "/nearby" || path.startsWith("/nearby/");
}

/**
 * This tab's network mode (docs/P2P_DESIGN.md, "Mode"), kept for the rest of
 * the tab's life in sessionStorage:
 * - `?net=local`: BroadcastChannel (tabs of this browser play together, no
 *   internet needed);
 * - `?net=nearby`, or any page under /nearby/: nearby links (devices on the
 *   same local network, QR codes, no internet);
 * - `?net=webrtc` switches back to the default, WebRTC through Trystero.
 */
export function selectTransportKind(): NetworkMode {
  let fromUrl: string | null = null;
  let nearbyPage = false;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("net");
    nearbyPage = isNearbyPath(window.location.pathname);
  } catch {
    fromUrl = null;
  }
  const requested: NetworkMode | null =
    fromUrl === "local" || fromUrl === "nearby" || fromUrl === "webrtc" ? fromUrl : nearbyPage ? "nearby" : null;
  try {
    if (requested === "webrtc") {
      sessionStorage.removeItem(NET_KEY);
    } else if (requested) {
      sessionStorage.setItem(NET_KEY, requested);
    }
    const stored = sessionStorage.getItem(NET_KEY);
    return stored === "local" || stored === "nearby" ? stored : "webrtc";
  } catch {
    return requested ?? "webrtc";
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
  /** This tab's links, in nearby mode only. */
  nearby: LinkManager | null;
}

export function createBrowserNetwork(mode: NetworkMode = selectTransportKind()): BrowserNetwork {
  const nearby = mode === "nearby" ? new LinkManager({ getPlayerId }) : null;

  const node = new NetworkNode({
    transport: () => {
      if (nearby) return createNearbyTransport(nearby, { storage: browserStorage });
      return mode === "local"
        ? createBroadcastChannelTransport()
        : createTrysteroTransport({ iceServers: turnServersFromEnv() });
    },
    storage: browserStorage,
    getPlayerId,
    // The browser's online flag says nothing about the local network.
    isOnline: () => mode === "nearby" || typeof navigator === "undefined" || navigator.onLine !== false,
    timings: mode === "local" ? LOCAL_TIMINGS : mode === "nearby" ? NEARBY_TIMINGS : undefined,
  });

  watchPageLifecycle(nearby ? withNearbyLinks(node, nearby) : node, window, document);
  return { mode, node, nearby };
}

export function createBrowserNode(): NetworkNode {
  return createBrowserNetwork().node;
}
