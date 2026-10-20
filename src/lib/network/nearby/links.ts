/**
 * Nearby links (docs/P2P_DESIGN.md, "Nearby play (no internet)"): this tab's
 * direct WebRTC connections to other tabs on the local network, with no
 * server of any kind (no signaling relay, no STUN). One LinkManager per tab.
 *
 * - QR handshake: createInvite() makes an offer (iceServers: [], one ordered
 *   data channel, ICE gathering awaited for at most ~3s) and encodes it
 *   (./codec.ts) into the invite URL; the guest's answerInvite() answers it
 *   into the reply URL; the inviter applies the reply (acceptReply). The
 *   invite's random token, echoed by the reply, picks the pending invite.
 *   Invites expire after ~10 minutes; an applied reply must connect within
 *   ~20s. A guest's connection may fail while it waits for the inviter to
 *   scan the reply, and recover once the inviter answers its checks: it is
 *   only given up when closed or expired.
 * - A link is open once its data channel is open and the other tab's `hi`
 *   arrived. Links speak a small JSON protocol (one JSON text per message):
 *     hi    {v, id, rooms, peers, game, player, seq}  first message, both ways
 *     rooms {rooms, seq}       the rooms (games) this tab is in
 *     peers {peers, seq}       the tabs this tab has open links with
 *     m     {r, d}             a message of room r
 *     sig   {to, d} / {from, d}  mesh signaling relayed by a common neighbour
 *     ping / pong              heartbeat
 *     bye                      the tab is leaving: drop it now
 *     part  {id, i, n, data}   a slice of a message longer than 16 KB
 *   `seq` comes from one counter per tab, so the latest rooms/peers win
 *   whichever link they arrive on.
 * - Mesh: QR codes only bootstrap. When a tab learns from a neighbour's
 *   `peers` about a tab it has no link with, the one with the smaller selfId
 *   sends it an offer through that neighbour, trickling its ICE candidates
 *   (`sig`); the neighbour only forwards between two of its own open links
 *   (one hop) and answers `fail` when it cannot. Failed attempts are retried
 *   with a backoff (5s, doubling), and after 5 failures in a row only when
 *   a neighbour's peer list changes.
 * - Liveness: a ping every 5s on every link; a link nothing was heard from
 *   for 30s is dropped, except right after a throttled timer (a background
 *   tab: the others did not get a chance to answer). A link whose data
 *   channel closes or whose connection fails or closes is dropped at once
 *   ("disconnected" may recover: it is left alone). pagehide (depart())
 *   says `bye` on every link and closes them all.
 * - Several links to one tab (a QR exchange between tabs already linked, a
 *   mesh connection made again after one side dropped the old one): the
 *   newest carries what this tab sends, messages are accepted from all, and
 *   the tab with the smaller selfId closes the replaced ones after a few
 *   seconds, so both sides end up on the same link even if they saw the
 *   links open in a different order. A tab is gone when its last link is.
 * - Replies opened in another tab of this browser (a camera app opens the
 *   reply URL in a new tab) reach the inviting tab over BroadcastChannel
 *   `hanab-nearby`: see deliverReplyToOtherTab.
 *
 * RTCPeerConnection, BroadcastChannel, timers, the clock and the random
 * source are injectable, so the tests run in Node with fakes (./testing.ts).
 * Everything received is untrusted: messages are validated and no handler
 * lets an exception escape.
 */
import { isEqual } from "lodash";
import { buildSdp, CompactDescription, fromCode, nearbyUrl, parseNearbyText, parseSdp, toCode } from "./codec";
import {
  isNearbyError,
  NearbyApi,
  NearbyError,
  NearbyErrorReason,
  NearbyInvite,
  NearbyLink,
  NearbyReply,
} from "./types";

/** Bump when tabs running the old code would misread link messages: links between them are refused. */
export const LINK_PROTOCOL = 1;
export const DATA_CHANNEL_LABEL = "hanab";
export const HANDOFF_CHANNEL = "hanab-nearby";
/** Messages longer than this (serialised) travel in parts. */
export const MAX_FRAME_CHARS = 16 * 1024;

/** Larger frames are ignored (a part frame is at most ~2x MAX_FRAME_CHARS once escaped). */
const MAX_INCOMING_FRAME_CHARS = 4 * MAX_FRAME_CHARS;
/** At most this many parts per message (1 MB), and messages being reassembled per link. */
const MAX_PARTS = 64;
const MAX_ASSEMBLIES = 4;
/** After this many failures in a row, a mesh connection is only retried when the peer lists change. */
const MAX_MESH_FAILURES = 5;
/** Connections being set up for the mesh at once (a hostile neighbour cannot exhaust the browser). */
const MAX_CONNECTING_MESH = 16;
/** Their ICE candidates kept until their description is applied. */
const MAX_QUEUED_CANDIDATES = 32;
const MAX_LISTED = 64;
const MAX_SDP_CHARS = 16 * 1024;

export interface LinkTimings {
  /** Longest wait for ICE gathering before encoding what was gathered. */
  gatherTimeoutMs: number;
  /** Pending invites and replies expire after this long. */
  inviteTtlMs: number;
  /** A link must open within this long of its reply being applied (QR) or of its offer (mesh). */
  connectTimeoutMs: number;
  pingIntervalMs: number;
  /** A link nothing was heard from for this long is dropped. */
  silenceTimeoutMs: number;
  /** First delay before retrying a failed mesh connection (doubled at each failure, up to meshRetryMaxMs). */
  meshRetryMs: number;
  meshRetryMaxMs: number;
  /** How long a replaced link is kept (by the tab with the smaller id) before being closed. */
  supersededGraceMs: number;
}

export const DEFAULT_LINK_TIMINGS: LinkTimings = {
  gatherTimeoutMs: 3000,
  inviteTtlMs: 10 * 60 * 1000,
  connectTimeoutMs: 20000,
  pingIntervalMs: 5000,
  silenceTimeoutMs: 30000,
  meshRetryMs: 5000,
  meshRetryMaxMs: 80000,
  supersededGraceMs: 5000,
};

/* ------------------------------------------------------------------ */
/* What the manager needs from the platform (fakes in tests)           */
/* ------------------------------------------------------------------ */

export interface IceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** The subset of RTCDataChannel used ("open", "message", "close" events). */
export interface DataChannelLike extends EventTarget {
  readonly label: string;
  readonly readyState: string;
  send(data: string): void;
  close(): void;
}

