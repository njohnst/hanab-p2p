import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useNetworkMode } from "~/hooks/networkMode";
import { i18n } from "~/lib/i18n";
import type { NetworkMode } from "~/lib/network";
import { en } from "~/locales/en";
import { fr } from "~/locales/fr";
import WaitingForGame from "./waitingForGame";

vi.mock("~/hooks/networkMode", () => ({ useNetworkMode: vi.fn() }));
vi.mock("~/components/homeButton", () => ({ default: () => null }));

function render(mode: NetworkMode | null, { timedOut = false, connected = false } = {}) {
  vi.mocked(useNetworkMode).mockReturnValue(mode);
  const app = createElement(WaitingForGame, {
    gameId: "TestGame",
    notSharedYet: timedOut,
    connection: connected
      ? {
          gameId: "TestGame",
          status: "connected",
          peers: [{ peerId: "host", playerId: "host" }],
          isAuthority: false,
          hasState: false,
          error: null,
        }
      : null,
  });
  return renderToStaticMarkup(app as Parameters<typeof renderToStaticMarkup>[0]);
}

describe("WaitingForGame", () => {
  it("shows automatic connection before the network mode is known", () => {
    const html = render(null);
    expect(html).toContain("Connecting online…");
    expect(html).toContain("The game opens automatically.");
    expect(html).not.toContain("<button");
  });

  it("offers a secondary offline fallback once online mode is known", () => {
    const html = render("webrtc");
    expect(html).toContain("Connecting online…");
    expect(html).toContain("Together without internet?");
    expect(html).toContain("Connect without internet");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("bg-cta");
  });

  it("offers the offline fallback immediately in nearby mode and hides it in local mode", () => {
    const nearby = render("nearby");
    expect(nearby).toContain("show their connection QR code");
    expect(nearby).toContain("Connect without internet");
    expect(nearby).not.toContain("Connecting online…");
    expect(render("local")).not.toContain("<button");
  });

  it("asks the inviter to keep the game open after the load timeout", () => {
    const html = render("webrtc", { timedOut: true });
    expect(html).toContain("No players connected yet");
    expect(html).toContain("keep the game open");
    expect(html).toContain("Connect without internet");
  });

  it("shows that data is pending once a peer connects, even after the timeout", () => {
    const html = render("webrtc", { connected: true, timedOut: true });
    expect(html).toContain("Connected. Waiting for game data…");
    expect(html).not.toContain("No players connected yet");
    expect(html).not.toContain("<button");
  });

  it("translates the waiting copy in French and falls back to English in Spanish", () => {
    const translateFr = i18n.getFixedT("fr");
    const translateEs = i18n.getFixedT("es");
    expect(Object.keys(fr.unified)).toEqual(Object.keys(en.unified));
    expect(translateFr("unified.connectWithoutInternet")).toBe("Se connecter sans internet");
    expect(translateEs("unified.connectWithoutInternet")).toBe("Connect without internet");
  });
});
