import React from "react";
import { useTranslation } from "react-i18next";
import HomeButton from "~/components/homeButton";
import Txt, { TxtSize } from "~/components/ui/txt";
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
 */
export default function WaitingForGame(props: Props) {
  const { gameId, notSharedYet, connection } = props;
  const { t } = useTranslation();

  const peersCount = connection?.peers.length ?? 0;

  return (
    <div className="relative w-100 h-100 flex flex-column justify-center items-center bg-main-dark pa3 pv4-l ph3-l shadow-5 br3 tc">
      <HomeButton className="absolute top-1 right-1" />
      <Txt size={TxtSize.MEDIUM} value={t("connectingToGame", "Connecting to the game…")} />
      <Txt
        className="lavender mt3"
        value={
          notSharedYet
            ? t(
                "waitingForGameShareLong",
                "No one has shared this game with you yet. Keep this page open: it will load as soon as another player who has it is online."
              )
            : t("waitingForGameShare", "Waiting for another player to share it…")
        }
      />
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
