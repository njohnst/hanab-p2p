import { describe, expect, it, vi } from "vitest";
import { offlineCachePrefix } from "../src/lib/serviceWorker";
import {
  buildServiceWorker,
  cachePrefix,
  isPrecached,
  parseRange,
  precacheHash,
  precacheKey,
  precacheManifest,
  routeRequest,
} from "./service-worker.mjs";

const SCOPE = "https://example.github.io/hanabi/";

describe("precacheKey", () => {
  it("maps pages to their directory URL and keeps other files", () => {
    expect(precacheKey("index.html")).toBe("");
    expect(precacheKey("play/index.html")).toBe("play/");
    expect(precacheKey("404/index.html")).toBe("404/");
    expect(precacheKey("404.html")).toBe("404.html");
    expect(precacheKey("_next/static/chunks/main-1a2b.js")).toBe("_next/static/chunks/main-1a2b.js");
    expect(precacheKey("static/sounds/play.mp3")).toBe("static/sounds/play.mp3");
  });
});

describe("isPrecached", () => {
  it("skips source maps, the worker itself and dotfiles", () => {
    expect(isPrecached("index.html")).toBe(true);
    expect(isPrecached("_next/static/chunks/main-1a2b.js")).toBe(true);
    expect(isPrecached("static/sounds/swoosh.wav")).toBe(true);
    expect(isPrecached("_next/static/chunks/main-1a2b.js.map")).toBe(false);
    expect(isPrecached("sw.js")).toBe(false);
    expect(isPrecached(".nojekyll")).toBe(false);
    expect(isPrecached(".well-known/security.txt")).toBe(false);
  });
});

describe("precacheManifest", () => {
  const files = [
    { path: "play/index.html", hash: "p" },
    { path: "index.html", hash: "i" },
    { path: "404.html", hash: "n" },
    { path: "_next/static/chunks/main-1a2b.js", hash: "m" },
    { path: "_next/static/chunks/main-1a2b.js.map", hash: "x" },
    { path: "sw.js", hash: "s" },
    { path: ".nojekyll", hash: "j" },
  ];

  it("lists the precached files by key, sorted", () => {
    expect(precacheManifest(files).precache).toEqual([
      ["", "i"],
      ["404.html", "n"],
      ["_next/static/chunks/main-1a2b.js", "m"],
      ["play/", "p"],
    ]);
  });

  it("versions the list by content: the order of files doesn't matter, a changed file does", () => {
    const { version } = precacheManifest(files);
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(precacheManifest([...files].reverse()).version).toBe(version);
    expect(
      precacheManifest(files.map((file) => (file.path === "404.html" ? { ...file, hash: "N" } : file))).version
    ).not.toBe(version);
    // Files that are not precached don't count.
    expect(precacheManifest(files.filter((file) => file.path !== "sw.js")).version).toBe(version);
  });
});

describe("cachePrefix", () => {
  it("is the prefix the page uses to delete the caches (?sw=off)", () => {
    expect(cachePrefix(SCOPE)).toBe(offlineCachePrefix(SCOPE));
  });
});

