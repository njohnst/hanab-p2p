import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import GameIndex from "~/components/GameIndex";
import LoadingScreen from "~/components/loadingScreen";
import { TutorialProvider } from "~/components/tutorial";
import { ReplayContext } from "~/hooks/replay";
import { logFailedPromise } from "~/lib/errors";
import { queryParam } from "~/lib/routes";

/**
 * The game page: /play/?gameId=<gameId> (see ~/lib/routes).
 * Rendered on the client only: the query is empty until the router is ready.
 */
export default function Play() {
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

  // Remount everything when moving to another game (e.g. "New game" at the end of one)
  return <GamePage key={gameId} gameId={gameId} />;
}

function GamePage(props: { gameId: string }) {
  const { gameId } = props;
  const [replayCursor, setReplayCursor] = useState<number>(null);

  return (
    <TutorialProvider>
      <ReplayContext.Provider value={{ cursor: replayCursor, moveCursor: setReplayCursor }}>
        <GameIndex gameId={gameId} />
      </ReplayContext.Provider>
    </TutorialProvider>
  );
}
