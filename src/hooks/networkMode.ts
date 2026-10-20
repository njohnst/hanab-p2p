/**
 * The tab's network mode and nearby links, for components (docs/P2P_DESIGN.md, "Mode").
 *
 * ~/lib/network is loaded with a dynamic import: the home page must not pull the sync engine in
 * with its own code (see src/__tests__/pages/index.test.ts), and on the other pages, which import
 * it anyway, the import resolves at once.
 */
import { useEffect, useState } from "react";
import { logFailedPromise } from "~/lib/errors";
import type { NearbyLink, NetworkMode } from "~/lib/network";

/** Set on <html> in nearby mode: style.css then turns off pull-to-refresh, which would close the links. */
export const NEARBY_MODE_CLASS = "nearby-mode";

/**
 * This tab's network mode, or null until mounted (pages are pre-rendered without one: the first
 * render must match the static HTML). Fixed for the tab's lifetime (see getNetworkMode).
 */
export function useNetworkMode(): NetworkMode | null {
  const [mode, setMode] = useState<NetworkMode | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("~/lib/network")
      .then(({ getNetworkMode }) => {
        if (cancelled) return;
        const current = getNetworkMode();
        if (current === "nearby") {
          document.documentElement.classList.add(NEARBY_MODE_CLASS);
        }
        setMode(current);
      })
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
    };
  }, []);

  return mode;
}

/**
 * This tab's nearby links (open ones and mesh connections being set up), kept up to date; null
 * outside nearby mode, while loading, or when `enabled` is false.
 */
export function useNearbyLinks(enabled = true): NearbyLink[] | null {
  const [links, setLinks] = useState<NearbyLink[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLinks(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: () => void = () => undefined;
    import("~/lib/network")
      .then(({ getNearby, getNetworkMode }) => {
        // getNearby() creates the network node: only ask in nearby mode.
        const nearby = !cancelled && getNetworkMode() === "nearby" ? getNearby() : null;
        if (nearby) {
          unsubscribe = nearby.subscribe((current) => setLinks(current));
        }
      })
      .catch(logFailedPromise);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return links;
}