describe("routeRequest", () => {
  const precached = new Set([
    "",
    "404.html",
    "play/",
    "summary/",
    "nearby/",
    "static/sounds/play.mp3",
    "_next/static/chunks/main-1a2b.js",
  ]);

  function route(url, { method = "GET", mode = "navigate", scope = SCOPE } = {}) {
    return routeRequest({ url, method, mode }, scope, precached);
  }

  describe("navigations", () => {
    it("serve precached pages, ignoring the query string", () => {
      expect(route(SCOPE)).toEqual({ type: "page", key: "" });
      expect(route(`${SCOPE}?net=nearby`)).toEqual({ type: "page", key: "" });
      expect(route(`${SCOPE}play/?gameId=ExcitingHookwormPink`)).toEqual({ type: "page", key: "play/" });
      expect(route(`${SCOPE}play/?gameId=ExcitingHookwormPink&as=bob`)).toEqual({ type: "page", key: "play/" });
      expect(route(`${SCOPE}summary/?gameId=ExcitingHookwormPink`)).toEqual({ type: "page", key: "summary/" });
    });

    it("serve the nearby page whatever its fragment", () => {
      expect(route(`${SCOPE}nearby/#o=AQIDBAUGBwg`)).toEqual({ type: "page", key: "nearby/" });
      expect(route(`${SCOPE}nearby/`)).toEqual({ type: "page", key: "nearby/" });
    });

    it("serve <dir>/index.html as <dir>/", () => {
      expect(route(`${SCOPE}index.html`)).toEqual({ type: "page", key: "" });
      expect(route(`${SCOPE}play/index.html?gameId=Foo`)).toEqual({ type: "page", key: "play/" });
    });

    it("serve precached files", () => {
      expect(route(`${SCOPE}static/sounds/play.mp3`)).toEqual({ type: "page", key: "static/sounds/play.mp3" });
      expect(route(`${SCOPE}404.html`)).toEqual({ type: "page", key: "404.html" });
    });

    it("redirect <dir> to <dir>/, keeping the query", () => {
      expect(route(`${SCOPE}play?gameId=ExcitingHookwormPink`)).toEqual({
        type: "redirect",
        location: `${SCOPE}play/?gameId=ExcitingHookwormPink`,
      });
      expect(route(`${SCOPE}nearby`)).toEqual({ type: "redirect", location: `${SCOPE}nearby/` });
    });

    it("leave other paths to the network, then 404.html", () => {
      expect(route(`${SCOPE}ExcitingHookwormPink`)).toEqual({ type: "notFound" });
      expect(route(`${SCOPE}ExcitingHookwormPink/summary`)).toEqual({ type: "notFound" });
      expect(route(`${SCOPE}other-project/`)).toEqual({ type: "notFound" });
      expect(route(`${SCOPE}sw.js`)).toEqual({ type: "notFound" });
    });

    it("decode the path", () => {
      const withSpace = new Set(["static/my file.png"]);
      expect(
        routeRequest({ url: `${SCOPE}static/my%20file.png`, method: "GET", mode: "navigate" }, SCOPE, withSpace)
      ).toEqual({
        type: "page",
        key: "static/my file.png",
      });
      expect(route(`${SCOPE}%E0%A4%A`)).toBeNull();
    });
  });

  describe("other requests", () => {
    it("serve precached files and anything under _next/static/, ignoring the query string", () => {
      const asset = { mode: "no-cors" };
      expect(route(`${SCOPE}static/sounds/play.mp3`, asset)).toEqual({ type: "asset", key: "static/sounds/play.mp3" });
      expect(route(`${SCOPE}_next/static/chunks/main-1a2b.js`, asset)).toEqual({
        type: "asset",
        key: "_next/static/chunks/main-1a2b.js",
      });
      expect(route(`${SCOPE}_next/static/chunks/592.0ld0ld.js`, { mode: "cors" })).toEqual({
        type: "asset",
        key: "_next/static/chunks/592.0ld0ld.js",
      });
      expect(route(`${SCOPE}static/sounds/play.mp3?v=2`, asset)).toEqual({
        type: "asset",
        key: "static/sounds/play.mp3",
      });
    });

    it("leave the rest to the browser", () => {
      expect(route(`${SCOPE}nearby-origins.json`, { mode: "cors" })).toBeNull();
      expect(route(`${SCOPE}sw.js`, { mode: "same-origin" })).toBeNull();
      expect(route(`${SCOPE}static/unknown.png`, { mode: "no-cors" })).toBeNull();
    });
  });

  it("only answers GET requests inside the scope, on its origin", () => {
    expect(route(`${SCOPE}play/`, { method: "POST" })).toBeNull();
    expect(route(`${SCOPE}play/`, { method: "HEAD" })).toBeNull();
    expect(route("https://example.github.io/hanabi")).toBeNull();
    expect(route("https://example.github.io/other/play/")).toBeNull();
    expect(route("https://evil.example/hanabi/play/")).toBeNull();
    expect(route("https://fonts.googleapis.com/css2?family=Caveat", { mode: "no-cors" })).toBeNull();
  });

  it("works at the root of an origin", () => {
    const scope = "http://localhost:3000/";
    expect(route("http://localhost:3000/play/?gameId=Foo", { scope })).toEqual({ type: "page", key: "play/" });
    expect(route("http://localhost:3000/play?gameId=Foo", { scope })).toEqual({
      type: "redirect",
      location: "http://localhost:3000/play/?gameId=Foo",
    });
    expect(route("http://localhost:3000/Foo", { scope })).toEqual({ type: "notFound" });
  });
});

