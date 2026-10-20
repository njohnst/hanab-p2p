import { afterEach, describe, expect, it, vi } from "vitest";
import { selectTransportKind } from "./browser";
import { createMemoryStorage } from "./storage";

function visit(url: string, sessionStorage = createMemoryStorage()) {
  const { pathname, search } = new URL(url, "https://hanab.test");
  vi.stubGlobal("window", { location: { pathname, search } });
  vi.stubGlobal("sessionStorage", sessionStorage);
  return sessionStorage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("network mode", () => {
  it("is webrtc by default", () => {
    visit("/");
    expect(selectTransportKind()).toBe("webrtc");
  });

  it("is nearby on pages under /nearby/ and with ?net=nearby, for the rest of the tab's life", () => {
    const session = visit("/nearby/");
    expect(selectTransportKind()).toBe("nearby");
    visit("/play/?gameId=SomeGame", session);
    expect(selectTransportKind()).toBe("nearby");

    visit("/play/?gameId=SomeGame&net=webrtc", session);
    expect(selectTransportKind()).toBe("webrtc");
    visit("/", session);
    expect(selectTransportKind()).toBe("webrtc");

    visit("/?net=nearby", session);
    expect(selectTransportKind()).toBe("nearby");
    visit("/nearby", createMemoryStorage());
    expect(selectTransportKind()).toBe("nearby");
    visit("/nearby-games/", createMemoryStorage());
    expect(selectTransportKind()).toBe("webrtc");
  });

  it("keeps ?net=local, and an explicit ?net wins over the page", () => {
    const session = visit("/?net=local");
    expect(selectTransportKind()).toBe("local");
    visit("/", session);
    expect(selectTransportKind()).toBe("local");
    visit("/nearby/?net=local", session);
    expect(selectTransportKind()).toBe("local");
    visit("/nearby/?net=webrtc", session);
    expect(selectTransportKind()).toBe("webrtc");
  });

  it("works without sessionStorage", () => {
    visit("/nearby/");
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(selectTransportKind()).toBe("nearby");
  });
});
