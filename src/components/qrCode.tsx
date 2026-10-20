import React, { useEffect, useState } from "react";
import { logFailedPromise } from "~/lib/errors";
import { renderQrSvg } from "~/lib/qr";

interface Props {
  /** What the code holds (a URL). */
  text: string;
  /** Accessible name of the image. */
  label: string;
  /** Quiet zone, in modules (see renderQrSvg). */
  margin?: number;
  /** Sizes the box: the SVG fills it (see .share-qr and .nearby-qr in style.css). */
  className?: string;
}

/**
 * A QR code drawn as inline SVG. The box is rendered at once (empty) and filled once the "qrcode"
 * library has loaded, so it is safe to pre-render.
 */
export default function QrCode(props: Props) {
  const { text, label, margin, className } = props;
  const [svg, setSvg] = useState<string>(null);

  useEffect(() => {
    let cancelled = false;
    // Never leave the previous code on screen while drawing another one: it could still be scanned.
    setSvg(null);
    renderQrSvg(text, { margin })
      .then((markup) => !cancelled && setSvg(markup))
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
    };
  }, [text, margin]);

  return (
    <div
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      aria-label={label}
      className={className}
      role="img"
    />
  );
}
