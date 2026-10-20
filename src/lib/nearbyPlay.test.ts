import { describe, expect, it } from "vitest";
import type { NearbyErrorReason } from "~/lib/network";
import { en } from "~/locales/en";
import { fr } from "~/locales/fr";
import {
  answerFailureKey,
  createFailureKey,
  INVITE_EXPIRY_GUESS_MS,
  inviteFailureKey,
  moveToOrigin,
  nearbyPageHref,
  onlinePlayHref,
  pickInviteOrigin,
  playerNamesById,
  replyNoticeKey,
  replyOrigin,
  withNetworkMode,
} from "./nearbyPlay";

const REASONS: NearbyErrorReason[] = [
  "malformed",
  "not-an-invite",
  "not-a-reply",
  "unknown-invite",
  "own-invite",
  "unsupported-version",
  "no-webrtc",
  "timeout",
  "failed",
  "cancelled",
];

/** The translation at a dotted key, or undefined. */
function lookup(resources: unknown, key: string): unknown {
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), resources);
}

function expectTranslated(key: string) {
  expect(typeof lookup(en, key), `en: ${key}`).toBe("string");
  expect(typeof lookup(fr, key), `fr: ${key}`).toBe("string");
}

describe("links", () => {
  it("opens the nearby page and the online home page with a page load", () => {
    expect(nearbyPageHref()).toBe("/nearby/");
    expect(onlinePlayHref()).toBe("/?net=webrtc");
  });

  it("sets the network mode in a URL, keeping its other parameters and its fragment", () => {
    expect(withNetworkMode("http://localhost:3000/play/?gameId=Foo&as=bob", "nearby")).toBe(
      "http://localhost:3000/play/?gameId=Foo&as=bob&net=nearby"
    );
    expect(withNetworkMode("https://example.com/hanab/play/?net=webrtc&gameId=Foo", "nearby")).toBe(
      "https://example.com/hanab/play/?net=nearby&gameId=Foo"
    );
    expect(withNetworkMode("http://192.168.1.5:3000/nearby/#o=AbC", "nearby")).toBe(
      "http://192.168.1.5:3000/nearby/?net=nearby#o=AbC"
    );
  });
});

describe("pickInviteOrigin", () => {
  it("uses the page's origin when other devices can open it", () => {
    expect(pickInviteOrigin({ current: "https://example.github.io", lan: [], loopback: false })).toEqual({
      origin: "https://example.github.io",
      choices: [],
      localOnly: false,
    });
  });

  it("uses this computer's best LAN address on localhost, offering the others", () => {
    const lan = ["http://192.168.1.5:3000", "http://10.0.0.2:3000"];
    expect(pickInviteOrigin({ current: "http://localhost:3000", lan, loopback: true })).toEqual({
      origin: "http://192.168.1.5:3000",
      choices: lan,
      localOnly: false,
    });
  });

  it("says when other devices can't open the links (localhost, no LAN address known)", () => {
    expect(pickInviteOrigin({ current: "http://localhost:3000", lan: [], loopback: true })).toEqual({
      origin: "http://localhost:3000",
      choices: [],
      localOnly: true,
    });
  });
});

describe("moveToOrigin", () => {
  const url = "http://192.168.1.5:3000/nearby/#o=AbC";

  it("swaps the origin and keeps the rest", () => {
    expect(moveToOrigin(url, "http://192.168.1.5:3000", "http://10.0.0.2:3000")).toBe(
      "http://10.0.0.2:3000/nearby/#o=AbC"
    );
  });

  it("leaves URLs of another origin alone", () => {
    expect(moveToOrigin(url, "http://10.0.0.2:3000", "http://172.16.0.1:3000")).toBe(url);
    expect(moveToOrigin(url, "http://192.168.1.5:3000", "http://192.168.1.5:3000")).toBe(url);
    expect(moveToOrigin(url, "", "http://10.0.0.2:3000")).toBe(url);
  });
});

