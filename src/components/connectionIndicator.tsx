import { useRouter } from "next/router";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowContainer, Popover } from "react-tiny-popover";
import { NearbyInviteModal } from "~/components/nearbyInvite";
import { POPOVER_ARROW_COLOR, POPOVER_CONTENT_STYLE } from "~/components/popoverAppearance";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useConnection } from "~/hooks/connection";
import { useGame } from "~/hooks/game";
import { useNetworkMode } from "~/hooks/networkMode";
import { useSession } from "~/hooks/session";
import { logFailedPromise } from "~/lib/errors";
import { NEARBY_PAGE } from "~/lib/nearbyPlay";
import { ConnectionInfo } from "~/lib/network";
import IGameState, { IPlayer } from "~/lib/state";

type Tone = "good" | "partial" | "pending" | "bad";

const DotClasses: Record<Tone, string> = {
  good: "bg-green",
  partial: "bg-gold",
  pending: "bg-gray",
  bad: "bg-red",
};

function Dot(props: { tone: Tone; className?: string }) {
  return (
    <span
      aria-hidden
      className={`dib br-100 flex-shrink-0 ${DotClasses[props.tone]} ${props.className || ""}`}
      style={{ width: 8, height: 8 }}
    />
  );
}

interface Presence {
  humans: IPlayer[];
  isOnline: (player: IPlayer) => boolean;
  onlineCount: number;
  watchingCount: number;
}

function getPresence(game: IGameState, connection: ConnectionInfo, selfPlayerId: string | null): Presence {
  const peerPlayerIds = new Set(connection.peers.map((peer) => peer.playerId).filter(Boolean));
  const isOnline = (player: IPlayer) => player.id === selfPlayerId || peerPlayerIds.has(player.id);
  const humans = game.players.filter((player) => !player.bot);
  const watchingCount = Array.from(peerPlayerIds).filter((id) => !game.players.some((player) => player.id === id))
    .length;

  return { humans, isOnline, onlineCount: humans.filter(isOnline).length, watchingCount };
}

/**
 * Header badge showing how this tab is connected to the game's peer-to-peer
 * room, with details (who is connected, who is hosting) in a popover.
 * Hidden for pass & play and tutorial games, which never go online.
 *
 * In nearby mode (no internet) it says "nearby" rather than "online", and its
 * details offer to invite a nearby player (the QR handshake, in a dialog) and,
 * when nobody is connected, explain how this device gets back in.
 */