describe("parseRange", () => {
  it("parses a single range", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("BYTES = 5 - 6", 100)).toEqual({ start: 5, end: 6 });
  });

  it("clamps the end to the body", () => {
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("refuses ranges past the end", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=200-300", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  it("ignores what it doesn't handle: the whole body is sent", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=5-2", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

/**
 * The generated sw.js, run against in-memory stand-ins for the worker's globals: a network (a map
 * of URLs to bodies), the Cache Storage, the registration and clients.
 */
function exportFiles(overrides = {}) {
  return {
    "index.html": "<html>home</html>",
    "play/index.html": "<html>play</html>",
    "summary/index.html": "<html>summary</html>",
    "nearby/index.html": "<html>nearby</html>",
    "404.html": "<html>not found</html>",
    "_next/static/chunks/main-1a2b.js": "console.log('main')",
    "static/sounds/play.mp3": "0123456789abcdefghij",
    ...overrides,
  };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mp3": "audio/mpeg" };

function createNetwork(scope, files) {
  const network = {
    online: true,
    files: new Map(),
    requests: [],
    serve(newFiles) {
      network.files = new Map(
        Object.entries(newFiles).map(([path, body]) => [new URL(path.replace(/index\.html$/, ""), scope).href, body])
      );
    },
    async fetch(request) {
      network.requests.push(request);
      if (!network.online) {
        throw new TypeError("Failed to fetch");
      }

      const url = new URL(request.url);
      const body = network.files.get(`${url.origin}${url.pathname}`);
      if (body === undefined) {
        return new Response("Not found (network)", { status: 404 });
      }
      const type = Object.entries(TYPES).find(([extension]) => url.pathname.endsWith(extension));
      return new Response(body, { headers: { "Content-Type": type ? type[1] : "text/html" } });
    },
  };
  network.serve(files);

  return network;
}

function createCacheStorage() {
  const stores = new Map();

  function cache(entries) {
    return {
      async match(request) {
        const entry = entries.get(typeof request === "string" ? request : request.url);
        return entry && new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers });
      },
      async put(request, response) {
        const body = await response.arrayBuffer();
        entries.set(typeof request === "string" ? request : request.url, {
          body,
          status: response.status,
          headers: [...response.headers],
        });
      },
    };
  }

  return {
    stores,
    async open(name) {
      if (!stores.has(name)) {
        stores.set(name, new Map());
      }
      return cache(stores.get(name));
    },
    async keys() {
      return [...stores.keys()];
    },
    async has(name) {
      return stores.has(name);
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
}

function hashFiles(files) {
  return Object.entries(files).map(([path, body]) => ({ path, hash: precacheHash(Buffer.from(body)) }));
}

/** Load sw.js for an export into a fresh worker sharing `caches` and `network`. */
function startWorker({ scope = SCOPE, files = exportFiles(), caches = createCacheStorage(), network } = {}) {
  const manifest = precacheManifest(hashFiles(files));
  const source = buildServiceWorker(manifest);
  const net = network || createNetwork(scope, files);
  const listeners = {};
  const self = {
    registration: { scope },
    addEventListener: (type, listener) => (listeners[type] = listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  new Function("self", "caches", "fetch", source)(self, caches, (request) => net.fetch(request));

  async function lifecycle(type) {
    let done;
    listeners[type]({ waitUntil: (promise) => (done = promise) });
    await done;
  }

  return {
    manifest,
    source,
    self,
    caches,
    network: net,
    cacheName: `${cachePrefix(scope)}${manifest.version}`,
    install: () => lifecycle("install"),
    activate: () => lifecycle("activate"),
    /** The worker's response, or null when it leaves the request to the browser. */
    async fetch(url, { mode = "navigate", method = "GET", headers = {} } = {}) {
      let response = null;
      const request = { url, method, mode, cache: "default", headers: new Headers(headers) };
      listeners.fetch({ request, respondWith: (promise) => (response = promise) });
      return response && (await response);
    },
  };
}

describe("sw.js", () => {
  it("is a classic script built from the tested functions", () => {
    const { source, manifest } = startWorker();
    expect(source).toContain(`serviceWorker("${manifest.version}", [`);
    expect(source).toContain(routeRequest.toString());
    expect(source).toContain(parseRange.toString());
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
  });

  describe("install", () => {
    it("downloads every precached file, bypassing the HTTP cache, then skips waiting", async () => {
      const worker = startWorker();
      await worker.install();

      const store = worker.caches.stores.get(worker.cacheName);
      expect([...store.keys()].sort()).toEqual(
        [
          SCOPE,
          `${SCOPE}404.html`,
          `${SCOPE}_next/static/chunks/main-1a2b.js`,
          `${SCOPE}nearby/`,
          `${SCOPE}play/`,
          `${SCOPE}static/sounds/play.mp3`,
          `${SCOPE}summary/`,
        ].sort()
      );
      expect(worker.network.requests).toHaveLength(7);
      expect(worker.network.requests.every((request) => request.cache === "reload")).toBe(true);
      expect(worker.self.skipWaiting).toHaveBeenCalled();
    });

    it("fails when the host serves other content (e.g. still the previous version)", async () => {
      const worker = startWorker();
      worker.network.serve(exportFiles({ "play/index.html": "<html>older play</html>" }));

      await expect(worker.install()).rejects.toThrow(/play\/.*not the expected content/);
      expect(worker.self.skipWaiting).not.toHaveBeenCalled();
    });

    it("fails when a file is missing", async () => {
      const worker = startWorker();
      worker.network.serve(exportFiles({ "static/sounds/play.mp3": undefined }));

      await expect(worker.install()).rejects.toThrow(/play\.mp3.*HTTP 404/);
    });

    it("downloads only the files that changed since the previous version", async () => {
      const previous = startWorker();
      await previous.install();
      await previous.activate();

      const files = exportFiles({ "play/index.html": "<html>play v2</html>" });
      const next = startWorker({ files, caches: previous.caches });
      await next.install();

      expect(next.network.requests.map((request) => request.url)).toEqual([`${SCOPE}play/`]);
      expect(next.caches.stores.get(next.cacheName).size).toBe(7);
    });

    it("resumes an interrupted install", async () => {
      const worker = startWorker();
      worker.network.serve(exportFiles({ "static/sounds/play.mp3": undefined }));
      await expect(worker.install()).rejects.toThrow();

      worker.network.serve(exportFiles());
      worker.network.requests = [];
      await worker.install();
      expect(worker.network.requests.map((request) => request.url)).toEqual([`${SCOPE}static/sounds/play.mp3`]);
    });
  });

  describe("activate", () => {
    it("keeps this version and the previous one only, and takes control of the open pages", async () => {
      const caches = createCacheStorage();
      const versions = ["v1", "v2", "v3"].map((label) => {
        const worker = startWorker({ caches, files: exportFiles({ "index.html": `<html>${label}</html>` }) });
        return worker;
      });
      const otherApp = `${cachePrefix("https://example.github.io/")}0123456789ab`;
      await caches.open(otherApp);
      await caches.open("someone-else");

      for (const worker of versions) {
        await worker.install();
        await worker.activate();
      }

      expect(await caches.keys()).toEqual(
        expect.arrayContaining([otherApp, "someone-else", versions[1].cacheName, versions[2].cacheName])
      );
      expect(await caches.has(versions[0].cacheName)).toBe(false);
      expect(versions[2].self.clients.claim).toHaveBeenCalled();
    });

    it("deletes what failed installs left", async () => {
      const caches = createCacheStorage();
      const broken = startWorker({ caches, files: exportFiles({ "index.html": "<html>broken</html>" }) });
      broken.network.online = false;
      await expect(broken.install()).rejects.toThrow();

      const worker = startWorker({ caches });
      await worker.install();
      await worker.activate();
      expect(await caches.has(broken.cacheName)).toBe(false);
      expect(await caches.has(worker.cacheName)).toBe(true);
    });
  });

  describe("fetch", () => {
    async function installed(options) {
      const worker = startWorker(options);
      await worker.install();
      await worker.activate();
      worker.network.online = false;
      worker.network.requests = [];
      return worker;
    }

    it("serves pages from the cache, whatever their query or fragment", async () => {
      const worker = await installed();

      expect(await (await worker.fetch(`${SCOPE}play/?gameId=ExcitingHookwormPink`)).text()).toBe("<html>play</html>");
      expect(await (await worker.fetch(`${SCOPE}summary/?gameId=ExcitingHookwormPink`)).text()).toBe(
        "<html>summary</html>"
      );
      expect(await (await worker.fetch(`${SCOPE}nearby/#o=AQIDBAUGBwg`)).text()).toBe("<html>nearby</html>");
      expect(await (await worker.fetch(`${SCOPE}?net=nearby`)).text()).toBe("<html>home</html>");
      expect(worker.network.requests).toHaveLength(0);
    });

    it("redirects <dir> to <dir>/, keeping the query", async () => {
      const worker = await installed();

      const response = await worker.fetch(`${SCOPE}play?gameId=ExcitingHookwormPink`);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(`${SCOPE}play/?gameId=ExcitingHookwormPink`);
    });

    it("asks the network for unknown pages, else serves 404.html", async () => {
      const worker = await installed();

      expect(await (await worker.fetch(`${SCOPE}ExcitingHookwormPink`)).text()).toBe("<html>not found</html>");

      worker.network.online = true;
      const online = await worker.fetch(`${SCOPE}ExcitingHookwormPink`);
      expect(online.status).toBe(404);
      expect(await online.text()).toBe("Not found (network)");
    });

    it("serves assets from the cache, else the network", async () => {
      const worker = await installed();

      const chunk = await worker.fetch(`${SCOPE}_next/static/chunks/main-1a2b.js`, { mode: "no-cors" });
      expect(await chunk.text()).toBe("console.log('main')");
      expect(chunk.headers.get("Content-Type")).toBe("text/javascript");

      worker.network.online = true;
      worker.network.serve({ "_next/static/chunks/70.later.js": "lazy" });
      expect(await (await worker.fetch(`${SCOPE}_next/static/chunks/70.later.js`, { mode: "cors" })).text()).toBe(
        "lazy"
      );
    });

    it("serves the previous version's chunks to pages it served", async () => {
      const caches = createCacheStorage();
      const previous = await installed({
        caches,
        files: exportFiles({ "_next/static/chunks/70.old.js": "old chunk" }),
      });
      const current = await installed({ caches, network: previous.network });

      const response = await current.fetch(`${SCOPE}_next/static/chunks/70.old.js`, { mode: "cors" });
      expect(await response.text()).toBe("old chunk");
    });

    it("answers Range requests (media) from the cache", async () => {
      const worker = await installed();
      const sound = `${SCOPE}static/sounds/play.mp3`;

      const partial = await worker.fetch(sound, { mode: "no-cors", headers: { Range: "bytes=2-5" } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get("Content-Range")).toBe("bytes 2-5/20");
      expect(partial.headers.get("Content-Length")).toBe("4");
      expect(partial.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(await partial.text()).toBe("2345");

      const whole = await worker.fetch(sound, { mode: "no-cors", headers: { Range: "bytes=0-" } });
      expect(whole.status).toBe(206);
      expect(await whole.text()).toBe("0123456789abcdefghij");

      const outside = await worker.fetch(sound, { mode: "no-cors", headers: { Range: "bytes=50-" } });
      expect(outside.status).toBe(416);
      expect(outside.headers.get("Content-Range")).toBe("bytes */20");
    });

    it("leaves other requests to the browser", async () => {
      const worker = await installed();

      expect(await worker.fetch(`${SCOPE}nearby-origins.json`, { mode: "cors" })).toBeNull();
      expect(await worker.fetch(`${SCOPE}play/`, { method: "POST" })).toBeNull();
      expect(await worker.fetch("https://example.github.io/other/", {})).toBeNull();
      expect(await worker.fetch("https://fonts.googleapis.com/css2?family=Kalam", { mode: "no-cors" })).toBeNull();
    });

    it("works under any scope", async () => {
      const scope = "http://192.168.1.5:3000/";
      const worker = await installed({ scope });

      expect(await (await worker.fetch(`${scope}play/?gameId=Foo`)).text()).toBe("<html>play</html>");
      expect(worker.caches.stores.has(`${cachePrefix(scope)}${worker.manifest.version}`)).toBe(true);
    });

    it("prefers the server on localhost while it answers", async () => {
      const scope = "http://localhost:3000/";
      const worker = await installed({ scope });
      expect(await (await worker.fetch(`${scope}play/?gameId=Foo`)).text()).toBe("<html>play</html>");

      // e.g. `next dev` now runs on the same port.
      worker.network.online = true;
      worker.network.serve({ "play/index.html": "<html>dev play</html>" });
      expect(await (await worker.fetch(`${scope}play/?gameId=Foo`)).text()).toBe("<html>dev play</html>");
    });
  });
});
