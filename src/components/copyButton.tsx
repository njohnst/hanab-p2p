import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";

interface Props {
  text: string;
  /** Defaults to "Copy". */
  label?: string;
  className?: string;
}

/** A small outlined button copying `text`, which says "Copied!" for two seconds. */
export default function CopyButton(props: Props) {
  const { text, label, className } = props;
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function onCopy() {
    await copyText(text);
    setCopied(true);
  }

  return (
    <Button
      outlined
      className={className}
      size={ButtonSize.SMALL}
      text={copied ? t("copied") : label || t("copy")}
      onClick={onCopy}
    />
  );
}
