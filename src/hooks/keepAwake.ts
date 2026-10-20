/**
 * Keeping a nearby game alive on phones (docs/P2P_DESIGN.md, "Limits"): a tab that is reloaded,
 * or that a phone kills in the background, loses its links, and only a new QR exchange brings them
 * back. So while links are open:
 * - useKeepAwake holds a Screen Wake Lock (where the browser has one: secure pages only), so the
 *   phone does not lock itself between turns. The browser drops the lock whenever the page is
 *   hidden; it is taken again when the page is visible again.
 * - useLeaveWarning asks before the page unloads (reload, closing the tab, typing another URL).
 *   Only registered while needed: a beforeunload listener also keeps Firefox from putting the page
 *   in its back/forward cache, and fires for navigations that never happen.
 */
import { useEffect } from "react";

export function useKeepAwake(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return;
    }

    let disposed = false;
    let requesting = false;
    let sentinel: WakeLockSentinel | null = null;

    const acquire = async () => {
      if (disposed || requesting || document.visibilityState !== "visible" || (sentinel && !sentinel.released)) {
        return;
      }

      requesting = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed) {
          lock.release().catch(() => undefined);
        } else {
          sentinel = lock;
        }
      } catch {
        // Refused (battery saver, a permissions policy): the screen may lock, nothing else to do.
      } finally {
        requesting = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        acquire();
      }
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}

export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) {
      return;
    }

    // Browsers show their own text; returnValue is what older ones need to show anything.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