export default function ConnectionIndicator() {
  const { t } = useTranslation();
  const game = useGame();
  const connection = useConnection();
  const { playerId } = useSession();
  const [open, setOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const nearby = useNetworkMode() === "nearby";

  if (!game || !connection || connection.status === "local") {
    return null;
  }

  const presence = getPresence(game, connection, playerId);
  const { humans, onlineCount } = presence;

  let tone: Tone;
  let label: string;
  if (connection.error) {
    tone = "bad";
    label = t("connectionProblem");
  } else if (connection.status === "offline") {
    tone = "bad";
    label = t("connectionOffline");
  } else if (connection.status === "connecting") {
    tone = "pending";
    label = t("connectionConnecting");
  } else if (humans.length === 0) {
    tone = "good";
    label = nearby ? t("nearby.indicator") : t("connectionOnline");
  } else {
    tone = onlineCount === humans.length ? "good" : "partial";
    label = t(nearby ? "nearby.playersNearby" : "playersOnline", { online: onlineCount, total: humans.length });
  }

  function onInvite() {
    // The dialog lives here: the popover unmounts its content when a click lands outside it.
    setOpen(false);
    setInviting(true);
  }

  return (
    <>
      <Popover
        containerClassName="z-999"
        content={({ position, childRect, popoverRect }) => (
          <ArrowContainer
            arrowColor={POPOVER_ARROW_COLOR}
            arrowSize={10}
            arrowStyle={{ opacity: 1 }}
            childRect={childRect}
            popoverRect={popoverRect}
            position={position}
          >
            <ConnectionDetails
              connection={connection}
              presence={presence}
              selfPlayerId={playerId}
              onInvite={nearby ? onInvite : undefined}
            />
          </ArrowContainer>
        )}
        isOpen={open}
        padding={5}
        positions={["bottom", "left"]}
        onClickOutside={() => setOpen(false)}
      >
        <button
          aria-expanded={open}
          aria-label={`${t("connectionTitle")}: ${label}`}
          className="relative z-1 flex items-center bg-transparent bn pointer pa1 mr1 color-inherit"
          id="connection-indicator"
          type="button"
          onClick={() => setOpen(!open)}
        >
          <Dot className="mr1" tone={tone} />
          <Txt className="nowrap" size={TxtSize.XSMALL} value={label} />
        </button>
      </Popover>
      {inviting && <NearbyInviteModal gameId={game.id} onClose={() => setInviting(false)} />}
    </>
  );
}

interface DetailsProps {
  connection: ConnectionInfo;
  presence: Presence;
  selfPlayerId: string | null;
  /** Nearby mode: invite a nearby player (opens the invitation dialog). */
  onInvite?: () => void;
}

function ConnectionDetails(props: DetailsProps) {
  const { connection, presence, selfPlayerId, onInvite } = props;
  const router = useRouter();
  const { humans, isOnline, onlineCount, watchingCount } = presence;
  const { t } = useTranslation();
  const connected = connection.status === "connected" || connection.status === "alone";

  return (
    <div className="ba bw1 bg-black pa2 br2 mw5" style={POPOVER_CONTENT_STYLE}>
      <Txt className="db ttu txt-yellow mb2" size={TxtSize.XSMALL} value={t("connectionTitle")} />

      {humans.map((player) => (
        <div key={player.id} className="flex items-center mb1">
          <Dot className="mr2" tone={isOnline(player) ? "good" : "pending"} />
          <Txt
            className="flex-grow-1 mr2"
            size={TxtSize.XSMALL}
            value={player.id === selfPlayerId ? `${player.name} (${t("you")})` : player.name}
          />
          <Txt
            className="gray nowrap"
            size={TxtSize.XSMALL}
            value={isOnline(player) ? t("playerConnected") : t("playerNotConnected")}
          />
        </div>
      ))}

      {watchingCount > 0 && (
        <Txt className="db gray mt1" size={TxtSize.XSMALL} value={t("spectatorsWatching", { count: watchingCount })} />
      )}

      {connected && humans.length > 1 && onlineCount < humans.length && (
        <Txt className="db lavender mt2" size={TxtSize.XSMALL} value={t("connectionWaitingForOthers")} />
      )}

      {connected && (
        <Txt
          multiline
          className="db gray mt2"
          size={TxtSize.XSMALL}
          value={connection.isAuthority ? t("connectionHosting") : t("connectionHostedElsewhere")}
        />
      )}

      {connection.error && <Txt multiline className="db red mt2" size={TxtSize.XSMALL} value={connection.error} />}

      {onInvite && connection.peers.length === 0 && (
        <>
          <Txt multiline className="db lavender mt2" size={TxtSize.XSMALL} value={t("nearby.inviteAgainHint")} />
          <Button
            outlined
            className="mt2 w-100"
            size={ButtonSize.TINY}
            onClick={() => router.push(NEARBY_PAGE).catch(logFailedPromise)}
          >
            <Txt size={TxtSize.XSMALL} value={t("nearby.scanInvitation")} />
          </Button>
        </>
      )}

      {onInvite && (
        <Button primary className="mt2 w-100" id="invite-nearby-player" size={ButtonSize.TINY} onClick={onInvite}>
          <Txt size={TxtSize.XSMALL} value={t("nearby.invite.button")} />
        </Button>
      )}
    </div>
  );
}
