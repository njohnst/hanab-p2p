/**
 * Public types of nearby play (docs/P2P_DESIGN.md, "Nearby play (no
 * internet)"), re-exported by ~/lib/network for the UI.
 *
 * A tab in nearby mode reaches the other tabs through links: one
 * RTCPeerConnection + data channel each, bootstrapped by exchanging two QR
 * codes (an invite and its reply), then completed into a mesh by the tabs
 * themselves. See ./links.ts for the protocol and ./codec.ts for the codes.
 */

/** A nearby code found in a scanned or pasted text (see parseNearbyText). */
export interface NearbyCode {
  /** "invite": a `#o=` code (an offer), to answer. "reply": a `#a=` code (an answer), for the inviter. */
  kind: "invite" | "reply";
  /** The compact description, base64url. */
  code: string;
}

/**
 * Why a nearby operation failed:
 *
 * malformed           - not a nearby code, or a damaged one (truncated, mistyped).
 * not-an-invite       - answerInvite was given a reply: it belongs to the inviting device.
 * not-a-reply         - acceptReply was given an invite.
 * unknown-invite      - a reply to an invite this tab does not hold (another device's, or already used).
 * own-invite          - this tab's own code: it must be scanned by another device.
 * unsupported-version - made by another version of the app (reload both pages), or the other tab speaks
 *                       another link protocol.
 * no-webrtc           - this browser has no WebRTC.
 * timeout             - the invite expired (~10 minutes), or the connection did not open in time (~20s).
 * failed              - the devices could not connect (different networks, client isolation, a WebRTC error).
 * cancelled           - cancel() was called, or the page went away.
 */
export type NearbyErrorReason =
  | "malformed"
  | "not-an-invite"
  | "not-a-reply"
  | "unknown-invite"
  | "own-invite"
  | "unsupported-version"
  | "no-webrtc"
  | "timeout"
  | "failed"
  | "cancelled";

const MESSAGES: Record<NearbyErrorReason, string> = {
  "malformed": "This is not a nearby invite or reply code (or it is incomplete).",
  "not-an-invite": "This is a reply code: scan it with the device that showed the invite.",
  "not-a-reply": "This is an invite code: scan it with another device to answer it.",
  "unknown-invite": "This reply answers an invite this page does not hold (another one, or one already used).",
  "own-invite": "This code was made on this page: scan it with another device.",
  "unsupported-version": "This code comes from another version of Hanab: reload the page on both devices.",
  "no-webrtc": "This browser cannot connect to nearby devices (no WebRTC support).",
  "timeout": "The connection timed out.",
  "failed": "The devices could not connect. Are they on the same network?",
  "cancelled": "Cancelled.",
};

/** Every rejection of the nearby API. The UI shows a message chosen by `reason`. */
export class NearbyError extends Error {
  readonly reason: NearbyErrorReason;

  constructor(reason: NearbyErrorReason, message?: string) {
    super(message || MESSAGES[reason]);
    this.name = "NearbyError";
    this.reason = reason;
    // Keeps instanceof working when classes are compiled down to ES5 functions.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isNearbyError(error: unknown): error is NearbyError {
  return error instanceof Error && error.name === "NearbyError" && typeof (error as NearbyError).reason === "string";
}

/** Another tab this tab is linked with (one entry per tab, whatever the number of connections to it). */
export interface NearbyLink {
  /** The other tab's selfId: also its peer id in game rooms (ConnectionInfo.peers). */
  peerId: string;
  /** Player id the other tab announced; null until known. */
  playerId: string | null;
  /** "connecting": a mesh connection is being set up. "open": messages flow. */
  state: "connecting" | "open";
  /** "invite": made by scanning QR codes. "mesh": made by the tabs through a common neighbour. */
  via: "invite" | "mesh";
}

/** An invite this tab shows as a QR code, waiting for its reply. */
export interface NearbyInvite {
  /** `<origin><basePath>/nearby/#o=<code>`: the QR code's content. */
  readonly url: string;
  /** Random, echoed by the reply: identifies the invite among this tab's pending ones. */
  readonly token: string;
  /**
   * Resolves when the guest's tab is linked, rejects (NearbyError) when the
   * invite expires (~10 minutes), is cancelled, or the connection fails or
   * does not open within ~20s of the reply. Never unhandled.
   */
  readonly connected: Promise<NearbyLink>;
  /**
   * Apply this invite's reply (a scanned or pasted reply URL or code).
   * Resolves once applied; `connected` then follows. Applying the same reply
   * again is a no-op; another invite's reply rejects with "unknown-invite".
   */
  acceptReply(text: string): Promise<void>;
  /** Give up waiting (no-op once connected): `connected` rejects with "cancelled". */
  cancel(): void;
}

/** The reply a guest shows as a QR code to the inviting device. */
export interface NearbyReply {
  /** `<origin><basePath>/nearby/#a=<code>`: the QR code's content. */
  readonly url: string;
  /**
   * Resolves when the inviter applied the reply and the link is open, with
   * the inviter's peer id and the game it invites to (null for none). Rejects
   * (NearbyError) after ~10 minutes, on cancel(), or when the connection is
   * closed. Never unhandled.
   */
  readonly connected: Promise<{ peerId: string; gameId: string | null }>;
  /** Give up (no-op once connected): `connected` rejects with "cancelled". */
  cancel(): void;
}

/** This tab's links (nearby mode only: see getNearby in ~/lib/network). */
export interface NearbyApi {
  /** Random per tab: this tab's peer id in links and game rooms. */
  readonly selfId: string;
  /**
   * Make an invite: a WebRTC offer with this device's local addresses (ICE
   * gathering takes up to ~3s). Start the camera first when possible: with
   * camera permission browsers reveal real addresses instead of mDNS names,
   * which networks that block multicast need. `gameId` is announced to the
   * guest once linked; `origin` defaults to the page's origin (give the LAN
   * origin when the page runs on localhost). Rejects with "no-webrtc" or "failed".
   */
  createInvite(options?: { gameId?: string | null; origin?: string }): Promise<NearbyInvite>;
  /**
   * Answer a scanned or pasted invite (URL or code): resolves with the reply
   * to show. Rejects with "malformed", "not-an-invite", "own-invite",
   * "unsupported-version", "no-webrtc" or "failed".
   */
  answerInvite(text: string, options?: { origin?: string }): Promise<NearbyReply>;
  /**
   * Apply a scanned or pasted reply to whichever pending invite it answers
   * (matched by token); resolves with that invite once applied (await its
   * `connected` for the link). Rejects with "malformed", "not-a-reply",
   * "own-invite", "unsupported-version", "unknown-invite", "timeout" (the
   * invite expired) or "failed".
   */
  acceptReply(text: string): Promise<NearbyInvite>;
  /** Linked tabs, open ones and mesh connections in progress, sorted by peer id. */
  links(): NearbyLink[];
  /** Call `callback` with links() now (asynchronously) and on every change. Returns an unsubscribe function. */
  subscribe(callback: (links: NearbyLink[]) => void): () => void;
}
