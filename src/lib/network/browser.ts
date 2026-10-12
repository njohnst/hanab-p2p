/**
 * The browser's network node: transport selection, ICE servers, storage and
 * the page-lifecycle hooks (./lifecycle.ts). Only called from the browser
 * (never at import time, never during the static pre-render).
 */
import { getPlayerId } from "~/lib/playerId";
import { watchPageLifecycle } from "./lifecycle";
import { KeyValueStorage } from "./storage";
import { NetworkNode, NetworkNodeOptions } from "./node";
import { createBroadcastChannelTransport } from "./transports/broadcast";
import { createTrysteroTransport } from "./transports/trystero";

export type TransportKind = "webrtc" | "local";

const NET_KEY = "hanab.net";

/**
 * `?net=local` makes this tab use BroadcastChannel (tabs of this browser play
 * together, no internet needed) for the rest of its life (sessionStorage);
 * `?net=webrtc` switches back. WebRTC through Trystero otherwise.
 */
export function selectTransportKind(): TransportKind {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("net");
  } catch {
    fromUrl = null;
  }
  try {
    if (fromUrl === "local") {
      sessionStorage.setItem(NET_KEY, "local");
    } else if (fromUrl === "webrtc") {
      sessionStorage.removeItem(NET_KEY);
    }
    return sessionStorage.getItem(NET_KEY) === "local" ? "local" : "webrtc";
  } catch {
    return fromUrl === "local" ? "local" : "webrtc";
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

export function createBrowserNode(): NetworkNode {
  const kind = selectTransportKind();

  const node = new NetworkNode({
    transport: () =>
      kind === "local"
        ? createBroadcastChannelTransport()
        : createTrysteroTransport({ iceServers: turnServersFromEnv() }),
    storage: browserStorage,
    getPlayerId,
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    timings: kind === "local" ? LOCAL_TIMINGS : undefined,
  });

  watchPageLifecycle(node, window, document);
  return node;
}
