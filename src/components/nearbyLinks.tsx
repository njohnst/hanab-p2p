import classnames from "classnames";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useNearbyLinks } from "~/hooks/networkMode";
import { logFailedPromise } from "~/lib/errors";
import { playerNamesById } from "~/lib/nearbyPlay";

/**
 * The devices this tab is linked with in nearby mode (open links and mesh connections being set
 * up), named after the players they announced when this browser knows them. Renders nothing
 * outside nearby mode.
 */
export default function NearbyLinks(props: { className?: string }) {
  const { className } = props;
  const { t } = useTranslation();
  const links = useNearbyLinks();
  const [names, setNames] = useState<Record<string, string>>({});

  // Names come from the games this browser holds: read again whenever someone links or leaves.
  useEffect(() => {
    if (!links?.length) return;

    let cancelled = false;
    import("~/lib/network")
      .then(({ getNetworkNode }) => {
        if (!cancelled) setNames(playerNamesById(getNetworkNode()?.store.list() ?? []));
      })
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
    };
  }, [links]);

  if (!links) {
    return null;
  }

  return (
    <section aria-labelledby="nearby-links-title" className={classnames("w-100", className)}>
      <h2 className="ma0 mb2 tc normal f6 f5-l ttu tracked lavender" id="nearby-links-title">
        {t("nearby.links.title")}
      </h2>
      {links.length === 0 ? (
        <Txt className="db gray tc" size={TxtSize.SMALL} value={t("nearby.links.none")} />
      ) : (
        <ul aria-live="polite" className="list ma0 pa0">
          {links.map((link) => (
            <li key={link.peerId} className="flex items-center pv1 bb b--white-20">
              <span
                aria-hidden
                className={classnames("dib br-100 flex-shrink-0 mr2", link.state === "open" ? "bg-green" : "bg-gray")}
                style={{ width: 8, height: 8 }}
              />
              <Txt
                className="flex-auto truncate mr2"
                multiline={false}
                value={
                  (link.playerId && names[link.playerId]) || t("nearby.links.device", { id: link.peerId.slice(0, 4) })
                }
              />
              <Txt
                className="gray nowrap"
                size={TxtSize.XSMALL}
                value={link.state === "open" ? t("playerConnected") : t("nearby.connecting")}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
