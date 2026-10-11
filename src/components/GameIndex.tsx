import dynamic from "next/dynamic";
import React, { useEffect, useState } from "react";
import { Game } from "~/components/game";
import WaitingForGame from "~/components/waitingForGame";
import { ConnectionContext } from "~/hooks/connection";
import { GameContext } from "~/hooks/game";
import { loadUserPreferences, UserPreferencesContext } from "~/hooks/userPreferences";
import { logFailedPromise } from "~/lib/errors";
import { ConnectionInfo, loadGame, subscribeToConnection, subscribeToGame } from "~/lib/network";
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

  if (!game) {
    return <WaitingForGame connection={connection} gameId={gameId} notSharedYet={notSharedYet} />;
  }

  return (
    <GameContext.Provider value={game}>
      <ConnectionContext.Provider value={connection}>
        <UserPreferencesContext.Provider value={[userPreferences, setUserPreferences]}>
          <Game onGameChange={setGame} />
        </UserPreferencesContext.Provider>
      </ConnectionContext.Provider>
    </GameContext.Provider>
  );
}

const GameIndex = dynamic(() => Promise.resolve(SsrFreeGameIndex), {
  ssr: false,
});
export default GameIndex;
