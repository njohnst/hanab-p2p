import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CopyButton from "~/components/copyButton";
import QrCode from "~/components/qrCode";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";

interface Props {
  /** The invitation or reply URL. */
  url: string;
  /** Accessible name of the QR code. */
  label: string;
}

/**
 * A nearby invitation or reply shown as a big QR code on pure white, with the standard quiet zone
 * so that phone camera apps read it from across a table. Under it, folded away, the link itself
 * with Copy (to paste it on the other device, the fallback when no camera can read it) and, where
 * the device has it, Share (AirDrop and Nearby Share work without internet).
 */
export default function NearbyCode(props: Props) {
  const { url, label } = props;
  const { t } = useTranslation();
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
  }, []);

  function onShare() {
    // Rejects with AbortError when the player dismisses the share sheet.
    navigator.share({ title: t("hanab"), url }).catch(() => undefined);
  }

  return (
    <div className="flex flex-column items-center w-100">
      <QrCode className="nearby-qr br2" label={label} margin={4} text={url} />
      <details className="nearby-link mt2 w-100 tc">
        <summary className="lavender pointer">
          <Txt size={TxtSize.SMALL} value={t("nearby.copyLinkSummary")} />
        </summary>
        <Txt className="db gray mt1 tl" size={TxtSize.XSMALL} style={{ wordBreak: "break-all" }} value={url} />
        <div className="flex justify-center mt2">
          <CopyButton text={url} />
          {canShare && <Button className="ml2" size={ButtonSize.SMALL} text={t("share")} onClick={onShare} />}
        </div>
      </details>
    </div>
  );
}
