import React from "react";
import { useTranslation } from "react-i18next";
import Txt, { TxtSize } from "~/components/ui/txt";

/** Keep this visible after failure, outside the collapsible connection diagnostics. */
export default function NearbyTroubleshooting() {
  const { t } = useTranslation();

  return (
    <section aria-label={t("nearby.troubleshooting.title")} className="ba b--gold br2 pa3 mb3 mw6 tl">
      <Txt className="db gold mb2" value={t("nearby.troubleshooting.title")} />
      <Txt className="db mb2" size={TxtSize.SMALL} value={t("nearby.troubleshooting.permission")} />
      <Txt className="db" size={TxtSize.SMALL} value={t("nearby.troubleshooting.retry")} />
    </section>
  );
}
