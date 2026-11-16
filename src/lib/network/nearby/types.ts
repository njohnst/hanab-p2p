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

/* ------------------------------------------------------------------ */
/* Connection diagnostics (./diagnostics.ts)                           */
/* ------------------------------------------------------------------ */

/**
 * What an ICE candidate's address is (see addressKind in ./diagnostics.ts):
 *
 * ipv4-private      - 10/8, 172.16/12, 192.168/16: a LAN (a hotspot is often 192.168.x or 10.x).
 * ipv4-cgnat        - 100.64/10: carrier-grade NAT (mobile data), or some hotspots and VPNs.
 * ipv4-link-local   - 169.254/16: no DHCP answer on that interface.
 * ipv4-loopback     - 127/8.
 * ipv4-public       - any other unicast IPv4.
 * ipv4-other        - 0/8, multicast, reserved, broadcast.
 * ipv6-global       - 2000::/3.
 * ipv6-unique-local - fc00::/7.
 * ipv6-link-local   - fe80::/10.
 * ipv6-loopback     - ::1.
 * ipv6-other        - any other IPv6 (unspecified, multicast, IPv4-mapped...).
 * mdns              - "<uuid>.local": the browser hides the address (no camera or microphone permission).
 * hostname          - another host name.
 * unknown           - empty, or not an address.
 */
export type NearbyAddressKind =
  | "ipv4-private"
  | "ipv4-cgnat"
  | "ipv4-link-local"
  | "ipv4-loopback"
  | "ipv4-public"
  | "ipv4-other"
  | "ipv6-global"
  | "ipv6-unique-local"
  | "ipv6-link-local"
  | "ipv6-loopback"
  | "ipv6-other"
  | "mdns"
  | "hostname"
  | "unknown";

/** An ICE candidate: an address where a device may be reached. */
export interface NearbyCandidate {
  /** "udp" or "tcp" (lowercase). */
  protocol: string;
  /** IP address, "<uuid>.local" (mDNS), a host name, or "" when the browser doesn't say. */
  address: string;
  /** null when unknown. */
  port: number | null;
  /** "host", "srflx", "prflx" or "relay" ("" when unknown). */
  type: string;
  kind: NearbyAddressKind;
}

/**
 * Why a candidate this device gathered is not in its code: the codec's reasons (see
 * CandidateLeftOut in ./codec.ts) or "late" (gathered after the code was made).
 */
export type NearbyLeftOutReason =
  | "unreadable"
  | "rtcp"
  | "not-host"
  | "active-tcp"
  | "address"
  | "duplicate"
  | "limit"
  | "late";

/** A candidate this device gathered. */
export interface NearbyLocalCandidate extends NearbyCandidate {
  /** TCP candidates: "active", "passive" or "so"; null otherwise. */
  tcpType: string | null;
  /** When it was gathered (ms since the start); null when only seen in the local description. */
  atMs: number | null;
  /** In this device's code (false until the code is made). */
  inCode: boolean;
  /** Why the code leaves it out; null when it carries it, or before the code is made. */
  leftOut: NearbyLeftOutReason | null;
}

/** An entry of the timeline: what changed, when. */
export interface NearbyTimelineEntry {
  /** Milliseconds since the start. */
  atMs: number;
  /**
   * gathering  - iceGatheringState ("gathering", "complete"), or "timeout" when the code was made
   *              before gathering completed;
   * ice        - iceConnectionState ("checking", "connected", "failed"...);
   * connection - connectionState;
   * channel    - the data channel ("open", "closed");
   * code       - this device's code was made ("<carried> of <gathered>");
   * remote     - the other device's code was read: the invitation (guest) or the applied reply
   *              (inviter) ("<n> addresses");
   * link       - "open": the other tab said hi;
   * closed     - closed, with the NearbyErrorReason ("failed", "timeout", "cancelled"...).
   */
  event: "ready" | "gathering" | "ice" | "connection" | "channel" | "code" | "remote" | "link" | "closed";
  value: string;
}

/** An ICE candidate pair, from RTCPeerConnection.getStats(). */
export interface NearbyCandidatePair {
  /** "frozen", "waiting", "in-progress", "succeeded" or "failed". */
  state: string;
  nominated: boolean;
  /** The pair the connection uses. */
  selected: boolean;
  /** null when the stats don't name it. */
  local: NearbyCandidate | null;
  remote: NearbyCandidate | null;
  /** Connectivity checks sent, and the answers they got. */
  requestsSent: number;
  responsesReceived: number;
  /** Connectivity checks from the other device, and the answers this one sent. */
  requestsReceived: number;
  responsesSent: number;
  bytesSent: number;
  bytesReceived: number;
  /** Seconds; null when unknown. */
  currentRoundTripTime: number | null;
}

/**
 * Where an invitation's or a reply's connection stands, for the "Connection details" readout and
 * to send to the developer: what each device offered and how far ICE got. A snapshot: get a new
 * one with diagnostics() or onDiagnostics().
 */
