import classnames from "classnames";
import Fireworks from "fireworks-canvas";
import Head from "next/head";
import Image from "next/legacy/image";
import Link from "next/link";
import { useRouter } from "next/router";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import LanguageSelector from "~/components/languageSelector";
import { NearbyModeBanner } from "~/components/nearbyBanners";
import Rules from "~/components/rules";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNetworkMode } from "~/hooks/networkMode";
import { useSession } from "~/hooks/session";
import { logFailedPromise } from "~/lib/errors";
import { openNearbyPage } from "~/lib/nearbyPlay";
// Types only: the sync engine and the game logic are loaded once the page is up (see Home).
import type { RecentGame } from "~/lib/network";
import { gameUrl, withBasePath } from "~/lib/routes";
import type { IGameStatus } from "~/lib/state";

/** How many of this browser's games the home page offers to go back to. */
const MAX_RECENT_GAMES = 5;

/** A game replica this browser stores (`getNetworkNode().store.list()`), reduced to what the list reads. */
export interface StoredGame {
  updatedAt: number;
  game: {
    id: string;
    status: IGameStatus;
    players: { id: string; name: string }[];
    options: { tutorial?: boolean };
  };
}

/**
 * The games worth going back to: those `playerId` joined, tutorial runs aside. The browser
 * also stores the games it only looked at (an invite or summary link opened without joining,
 * a spectated game). Games still in their lobby or in progress come first, then the finished
 * ones, most recently updated first within each group.
 */
export function pickRecentGames(replicas: StoredGame[], playerId: string | null): RecentGame[] {
  if (!playerId) return [];

  const rank = (game: RecentGame) => (game.status === "over" ? 1 : 0);

  return replicas
    .filter(({ game }) => !game.options?.tutorial && (game.players || []).some((player) => player.id === playerId))
    .map(({ game, updatedAt }) => ({
      id: game.id,
      status: game.status,
      playersNames: game.players.map((player) => player.name),
      updatedAt,
    }))
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECENT_GAMES);
}

function RecentGameRow(props: { game: RecentGame }) {
  const { game } = props;
  const { t } = useTranslation();

  const names = game.playersNames.filter(Boolean).join(", ") || game.id;

  let status: { label: string; className: string };
  switch (game.status) {
    case "lobby":
      status = { label: t("recentGames.lobby", "Waiting in lobby"), className: "txt-yellow" };
      break;
    case "over":
      status = { label: t("recentGames.over", "Finished"), className: "lavender" };
      break;
    default:
      status = { label: t("recentGames.ongoing", "In progress"), className: "txt-green" };
  }

  // Finished games open on their final board too: from there the table can follow the
  // next game someone already started (or start one), and the summary is one click away.
  return (
    <Link
      className="flex items-center w-100 pv2 ph3 br2 ba b--white-20 bg-white-10 hover-bg-white-20 near-white no-underline"
      href={gameUrl(game.id)}
    >
      <span className="flex flex-column flex-auto">
        <Txt className="truncate" multiline={false} value={names} />
        <Txt className={classnames("ttu tracked", status.className)} size={TxtSize.XXSMALL} value={status.label} />
      </span>
      <span aria-hidden="true" className="ml2 lavender">
        ›
      </span>
    </Link>
  );
}

