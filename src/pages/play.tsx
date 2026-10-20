import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import GameIndex from "~/components/GameIndex";
import LoadingScreen from "~/components/loadingScreen";
import { SwitchToNearbyBanner } from "~/components/nearbyBanners";
import { TutorialProvider } from "~/components/tutorial";
import { useKeepAwake, useLeaveWarning } from "~/hooks/keepAwake";
import { useNearbyLinks, useNetworkMode } from "~/hooks/networkMode";
import { ReplayContext } from "~/hooks/replay";
import { logFailedPromise } from "~/lib/errors";
import { isNearbyGame } from "~/lib/network";
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
    <>
      <TutorialProvider>
        <ReplayContext.Provider value={{ cursor: replayCursor, moveCursor: setReplayCursor }}>
          <GameIndex gameId={gameId} />
        </ReplayContext.Provider>
      </TutorialProvider>
      <NearbyPlay gameId={gameId} />
    </>
  );
}

/**
 * Nearby play around the game (docs/P2P_DESIGN.md, "Nearby play (no internet)"):
 * - in nearby mode, while links to other devices are open, keep the screen awake and ask before
 *   leaving the page: a reload or a phone locking itself loses the links;
 * - in another mode, for a game this browser played nearby, offer to switch to nearby mode.
 */
function NearbyPlay(props: { gameId: string }) {
  const { gameId } = props;
  const mode = useNetworkMode();
  const links = useNearbyLinks(mode === "nearby");
  const linked = !!links?.some((link) => link.state === "open");
  const [playedNearby, setPlayedNearby] = useState(false);

  useKeepAwake(linked);
  useLeaveWarning(linked);

  useEffect(() => {
    setPlayedNearby(isNearbyGame(gameId));
  }, [gameId]);

  return mode && mode !== "nearby" && playedNearby ? <SwitchToNearbyBanner /> : null;
}
