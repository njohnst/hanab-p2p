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
 *
 * In nearby mode (./nearby/links.ts) the page going away also closes every
 * link, after the rooms' goodbyes went out on them (withNearbyLinks).
 */
import type { NetworkNode } from "./node";

export type LifecycleNode = Pick<NetworkNode, "depart" | "revive" | "refresh">;

/**
 * The node, plus nearby links that close when the page goes away: after the
 * node departed, since the rooms' goodbyes travel on the links. Nothing
 * reopens them when the page comes back (that takes new QR codes).
 */
export function withNearbyLinks(node: LifecycleNode, links: { depart(): void }): LifecycleNode {
  return {
    depart: () => {
      node.depart();
      links.depart();
    },
    revive: () => node.revive(),
    refresh: () => node.refresh(),
  };
}

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
