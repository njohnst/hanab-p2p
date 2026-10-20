/**
 * Registers the offline cache's service worker (see docs/P2P_DESIGN.md, "Getting the app without
 * internet"). The build writes it to out/sw.js (scripts/generate-sw.mjs, from
 * scripts/service-worker.mjs): it precaches the whole export, so a device that opened the app once
 * can open it again with no internet.
 *
 * - Production builds on secure pages only (https, localhost): browsers have no service workers
 *   elsewhere, e.g. on http://<lan-ip>. Registered once the page has loaded, so that precaching
 *   doesn't slow it down.
 * - `next dev` has none, and removes the one a production build served on the same origin left
 *   behind (e.g. `yarn serve:static` and `next dev` both on localhost:3000).
 * - Debug aid: opening any page with `?sw=off` unregisters this app's worker and deletes its caches.
 *   The next page load without it registers the worker again, from scratch.
 *
 * Never throws: the app works without its offline cache.
 */
import { withBasePath } from "~/lib/routes";

let started = false;

/**
 * Prefix of the names of this app's caches for a worker scope (an absolute URL).
 * Keep in sync with cachePrefix in scripts/service-worker.mjs (a test checks).
 */
export function offlineCachePrefix(scope: string): string {
  return `hanab-offline:${scope}:`;
}

/** Register the worker (or remove it, see above). Call once the app is mounted; later calls do nothing. */
export function registerServiceWorker() {
  if (started) {
    return;
  }
  started = true;

  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) {
      return;
    }

    const scope = new URL(withBasePath("/"), window.location.href).href;
    const disabled = new URLSearchParams(window.location.search).get("sw") === "off";
    if (process.env.NODE_ENV !== "production" || disabled) {
      removeServiceWorker(scope).catch(warn);
      return;
    }

    afterLoad(() => addServiceWorker().catch(warn));
  } catch (error) {
    warn(error);
  }
}

/** sw.js controls the whole app, and the browser always checks it for updates on the server. */
async function addServiceWorker() {
  await navigator.serviceWorker.register(withBasePath("/sw.js"), { scope: withBasePath("/"), updateViaCache: "none" });
}

/** Unregister this app's worker for `scope` and delete its caches. */
async function removeServiceWorker(scope: string) {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.filter((registration) => registration.scope === scope).map((r) => r.unregister()));

  if (typeof caches !== "undefined") {
    const prefix = offlineCachePrefix(scope);
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => caches.delete(name)));
  }
}

function afterLoad(callback: () => void) {
  if (document.readyState === "complete") {
    callback();
  } else {
    window.addEventListener("load", callback, { once: true });
  }
}

function warn(error: unknown) {
  console.warn("Offline cache:", error);
}
