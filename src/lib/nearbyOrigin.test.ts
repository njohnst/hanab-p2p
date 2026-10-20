import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost, parseNearbyOrigins, resolveInviteOrigins } from "./nearbyOrigin";

describe("isLoopbackHost", () => {
  it.each([
    ["localhost"],
    ["LOCALHOST"],
    ["localhost."],
    ["hanab.localhost"],
    ["127.0.0.1"],
    ["127.1.2.3"],
    ["127.255.255.255"],
    ["::1"],
    ["[::1]"],
    ["0:0:0:0:0:0:0:1"],
    ["[::ffff:7f00:1]"],
    ["::ffff:127.0.0.1"],
  ])("%s is this computer only", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    ["192.168.1.5"],
    ["10.0.0.2"],
    ["128.0.0.1"],
    ["127.0.0.256"],
    ["127.example.com"],
    ["localhost.example.com"],
    ["mylocalhost"],
    ["example.github.io"],
    ["[fe80::1]"],
    ["[::2]"],
    ["[2001:db8::1]"],
    ["[::ffff:c0a8:105]"],
    [""],
  ])("%j is reachable from other devices", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("parseNearbyOrigins", () => {
  it("keeps the server's origins in order", () => {
    expect(
      parseNearbyOrigins({ origins: ["http://192.168.1.5:3000", "https://10.0.0.2:8443", "http://[2001:db8::1]:3000"] })
    ).toEqual(["http://192.168.1.5:3000", "https://10.0.0.2:8443", "http://[2001:db8::1]:3000"]);
  });

  it("normalises them to origins", () => {
    expect(parseNearbyOrigins({ origins: ["http://192.168.1.5:3000/", "http://192.168.1.6:80/hanabi/"] })).toEqual([
      "http://192.168.1.5:3000",
      "http://192.168.1.6",
    ]);
  });

  it("drops loopback, duplicate, current and invalid entries", () => {
    expect(
      parseNearbyOrigins(
        {
          origins: [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "http://192.168.1.5:3000",
            "http://192.168.1.5:3000/",
            "http://192.168.1.7:3000",
            "ftp://192.168.1.6",
            "javascript:alert(1)",
            "not a url",
            42,
            null,
          ],
        },
        "http://192.168.1.7:3000"
      )
    ).toEqual(["http://192.168.1.5:3000"]);
  });

  it("returns nothing for other answers", () => {
    expect(parseNearbyOrigins(null)).toEqual([]);
    expect(parseNearbyOrigins("http://192.168.1.5:3000")).toEqual([]);
    expect(parseNearbyOrigins({})).toEqual([]);
    expect(parseNearbyOrigins({ origins: "http://192.168.1.5:3000" })).toEqual([]);
  });
});

describe("resolveInviteOrigins", () => {
  function openPage(href: string) {
    const url = new URL(href);
    vi.stubGlobal("window", { location: { href, origin: url.origin, hostname: url.hostname } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the server for its LAN origins on a loopback page", async () => {
    openPage("http://localhost:3000/new-game/");
    const fetch = vi.fn(async () => Response.json({ origins: ["http://192.168.1.5:3000", "http://localhost:3000"] }));
    vi.stubGlobal("fetch", fetch);

    expect(await resolveInviteOrigins()).toEqual({
      current: "http://localhost:3000",
      lan: ["http://192.168.1.5:3000"],
      loopback: true,
    });
    expect(fetch).toHaveBeenCalledWith("/nearby-origins.json", expect.objectContaining({ cache: "no-store" }));
  });

  it("doesn't ask elsewhere", async () => {
    openPage("http://192.168.1.5:3000/play/?gameId=Foo");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(await resolveInviteOrigins()).toEqual({ current: "http://192.168.1.5:3000", lan: [], loopback: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has no LAN origins when the server doesn't know them", async () => {
    openPage("http://localhost:3000/");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not found", { status: 404 }))
    );
    expect((await resolveInviteOrigins()).lan).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>"))
    );
    expect((await resolveInviteOrigins()).lan).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")))
    );
    expect((await resolveInviteOrigins()).lan).toEqual([]);
  });

  it("knows nothing while pre-rendering", async () => {
    expect(await resolveInviteOrigins()).toEqual({ current: "", lan: [], loopback: false });
  });

  it("gives up after 2 seconds", async () => {
    vi.useFakeTimers();
    openPage("http://127.0.0.1:3000/");
    let signal: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise(() => undefined);
      })
    );

    const result = resolveInviteOrigins();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ current: "http://127.0.0.1:3000", lan: [], loopback: true });
    expect(signal.aborted).toBe(true);
  });
});
