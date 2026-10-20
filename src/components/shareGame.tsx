import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NearbyInvite, NearbyInviteModal } from "~/components/nearbyInvite";
import QrCode from "~/components/qrCode";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNetworkMode } from "~/hooks/networkMode";
import { copyText } from "~/lib/clipboard";
import { absoluteGameUrl } from "~/lib/routes";

interface Props {
  gameId: string;
  className?: string;
  /**
   * The player just asked to invite (the in-game menu's "Invite players"): in nearby mode, start
   * the invitation at once instead of offering a button for it.
   */
  inviteNow?: boolean;
}

/**
 * Invite panel for network games. Online: a QR code of the game link, the link itself, a Copy
 * button and, where the device supports it, the native Share sheet. In nearby mode (no internet),
 * the game link would lead nowhere: players are invited with the nearby QR handshake instead
 * (~/components/nearbyInvite).
 */
export default function ShareGame(props: Props) {
  const mode = useNetworkMode();

  if (mode === null) {
    return null;
  }

  return mode === "nearby" ? <NearbyShareGame {...props} /> : <OnlineShareGame {...props} />;
}

function OnlineShareGame(props: Props) {
  const { gameId, className = "" } = props;
  const { t } = useTranslation();

  // Browser-only values, resolved after mount so pre-rendered markup matches.
  const [url, setUrl] = useState<string>(null);
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUrl(absoluteGameUrl(gameId));
    setCanShare(typeof navigator.share === "function");
  }, [gameId]);

  useEffect(() => {
    if (!copied) return;

    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function onCopy() {
    await copyText(url);
    setCopied(true);
  }

  function onShare() {
    // Rejects with AbortError when the player dismisses the share sheet.
    navigator.share({ title: t("hanab"), text: t("invitationNoPlayers"), url }).catch(() => undefined);
  }

  if (!url) {
    return null;
  }

  return (
    <div className={`flex flex-column flex-row-ns items-center ${className}`}>
      <QrCode
        className="share-qr bg-white br2 pa1 flex-shrink-0 mb3 mb0-ns mr3-ns"
        label={t("scanToJoin")}
        text={url}
      />
      <div className="flex flex-column items-center items-start-ns mw6">
        <Txt className="mb1" value={t("shareGame")} />
        <Txt className="lavender mb2" size={TxtSize.SMALL} value={t("scanToJoin")} />
        <a className="lavender mb2 tc tl-ns" href={url} rel="noopener noreferrer" style={{ wordBreak: "break-all" }}>
          <Txt size={TxtSize.SMALL} value={url} />
        </a>
        <div className="flex">
          <Button outlined size={ButtonSize.SMALL} text={copied ? t("copied") : t("copy")} onClick={onCopy} />
          {canShare && <Button className="ml2" size={ButtonSize.SMALL} text={t("share")} onClick={onShare} />}
        </div>
      </div>
    </div>
  );
}

function NearbyShareGame(props: Props) {
  const { gameId, className = "", inviteNow = false } = props;
  const { t } = useTranslation();
  const [inviting, setInviting] = useState(false);

  if (inviteNow) {
    return <NearbyInvite className={className} gameId={gameId} />;
  }

  // The lobby: the invitation (camera, two QR codes) is too tall to fit in it, so it opens in a dialog.
  return (
    <div className={`flex flex-column items-center items-start-ns ${className}`}>
      <Txt className="mb1" value={t("invitePlayers")} />
      <Txt className="lavender mb2 tc tl-ns" size={TxtSize.SMALL} value={t("nearby.invite.lobbyHint")} />
      <Button
        primary
        id="invite-nearby"
        size={ButtonSize.SMALL}
        text={t("nearby.invite.button")}
        onClick={() => setInviting(true)}
      />
      {inviting && <NearbyInviteModal gameId={gameId} onClose={() => setInviting(false)} />}
    </div>
  );
}
