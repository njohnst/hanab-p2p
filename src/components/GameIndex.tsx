import dynamic from "next/dynamic";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Game } from "~/components/game";
import Toast, { useToast } from "~/components/toast";
import WaitingForGame from "~/components/waitingForGame";
import { ConnectionContext } from "~/hooks/connection";
import { GameContext } from "~/hooks/game";
import { loadUserPreferences, UserPreferencesContext } from "~/hooks/userPreferences";
import { logFailedPromise } from "~/lib/errors";
import {
  ConnectionInfo,
  loadGame,
  RejectionReason,
  subscribeToConnection,
  subscribeToGame,
  subscribeToRejections,
} from "~/lib/network";
import IGameState from "~/lib/state";

interface Props {
  gameId: string;
}

function SsrFreeGameIndex(props: Props) {
  const { gameId } = props;
  const [userPreferences, setUserPreferences] = useState(loadUserPreferences());
  const [game, setGame] = useState<IGameState>(null);
  const [notSharedYet, setNotSharedYet] = useState(false);
  const [connection, setConnection] = useState<ConnectionInfo>(null);
  const { toast, showToast, dismissToast } = useToast();
  const { t } = useTranslation();

  /**
   * Follow the game: from this browser's replica when there is one, otherwise
   * as soon as a peer shares it.
   */
  useEffect(() => {
    return subscribeToGame(gameId, (game) => {
      setGame({ ...game, synced: true });
    });
  }, [gameId]);

  /**
   * Tell "connecting" apart from "nobody has shared it yet" for the waiting screen.
   */
  useEffect(() => {
    let cancelled = false;

    loadGame(gameId)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          setGame((current) => current || { ...loaded, synced: true });
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

  /**
   * Tell the player when the authority refuses one of this tab's writes. The
   * network layer has already re-delivered the authoritative state through
   * subscribeToGame, so a message is all that is left to do.
   */
  useEffect(() => {
    const getMessage = (reason: RejectionReason): string => {
      switch (reason) {
        case "turn-conflict":
          return t("rejectionTurnConflict", "The turn moved on before your action arrived, so it wasn't applied.");
        case "game-full":
          return t("rejectionGameFull", "This game is already full.");
        case "game-started":
          return t("rejectionGameStarted", "This game has already started. You can still watch.");
        default:
          return t("rejectionInvalid", "Your last action couldn't be applied.");
      }
    };

    return subscribeToRejections(gameId, (rejection) => {
      showToast(getMessage(rejection.reason));
    });
  }, [gameId, showToast, t]);

  /** A message about the previous game has nothing to do on this one's screen. */
  useEffect(() => {
    dismissToast();
  }, [gameId, dismissToast]);

  return (
    <>
      {game ? (
        <GameContext.Provider value={game}>
          <ConnectionContext.Provider value={connection}>
            <UserPreferencesContext.Provider value={[userPreferences, setUserPreferences]}>
              <Game onGameChange={setGame} />
            </UserPreferencesContext.Provider>
          </ConnectionContext.Provider>
        </GameContext.Provider>
      ) : (
        <WaitingForGame connection={connection} gameId={gameId} notSharedYet={notSharedYet} />
      )}
      {/* Rendered in both cases so the live region stays mounted when the game arrives. */}
      <Toast toast={toast} onDismiss={dismissToast} />
    </>
  );
}

const GameIndex = dynamic(() => Promise.resolve(SsrFreeGameIndex), {
  ssr: false,
});
export default GameIndex;
