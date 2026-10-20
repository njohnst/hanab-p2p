import Router, { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import HomeButton from "~/components/homeButton";
import NearbyJoin, { NearbyReplyHandoff } from "~/components/nearbyJoin";
import NearbyLinks from "~/components/nearbyLinks";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNetworkMode } from "~/hooks/networkMode";
import { logFailedPromise } from "~/lib/errors";
import { onlinePlayHref, withNetworkMode } from "~/lib/nearbyPlay";
import { getNetworkMode, parseNearbyText } from "~/lib/network";

type View =
  /** Pre-rendered, and until the router has the URL. */
  | { name: "loading" }
  /** Reloading in nearby mode. */
  | { name: "switching" }
  | { name: "landing" }
  /** Opened with an invitation (`#o=`): answer it. `id` tells two fragments apart. */
  | { name: "invite"; text: string; id: number }
  /** Opened with a reply (`#a=`), by the inviter's camera app: hand it to the inviting tab. */
  | { name: "reply"; text: string; id: number };

/** A fragment carrying a nearby code: `#o=<code>` (invitation) or `#a=<code>` (reply). */
const CODE_FRAGMENT = /^#[oa]=/;

/**
 * The nearby page, /nearby/ (docs/P2P_DESIGN.md, "Nearby play (no internet)"). Any page under
 * /nearby/ puts the tab in nearby mode, which is what invitation and reply URLs rely on:
 * - `#o=<code>`: an invitation, opened by the guest's camera app (or pasted): answered at once,
 *   showing the reply QR code, then the game opens;
 * - `#a=<code>`: a reply, opened by the inviter's camera app in a new tab: handed to the inviting
 *   tab of this browser;
 * - no fragment: what nearby play is, a scanner for invitations, and the devices linked so far.
 *
 * The fragment is removed from the address once read, so that reloading does not reuse a code
 * that was already answered. A tab that arrives here client-side from another mode reloads.
 */
export default function Nearby() {
  const router = useRouter();
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ name: "loading" });
  const ready = router.isReady;
  // Sets the nearby-mode class on <html>: no pull-to-refresh, which would reload the page.
  useNetworkMode();

  useEffect(() => {
    // Wait for the router: until then, Next may still rewrite the address (adding the query).
    if (!ready) return;

    if (getNetworkMode() !== "nearby") {
      // Arrived client-side from an online page: the mode is chosen when a page loads.
      const target = withNetworkMode(window.location.href, "nearby");
      if (target !== window.location.href) {
        setView({ name: "switching" });
        window.location.replace(target);
        return;
      }
    }

    let count = 0;
    const read = () => {
      const hash = window.location.hash;
      const code = CODE_FRAGMENT.test(hash) ? parseNearbyText(hash) : null;
      if (!code) {
        setView((current) => (current.name === "loading" ? { name: "landing" } : current));
        return;
      }

      count += 1;
      const text = window.location.href;
      setView(code.kind === "invite" ? { name: "invite", text, id: count } : { name: "reply", text, id: count });
      // A hash-only change for the router: the page stays mounted.
      Router.replace(Router.asPath.split("#")[0], undefined, { shallow: true, scroll: false }).catch(logFailedPromise);
    };

    read();
    // Another code opened in this very tab (pasted in the address bar) changes the fragment only.
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [ready]);

  return (
    <div className="w-100 h-100 overflow-y-scroll relative bg-main-dark pa2 pv4-l ph3-l shadow-5 br3">
      <HomeButton className="absolute top-1 right-1" />
      <div className="center mw6 w-100 ph2 pv4 flex flex-column items-center">
        {(view.name === "loading" || view.name === "switching") && (
          <Txt
            className="lavender mt5"
            role="status"
            value={view.name === "switching" ? t("nearby.switching") : t("loading")}
          />
        )}

        {view.name === "invite" && (
          <>
            <Txt className="mb4 tc" size={TxtSize.MEDIUM} value={t("nearby.answer.title")} />
            <NearbyJoin key={view.id} initialInvite={view.text} />
          </>
        )}

        {view.name === "reply" && (
          <>
            <Txt className="mb4 tc" size={TxtSize.MEDIUM} value={t("nearby.reply.title")} />
            <NearbyReplyHandoff key={view.id} text={view.text} onDismiss={() => setView({ name: "landing" })} />
          </>
        )}

        {view.name === "landing" && <Landing />}
      </div>
    </div>
  );
}

function Landing() {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <>
      <Txt className="mb3 tc" size={TxtSize.MEDIUM} value={t("nearby.title")} />
      <Txt className="lavender tc mb4" value={t("nearby.intro")} />

      <NearbyJoin />

      <div className="flex flex-wrap justify-center mt4">
        <Button
          primary
          className="ma1"
          id="nearby-new-game"
          size={ButtonSize.MEDIUM}
          text={t("createRoom")}
          onClick={() => router.push("/new-game").catch(logFailedPromise)}
        />
        <Button
          outlined
          className="ma1"
          id="play-online"
          size={ButtonSize.MEDIUM}
          text={t("nearby.playOnline")}
          onClick={() => window.location.assign(onlinePlayHref())}
        />
      </div>

      <NearbyLinks className="mt4" />
    </>
  );
}
