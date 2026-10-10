import { ID, uniqueId } from "~/lib/id";

const PLAYER_ID_KEY = "hanab.playerId";
const TAB_IDENTITY_KEY = "hanab.as";

let memoryFallback: ID = null;

function readTabIdentity(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("as");
  try {
    if (fromUrl) {
      sessionStorage.setItem(TAB_IDENTITY_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(TAB_IDENTITY_KEY);
  } catch {
    return fromUrl;
  }
}

/**
 * Stable player id for this browser. Replaces the server-side session cookie
 * the app used when it had a backend.
 *
 * Opening any page with `?as=<label>` gives the tab its own identity for the
 * rest of its life (kept in sessionStorage), so several seats can be played
 * from one browser, e.g. `/play/?gameId=Foo&as=bob`.
 *
 * Returns null during server-side rendering (static export pre-render).
 */
export function getPlayerId(): ID | null {
  if (typeof window === "undefined") {
    return null;
  }

  const label = readTabIdentity();
  const key = label ? `${PLAYER_ID_KEY}.${label}` : PLAYER_ID_KEY;

  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = uniqueId();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    memoryFallback = memoryFallback || uniqueId();
    return memoryFallback;
  }
}

/** Forget this browser's (or this tab's) player id; the next call to getPlayerId creates a new one. */
export function resetPlayerId() {
  if (typeof window === "undefined") {
    return;
  }

  const label = readTabIdentity();
  try {
    localStorage.removeItem(label ? `${PLAYER_ID_KEY}.${label}` : PLAYER_ID_KEY);
  } catch {
    memoryFallback = null;
  }
}