export default function Home() {
  const router = useRouter();
  const { t } = useTranslation();
  const { playerId } = useSession();
  const mode = useNetworkMode();
  const [recentGames, setRecentGames] = useState<RecentGame[]>([]);
  const rulesRef = useRef<HTMLDivElement>();
  const fireworksRef = useRef();

  // The page is pre-rendered without access to localStorage: only list the games it holds once mounted,
  // and again when the tab comes back to the foreground (they may have moved on in another tab).
  // ~/lib/network (the sync engine and the game logic) is fetched then rather than with the page:
  // nothing else here needs it, and a first visit has no game to list.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      import("~/lib/network")
        .then(({ getNetworkNode }) => {
          if (cancelled) return;
          setRecentGames(pickRecentGames(getNetworkNode()?.store.list() ?? [], playerId));
        })
        .catch(logFailedPromise);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [playerId]);

  useEffect(() => {
    router.prefetch("/new-game").catch(logFailedPromise);
    router.prefetch("/join-game").catch(logFailedPromise);
    router.prefetch("/learn").catch(logFailedPromise);
  }, [router]);

  /**
   * Display fireworks animation when game ends
   */
  useEffect(() => {
    const fireworks = new Fireworks(fireworksRef.current, {
      maxRockets: 15, // max # of rockets to spawn
      rocketSpawnInterval: 150, // milliseconds to check if new rockets should spawn
      numParticles: 100, // number of particles to spawn when rocket explodes (+0-10)
      explosionMinHeight: 10, // minimum percentage of height of container at which rockets explode
      explosionChance: 1, // chance in each tick the rocket will explode
    });
    fireworks.start();

    const timeout = setTimeout(() => {
      fireworks.stop();
    }, 1500);

    return () => clearTimeout(timeout);
  }, []);

  return (
    <div
      className="relative w-100 overflow-y-scroll flex flex-column justify-center items-center pa2 pv4-l ph3-l shadow-5 br3"
      style={{
        backgroundImage: "linear-gradient(to bottom right, #001030, #00133d)",
      }}
    >
      <Head>
        <title>Hanab</title>
      </Head>
      <div className="absolute top-1 right-2">
        <LanguageSelector outlined />
      </div>
      {/* Grows past the screen height (instead of overflowing it) when the games list makes it taller */}
      <div className="min-vh-100 pv4 flex flex-column items-center justify-center">
        {mode === "nearby" && <NearbyModeBanner className="mt4 mb4" />}
        <div className="flex flex-column items-center">
          <div className="mb4 w4 h4">
            <Image
              alt={t("landingImageAlt", "Hanabcards game online logo")}
              height={256}
              priority={true}
              src={withBasePath("/static/hanab.png")}
              width={256}
            />
          </div>
          <Txt size={TxtSize.LARGE} value={t("hanab", "Hanab")} />
        </div>
        <span className="tc lavender">{t("tagline", "Play the Hanab game online with friends!")}</span>
        <main className="flex flex-column mt5">
          <Button
            primary
            className="mb4"
            id="create-room"
            size={ButtonSize.LARGE}
            text={t("createRoom", "Create a room")}
            onClick={() => router.push("/new-game")}
          />
          <Button
            className="mb4"
            id="join-room"
            size={ButtonSize.LARGE}
            text={t("joinRoom", "Join a room")}
            onClick={() => router.push("/join-game")}
          />
          <Button
            className="mb4"
            id="tutorial"
            size={ButtonSize.LARGE}
            onClick={() => {
              router.push("/learn").catch(logFailedPromise);
            }}
          >
            {t("learnHanab", "Learn")}
            <Txt className="ml2" size={TxtSize.XXSMALL}>
              {t("learnHanabTime", "~5 mn")}
            </Txt>
          </Button>
          {/* Opens /nearby/ with a page load, which puts the tab in nearby mode (once there, the banner above says so). */}
          {mode !== "nearby" && (
            <Button
              outlined
              className="mb4"
              id="play-nearby"
              size={ButtonSize.MEDIUM}
              text={t("nearby.playWithoutInternet")}
              onClick={() => openNearbyPage(router).catch(logFailedPromise)}
            />
          )}

          {recentGames.length > 0 && (
            // Zero intrinsic width: takes the buttons' width rather than widening the column to fit long names
            <section aria-labelledby="recent-games-title" id="recent-games" style={{ width: 0, minWidth: "100%" }}>
              <h2 className="ma0 mb2 tc normal f6 f5-l ttu tracked lavender" id="recent-games-title">
                {t("recentGames.title", "Your games")}
              </h2>
              <ul className="list ma0 pa0">
                {recentGames.map((game, i) => (
                  <li key={game.id} className={i > 0 ? "mt2" : undefined}>
                    <RecentGameRow game={game} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <span
            className="flex flex-column items-center link white pointer mt4"
            onClick={() => {
              rulesRef.current.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <span>{t("whatsHanab", "What's Hanab?")}</span>
            <span>⌄</span>
          </span>
        </main>
      </div>
      <div ref={rulesRef}>
        <Rules />
      </div>
      <div ref={fireworksRef} className="fixed absolute--fill z-999" style={{ pointerEvents: "none" }} />
    </div>
  );
}