/**
 * The subset of RTCPeerConnection used ("icecandidate", "icegatheringstatechange",
 * "connectionstatechange", "iceconnectionstatechange" and "datachannel" events).
 */
export interface PeerConnectionLike extends EventTarget {
  readonly localDescription: { type: string; sdp: string } | null;
  /** Missing in older Firefox, which only has iceConnectionState. */
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly iceGatheringState: string;
  createDataChannel(label: string, options?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  createAnswer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(description: { type?: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  close(): void;
}

export interface BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export type PeerConnectionFactory = (config: { iceServers: [] }) => PeerConnectionLike;
export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The global timers, looked up at call time (so that test fake timers apply). */
const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function defaultPeerConnectionFactory(): PeerConnectionFactory | null {
  if (typeof RTCPeerConnection === "undefined") return null;
  return (config) => (new RTCPeerConnection(config) as unknown) as PeerConnectionLike;
}

function defaultBroadcastChannelFactory(): BroadcastChannelFactory | null {
  if (typeof BroadcastChannel === "undefined") return null;
  return (name) => (new BroadcastChannel(name) as unknown) as BroadcastChannelLike;
}

function defaultRandom(bytes: Uint8Array) {
  crypto.getRandomValues(bytes);
}

export interface LinkManagerOptions {
  /** This tab's id (random by default). The smaller of two ids initiates their mesh connection. */
  selfId?: string;
  /** null: no WebRTC. Defaults to the browser's RTCPeerConnection. */
  createPeerConnection?: PeerConnectionFactory | null;
  /** null: no reply hand-off between tabs. Defaults to the browser's BroadcastChannel. */
  createBroadcastChannel?: BroadcastChannelFactory | null;
  random?: (bytes: Uint8Array) => void;
  now?: () => number;
  timers?: Timers;
  /** Announced to linked tabs (NearbyLink.playerId). */
  getPlayerId?: () => string | null;
  /** Origin of invite and reply URLs when the caller gives none. Defaults to the page's. */
  origin?: () => string;
  timings?: Partial<LinkTimings>;
}

/** What the nearby transport (./transport.ts) hears from the links. */
export interface RoomWatcher {
  /** Some tab's room list changed, or a tab was linked or lost: recompute room members. */
  changed(): void;
  message(peerId: string, roomId: string, data: unknown): void;
}

/* ------------------------------------------------------------------ */
/* Link messages                                                       */
/* ------------------------------------------------------------------ */

interface HiMessage {
  t: "hi";
  v: number;
  id: string;
  rooms: string[];
  peers: string[];
  game: string | null;
  player: string | null;
  seq: number;
}

type SigData =
  | { a: string; k: "offer" | "answer"; sdp: string }
  | { a: string; k: "cand"; c: string; mid?: string | null; idx?: number | null }
  | { a: string; k: "fail" };

type LinkMessage =
  | HiMessage
  | { t: "rooms"; rooms: string[]; seq: number }
  | { t: "peers"; peers: string[]; seq: number }
  | { t: "m"; r: string; d: unknown }
  | { t: "sig"; to?: string; from?: string; d: SigData }
  | { t: "ping" | "pong" | "bye" }
  | { t: "part"; id: string; i: number; n: number; data: string };

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;
const isRoom = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
const isSeq = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isListOf = (value: unknown, check: (item: unknown) => boolean): value is string[] =>
  Array.isArray(value) && value.length <= MAX_LISTED && value.every(check);
const isOptional = (value: unknown, check: (item: unknown) => boolean) =>
  value === undefined || value === null || check(value);

function isHi(message: Obj): message is Obj & HiMessage {
  return (
    isSeq(message.v) &&
    isId(message.id) &&
    isListOf(message.rooms, isRoom) &&
    isListOf(message.peers, isId) &&
    isOptional(message.game, isRoom) &&
    isOptional(message.player, isRoom) &&
    isSeq(message.seq)
  );
}

/** Validated signaling, rebuilt with only the known fields (a relay forwards nothing else). */
function parseSig(value: unknown): SigData | null {
  if (!isObject(value) || !isId(value.a)) return null;
  const { a, k } = value;
  switch (k) {
    case "offer":
    case "answer":
      return typeof value.sdp === "string" && value.sdp.length <= MAX_SDP_CHARS ? { a, k, sdp: value.sdp } : null;
    case "cand": {
      const { c, mid, idx } = value;
      if (typeof c !== "string" || c.length > 1024) return null;
      if (!isOptional(mid, (item) => typeof item === "string" && item.length <= 64)) return null;
      if (!isOptional(idx, (item) => isSeq(item) && item < 64)) return null;
      return { a, k, c, mid: (mid as string) ?? null, idx: (idx as number) ?? null };
    }
    case "fail":
      return { a, k };
    default:
      return null;
  }
}

/** Slices of at most `size` characters, never splitting a surrogate pair (each slice must be valid UTF-16). */
function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function listen(target: EventTarget, type: string, handler: (event: Event) => void): () => void {
  target.addEventListener(type, handler);
  return () => target.removeEventListener(type, handler);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

/** A promise settled from outside, never reported as an unhandled rejection. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** ICE credentials: unique per RTCPeerConnection, they recognise this tab's own codes. */
function credentialsOf(description: CompactDescription): string {
  return `${description.ufrag}:${description.pwd}`;
}

/** A failure while making an invite or reply: anything but a cancellation is "failed". */
function setupFailure(error: unknown): NearbyError {
  if (isNearbyError(error) && (error.reason === "cancelled" || error.reason === "no-webrtc")) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new NearbyError("failed", `Could not set up the connection: ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

interface MeshSignaling {
  /** Attempt id, shared by both sides' sig messages. */
  id: string;
  initiator: boolean;
  /** The neighbour signaling goes through. */
  relay: string | null;
  /** Our description went out: candidates can follow. */
  localSent: boolean;
  /** Their description is applied: their candidates can be added. */
  remoteApplied: boolean;
  outbox: SigData[];
  inbox: IceCandidateLike[];
}

interface Assembly {
  n: number;
  parts: string[];
  count: number;
}

interface Link {
  pc: PeerConnectionLike;
  channel: DataChannelLike | null;
  via: NearbyLink["via"];
  /** The other tab: known from the start for mesh links, from its hi for QR links. */
  peerId: string | null;
  state: "connecting" | "open" | "closed";
  channelOpen: boolean;
  lastHeard: number;
  /** The game announced to the other tab in our hi (the invite's). */
  announcedGame: string | null;
  /** The game the other tab announced in its hi. */
  remoteGame: string | null;
  /** Before it opens, a failed connection may recover (a guest waiting for its reply to be scanned). */
  patient: boolean;
  timers: unknown[];
  cleanup: Array<() => void>;
  parts: Map<string, Assembly>;
  mesh: MeshSignaling | null;
  onOpen: ((link: Link) => void) | null;
  onClose: ((reason: NearbyErrorReason) => void) | null;
}

/** A function, so that TypeScript does not assume the state unchanged across an await. */
function isClosed(link: Link): boolean {
  return link.state === "closed";
}

/** A linked tab. */
interface Peer {
  id: string;
  /** Open links, oldest first: the last one carries what this tab sends. */
  links: Link[];
  playerId: string | null;
  rooms: string[];
  roomsSeq: number;
  peers: string[];
  peersSeq: number;
}

interface PendingInvite {
  token: string;
  link: Link;
  invite: NearbyInvite | null;
  /** The reply code applied (an invite takes one reply). */
  answer: string | null;
  failure: NearbyErrorReason | null;
}

interface MeshRetry {
  failures: number;
  retryAt: number;
  lastAttemptAt: number;
}

export class LinkManager implements NearbyApi {
  readonly selfId: string;
  readonly timings: LinkTimings;

  private readonly createPeerConnection: PeerConnectionFactory | null;
  private readonly random: (bytes: Uint8Array) => void;
  private readonly now: () => number;
  private readonly timers: Timers;

  private readonly links_ = new Set<Link>();
  private readonly peers = new Map<string, Peer>();
  private readonly invites = new Map<string, PendingInvite>();
  private readonly meshes = new Map<string, MeshRetry>();
  /** Tabs that said bye, until when they are not meshed with (neighbours may still list them for a moment). */
  private readonly gone = new Map<string, number>();
  /** Credentials of the codes this tab made (recent ones). */
  private readonly own: string[] = [];
  private readonly watchers = new Set<RoomWatcher>();
  private readonly subscribers = new Set<(links: NearbyLink[]) => void>();
  private rooms: string[] = [];
  private seq = 0;
  private partCounter = 0;
  private ticker: unknown = null;
  private lastTick = 0;
  private departing = false;
  private lastLinks: NearbyLink[] | null = null;
  private handoff: BroadcastChannelLike | null = null;

  constructor(private readonly options: LinkManagerOptions = {}) {
    this.random = options.random ?? defaultRandom;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.timings = { ...DEFAULT_LINK_TIMINGS, ...options.timings };
    this.selfId = options.selfId ?? this.randomId(10);
    this.createPeerConnection =
      options.createPeerConnection === undefined ? defaultPeerConnectionFactory() : options.createPeerConnection;

    const createChannel =
      options.createBroadcastChannel === undefined ? defaultBroadcastChannelFactory() : options.createBroadcastChannel;
    if (createChannel) {
      try {
        this.handoff = createChannel(HANDOFF_CHANNEL);
        this.handoff.onmessage = (event) => this.onHandoff(event?.data);
      } catch (e) {
        console.warn("[network] no reply hand-off between tabs", e);
        this.handoff = null;
      }
    }
  }

  /** This browser can make links (it has WebRTC). */
  get supported(): boolean {
    return this.createPeerConnection !== null;
  }

  /* ------------------------------------------------------------------ */
  /* NearbyApi                                                           */
  /* ------------------------------------------------------------------ */

  async createInvite(options: { gameId?: string | null; origin?: string } = {}): Promise<NearbyInvite> {
    const link = this.newLink("invite", false);
    link.announcedGame = options.gameId ?? null;
    const token = this.randomHex(4);
    let url: string;
    try {
      this.attachChannel(link, link.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
      const offer = await link.pc.createOffer();
      this.ensureLive(link);
      await link.pc.setLocalDescription(offer);
      await this.gathered(link);
      this.ensureLive(link);
      const compact = parseSdp(link.pc.localDescription, token);
      url = nearbyUrl("invite", toCode(compact), options.origin ?? this.origin());
      this.rememberOwn(compact);
    } catch (e) {
      this.close(link, "failed");
      throw setupFailure(e);
    }

    const connected = deferred<NearbyLink>();
    const pending: PendingInvite = { token, link, invite: null, answer: null, failure: null };
    link.onOpen = (opened) => {
      this.invites.delete(token);
      connected.resolve(this.describe(opened));
    };
    link.onClose = (reason) => {
      if (this.invites.get(token) === pending) this.invites.delete(token);
      pending.failure = reason;
      connected.reject(new NearbyError(reason));
    };
    this.later(link, this.timings.inviteTtlMs, () => this.close(link, "timeout"));

    const invite: NearbyInvite = {
      url,
      token,
      connected: connected.promise,
      acceptReply: async (text: string) => {
        const { description, code } = this.readCode(text, "reply");
        if (description.token !== token) throw new NearbyError("unknown-invite");
        await this.applyReply(pending, description, code);
      },
      cancel: () => {
        if (link.state === "connecting") this.close(link, "cancelled");
      },
    };
    pending.invite = invite;
    this.invites.set(token, pending);
    return invite;
  }

  async answerInvite(text: string, options: { origin?: string } = {}): Promise<NearbyReply> {
    const { description } = this.readCode(text, "invite");
    const link = this.newLink("invite", true);
    let url: string;
    try {
      link.cleanup.push(listen(link.pc, "datachannel", (event) => this.onDataChannel(link, event)));
      await link.pc.setRemoteDescription(buildSdp(description));
      this.ensureLive(link);
      const answer = await link.pc.createAnswer();
      this.ensureLive(link);
      await link.pc.setLocalDescription(answer);
      await this.gathered(link);
      this.ensureLive(link);
      const compact = parseSdp(link.pc.localDescription, description.token);
      url = nearbyUrl("reply", toCode(compact), options.origin ?? this.origin());
      this.rememberOwn(compact);
    } catch (e) {
      this.close(link, "failed");
      throw setupFailure(e);
    }

    const connected = deferred<{ peerId: string; gameId: string | null }>();
    link.onOpen = (opened) => connected.resolve({ peerId: opened.peerId, gameId: opened.remoteGame });
    link.onClose = (reason) => connected.reject(new NearbyError(reason));
    this.later(link, this.timings.inviteTtlMs, () => this.close(link, "timeout"));
    return {
      url,
      connected: connected.promise,
      cancel: () => {
        if (link.state === "connecting") this.close(link, "cancelled");
      },
    };
  }

  async acceptReply(text: string): Promise<NearbyInvite> {
    const { description, code } = this.readCode(text, "reply");
    const pending = this.invites.get(description.token);
    if (!pending) throw new NearbyError("unknown-invite");
    await this.applyReply(pending, description, code);
    return pending.invite;
  }

  links(): NearbyLink[] {
    const result: NearbyLink[] = [];
    this.peers.forEach((peer) => result.push(this.describe(peer.links[peer.links.length - 1])));
    this.links_.forEach((link) => {
      const peerId = link.peerId;
      if (link.state !== "connecting" || link.via !== "mesh" || !peerId) return;
      if (result.some((listed) => listed.peerId === peerId)) return;
      result.push({ peerId, playerId: null, state: "connecting", via: "mesh" });
    });
    return result.sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
  }

  subscribe(callback: (links: NearbyLink[]) => void): () => void {
    this.subscribers.add(callback);
    queueMicrotask(() => {
      if (this.subscribers.has(callback)) this.deliverLinks(callback, this.links());
    });
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rooms (for the nearby transport)                                    */
  /* ------------------------------------------------------------------ */

  /** The rooms this tab is in: announced to every linked tab. */
  setRooms(roomIds: string[]) {
    const rooms = Array.from(new Set(roomIds)).sort().slice(0, MAX_LISTED);
    if (isEqual(rooms, this.rooms)) return;
    this.rooms = rooms;
    this.broadcast({ t: "rooms", rooms, seq: ++this.seq });
  }

  /** Linked tabs in a room. */
  roomPeers(roomId: string): string[] {
    return Array.from(this.peers.values())
      .filter((peer) => peer.rooms.includes(roomId))
      .map((peer) => peer.id);
  }

  /** Send a room message to a linked tab. Never throws. */
  sendRoom(peerId: string, roomId: string, data: unknown) {
    const peer = this.peers.get(peerId);
    if (peer) this.sendToPeer(peer, { t: "m", r: roomId, d: data });
  }

  watchRooms(watcher: RoomWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The page is going away (pagehide): say bye on every link and close them
   * all, with pending invites and replies ("cancelled"). The manager stays
   * usable (a page restored from the back/forward cache can invite again).
   */
  depart() {
    this.departing = true;
    try {
      const links = Array.from(this.links_);
      links.forEach((link) => this.sendFrame(link, { t: "bye" }));
      links.forEach((link) => this.close(link, "cancelled"));
      this.meshes.clear();
    } finally {
      this.departing = false;
    }
    this.notifyWatchers();
    this.emitLinks();
  }

  /** Close everything for good (tests). */
  dispose() {
    this.depart();
    this.subscribers.clear();
    this.watchers.clear();
    if (this.handoff) {
      this.handoff.onmessage = null;
      try {
        this.handoff.close();
      } catch {
        // Already closed.
      }
      this.handoff = null;
    }
    this.stopTicking();
  }

  /** Every link, including replaced and unfinished ones, for tests and debugging. */
  debugLinks(): Array<{ peerId: string | null; state: Link["state"]; via: Link["via"]; current: boolean }> {
    return Array.from(this.links_).map((link) => {
      const peer = link.peerId ? this.peers.get(link.peerId) : null;
      return {
        peerId: link.peerId,
        state: link.state,
        via: link.via,
        current: !!peer && peer.links[peer.links.length - 1] === link,
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* QR handshake                                                        */
  /* ------------------------------------------------------------------ */

  /** Decode a scanned or pasted code of the expected kind. */
  private readCode(text: string, expected: "invite" | "reply"): { description: CompactDescription; code: string } {
    const parsed = parseNearbyText(text);
    if (!parsed) throw new NearbyError("malformed");
    const description = fromCode(parsed.code);
    if ((description.type === "offer" ? "invite" : "reply") !== expected) {
      throw new NearbyError(expected === "invite" ? "not-an-invite" : "not-a-reply");
    }
    if (this.own.includes(credentialsOf(description))) throw new NearbyError("own-invite");
    return { description, code: parsed.code };
  }

  private rememberOwn(description: CompactDescription) {
    this.own.push(credentialsOf(description));
    if (this.own.length > 100) this.own.shift();
  }

  private async applyReply(pending: PendingInvite, description: CompactDescription, code: string) {
    const link = pending.link;
    if (link.state === "closed") throw new NearbyError(pending.failure ?? "unknown-invite");
    if (pending.answer !== null) {
      if (pending.answer === code) return;
      throw new NearbyError("unknown-invite", "This invite was already answered: make a new one.");
    }
    pending.answer = code;
    try {
      await link.pc.setRemoteDescription(buildSdp(description));
    } catch (e) {
      this.close(link, "failed");
      throw setupFailure(e);
    }
    // The await may have seen it close (expiry, cancel(), pagehide).
    if (isClosed(link)) throw new NearbyError(pending.failure ?? "cancelled");
    if (link.state === "connecting") {
      this.later(link, this.timings.connectTimeoutMs, () => this.close(link, "timeout"));
    }
  }

  /** Resolves when ICE gathering is over, or after gatherTimeoutMs with what was gathered so far. */
  private gathered(link: Link): Promise<void> {
    const pc = link.pc;
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const removers: Array<() => void> = [];
      let timer: unknown = null;
      const done = () => {
        removers.forEach((remove) => remove());
        this.timers.clearTimeout(timer);
        resolve();
      };
      removers.push(
        listen(pc, "icegatheringstatechange", () => {
          if (pc.iceGatheringState === "complete") done();
        }),
        listen(pc, "icecandidate", (event) => {
          if (!(event as Event & { candidate?: unknown }).candidate) done();
        })
      );
      timer = this.timers.setTimeout(done, this.timings.gatherTimeoutMs);
    });
  }

  private ensureLive(link: Link) {
    if (isClosed(link)) throw new NearbyError("cancelled");
  }

  /* ------------------------------------------------------------------ */
  /* Reply hand-off between tabs                                         */
  /* ------------------------------------------------------------------ */

  private onHandoff(data: unknown) {
    try {
      if (!isObject(data) || data.type !== "reply" || !isId(data.id) || typeof data.code !== "string") return;
      let description: CompactDescription;
      try {
        description = fromCode(data.code);
      } catch {
        return;
      }
      if (description.type !== "answer") return;
      const pending = this.invites.get(description.token);
      if (!pending || (pending.answer !== null && pending.answer !== data.code)) return;
      this.handoff?.postMessage({ type: "ack", id: data.id });
      if (pending.answer === null) {
        this.applyReply(pending, description, data.code).catch((e) => {
          console.warn("[network] could not apply a reply from another tab", e);
        });
      }
    } catch (e) {
      console.warn("[network] error handling a reply from another tab", e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Links                                                               */
  /* ------------------------------------------------------------------ */

  private newLink(via: Link["via"], patient: boolean): Link {
    if (!this.createPeerConnection) throw new NearbyError("no-webrtc");
    let pc: PeerConnectionLike;
    try {
      pc = this.createPeerConnection({ iceServers: [] });
    } catch (e) {
      console.warn("[network] could not create a WebRTC connection", e);
      throw new NearbyError("no-webrtc");
    }
    const link: Link = {
      pc,
      channel: null,
      via,
      peerId: null,
      state: "connecting",
      channelOpen: false,
      lastHeard: this.now(),
      announcedGame: null,
      remoteGame: null,
      patient,
      timers: [],
      cleanup: [],
      parts: new Map(),
      mesh: null,
      onOpen: null,
      onClose: null,
    };
    const onState = () => this.onConnectionState(link);
    link.cleanup.push(listen(pc, "connectionstatechange", onState), listen(pc, "iceconnectionstatechange", onState));
    this.links_.add(link);
    this.startTicking();
    return link;
  }

  /** Run `callback` after `ms` unless the link closed (or opened: timers are cleared then). */
  private later(link: Link, ms: number, callback: () => void) {
    const handle = this.timers.setTimeout(() => {
      link.timers = link.timers.filter((other) => other !== handle);
      if (link.state !== "closed") this.guard(callback);
    }, ms);
    link.timers.push(handle);
  }

  private clearTimers(link: Link) {
    link.timers.forEach((handle) => this.timers.clearTimeout(handle));
    link.timers = [];
  }

  private onConnectionState(link: Link) {
    if (link.state === "closed") return;
    const state = link.pc.connectionState ?? link.pc.iceConnectionState;
    if (state === "closed") {
      this.close(link, "failed");
    } else if (state === "failed" && (link.state === "open" || !link.patient)) {
      this.close(link, "failed");
    }
  }

  private onDataChannel(link: Link, event: Event) {
    const channel = (event as Event & { channel?: DataChannelLike }).channel;
    if (channel && channel.label === DATA_CHANNEL_LABEL && !link.channel) {
      this.attachChannel(link, channel);
    }
  }

  private attachChannel(link: Link, channel: DataChannelLike) {
    link.channel = channel;
    link.cleanup.push(
      listen(channel, "open", () => this.onChannelOpen(link)),
      listen(channel, "message", (event) => this.onFrame(link, (event as Event & { data?: unknown }).data)),
      listen(channel, "close", () => this.close(link, "failed"))
    );
    if (channel.readyState === "open") this.onChannelOpen(link);
  }

  private onChannelOpen(link: Link) {
    if (link.state === "closed" || link.channelOpen) return;
    link.channelOpen = true;
    link.lastHeard = this.now();
    this.sendFrame(link, this.hiMessage(link));
  }

  private hiMessage(link: Link): HiMessage {
    let player: string | null = null;
    try {
      player = this.options.getPlayerId?.() ?? null;
    } catch {
      player = null;
    }
    return {
      t: "hi",
      v: LINK_PROTOCOL,
      id: this.selfId,
      rooms: this.rooms,
      peers: this.openPeerIds(),
      game: link.announcedGame,
      player,
      seq: ++this.seq,
    };
  }

  private onHi(link: Link, message: Obj) {
    if (!isHi(message)) return;
    if (message.v !== LINK_PROTOCOL) {
      console.warn(`[network] a nearby tab speaks link protocol ${message.v}, this one ${LINK_PROTOCOL}`);
      this.close(link, "unsupported-version");
      return;
    }
    if (message.id === this.selfId) {
      this.close(link, "own-invite");
      return;
    }
    if (link.peerId && link.peerId !== message.id) {
      this.close(link, "failed");
      return;
    }
    if (link.state === "open") {
      const peer = this.peers.get(message.id);
      if (peer) this.updatePeer(peer, message);
      return;
    }

    link.peerId = message.id;
    link.remoteGame = message.game ?? null;
    link.state = "open";
    this.clearTimers(link);

    let peer = this.peers.get(message.id);
    const isNew = !peer;
    if (!peer) {
      peer = { id: message.id, links: [], playerId: null, rooms: [], roomsSeq: -1, peers: [], peersSeq: -1 };
      this.peers.set(peer.id, peer);
    }
    const replaced = peer.links.slice();
    peer.links.push(link);
    this.gone.delete(peer.id);
    this.meshes.delete(peer.id);

    // Both sides may see two links open in a different order: the smaller id
    // closes the replaced ones, the other side then falls back on the new one.
    if (this.selfId < peer.id) {
      const current = peer;
      replaced.forEach((old) =>
        this.later(old, this.timings.supersededGraceMs, () => {
          if (current.links[current.links.length - 1] !== old) this.close(old, "cancelled");
        })
      );
    }
    // Unfinished mesh connections to the same tab are useless now.
    Array.from(this.links_)
      .filter((other) => other !== link && other.state === "connecting" && other.peerId === message.id)
      .forEach((other) => this.close(other, "cancelled"));

    const onOpen = link.onOpen;
    link.onOpen = null;
    link.onClose = null;
    const roomsChanged = this.updatePeer(peer, message, false);
    if (onOpen) this.guard(() => onOpen(link));
    if (isNew || roomsChanged) this.notifyWatchers();
    if (isNew) this.broadcastPeers();
    this.emitLinks();
    this.maybeMesh();
  }

  /** Apply what a hi says about its tab (when newer than what we have). Returns whether its rooms changed. */
  private updatePeer(peer: Peer, hi: HiMessage, notify = true): boolean {
    peer.playerId = hi.player ?? null;
    let roomsChanged = false;
    if (hi.seq > peer.roomsSeq) {
      roomsChanged = !isEqual(peer.rooms, hi.rooms);
      peer.rooms = hi.rooms;
      peer.roomsSeq = hi.seq;
    }
    if (hi.seq > peer.peersSeq) this.setPeerList(peer, hi.peers, hi.seq);
    if (notify) {
      if (roomsChanged) this.notifyWatchers();
      this.emitLinks();
      this.maybeMesh();
    }
    return roomsChanged;
  }

  private close(link: Link, reason: NearbyErrorReason) {
    if (link.state === "closed") return;
    const wasOpen = link.state === "open";
    link.state = "closed";
    this.clearTimers(link);
    link.cleanup.forEach((remove) => remove());
    link.cleanup = [];
    link.parts.clear();
    this.links_.delete(link);
    try {
      link.pc.close();
    } catch {
      // Already closed.
    }

    if (wasOpen) {
      const peer = link.peerId ? this.peers.get(link.peerId) : null;
      if (peer) {
        peer.links = peer.links.filter((other) => other !== link);
        if (!peer.links.length) {
          this.peers.delete(peer.id);
          if (!this.departing) {
            this.notifyWatchers();
            this.broadcastPeers();
          }
        }
      }
    } else {
      const onClose = link.onClose;
      link.onOpen = null;
      link.onClose = null;
      if (onClose) this.guard(() => onClose(reason));
      if (link.mesh?.initiator && link.peerId && (reason === "timeout" || reason === "failed")) {
        this.meshFailed(link.peerId);
      }
    }

    if (!this.departing) {
      this.emitLinks();
      this.maybeMesh();
    }
    if (!this.links_.size) this.stopTicking();
  }

  private describe(link: Link): NearbyLink {
    const peer = link.peerId ? this.peers.get(link.peerId) : null;
    return {
      peerId: link.peerId,
      playerId: peer?.playerId ?? null,
      state: link.state === "open" ? "open" : "connecting",
      via: link.via,
    };
  }

  private openPeerIds(): string[] {
    return Array.from(this.peers.keys()).sort().slice(0, MAX_LISTED);
  }

  /* ------------------------------------------------------------------ */
  /* Frames                                                              */
  /* ------------------------------------------------------------------ */

  private sendFrame(link: Link, message: LinkMessage) {
    if (!link.channel || !link.channelOpen || link.state === "closed") return;
    let text: string;
    try {
      text = JSON.stringify(message);
    } catch (e) {
      console.warn("[network] could not serialise a message", e);
      return;
    }
    if (text.length <= MAX_FRAME_CHARS) {
      this.write(link, text);
      return;
    }
    const parts = splitText(text, MAX_FRAME_CHARS);
    if (parts.length > MAX_PARTS) {
      console.warn("[network] message too large for a nearby link");
      return;
    }
    const id = (++this.partCounter).toString(36);
    parts.forEach((data, i) => this.write(link, JSON.stringify({ t: "part", id, i, n: parts.length, data })));
  }

  private write(link: Link, text: string) {
    try {
      link.channel.send(text);
    } catch (e) {
      console.warn("[network] could not send to a nearby tab", e);
    }
  }

  /** To the tab's current (newest) link. */
  private sendToPeer(peer: Peer, message: LinkMessage) {
    const link = peer.links[peer.links.length - 1];
    if (link) this.sendFrame(link, message);
  }

  /**
   * To every link whose channel is open, including those still waiting for
   * the other's hi (it went out first: they read it before this).
   */
  private broadcast(message: LinkMessage) {
    this.links_.forEach((link) => this.sendFrame(link, message));
  }

  private broadcastPeers() {
    if (this.departing) return;
    this.broadcast({ t: "peers", peers: this.openPeerIds(), seq: ++this.seq });
  }

  private onFrame(link: Link, data: unknown) {
    if (link.state === "closed" || typeof data !== "string" || data.length > MAX_INCOMING_FRAME_CHARS) return;
    link.lastHeard = this.now();
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    this.handle(link, message, true);
  }

  private handle(link: Link, message: unknown, allowParts: boolean) {
    this.guard(() => {
      if (!isObject(message) || typeof message.t !== "string") return;
      switch (message.t) {
        case "part":
          if (allowParts) this.onPart(link, message);
          return;
        case "hi":
          this.onHi(link, message);
          return;
        case "ping":
          this.sendFrame(link, { t: "pong" });
          return;
        case "pong":
          return;
        case "bye":
          this.onBye(link);
          return;
      }
      if (link.state !== "open") return;
      const peer = this.peers.get(link.peerId);
      if (!peer) return;
      switch (message.t) {
        case "rooms":
          if (isListOf(message.rooms, isRoom) && isSeq(message.seq) && message.seq > peer.roomsSeq) {
            const changed = !isEqual(peer.rooms, message.rooms);
            peer.rooms = message.rooms;
            peer.roomsSeq = message.seq;
            if (changed) this.notifyWatchers();
          }
          return;
        case "peers":
          if (isListOf(message.peers, isId) && isSeq(message.seq) && message.seq > peer.peersSeq) {
            this.setPeerList(peer, message.peers, message.seq);
            this.maybeMesh();
          }
          return;
        case "m":
          if (isRoom(message.r) && "d" in message) {
            const { r, d } = message;
            this.watchers.forEach((watcher) => this.guard(() => watcher.message(peer.id, r, d)));
          }
          return;
        case "sig":
          this.onSig(peer, message);
          return;
      }
    });
  }

  private onPart(link: Link, message: Obj) {
    const { id, i, n, data } = message;
    if (!isId(id) || !isSeq(n) || n < 2 || n > MAX_PARTS || !isSeq(i) || i >= n) return;
    if (typeof data !== "string" || data.length > MAX_FRAME_CHARS) return;
    let assembly = link.parts.get(id);
    if (!assembly) {
      if (link.parts.size >= MAX_ASSEMBLIES) link.parts.delete(link.parts.keys().next().value);
      assembly = { n, parts: new Array<string>(n), count: 0 };
      link.parts.set(id, assembly);
    }
    if (assembly.n !== n || assembly.parts[i] !== undefined) return;
    assembly.parts[i] = data;
    assembly.count++;
    if (assembly.count < n) return;
    link.parts.delete(id);
    let whole: unknown;
    try {
      whole = JSON.parse(assembly.parts.join(""));
    } catch {
      return;
    }
    this.handle(link, whole, false);
  }

  private onBye(link: Link) {
    const peer = link.state === "open" && link.peerId ? this.peers.get(link.peerId) : null;
    if (!peer) {
      this.close(link, "failed");
      return;
    }
    this.gone.set(peer.id, this.now() + this.timings.silenceTimeoutMs);
    Array.from(this.links_)
      .filter((other) => other.peerId === peer.id)
      .forEach((other) => this.close(other, "cancelled"));
  }

  /* ------------------------------------------------------------------ */
  /* Mesh                                                                */
  /* ------------------------------------------------------------------ */

  private setPeerList(peer: Peer, list: string[], seq: number) {
    const changed = !isEqual(peer.peers, list);
    peer.peers = list;
    peer.peersSeq = seq;
    if (!changed) return;
    // The network changed: failed mesh connections are worth another try,
    // even after many failures (but no sooner than the first backoff).
    this.meshes.forEach((retry) => {
      retry.retryAt = Math.min(retry.retryAt, retry.lastAttemptAt + this.timings.meshRetryMs);
    });
  }

  /** Initiate the mesh connections that are ours to initiate (to tabs with a larger id) and due. */
  private maybeMesh() {
    if (this.departing || !this.supported) return;
    const now = this.now();
    const relays = new Map<string, string>();
    this.peers.forEach((peer) =>
      peer.peers.forEach((id) => {
        if (id !== this.selfId && !this.peers.has(id) && !relays.has(id)) relays.set(id, peer.id);
      })
    );
    // Forget the failures of tabs nobody lists anymore.
    this.meshes.forEach((_, id) => {
      if (!relays.has(id)) this.meshes.delete(id);
    });
    relays.forEach((relay, id) => {
      if (this.selfId >= id) return;
      if ((this.gone.get(id) ?? 0) > now) return;
      if (Array.from(this.links_).some((link) => link.state === "connecting" && link.peerId === id)) return;
      const retry = this.meshes.get(id);
      if (retry && now < retry.retryAt) return;
      this.startMesh(id, relay);
    });
  }

  private meshFailed(peerId: string) {
    const retry = this.meshes.get(peerId) ?? { failures: 0, retryAt: 0, lastAttemptAt: this.now() };
    retry.failures++;
    retry.retryAt =
      retry.failures >= MAX_MESH_FAILURES
        ? Infinity
        : this.now() + Math.min(this.timings.meshRetryMs * 2 ** (retry.failures - 1), this.timings.meshRetryMaxMs);
    this.meshes.set(peerId, retry);
  }

  private connectingMeshCount(): number {
    return Array.from(this.links_).filter((link) => link.via === "mesh" && link.state === "connecting").length;
  }

  private startMesh(peerId: string, relay: string) {
    if (this.connectingMeshCount() >= MAX_CONNECTING_MESH) return;
    let link: Link;
    try {
      link = this.newLink("mesh", false);
    } catch {
      return;
    }
    link.peerId = peerId;
    link.mesh = this.meshSignaling(this.randomHex(6), true, relay);
    const retry = this.meshes.get(peerId) ?? { failures: 0, retryAt: 0, lastAttemptAt: 0 };
    retry.lastAttemptAt = this.now();
    this.meshes.set(peerId, retry);

    this.trickle(link);
    this.later(link, this.timings.connectTimeoutMs, () => this.close(link, "timeout"));
    const run = async () => {
      this.attachChannel(link, link.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }));
      const offer = await link.pc.createOffer();
      this.ensureLive(link);
      await link.pc.setLocalDescription(offer);
      this.ensureLive(link);
      this.sendLocalDescription(link, "offer");
    };
    run().catch((e) => {
      if (link.state === "closed") return;
      console.warn("[network] could not start a mesh connection", e);
      this.close(link, "failed");
    });
    this.emitLinks();
  }

  private answerMesh(from: string, relay: string, offer: { a: string; sdp: string }) {
    if (this.departing || !this.supported) return;
    const unfinished = Array.from(this.links_).filter(
      (link) => link.state === "connecting" && link.via === "mesh" && link.peerId === from
    );
    // Only the smaller id initiates, so ours should not exist; if it does, the smaller id's offer wins.
    if (unfinished.some((link) => link.mesh?.initiator) && this.selfId < from) return;
    unfinished.forEach((link) => this.close(link, "cancelled"));
    if (this.connectingMeshCount() >= MAX_CONNECTING_MESH) return;

    let link: Link;
    try {
      link = this.newLink("mesh", false);
    } catch {
      return;
    }
    link.peerId = from;
    link.mesh = this.meshSignaling(offer.a, false, relay);
    link.cleanup.push(listen(link.pc, "datachannel", (event) => this.onDataChannel(link, event)));
    this.trickle(link);
    this.later(link, this.timings.connectTimeoutMs, () => this.close(link, "timeout"));
    const run = async () => {
      await link.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      this.ensureLive(link);
      this.remoteApplied(link);
      const answer = await link.pc.createAnswer();
      this.ensureLive(link);
      await link.pc.setLocalDescription(answer);
      this.ensureLive(link);
      this.sendLocalDescription(link, "answer");
    };
    run().catch((e) => {
      if (link.state === "closed") return;
      console.warn("[network] could not answer a mesh connection", e);
      this.signal(link, { a: offer.a, k: "fail" });
      this.close(link, "failed");
    });
    this.emitLinks();
  }

  private meshSignaling(id: string, initiator: boolean, relay: string): MeshSignaling {
    return { id, initiator, relay, localSent: false, remoteApplied: false, outbox: [], inbox: [] };
  }

  private sendLocalDescription(link: Link, kind: "offer" | "answer") {
    const mesh = link.mesh;
    this.signal(link, { a: mesh.id, k: kind, sdp: link.pc.localDescription?.sdp ?? "" });
    mesh.localSent = true;
    mesh.outbox.splice(0).forEach((data) => this.signal(link, data));
  }

  /** Send our ICE candidates as they come (after our description). */
  private trickle(link: Link) {
    link.cleanup.push(
      listen(link.pc, "icecandidate", (event) => {
        const candidate = (event as Event & { candidate?: IceCandidateLike | null }).candidate;
        const mesh = link.mesh;
        if (!candidate?.candidate || !mesh) return;
        const data: SigData = {
          a: mesh.id,
          k: "cand",
          c: candidate.candidate,
          mid: candidate.sdpMid ?? null,
          idx: candidate.sdpMLineIndex ?? null,
        };
        if (mesh.localSent) {
          this.signal(link, data);
        } else {
          mesh.outbox.push(data);
        }
      })
    );
  }

  private remoteApplied(link: Link) {
    link.mesh.remoteApplied = true;
    link.mesh.inbox.splice(0).forEach((candidate) => this.addCandidate(link, candidate));
  }

  private addCandidate(link: Link, candidate: IceCandidateLike) {
    link.pc.addIceCandidate(candidate).catch((e) => {
      console.warn("[network] ignored an ICE candidate", e);
    });
  }

  /** Send signaling to the link's tab through a neighbour linked with both. */
  private signal(link: Link, data: SigData) {
    const mesh = link.mesh;
    const to = link.peerId;
    if (!mesh || !to) return;
    let relay = mesh.relay ? this.peers.get(mesh.relay) : undefined;
    if (!relay) {
      relay = Array.from(this.peers.values()).find((peer) => peer.peers.includes(to));
      mesh.relay = relay?.id ?? null;
    }
    // Without a relay the attempt times out (and is retried later).
    if (relay) this.sendToPeer(relay, { t: "sig", to, d: data });
  }

  private onSig(neighbour: Peer, message: Obj) {
    const data = parseSig(message.d);
    if (!data) return;
    if (message.to !== undefined) {
      // Relay, only between two of our own open links (one hop).
      if (!isId(message.to) || message.to === neighbour.id || message.to === this.selfId) return;
      const target = this.peers.get(message.to);
      if (target) {
        this.sendToPeer(target, { t: "sig", from: neighbour.id, d: data });
      } else if (data.k !== "fail") {
        this.sendToPeer(neighbour, { t: "sig", from: message.to, d: { a: data.a, k: "fail" } });
      }
      return;
    }
    const from = message.from;
    if (!isId(from) || from === this.selfId || from === neighbour.id) return;

    const link = Array.from(this.links_).find(
      (candidate) => candidate.mesh?.id === data.a && candidate.peerId === from && candidate.state !== "closed"
    );
    switch (data.k) {
      case "offer":
        if (!link) this.answerMesh(from, neighbour.id, data);
        return;
      case "answer":
        if (!link || !link.mesh.initiator || link.state !== "connecting" || link.mesh.remoteApplied) return;
        link.pc
          .setRemoteDescription({ type: "answer", sdp: data.sdp })
          .then(() => {
            if (link.state !== "closed") this.remoteApplied(link);
          })
          .catch((e) => {
            console.warn("[network] could not apply a mesh answer", e);
            this.close(link, "failed");
          });
        return;
      case "cand":
        if (!link) return;
        if (link.mesh.remoteApplied) {
          this.addCandidate(link, { candidate: data.c, sdpMid: data.mid ?? null, sdpMLineIndex: data.idx ?? null });
        } else if (link.mesh.inbox.length < MAX_QUEUED_CANDIDATES) {
          link.mesh.inbox.push({ candidate: data.c, sdpMid: data.mid ?? null, sdpMLineIndex: data.idx ?? null });
        }
        return;
      case "fail":
        if (link && link.state === "connecting") this.close(link, "failed");
        return;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Heartbeat                                                           */
  /* ------------------------------------------------------------------ */

  private startTicking() {
    if (this.ticker !== null) return;
    this.lastTick = this.now();
    this.ticker = this.timers.setInterval(() => this.guard(() => this.tick()), this.timings.pingIntervalMs);
  }

  private stopTicking() {
    if (this.ticker === null) return;
    this.timers.clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick() {
    const now = this.now();
    // A throttled timer means this tab was in the background: the others did
    // not get a chance to answer, so do not expire anyone this round.
    const throttled = now - this.lastTick > this.timings.pingIntervalMs * 2;
    this.lastTick = now;
    Array.from(this.links_).forEach((link) => {
      if (link.state === "closed" || !link.channelOpen) return;
      if (!throttled && now - link.lastHeard > this.timings.silenceTimeoutMs) {
        this.close(link, "timeout");
        return;
      }
      this.sendFrame(link, { t: "ping" });
    });
    this.gone.forEach((until, id) => {
      if (until <= now) this.gone.delete(id);
    });
    this.maybeMesh();
  }

  /* ------------------------------------------------------------------ */
  /* Notifications                                                       */
  /* ------------------------------------------------------------------ */

  private notifyWatchers() {
    this.watchers.forEach((watcher) => this.guard(() => watcher.changed()));
  }

  private deliverLinks(callback: (links: NearbyLink[]) => void, links: NearbyLink[]) {
    try {
      callback(links);
    } catch (e) {
      console.error("[network] nearby links subscriber failed", e);
    }
  }

  private emitLinks() {
    const links = this.links();
    if (isEqual(links, this.lastLinks)) return;
    this.lastLinks = links;
    Array.from(this.subscribers).forEach((callback) => this.deliverLinks(callback, links));
  }

  private guard(run: () => void) {
    try {
      run();
    } catch (e) {
      console.warn("[network] error in a nearby link", e);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ids                                                                 */
  /* ------------------------------------------------------------------ */

  private origin(): string {
    if (this.options.origin) return this.options.origin();
    return typeof window !== "undefined" ? window.location.origin : "";
  }

  private randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    this.random(bytes);
    return bytes;
  }

  private randomHex(length: number): string {
    return Array.from(this.randomBytes(length), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private randomId(length: number): string {
    return Array.from(this.randomBytes(length), (byte) => byte.toString(36).padStart(2, "0")).join("");
  }
}

/**
 * Hand a reply (URL or code) to the tab of this browser that holds its
 * invite, over BroadcastChannel: what a page opened by the camera app with a
 * reply URL does. Resolves true when that tab acknowledged it (it then
 * applies the reply), false when no tab did within `timeoutMs`, or when the
 * text is not a usable reply.
 */
export function deliverReplyToOtherTab(
  text: string,
  timeoutMs = 1500,
  options: { createBroadcastChannel?: BroadcastChannelFactory | null; timers?: Timers } = {}
): Promise<boolean> {
  const parsed = parseNearbyText(text);
  if (!parsed) return Promise.resolve(false);
  try {
    if (fromCode(parsed.code).type !== "answer") return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
  const createChannel =
    options.createBroadcastChannel === undefined ? defaultBroadcastChannelFactory() : options.createBroadcastChannel;
  if (!createChannel) return Promise.resolve(false);
  const timers = options.timers ?? GLOBAL_TIMERS;

  return new Promise((resolve) => {
    let channel: BroadcastChannelLike;
    try {
      channel = createChannel(HANDOFF_CHANNEL);
    } catch {
      resolve(false);
      return;
    }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16)).join("");
    let done = false;
    let timer: unknown = null;
    const finish = (acknowledged: boolean) => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
      resolve(acknowledged);
    };
    channel.onmessage = (event) => {
      const data = event?.data;
      if (isObject(data) && data.type === "ack" && data.id === id) finish(true);
    };
    timer = timers.setTimeout(() => finish(false), timeoutMs);
    try {
      channel.postMessage({ type: "reply", id, code: parsed.code });
    } catch {
      finish(false);
    }
  });
}
