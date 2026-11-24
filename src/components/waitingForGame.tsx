import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import HomeButton from "~/components/homeButton";
import OnlineConnectionFailure from "~/components/onlineConnectionFailure";
import NearbyJoin from "~/components/nearbyJoin";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNetworkMode } from "~/hooks/networkMode";
import { ConnectionInfo } from "~/lib/network";

interface Props {
  gameId: string;
  /** loadGame gave up: no peer has shared the game yet (they may still come). */
  notSharedYet: boolean;
  connection: ConnectionInfo | null;
}

/**
 * Shown while this browser has no copy of the game: it arrives as soon as a
 * peer that has it connects, so never treat the game as nonexistent.
 * In nearby mode, peers only connect through an invitation: say how to get one.
 */
export default function WaitingForGame(props: Props) {
  const { gameId, notSharedYet, connection } = props;
  const { t } = useTranslation();
  const mode = useNetworkMode();
  const [scanning, setScanning] = useState(false);

  const hasPeers = !!connection?.peers.length;
  const canShowFallback = (mode === "webrtc" || mode === "nearby") && (!hasPeers || scanning);
  let title = t("unified.connectingOnline");
  let detail = t("unified.connectingHelp");

  if (hasPeers) {
    title = t("unified.waitingForData");
    detail = null;
  } else if (connection?.connectionFailure) {
    title = t("onlineFailure.title");
    detail = t("onlineFailure.description");
  } else if (notSharedYet && mode !== "local") {
    title = t("unified.noPlayersConnected");
    detail = t("unified.keepInviterOpen");
  } else if (mode === "nearby") {
    title = t("connectingToGame");
    detail = t("unified.nearbyWaiting");
  } else if (mode === "local") {
    title = t("connectingToGame");
    detail = t(notSharedYet ? "waitingForGameShareLong" : "waitingForGameShare");
  }

  return (
    <div className="relative w-100 h-100 overflow-y-auto flex flex-column justify-center items-center bg-main-dark pa3 pv4-l ph3-l shadow-5 br3 tc">
      <HomeButton className="absolute top-1 right-1" />
      <div className="flex flex-column mw6" role="status">
        <Txt size={TxtSize.MEDIUM} value={title} />
        {detail && <Txt className="lavender mt3" value={detail} />}
      </div>
      {canShowFallback && (
        <div className="mt4 w-100 mw6">
          {mode === "webrtc" && !scanning && (
            <Txt className="db lavender mb2" size={TxtSize.SMALL} value={t("unified.offlinePrompt")} />
          )}
          <Button
            outlined
            aria-expanded={scanning}
            size={ButtonSize.SMALL}
            text={t("unified.connectWithoutInternet")}
            onClick={() => setScanning((current) => !current)}
          />
          {scanning && (
            <div className="mt3">
              <NearbyJoin scanHint={t("unified.offlineScanHint")} />
            </div>
          )}
        </div>
      )}
      <Txt className="gray mt3" size={TxtSize.XSMALL} value={gameId} />
      <OnlineConnectionFailure connection={connection} />
      {connection?.error && <Txt className="red mt3" value={connection.error} />}
    </div>
  );
}
