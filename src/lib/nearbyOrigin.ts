/**
 * Where other devices can open the app, for nearby invite and reply URLs (see docs/P2P_DESIGN.md,
 * "Getting the app without internet").
 *
 * Those URLs carry the page's origin, and a page opened on localhost names this computer only. So on
 * a loopback page, the app asks the server for its LAN origins: `yarn serve:static`
 * (scripts/serve-static.mjs) answers <basePath>/nearby-origins.json with
 * {"origins": ["http://192.168.1.5:3000", ...]}, best first. Other hosts don't (`next dev` answers
 * 404), and the list is empty.
 */
import { withBasePath } from "~/lib/routes";

/** How long to wait for the server's LAN origins. */
const ORIGINS_TIMEOUT_MS = 2000;

/** At most this many LAN origins are kept from the server's answer. */
const MAX_ORIGINS = 16;

export type InviteOrigins = {
  /** This page's origin. */
  current: string;
  /** Origins of this server for other devices, best first. Only on loopback pages, else empty. */
  lan: string[];
  /** This page was opened on this computer only (localhost, 127.x.x.x, ::1). */
  loopback: boolean;
};

/** Whether a host name (as in URL.hostname) names this computer only: localhost, *.localhost, 127.0.0.0/8, ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = (hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    return ipv4.slice(1).every((part) => Number(part) <= 255);
  }

  if (!host.includes(":")) {
    return false;
  }

  // IPv6, in brackets or not: the URL parser writes it the short way (0:0:0:0:0:0:0:1 is [::1], and
  // the IPv4-mapped ::ffff:127.0.0.1 is [::ffff:7f00:1]).
  try {
    const canonical = new URL(`http://[${host.replace(/^\[(.*)\]$/, "$1")}]/`).hostname;
    return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
  } catch {
    return false;
  }
}

/**
 * The LAN origins in the server's answer ({"origins": [...]}): http(s) origins, without loopback
 * ones, `current` or duplicates. Anything else is dropped.
 */
export function parseNearbyOrigins(data: unknown, current?: string): string[] {
  const origins = data && typeof data === "object" ? (data as { origins?: unknown }).origins : null;
  if (!Array.isArray(origins)) {
    return [];
  }

  const result: string[] = [];
  for (const value of origins) {
    if (typeof value !== "string") {
      continue;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }

    const valid = (url.protocol === "http:" || url.protocol === "https:") && !isLoopbackHost(url.hostname);
    if (valid && url.origin !== current && !result.includes(url.origin)) {
      result.push(url.origin);
    }
  }

  return result.slice(0, MAX_ORIGINS);
}

/**
 * This page's origin, plus the origins other devices can use when it was opened on localhost.
 * Never rejects. Client-side only (while pre-rendering, current is "").
 */
export async function resolveInviteOrigins(): Promise<InviteOrigins> {
  if (typeof window === "undefined") {
    return { current: "", lan: [], loopback: false };
  }

  const { origin, hostname } = window.location;
  const loopback = isLoopbackHost(hostname);

  return { current: origin, lan: loopback ? await fetchLanOrigins(origin) : [], loopback };
}

async function fetchLanOrigins(current: string): Promise<string[]> {
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> = null;
  const timeout = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve([]);
    }, ORIGINS_TIMEOUT_MS);
  });

  const request = (async () => {
    const response = await fetch(withBasePath("/nearby-origins.json"), {
      cache: "no-store",
      signal: controller?.signal,
    });

    return response.ok ? parseNearbyOrigins(await response.json(), current) : [];
  })().catch((): string[] => []);

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
