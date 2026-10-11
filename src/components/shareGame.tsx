import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { logFailedPromise } from "~/lib/errors";
import { absoluteGameUrl } from "~/lib/routes";

interface Props {
  gameId: string;
  className?: string;
}

async function renderQrSvg(text: string): Promise<string> {
  // Loaded on demand: only lobbies and the invite dialog need it.
  const mod = await import("qrcode");
  const QRCode = ((mod as unknown) as { default?: typeof mod }).default ?? mod;

  return QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

function copyWithTextarea(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

/**
 * Invite panel for network games: a QR code of the game link, the link
 * itself, a Copy button and, where the device supports it, the native Share sheet.
 */
export default function ShareGame(props: Props) {
  const { gameId, className = "" } = props;
  const { t } = useTranslation();

  // Browser-only values, resolved after mount so pre-rendered markup matches.
  const [url, setUrl] = useState<string>(null);
  const [qrSvg, setQrSvg] = useState<string>(null);
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const link = absoluteGameUrl(gameId);
    setUrl(link);
    setCanShare(typeof navigator.share === "function");

    let cancelled = false;
    renderQrSvg(link)
      .then((svg) => !cancelled && setQrSvg(svg))
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
    };
  }, [gameId]);

  useEffect(() => {
    if (!copied) return;

    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      copyWithTextarea(url);
    }
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
      <div
        dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined}
        aria-label={t("scanToJoin")}
        className="share-qr bg-white br2 pa1 flex-shrink-0 mb3 mb0-ns mr3-ns"
        role="img"
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