export interface NearbyDiagnostics {
  /** "inviter": this device showed the invitation; "guest": it answered one. */
  role: "inviter" | "guest";
  /** When it started (Date.now()). */
  startedAt: number;
  /** Milliseconds from the start to this snapshot (frozen once the link opened or closed). */
  elapsedMs: number;
  /**
   * preparing  - gathering this device's addresses;
   * waiting    - this device's code is shown (inviter: no reply yet; guest: until the link opens);
   * ready      - codes exchanged; waiting for the user to start checks;
   * connecting - connection checks have been started;
   * open       - linked;
   * closed     - given up before or after opening: see `closed`.
   */
  stage: "preparing" | "ready" | "waiting" | "connecting" | "open" | "closed";
  /** Why it closed ("failed", "timeout", "cancelled"...); null while not closed. */
  closed: NearbyErrorReason | null;
  /** The RTCPeerConnection's latest states ("" when the browser has none, e.g. connectionState in old Firefox). */
  iceGatheringState: string;
  iceConnectionState: string;
  connectionState: string;
  /** The DTLS state from the stats ("new", "connecting", "connected", "failed"...); null when unknown. */
  dtlsState: string | null;
  /** How ICE gathering ended: "complete", "timeout" (the code was made after ~3s without it), null: not yet. */
  gatheringEnd: "complete" | "timeout" | null;
  /** How long gathering took (to its end, or so far). */
  gatheringMs: number;
  /** How many candidates this device's code carries; null until it is made. */
  codeCandidates: number | null;
  /** Every candidate this device gathered, in order. */
  local: NearbyLocalCandidate[];
  /** The candidates of the other device's code; null until known (the inviter learns them from the reply). */
  remote: NearbyCandidate[] | null;
  timeline: NearbyTimelineEntry[];
  /** Timeline entries dropped in the middle (the first and the latest ones are kept). */
  timelineDropped: number;
  /** The latest candidate pairs (getStats, about every second until the link opens or closes): kept once closed. */
  pairs: NearbyCandidatePair[];
  /** When `pairs` were read (ms since the start); null: never. */
  statsAtMs: number | null;
}

/** Diagnostics of an invitation's or a reply's connection (NearbyInvite and NearbyReply have them). */
export interface NearbyDiagnosticsSource {
  /** The current diagnostics. Never throws. */
  diagnostics(): NearbyDiagnostics;
  /**
   * Call `callback` with diagnostics() now (asynchronously) and whenever they change (state changes,
   * new statistics): about every second while connecting. Returns an unsubscribe function.
   */
  onDiagnostics(callback: (diagnostics: NearbyDiagnostics) => void): () => void;
}

/** An invite this tab shows as a QR code, waiting for its reply. */
export interface NearbyInvite extends NearbyDiagnosticsSource {
  /** `<origin><basePath>/nearby/#o=<code>`: the QR code's content. */
  readonly url: string;
  /** Random, echoed by the reply: identifies the invite among this tab's pending ones. */
  readonly token: string;
  /**
   * Resolves when the guest's tab is linked, rejects (NearbyError) when the
   * invite expires (~10 minutes), is cancelled, or the connection fails or
   * does not open within ~20s of starting connection checks. Never unhandled.
   */
  readonly connected: Promise<NearbyLink>;
  /**
   * Apply this invite's reply (a scanned or pasted reply URL or code).
   * Resolves once applied; `connected` then follows. Applying the same reply
   * again is a no-op; another invite's reply rejects with "unknown-invite".
   */
  acceptReply(text: string): Promise<void>;
  /** Release the saved remote candidates after the user taps Connect now. Idempotent. */
  startConnecting(): Promise<void>;
  /** Give up (no-op once connected): `connected` rejects with "cancelled". */
  cancel(): void;
}

/** The reply a guest shows as a QR code to the inviting device. */
export interface NearbyReply extends NearbyDiagnosticsSource {
  /** `<origin><basePath>/nearby/#a=<code>`: the QR code's content. */
  readonly url: string;
  /**
   * Resolves when the inviter applied the reply and the link is open, with
   * the inviter's peer id and the game it invites to (null for none). Rejects
   * (NearbyError) after ~10 minutes, on cancel(), or when the connection is
   * closed. Never unhandled.
   */
  readonly connected: Promise<{ peerId: string; gameId: string | null }>;
  /** Release the saved remote candidates after the user taps Connect now. Idempotent. */
  startConnecting(): Promise<void>;
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
   * With manualStart, scanning only prepares the connection; call startConnecting after both scans.
   */
  createInvite(options?: { gameId?: string | null; origin?: string; manualStart?: boolean }): Promise<NearbyInvite>;
  /**
   * Answer a scanned or pasted invite (URL or code): resolves with the reply
   * to show. Rejects with "malformed", "not-an-invite", "own-invite",
   * "unsupported-version", "no-webrtc" or "failed".
   * With manualStart, candidates are held until startConnecting; the reply QR remains usable for 10 minutes.
   */
  answerInvite(text: string, options?: { origin?: string; manualStart?: boolean }): Promise<NearbyReply>;
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
