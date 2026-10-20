import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

let register: ReturnType<typeof vi.fn>;
let registrations: Array<{ scope: string; unregister: ReturnType<typeof vi.fn> }>;
let cacheNames: string[];
let loadListeners: Listener[];

function openPage(href: string, { secure = true, loaded = true, serviceWorker = true } = {}) {
  const url = new URL(href);
  loadListeners = [];
  vi.stubGlobal("window", {
    location: { href, search: url.search },
    isSecureContext: secure,
    addEventListener: (type: string, listener: Listener) => type === "load" && loadListeners.push(listener),
  });
  vi.stubGlobal("document", { readyState: loaded ? "complete" : "interactive" });
  vi.stubGlobal(
    "navigator",
    serviceWorker ? { serviceWorker: { register, getRegistrations: async () => registrations } } : {}
  );
  vi.stubGlobal("caches", {
    keys: async () => [...cacheNames],
    delete: async (name: string) => {
      cacheNames = cacheNames.filter((other) => other !== name);
      return true;
    },
  });
}

/** A fresh copy of the module: it registers once per page load. */
async function registerServiceWorker() {
  vi.resetModules();
  const serviceWorker = await import("./serviceWorker");
  serviceWorker.registerServiceWorker();
  // Let the removal (?sw=off, development) run.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  register = vi.fn(async () => ({}));
  registrations = [];
  cacheNames = [];
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerServiceWorker", () => {
  it("registers sw.js for the whole app, never through the HTTP cache", async () => {
    openPage("https://example.github.io/play/?gameId=Foo");
    await registerServiceWorker();

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  it("waits for the page to load", async () => {
    openPage("https://example.github.io/", { loaded: false });
    await registerServiceWorker();
    expect(register).not.toHaveBeenCalled();

    loadListeners.forEach((listener) => listener());
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("does nothing where browsers have no service workers", async () => {
    openPage("http://192.168.1.5:3000/", { secure: false });
    await registerServiceWorker();

    openPage("https://example.github.io/", { serviceWorker: false });
    await expect(registerServiceWorker()).resolves.toBeUndefined();

    expect(register).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    register = vi.fn(async () => Promise.reject(new Error("SecurityError")));
    openPage("https://example.github.io/");
    await registerServiceWorker();

    register = vi.fn(() => {
      throw new Error("InvalidStateError");
    });
    openPage("https://example.github.io/");
    await expect(registerServiceWorker()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  describe("with ?sw=off, or in development", () => {
    const scope = "https://example.github.io/";
    const prefix = `hanab-offline:${scope}:`;

    beforeEach(() => {
      registrations = [
        { scope, unregister: vi.fn(async () => true) },
        { scope: "https://example.github.io/other-app/", unregister: vi.fn(async () => true) },
      ];
      cacheNames = [
        `${prefix}0123456789ab`,
        `${prefix}meta`,
        "hanab-offline:https://example.github.io/other-app/:ab",
        "other",
      ];
    });

    it("unregisters this app's worker and deletes its caches", async () => {
      openPage(`${scope}?sw=off`);
      await registerServiceWorker();

      expect(register).not.toHaveBeenCalled();
      expect(registrations[0].unregister).toHaveBeenCalled();
      expect(registrations[1].unregister).not.toHaveBeenCalled();
      expect(cacheNames).toEqual(["hanab-offline:https://example.github.io/other-app/:ab", "other"]);
    });

    it("removes what a production build left on the origin", async () => {
      vi.stubEnv("NODE_ENV", "development");
      openPage(`${scope}new-game/`);
      await registerServiceWorker();

      expect(register).not.toHaveBeenCalled();
      expect(registrations[0].unregister).toHaveBeenCalled();
      expect(cacheNames).toEqual(["hanab-offline:https://example.github.io/other-app/:ab", "other"]);
    });
  });
});
