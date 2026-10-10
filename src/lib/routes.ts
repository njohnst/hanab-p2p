/**
 * Every in-app URL is built here (see docs/P2P_DESIGN.md, "Routing").
 *
 * The static export cannot pre-render pages for unknown game ids, so games
 * live at /play/?gameId=<id> and summaries at /summary/?gameId=<id>.
 *
 * - gameUrl, summaryUrl and learnUrl return paths WITHOUT the base path: give
 *   them to next/router or next/link, which add it.
 * - withBasePath is for raw URLs the router doesn't see: <a href>, <img src>,
 *   next/image src, Audio, location.assign, manifest links...
 * - absoluteGameUrl is the full link to share (copy, QR code).
 */

/** Keep in sync with normalizeBasePath in next.config.js. */
function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

type QueryParams = Record<string, string | null | undefined>;

function withQuery(pathname: string, params: QueryParams): string {
  const search = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return search ? `${pathname}?${search}` : pathname;
}

/** Prefix an absolute in-app path ("/static/...") with the base path. */
export function withBasePath(path: string): string {
  if (!path.startsWith("/")) {
    return path;
  }

  return `${BASE_PATH}${path}`;
}

/** Strip the base path from a location pathname (e.g. window.location.pathname). */
export function stripBasePath(pathname: string): string {
  if (!BASE_PATH) {
    return pathname;
  }
  if (pathname === BASE_PATH) {
    return "/";
  }
  if (pathname.startsWith(`${BASE_PATH}/`)) {
    return pathname.slice(BASE_PATH.length);
  }

  return pathname;
}

/** The game page. Extra params are appended to the query (e.g. { "back-to-game": id }). */
export function gameUrl(gameId: string, params: QueryParams = {}): string {
  return withQuery("/play/", { gameId, ...params });
}

export function summaryUrl(gameId: string): string {
  return withQuery("/summary/", { gameId });
}

/** The tutorial, optionally offering to go back to `backToGameId` afterwards. */
export function learnUrl(backToGameId?: string): string {
  return withQuery("/learn/", { "back-to-game": backToGameId });
}

/** Full URL of a game (origin + base path + path), for share links and QR codes. */
export function absoluteGameUrl(gameId: string): string {
  const path = withBasePath(gameUrl(gameId));
  if (typeof window === "undefined") {
    return path;
  }

  return `${window.location.origin}${path}`;
}

/** Normalise a Next.js query value (string | string[] | undefined) to a single string. */
export function queryParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  return value || null;
}
