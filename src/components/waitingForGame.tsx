import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import NearbyJoin from "~/components/nearbyJoin";
import HomeButton from "~/components/homeButton";
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
  const canScan = useNetworkMode() !== "local";
  const [scanning, setScanning] = useState(false);

  const peersCount = connection?.peers.length ?? 0;

  const longMessage = t("unified.waiting");

  return (
    <div className="relative w-100 h-100 overflow-y-auto flex flex-column justify-center items-center bg-main-dark pa3 pv4-l ph3-l shadow-5 br3 tc">
      <HomeButton className="absolute top-1 right-1" />
      <Txt size={TxtSize.MEDIUM} value={t("connectingToGame", "Connecting to the game…")} />
      <Txt
        className="lavender mt3"
        value={notSharedYet ? longMessage : t("waitingForGameShare", "Waiting for another player to share it…")}
      />
      {canScan && peersCount === 0 && (
        <Button
          primary
          className="mt3"
          size={ButtonSize.SMALL}
          text={t("unified.connectByQr")}
          onClick={() => setScanning(!scanning)}
        />
      )}
      {scanning && (
        <div className="mt3 w-100 mw6">
          <NearbyJoin />
        </div>
      )}
      <Txt className="gray mt3" size={TxtSize.XSMALL} value={gameId} />
      {connection && connection.status !== "local" && (
        <Txt
          className="gray mt1"
          size={TxtSize.XSMALL}
          value={t("connectedPeers", "{{count}} player(s) connected", { count: peersCount })}
        />
      )}
      {connection?.error && <Txt className="red mt3" value={connection.error} />}
    </div>
  );
}
