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

/**
 * Ids from readableUniqueId (~/lib/id): capitalised words joined, e.g. "ExcitingHookwormPink".
 * From 2024 to 2026 hanab.cards also numbered them for rematches: "ExcitingHookwormPink-0".
 */
const READABLE_GAME_ID = /^(?:[A-Z][a-z]+){2,}(?:-\d+)?$/;

/** A gameId query value: links name the id explicitly, so don't assume how it was generated. */
const GAME_ID_PARAM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const URL_WITH_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** "hanab.cards/...", "localhost:3000/...": a link pasted without its scheme. */
const URL_WITHOUT_SCHEME = /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i;

/**
 * Invisible characters that copying from chat apps can leave in the text: soft hyphen,
 * zero-width spaces and joiners, direction marks, bidi embeddings and isolates, BOM.
 */
const INVISIBLE_CHARACTERS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/**
 * Brackets, quotes, chat formatting (*bold*, _italic_, `code`) and sentence punctuation
 * around a name or link pasted from a message. Languages pair quotes differently (“…”, „…“,
 * «…», »…«), so all of them count on both sides: ' " ‘ ’ ‚ ‛ “ ” „ ‟ « » ‹ ›.
 * Not "…": it marks a name or link truncated by a chat preview, which would name another room.
 */
const SURROUNDING_PUNCTUATION = /^[<([{*_`'"\u2018-\u201f\u00ab\u00bb\u2039\u203a]+|[>)\]}*_`'"\u2018-\u201f\u00ab\u00bb\u2039\u203a.,;:!?]+$/g;

function parseLink(text: string): string | null {
  let url: URL;
  try {
    if (URL_WITH_SCHEME.test(text)) {
      url = new URL(text);
    } else if (URL_WITHOUT_SCHEME.test(text)) {
      url = new URL(`https://${text}`);
    } else {
      url = new URL(text, "https://relative.invalid/");
    }
  } catch {
    return null;
  }

  // Current links: /play/?gameId=<id>, /summary/?gameId=<id>, with or without other params.
  const param = (url.searchParams.get("gameId") || "").trim();
  if (GAME_ID_PARAM.test(param)) {
    return param;
  }

  // Legacy hanab.cards links, on any host and under any base path: .../<Id> and .../<Id>/summary.
  // Path segments can be anything (base path, page names), so only a full readable id counts.
  const segments = stripBasePath(url.pathname).split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1].toLowerCase() === "summary") {
    segments.pop();
  }
  const last = segments[segments.length - 1];

  return last && READABLE_GAME_ID.test(last) ? last : null;
}

/**
 * The game id in what a player typed or pasted to join a room, or null if there is none:
 * - a room name: "ExcitingHookwormPink" (ids are case-sensitive, so the case is kept),
 * - a link to the game or its summary: ".../play/?gameId=<id>", "/summary?gameId=<id>&as=bob",
 * - a legacy hanab.cards link: "https://hanab.cards/<Id>", "https://hanab.cards/<Id>/summary",
 * - a whole invitation message containing one of these links,
 * each possibly in quotes, brackets or chat formatting, or carrying invisible characters.
 */
export function parseGameReference(input: string): string | null {
  const tokens = (input || "")
    .replace(INVISIBLE_CHARACTERS, "")
    .split(/\s+/)
    .map((token) => token.replace(SURROUNDING_PUNCTUATION, ""))
    .filter(Boolean);

  if (tokens.length === 1) {
    const [token] = tokens;
    return READABLE_GAME_ID.test(token) ? token : parseLink(token);
  }

  // In a message, only links count: a capitalised word in its text is not a room name.
  for (const token of tokens) {
    if (/[/?]/.test(token)) {
      const id = parseLink(token);
      if (id) {
        return id;
      }
    }
  }

  return null;
}
