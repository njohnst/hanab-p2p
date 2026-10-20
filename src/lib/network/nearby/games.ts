/**
 * Games joined in nearby mode, remembered in localStorage
 * (`hanab.nearbyGames`, at most 50, most recent first) so that a tab in
 * another mode can tell the player that a game is played nearby and offer to
 * switch (docs/P2P_DESIGN.md, "Mode").
 *
 * Every access is guarded: storage may be unavailable or hold anything.
 */
import { KeyValueStorage } from "../storage";

export const NEARBY_GAMES_KEY = "hanab.nearbyGames";
export const MAX_NEARBY_GAMES = 50;

/** Remembered game ids, most recent first. */
export function listNearbyGames(storage: KeyValueStorage | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(NEARBY_GAMES_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_NEARBY_GAMES)
      : [];
  } catch {
    return [];
  }
}

export function rememberNearbyGame(storage: KeyValueStorage | null, gameId: string) {
  if (!storage || !gameId) return;
  const games = listNearbyGames(storage);
  if (games[0] === gameId) return;
  const next = [gameId, ...games.filter((id) => id !== gameId)].slice(0, MAX_NEARBY_GAMES);
  try {
    storage.setItem(NEARBY_GAMES_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn("[network] could not remember a nearby game", e);
  }
}

export function isRememberedNearbyGame(storage: KeyValueStorage | null, gameId: string): boolean {
  return !!gameId && listNearbyGames(storage).includes(gameId);
}
