import { useRouter } from "next/router";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { logFailedPromise } from "~/lib/errors";
import { NEARBY_PAGE, onlinePlayHref, withNetworkMode } from "~/lib/nearbyPlay";

/**
 * Home page, in nearby mode: says the tab plays with devices around it, without internet, with a
 * way to scan an invitation (client-side: the links stay open) and one back to online play (a page
 * load: the mode is chosen when the page loads).
 */
export function NearbyModeBanner(props: { className?: string }) {
  const { className = "" } = props;
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <div className={`flex flex-column items-center bg-black-50 ba b--yellow br3 pa3 mw6 ${className}`} id="nearby-mode">
      <Txt className="tc mb2" value={t("nearby.modeBanner")} />
      <div className="flex flex-wrap justify-center">
        <Button
          primary
          className="ma1"
          size={ButtonSize.SMALL}
          text={t("nearby.scanInvitation")}
          onClick={() => router.push(NEARBY_PAGE).catch(logFailedPromise)}
        />
        <Button
          outlined
          className="ma1"
          size={ButtonSize.SMALL}
          text={t("nearby.playOnline")}
          onClick={() => window.location.assign(onlinePlayHref())}
        />
      </div>
    </div>
  );
}

/**
 * Game page, outside nearby mode, for a game this browser played nearby: online, nobody can be
 * reached for it. Offers to reload the page in nearby mode (the tab's mode is chosen at load).
 */
export function SwitchToNearbyBanner() {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) {
    return null;
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 flex flex-wrap items-center justify-center bg-main-dark bb b--yellow shadow-4 pa2 z-999"
      id="switch-to-nearby"
      role="status"
    >
      <Txt className="mr2" size={TxtSize.SMALL} value={t("nearby.switchBanner")} />
      <Button
        primary
        className="nowrap"
        size={ButtonSize.TINY}
        text={t("nearby.switchButton")}
        onClick={() => window.location.assign(withNetworkMode(window.location.href, "nearby"))}
      />
      <Button
        void
        aria-label={t("nearby.dismiss")}
        className="ml1"
        size={ButtonSize.TINY}
        text="×"
        onClick={() => setDismissed(true)}
      />
    </div>
  );
}
