import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NearbyInviteModal } from "~/components/nearbyInvite";
import QrCode from "~/components/qrCode";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNetworkMode } from "~/hooks/networkMode";
import { copyText } from "~/lib/clipboard";
import { absoluteGameUrl } from "~/lib/routes";

interface Props {
  gameId: string;
  className?: string;
  /** Let the game own the QR dialog so it survives menu/turn changes. */
  onConnectByQr?: () => void;
}

/** The same room link and optional QR connection handshake in every network game. */
export default function ShareGame(props: Props) {
  const { gameId, className = "", onConnectByQr } = props;
  const { t } = useTranslation();
  const mode = useNetworkMode();
  const [inviting, setInviting] = useState(false);

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
    <div className={`flex flex-column items-center ${className}`}>
      <div className="flex flex-column flex-row-ns items-center">
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
      {mode && mode !== "local" && (
        <div className="mt3 tc mw6">
          <Txt className="db lavender mb2" size={TxtSize.SMALL} value={t("unified.connectionHint")} />
          <Button
            outlined
            id="connect-by-qr"
            size={ButtonSize.SMALL}
            text={t("unified.connectByQr")}
            onClick={onConnectByQr ?? (() => setInviting(true))}
          />
        </div>
      )}
      {inviting && <NearbyInviteModal gameId={gameId} onClose={() => setInviting(false)} />}
    </div>
  );
}
