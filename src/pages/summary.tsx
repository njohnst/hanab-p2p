import classnames from "classnames";
import moment from "moment";
import { useRouter } from "next/router";
import React, { ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import shortid from "shortid";
import GameActionsStats from "~/components/gameActionsStats";
import GameBoard from "~/components/gameBoard";
import GameStats from "~/components/gameStats";
import LoadingScreen from "~/components/loadingScreen";
import PlayerStats from "~/components/playerStats";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import WaitingForGame from "~/components/waitingForGame";
import { GameContext } from "~/hooks/game";
import { newGame } from "~/lib/actions";
import { logEvent } from "~/lib/analytics";
import { logFailedPromise } from "~/lib/errors";
import { ConnectionInfo, loadGame, subscribeToConnection, subscribeToGame, updateGame } from "~/lib/network";
import { gameUrl, queryParam } from "~/lib/routes";
import IGameState, { GameVariant } from "~/lib/state";

interface SectionProps {
  children: ReactNode;
  title: string;
  className?: string;
}

function Section(props: SectionProps) {
  const { children, className, title } = props;

  return (
    <div className="mt4 w-100 flex flex-column">
      <div className="w-100 bg-black-50 pt3 pb3 bb bt b--yellow">
        <Txt className="ttu pl3 pr0 ph6.5-m ph8-l" size={TxtSize.MEDIUM} value={title} />
      </div>
      <div
        className={classnames("mt3 mt4-l w-100 pv1 ph3 ph6.5-m ph8-l mr4 mr0-m", className)}
        style={{ maxWidth: "100vw", overflowX: "scroll", overflowY: "visible" }}
      >
        {children}
      </div>
    </div>
  );
}

function formatDuration(start: number, end: number) {
  return moment.utc(moment(end).diff(start)).format("HH:mm:ss");
}

function CopiedToast({ visible, label }: { visible: boolean; label: string }) {
  if (!visible) return null;

  return (
    <div
      className="fixed z-999 bg-white black ph3 pv2 br2 shadow-2 f6 fw5"
      style={{ top: "1rem", left: "50%", transform: "translateX(-50%)" }}
    >
      {label}
    </div>
  );
}

function ShuffleSeed({ seed, onCopy }: { seed: string; onCopy: () => void }) {
  return (
    <Txt className="mt2 lavender flex items-center" size={TxtSize.MEDIUM}>
      Shuffle: {seed}
      <button className="ml2 pointer bg-transparent bn lavender o-70 glow" onClick={onCopy}>
        <svg
          fill="none"
          height="16"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="16"
        >
          <rect height="13" rx="2" ry="2" width="13" x="9" y="9" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      </button>
    </Txt>
  );
}

/**
 * The game summary: /summary/?gameId=<gameId> (see ~/lib/routes).
 * Rendered on the client only: the query is empty until the router is ready.
 */
export default function Summary() {
  const router = useRouter();
  const gameId = router.isReady ? queryParam(router.query.gameId) : null;

  useEffect(() => {
    if (router.isReady && !gameId) {
      router.replace("/").catch(logFailedPromise);
    }
  }, [router, gameId]);

  if (!gameId) {
    return <LoadingScreen />;
  }

  return <GameSummary key={gameId} gameId={gameId} />;
}

function GameSummary(props: { gameId: string }) {
  const { gameId } = props;

  const router = useRouter();
  const [game, setGame] = useState<IGameState>(null);
  const [notSharedYet, setNotSharedYet] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  /**
   * Follow the game: from this browser's replica when there is one, otherwise
   * as soon as a peer shares it.
   */
  useEffect(() => {
    return subscribeToGame(gameId, (game) => {
      setGame(game);
    });
  }, [gameId]);

  useEffect(() => {
    let cancelled = false;

    loadGame(gameId)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          setGame((current) => current || loaded);
        } else {
          setNotSharedYet(true);
        }
      })
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
    };
  }, [gameId]);

  useEffect(() => {
    return subscribeToConnection(gameId, setConnection);
  }, [gameId]);

  function onBackClick() {
    router.push(gameUrl(gameId)).catch(logFailedPromise);
  }

  function gameVariantToText(gameVariant: GameVariant) {
    switch (gameVariant) {
      case GameVariant.CLASSIC:
        return t("classicVariant");
      case GameVariant.MULTICOLOR:
        return t("multicolorVariant");
      case GameVariant.RAINBOW:
        return t("rainbowVariant");
      case GameVariant.CRITICAL_RAINBOW:
        return t("criticalRainbowVariant");
      case GameVariant.ORANGE:
        return t("orangeVariant");
      case GameVariant.SEQUENCE:
        return t("sequenceVariant");
      default:
        return "UNKNOWN";
    }
  }

  function onCopySeed() {
    navigator.clipboard.writeText(game.options.seed);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!game) {
    return <WaitingForGame connection={connection} gameId={gameId} notSharedYet={notSharedYet} />;
  }

  const gameDuration = game.startedAt && game.endedAt ? formatDuration(game.startedAt, game.endedAt) : null;
  const shortSeed = game.options.seed ? game.options.seed.slice(0, 4) + "∗∗∗∗" + game.options.seed.slice(-4) : "";

  return (
    <GameContext.Provider value={game}>
      <CopiedToast label={t("copied")} visible={copied} />
      <div className="flex flex-column items-center pv4">
        <Button
          void
          className="absolute left-0 top-1"
          size={ButtonSize.MEDIUM}
          text={`< ${t("back")}`}
          onClick={() => onBackClick()}
        />
        <Txt className="mt4" size={TxtSize.LARGE} value={t("summary")} />
        <div className="flex flex-column items-center mt4">
          <Txt size={TxtSize.MEDIUM} value={t("summarySubtitle")} />
          <Txt className="mt2" size={TxtSize.MEDIUM}>
            Players: {game.players.length} · Mode: {gameVariantToText(game.options.variant)}
          </Txt>
          <ShuffleSeed seed={shortSeed} onCopy={onCopySeed} />
          {gameDuration && <Txt className="mt2" size={TxtSize.MEDIUM} value={t("gameCompleted", { gameDuration })} />}
        </div>

        <Section title={t("result")}>
          <GameBoard />
        </Section>

        <Section title={t("evolution")}>
          <Txt className="db mb3" size={TxtSize.SMALL} value={t("evolutionSubtext")} />
          <GameStats />
        </Section>

        <Section className="flex justify-center-l" title={t("playerActions")}>
          {game.players.map((player, i) => {
            return (
              <div key={i} className="flex flex-column items-center mh3 mh4-m">
                <Txt value={player.name} />
                <div className="mt2 mh2">
                  <PlayerStats player={player} />
                </div>
              </div>
            );
          })}
        </Section>

        <Section title={t("playerHints")}>
          <GameActionsStats />
        </Section>

        <Section className="tc" title={t("tryOutTitle")}>
          <div>
            <Txt size={TxtSize.MEDIUM}>
              Players: {game.players.length} · Mode: {gameVariantToText(game.options.variant)}
            </Txt>
            <div className="mt2 flex items-center justify-center">
              <ShuffleSeed seed={shortSeed} onCopy={onCopySeed} />
            </div>
            <Button
              primary
              className="ml3 mt4"
              text={t("tryOutButton")}
              onClick={async () => {
                const nextGameId = shortid();
                const nextGame = newGame({
                  ...game.options,
                  id: nextGameId,
                });

                await updateGame(nextGame);
                await updateGame({ ...game, nextGameId: nextGameId });

                logEvent("Game", "Game created");

                await router.push(gameUrl(nextGame.id));
              }}
            />
          </div>
          <div className="mt4">
            <Txt>
              <Trans i18nKey="tryOutAlternative">
                You can also play with other setups and meet our AI on
                <a className="lavender" href="https://hanab.cards">
                  hanab.cards
                </a>
              </Trans>
            </Txt>
          </div>
        </Section>
      </div>
    </GameContext.Provider>
  );
}
