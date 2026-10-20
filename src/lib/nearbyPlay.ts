/**
 * Helpers for the nearby play screens (docs/P2P_DESIGN.md, "Nearby play (no internet)"): where
 * their links go, which origin the QR codes carry, and which message explains each failure.
 *
 * The screens are ~/pages/nearby.tsx and ~/components/nearby*.tsx. Everything here is pure (the
 * one navigation helper loads ~/lib/network when called), so it is unit-tested in Node and the
 * home page can use it without loading the sync engine.
 */
import type { InviteOrigins } from "~/lib/nearbyOrigin";
import type { NearbyErrorReason, NetworkMode } from "~/lib/network";
import { withBasePath } from "~/lib/routes";

/** The nearby page, for the Next router (client-side navigation, within nearby mode). */
export const NEARBY_PAGE = "/nearby/";

/** The nearby page for a page load, which puts the tab in nearby mode. */
export function nearbyPageHref(): string {
  return withBasePath(NEARBY_PAGE);
}

/** The home page in the default (online) mode, for a page load: `?net=webrtc` leaves nearby mode. */
export function onlinePlayHref(): string {
  return withBasePath("/?net=webrtc");
}

/** `href` (a full URL) with `net=<mode>` in its query, its fragment kept. */
export function withNetworkMode(href: string, mode: NetworkMode): string {
  const url = new URL(href);
  url.searchParams.set("net", mode);
  return url.toString();
}

/**
 * Open the nearby page: with the router within nearby mode (a page load would close the links to
 * the other devices), otherwise with a page load, which switches the tab to nearby mode.
 */
export async function openNearbyPage(router: { push(url: string): Promise<boolean> }): Promise<void> {
  const { getNetworkMode } = await import("~/lib/network");
  if (getNetworkMode() === "nearby") {
    await router.push(NEARBY_PAGE);
  } else {
    window.location.assign(nearbyPageHref());
  }
}

/* ------------------------------------------------------------------ */
/* Origins                                                             */
/* ------------------------------------------------------------------ */

export interface InviteOriginChoice {
  /** The origin to put in invitation URLs. */
  origin: string;
  /** Other devices' ways to reach this server, best first, when the page runs on localhost. */
  choices: string[];
  /** The page runs on localhost and no other address is known: other devices can't open its links. */
  localOnly: boolean;
}

/**
 * Which origin invitations carry: the page's own, except on localhost where other devices need
 * one of this computer's LAN addresses (from `yarn serve:static`, see ~/lib/nearbyOrigin).
 */
export function pickInviteOrigin(origins: InviteOrigins): InviteOriginChoice {
  if (!origins.loopback) {
    return { origin: origins.current, choices: [], localOnly: false };
  }
  if (origins.lan.length) {
    return { origin: origins.lan[0], choices: origins.lan, localOnly: false };
  }

  return { origin: origins.current, choices: [], localOnly: true };
}

/** `url` made for `from`, moved to the origin `to` (the code after the origin is the same). */
export function moveToOrigin(url: string, from: string, to: string): string {
  if (!from || !to || from === to || !url.startsWith(from)) {
    return url;
  }

  return `${to}${url.slice(from.length)}`;
}

/**
 * The origin a guest's reply should carry: the invitation's own when it was a URL. The reply goes
 * back to the inviting device: opened by its camera app, it must land on the origin of the
 * inviting tab, the only place where it can be handed to that tab (BroadcastChannel is per
 * origin). A bare code (pasted) gives no origin: `fallback`.
 */
export function replyOrigin(inviteText: string, fallback: string): string {
  const match = /https?:\/\/[^\s/?#"'<>`]+/i.exec(inviteText || "");
  if (match) {
    try {
      return new URL(match[0]).origin;
    } catch {
      // Not a URL after all.
    }
  }

  return fallback;
}

/* ------------------------------------------------------------------ */
/* Messages (translation keys, in ~/locales under "nearby")             */
/* ------------------------------------------------------------------ */

/** An invitation older than this that times out has expired (they last 10 minutes, see NearbyInvite). */
export const INVITE_EXPIRY_GUESS_MS = 9.5 * 60 * 1000;

/** Why createInvite failed. */
export function createFailureKey(reason: NearbyErrorReason): string {
  return reason === "no-webrtc" ? "nearby.noWebrtc" : "nearby.invite.prepareFailed";
}

/**
 * A scanned reply the inviter can't use, but which leaves the invitation valid: the message to show
 * while scanning goes on. null: the invitation itself failed (see inviteFailureKey).
 */
export function replyNoticeKey(reason: NearbyErrorReason): string | null {
  switch (reason) {
    case "malformed":
      return "nearby.invite.notice.malformed";
    case "not-a-reply":
      return "nearby.invite.notice.invitation";
    case "unknown-invite":
      return "nearby.invite.notice.otherInvitation";
    case "own-invite":
      return "nearby.invite.notice.ownCode";
    case "unsupported-version":
      return "nearby.invite.notice.otherVersion";
    default:
      return null;
  }
}

/**
 * Why an invitation ended without a link. `replied`: this tab applied a reply (the devices then had
 * ~20s to connect); `ageMs`: how old the invitation is, to tell an expiry from a reply applied by
 * another tab that did not connect (both are "timeout").
 */
export function inviteFailureKey(reason: NearbyErrorReason, situation: { replied: boolean; ageMs: number }): string {
  switch (reason) {
    case "timeout":
      return !situation.replied && situation.ageMs >= INVITE_EXPIRY_GUESS_MS
        ? "nearby.invite.expired"
        : "nearby.noConnection";
    case "failed":
      return "nearby.noConnection";
    case "no-webrtc":
      return "nearby.noWebrtc";
    default:
      return replyNoticeKey(reason) ?? "nearby.invite.prepareFailed";
  }
}

/** Why a guest could not answer an invitation, or its reply never connected. */
export function answerFailureKey(reason: NearbyErrorReason): string {
  switch (reason) {
    case "malformed":
      return "nearby.answer.malformed";
    case "not-an-invite":
      return "nearby.answer.notAnInvitation";
    case "own-invite":
      return "nearby.answer.ownInvitation";
    case "unsupported-version":
      return "nearby.answer.otherVersion";
    case "no-webrtc":
      return "nearby.noWebrtc";
    case "timeout":
      return "nearby.answer.expired";
    default:
      return "nearby.noConnection";
  }
}

/* ------------------------------------------------------------------ */
/* Linked devices                                                      */
/* ------------------------------------------------------------------ */

/** The part of a stored game replica (`getNetworkNode().store.list()`) naming its players. */
export interface ReplicaPlayers {
  updatedAt: number;
  game: { players?: Array<{ id: string; name: string }> };
}

/**
 * Player names by player id, from the games this browser holds (the most recently updated game
 * wins): linked tabs announce a player id, and this is how the nearby page puts a name on it.
 */
export function playerNamesById(replicas: ReplicaPlayers[]): Record<string, string> {
  const names: Record<string, string> = {};
  [...replicas]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .forEach(({ game }) => {
      (game?.players || []).forEach((player) => {
        if (player?.id && player.name) {
          names[player.id] = player.name;
        }
      });
    });

  return names;
}
