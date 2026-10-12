/**
 * Page-lifecycle hooks of the browser's network node (see ./browser.ts).
 *
 * - The page goes away (pagehide, whether it is unloaded or kept in the
 *   back/forward cache): every room is left at once with a `bye`, so the
 *   peers drop this tab and hand the authority over right away instead of
 *   waiting ~25s for WebRTC to notice the closed connections.
 * - beforeunload is deliberately not used: pagehide fires on every unload in
 *   current browsers, while beforeunload also fires for navigations that never
 *   happen (cancelled, downloads, mailto: links), and in Firefox a
 *   beforeunload listener keeps the page out of the back/forward cache.
 * - Restored from the back/forward cache (pageshow with persisted), visible
 *   again or back online: re-join (NetworkNode.revive).
 *
 * In-app route changes fire none of these: they keep the rooms' grace period.
 */
import type { NetworkNode } from "./node";

type LifecycleNode = Pick<NetworkNode, "depart" | "revive" | "refresh">;

/** `document`, or a stand-in in tests. */
type VisibilitySource = EventTarget & { readonly visibilityState: string };

/** Wire `node` to the page's lifecycle events. Returns a function that unwires it. */
export function watchPageLifecycle(node: LifecycleNode, page: EventTarget, doc: VisibilitySource): () => void {
  const listeners: Array<[EventTarget, string, (event: Event) => void]> = [
    [
      doc,
      "visibilitychange",
      () => {
        if (doc.visibilityState === "visible") node.revive();
      },
    ],
    [page, "online", () => node.revive()],
    [page, "offline", () => node.refresh()],
    [page, "pagehide", () => node.depart()],
    [
      page,
      "pageshow",
      (event) => {
        // Restored from the back/forward cache: the rooms were left on pagehide.
        if ((event as PageTransitionEvent).persisted) node.revive();
      },
    ],
  ];

  listeners.forEach(([target, type, listener]) => target.addEventListener(type, listener));
  return () => {
    listeners.forEach(([target, type, listener]) => target.removeEventListener(type, listener));
  };
}