describe("replyOrigin", () => {
  it("takes the invitation's origin, so the reply opens where the inviting tab is", () => {
    expect(replyOrigin("https://example.github.io/hanab/nearby/#o=AbCdEf", "http://localhost:3000")).toBe(
      "https://example.github.io"
    );
    expect(replyOrigin("Join me! http://192.168.1.5:3000/nearby/#o=AbCdEf", "https://other.example")).toBe(
      "http://192.168.1.5:3000"
    );
    expect(replyOrigin("<http://[fe80::1]:3000/nearby/#o=AbC>", "https://other.example")).toBe("http://[fe80::1]:3000");
  });

  it("falls back for a bare code", () => {
    expect(replyOrigin("o=AbCdEfGhIjKlMnOp", "http://192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
    expect(replyOrigin("AbCdEfGhIjKlMnOp", "http://192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
    expect(replyOrigin("", "http://192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
  });
});

describe("failure messages", () => {
  it("tells an expired invitation from devices that could not connect", () => {
    const young = INVITE_EXPIRY_GUESS_MS - 1000;
    expect(inviteFailureKey("timeout", { replied: false, ageMs: INVITE_EXPIRY_GUESS_MS })).toBe(
      "nearby.invite.expired"
    );
    // A reply applied by another tab of the browser, that did not connect within ~20s.
    expect(inviteFailureKey("timeout", { replied: false, ageMs: young })).toBe("nearby.noConnection");
    expect(inviteFailureKey("timeout", { replied: true, ageMs: Infinity })).toBe("nearby.noConnection");
    expect(inviteFailureKey("failed", { replied: true, ageMs: 0 })).toBe("nearby.noConnection");
    expect(inviteFailureKey("no-webrtc", { replied: false, ageMs: 0 })).toBe("nearby.noWebrtc");
  });

  it("keeps scanning after a reply the invitation can't use", () => {
    expect(replyNoticeKey("malformed")).toBe("nearby.invite.notice.malformed");
    expect(replyNoticeKey("not-a-reply")).toBe("nearby.invite.notice.invitation");
    expect(replyNoticeKey("unknown-invite")).toBe("nearby.invite.notice.otherInvitation");
    expect(replyNoticeKey("own-invite")).toBe("nearby.invite.notice.ownCode");
    expect(replyNoticeKey("unsupported-version")).toBe("nearby.invite.notice.otherVersion");
    // The invitation itself is over.
    expect(replyNoticeKey("timeout")).toBeNull();
    expect(replyNoticeKey("failed")).toBeNull();
    expect(replyNoticeKey("cancelled")).toBeNull();
  });

  it("explains a guest's failures", () => {
    expect(answerFailureKey("malformed")).toBe("nearby.answer.malformed");
    expect(answerFailureKey("not-an-invite")).toBe("nearby.answer.notAnInvitation");
    expect(answerFailureKey("own-invite")).toBe("nearby.answer.ownInvitation");
    expect(answerFailureKey("unsupported-version")).toBe("nearby.answer.otherVersion");
    expect(answerFailureKey("timeout")).toBe("nearby.answer.expired");
    expect(answerFailureKey("failed")).toBe("nearby.noConnection");
    expect(answerFailureKey("no-webrtc")).toBe("nearby.noWebrtc");
  });

  it("has a message in English and French for every reason", () => {
    for (const reason of REASONS) {
      expectTranslated(createFailureKey(reason));
      expectTranslated(answerFailureKey(reason));
      for (const replied of [false, true]) {
        for (const ageMs of [0, Infinity]) {
          expectTranslated(inviteFailureKey(reason, { replied, ageMs }));
        }
      }
      const notice = replyNoticeKey(reason);
      if (notice) expectTranslated(notice);
    }
  });
});

describe("playerNamesById", () => {
  it("names players after the most recently updated game", () => {
    const names = playerNamesById([
      { updatedAt: 200, game: { players: [{ id: "p1", name: "Alice" }] } },
      {
        updatedAt: 100,
        game: {
          players: [
            { id: "p1", name: "Old Alice" },
            { id: "p2", name: "Bob" },
          ],
        },
      },
      { updatedAt: 300, game: {} },
    ]);

    expect(names).toEqual({ p1: "Alice", p2: "Bob" });
  });
});
