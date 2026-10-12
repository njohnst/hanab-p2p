/**
 * The home page's "Your games" list (src/pages/index.tsx). Tests can't sit next to
 * the page: Next.js would publish any file under src/pages as a page.
 */
import { describe, expect, it, vi } from "vitest";
import type { IGameStatus } from "~/lib/state";
import { pickRecentGames, StoredGame } from "~/pages/index";

// Which of the heavy modules loading the page pulls in (they are loaded for real, only recorded).
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("~/lib/network", async (importOriginal) => {
  loaded.add("~/lib/network");
  return importOriginal();
});
vi.mock("~/lib/state", async (importOriginal) => {
  loaded.add("~/lib/state");
  return importOriginal();
});

const ME = "me";

function stored(
  id: string,
  status: `${IGameStatus}`,
  updatedAt: number,
  playerIds: string[],
  options: { tutorial?: boolean } = {}
): StoredGame {
  return {
    updatedAt,
    game: {
      id,
      status: status as IGameStatus,
      players: playerIds.map((playerId) => ({ id: playerId, name: `${playerId} in ${id}` })),
      options,
    },
  };
}

describe("pickRecentGames", () => {
  it("only lists the games this browser's player joined, tutorial runs aside", () => {
    const replicas = [
      stored("Played", "over", 100, ["bot", ME]),
      // Opened from an invite (or a summary link) and left without joining, or spectated.
      stored("Spectated", "ongoing", 200, ["alice", "bob"]),
      stored("Tutorial", "ongoing", 300, [ME, "bot1", "bot2"], { tutorial: true }),
      stored("Waiting", "lobby", 50, [ME]),
    ];

    expect(pickRecentGames(replicas, ME)).toEqual([
      { id: "Waiting", status: "lobby", playersNames: ["me in Waiting"], updatedAt: 50 },
      { id: "Played", status: "over", playersNames: ["bot in Played", "me in Played"], updatedAt: 100 },
    ]);
  });

  it("lists the games still going first, then the finished ones, most recent first, five at most", () => {
    const replicas = [
      stored("Over1", "over", 600, [ME]),
      stored("Ongoing1", "ongoing", 100, [ME]),
      stored("Over2", "over", 700, [ME]),
      stored("Lobby1", "lobby", 300, [ME]),
      stored("Ongoing2", "ongoing", 200, [ME]),
      stored("Over3", "over", 500, [ME]),
    ];

    expect(pickRecentGames(replicas, ME).map((game) => game.id)).toEqual([
      "Lobby1",
      "Ongoing2",
      "Ongoing1",
      "Over2",
      "Over1",
    ]);
  });

  it("lists nothing without a player id (pre-render)", () => {
    expect(pickRecentGames([stored("Played", "over", 100, [ME])], null)).toEqual([]);
  });
});

describe("Home page", () => {
  /**
   * The list is read from the replicas once mounted, through a dynamic import:
   * loading the sync engine and the game logic with the page would make every
   * visit download and parse them before the landing page is interactive.
   */
  it("loads neither the sync engine nor the game logic with the page", () => {
    expect(Array.from(loaded)).toEqual([]);
  });
});
