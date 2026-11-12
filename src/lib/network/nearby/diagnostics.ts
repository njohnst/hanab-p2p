/**
 * Connection diagnostics of the QR links (docs/P2P_DESIGN.md, "Connection details"): what each
 * device offered in its code and how far ICE got, so that a player whose devices do not connect
 * can see why, and copy a short report for whoever helps them.
 *
 * - addressKind classifies a candidate's address (a LAN, carrier-grade NAT, IPv6 global, an mDNS
 *   name hiding the address...).
 * - DiagnosticsRecorder follows one QR link's RTCPeerConnection: the candidates gathered and those
 *   the code carries (./codec.ts candidateChoices), the other device's candidates, a timeline of
 *   state changes, and the ICE candidate pairs from getStats(), read about every second while
 *   connecting and kept once the connection is closed (getStats on a closed one throws).
 * - formatReport turns a snapshot into the plain-text report the player copies (in English: it is
 *   for the developer).
 */
import { candidateChoices, CompactCandidate, isMdnsName, parseIpv4, parseIpv6, readCandidate } from "./codec";
import {
  NearbyAddressKind,
  NearbyCandidate,
  NearbyCandidatePair,
  NearbyDiagnostics,
  NearbyErrorReason,
  NearbyLocalCandidate,
  NearbyTimelineEntry,
} from "./types";

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

function ipv4Kind(b: Uint8Array): NearbyAddressKind {
  if (b[0] === 10 || (b[0] === 172 && (b[1] & 0xf0) === 16) || (b[0] === 192 && b[1] === 168)) return "ipv4-private";
  if (b[0] === 100 && (b[1] & 0xc0) === 64) return "ipv4-cgnat";
  if (b[0] === 169 && b[1] === 254) return "ipv4-link-local";
  if (b[0] === 127) return "ipv4-loopback";
  if (b[0] === 0 || b[0] >= 224) return "ipv4-other";
  return "ipv4-public";
}

function ipv6Kind(b: Uint8Array): NearbyAddressKind {
  if (b.every((byte, i) => byte === (i === 15 ? 1 : 0))) return "ipv6-loopback";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "ipv6-link-local";
  if ((b[0] & 0xfe) === 0xfc) return "ipv6-unique-local";
  if ((b[0] & 0xe0) === 0x20) return "ipv6-global";
  return "ipv6-other";
}

/** What a candidate's address is (see NearbyAddressKind). */
export function addressKind(address: string): NearbyAddressKind {
  const text = (address || "").trim();
  if (!text) return "unknown";
  const ipv4 = parseIpv4(text);
  if (ipv4) return ipv4Kind(ipv4);
  if (text.includes(":")) {
    const ipv6 = parseIpv6(text);
    return ipv6 ? ipv6Kind(ipv6) : "unknown";
  }
  if (isMdnsName(text) || /\.local\.?$/i.test(text)) return "mdns";
  return /^[a-z0-9.-]+$/i.test(text) ? "hostname" : "unknown";
}

const KIND_LABELS: Record<NearbyAddressKind, string> = {
  "ipv4-private": "IPv4 private (LAN or hotspot)",
  "ipv4-cgnat": "IPv4 carrier NAT",
  "ipv4-link-local": "IPv4 link-local",
  "ipv4-loopback": "IPv4 loopback",
  "ipv4-public": "IPv4 public",
  "ipv4-other": "IPv4 other",
  "ipv6-global": "IPv6 global",
  "ipv6-unique-local": "IPv6 unique-local",
  "ipv6-link-local": "IPv6 link-local",
  "ipv6-loopback": "IPv6 loopback",
  "ipv6-other": "IPv6 other",
  "mdns": "hidden behind a .local name",
  "hostname": "host name",
  "unknown": "unknown",
};

function candidateOf(fields: {
  protocol: string;
  address: string;
  port: number | null;
  type: string;
}): NearbyCandidate {
  return { ...fields, kind: addressKind(fields.address) };
}

/**
 * The same candidate from an icecandidate event and from the local description: by its fields, not
 * its text (Chrome's events add "ufrag ... network-id ..." that its SDP lines don't have).
 */
function candidateKey(value: string): string {
  const fields = readCandidate(value);
  if (!fields) return value.trim().replace(/^(?:a=)?candidate:/i, "");
  return [
    fields.component,
    fields.protocol,
    fields.address.toLowerCase(),
    fields.port,
    fields.type,
    fields.tcpType,
  ].join(" ");
}

/* ------------------------------------------------------------------ */
/* getStats                                                            */
/* ------------------------------------------------------------------ */

/** The subset of an RTCStatsReport read here. */
export interface StatsReportLike {
  forEach(callback: (value: unknown) => void): void;
}

type Stat = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function statCandidate(stat: Stat | undefined): NearbyCandidate | null {
  if (!stat) return null;
  return candidateOf({
    protocol: text(stat.protocol).toLowerCase(),
    // `ip` in older browsers; empty when the browser hides a remote mDNS address.
    address: text(stat.address) || text(stat.ip),
    port: typeof stat.port === "number" ? stat.port : null,
    type: text(stat.candidateType),
  });
}

/** The ICE candidate pairs of a getStats() report, and the DTLS state. */
export function readStats(report: StatsReportLike): { pairs: NearbyCandidatePair[]; dtlsState: string | null } {
  const byId = new Map<string, Stat>();
  const pairs: Stat[] = [];
  const selected = new Set<string>();
  let dtlsState: string | null = null;
  report.forEach((value) => {
    if (!value || typeof value !== "object") return;
    const stat = value as Stat;
    if (typeof stat.id === "string") byId.set(stat.id, stat);
    if (stat.type === "candidate-pair") pairs.push(stat);
    if (stat.type === "transport") {
      if (typeof stat.selectedCandidatePairId === "string") selected.add(stat.selectedCandidatePairId);
      if (typeof stat.dtlsState === "string") dtlsState = stat.dtlsState;
    }
  });
  return {
    pairs: pairs.map((pair) => ({
      state: text(pair.state),
      nominated: pair.nominated === true,
      selected: pair.selected === true || selected.has(text(pair.id)),
      local: statCandidate(byId.get(text(pair.localCandidateId))),
      remote: statCandidate(byId.get(text(pair.remoteCandidateId))),
      requestsSent: count(pair.requestsSent),
      responsesReceived: count(pair.responsesReceived),
      requestsReceived: count(pair.requestsReceived),
      responsesSent: count(pair.responsesSent),
      bytesSent: count(pair.bytesSent),
      bytesReceived: count(pair.bytesReceived),
      currentRoundTripTime: typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime : null,
    })),
    dtlsState,
  };
}

/* ------------------------------------------------------------------ */
/* Recorder                                                            */
/* ------------------------------------------------------------------ */

/** The subset of RTCPeerConnection followed. */
export interface DiagnosedConnection extends EventTarget {
  readonly localDescription: { sdp?: string | null } | null;
  readonly iceGatheringState: string;
  readonly iceConnectionState?: string;
  readonly connectionState?: string;
  getStats?(): Promise<StatsReportLike>;
}

export interface DiagnosticsClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** About once a second while connecting. */
export const STATS_INTERVAL_MS = 1000;
/** Timeline entries kept: the first ones (how it started) and the latest ones. */
const TIMELINE_HEAD = 12;
const TIMELINE_MAX = 60;

interface Gathered {
  key: string;
  value: string;
  atMs: number;
}

export class DiagnosticsRecorder {
  private readonly startedAt: number;
  private readonly gathered: Gathered[] = [];
  private readonly timeline: NearbyTimelineEntry[] = [];
  private readonly listeners = new Set<(diagnostics: NearbyDiagnostics) => void>();
  private readonly removers: Array<() => void> = [];
  private timelineDropped = 0;
  private stage: NearbyDiagnostics["stage"] = "preparing";
  private closedReason: NearbyErrorReason | null = null;
  private endedAt: number | null = null;
  private gatheringEnd: NearbyDiagnostics["gatheringEnd"] = null;
  private gatheringEndedAt: number | null = null;
  /** The code's choices, by candidate key (once it is made). */
  private choices: Map<string, NearbyLocalCandidate["leftOut"]> | null = null;
  private choiceOrder: Array<{ key: string; value: string }> = [];
  private codeCandidates: number | null = null;
  private remote: NearbyCandidate[] | null = null;
  private pairs: NearbyCandidatePair[] = [];
  private dtlsState: string | null = null;
  private statsAt: number | null = null;
  private poller: unknown = null;
  private reading = false;

  constructor(
    private readonly role: NearbyDiagnostics["role"],
    private readonly pc: DiagnosedConnection,
    private readonly clock: DiagnosticsClock,
    private readonly statsIntervalMs = STATS_INTERVAL_MS
  ) {
    this.startedAt = clock.now();
    const follow = (type: string, handler: (event: Event) => void) => {
      pc.addEventListener(type, handler);
      this.removers.push(() => pc.removeEventListener(type, handler));
    };
    follow("icecandidate", (event) => {
      const candidate = (event as Event & { candidate?: { candidate?: string } | null }).candidate;
      if (candidate?.candidate) this.onCandidate(candidate.candidate);
    });
    follow("icegatheringstatechange", () => {
      const state = pc.iceGatheringState;
      if (state === "complete" && this.gatheringEnd === null) {
        this.gatheringEnd = "complete";
        this.gatheringEndedAt = this.elapsed();
      }
      this.add("gathering", state);
    });
    follow("iceconnectionstatechange", () => this.add("ice", pc.iceConnectionState ?? ""));
    follow("connectionstatechange", () => this.add("connection", pc.connectionState ?? ""));
  }

  /** This device's code was made from the local description (gathering complete or cut short). */
  codeMade(carried: number) {
    if (this.gatheringEnd === null) {
      this.gatheringEnd = this.pc.iceGatheringState === "complete" ? "complete" : "timeout";
      this.gatheringEndedAt = this.elapsed();
      if (this.gatheringEnd === "timeout") this.add("gathering", "timeout", false);
    }
    const choices = candidateChoices(this.pc.localDescription);
    this.choices = new Map(choices.map((choice) => [candidateKey(choice.value), choice.leftOut]));
    this.choiceOrder = choices.map((choice) => ({ key: candidateKey(choice.value), value: choice.value }));
    this.codeCandidates = carried;
    this.stage = "waiting";
    this.add("code", `${carried} of ${choices.length}`);
  }

  /** The other device's code is known (its candidates): connection checks can start. */
  remoteKnown(candidates: CompactCandidate[], connecting: boolean) {
    this.remote = candidates.map((candidate) => candidateOf({ ...candidate, port: candidate.port, type: "host" }));
    if (connecting) this.stage = "connecting";
    this.add("remote", `${candidates.length} address${candidates.length === 1 ? "" : "es"}`);
    this.startPolling();
  }

  /** The data channel opened. */
  channelOpen() {
    this.add("channel", "open");
  }

  /** The link opened: one last reading, then the snapshot stays as it is. */
  opened() {
    if (this.stage === "closed") return;
    this.stage = "open";
    this.add("link", "open", false);
    this.endedAt = this.clock.now();
    this.stopPolling();
    this.readStats();
    this.notify();
  }

  /**
   * The link is closing (before its RTCPeerConnection is closed): a last reading is asked while
   * the connection can still answer, and the listeners are removed. What was recorded stays.
   */
  closing(reason: NearbyErrorReason) {
    if (this.stage === "closed") return;
    const wasOpen = this.stage === "open";
    // The state change that made the link close may not have reached this recorder's listeners yet
    // (the link manager's run first, and closing removes these): note the states as they are.
    if (this.pc.iceConnectionState) this.add("ice", this.pc.iceConnectionState, false);
    if (this.pc.connectionState) this.add("connection", this.pc.connectionState, false);
    this.stage = "closed";
    this.closedReason = reason;
    this.add("closed", reason, false);
    if (!wasOpen) {
      this.endedAt = this.clock.now();
      this.readStats();
    }
    this.stopPolling();
    this.removers.splice(0).forEach((remove) => remove());
    this.notify();
  }

  snapshot(): NearbyDiagnostics {
    const elapsedMs = (this.endedAt ?? this.clock.now()) - this.startedAt;
    return {
      role: this.role,
      startedAt: this.startedAt,
      elapsedMs,
      stage: this.stage,
      closed: this.closedReason,
      iceGatheringState: this.pc.iceGatheringState ?? "",
      iceConnectionState: this.pc.iceConnectionState ?? "",
      connectionState: this.pc.connectionState ?? "",
      dtlsState: this.dtlsState,
      gatheringEnd: this.gatheringEnd,
      gatheringMs: this.gatheringEndedAt ?? elapsedMs,
      codeCandidates: this.codeCandidates,
      local: this.localCandidates(),
      remote: this.remote ? this.remote.map((candidate) => ({ ...candidate })) : null,
      timeline: this.timeline.map((entry) => ({ ...entry })),
      timelineDropped: this.timelineDropped,
      pairs: this.pairs.map((pair) => ({ ...pair })),
      statsAtMs: this.statsAt,
    };
  }

  /** `callback` gets snapshot() now (asynchronously) and on every change. */
  subscribe(callback: (diagnostics: NearbyDiagnostics) => void): () => void {
    this.listeners.add(callback);
    Promise.resolve().then(() => {
      if (this.listeners.has(callback)) this.deliver(callback, this.snapshot());
    });
    return () => {
      this.listeners.delete(callback);
    };
  }

  private localCandidates(): NearbyLocalCandidate[] {
    const atByKey = new Map(this.gathered.map((entry) => [entry.key, entry.atMs]));
    const fromCode = this.choiceOrder.map(({ key, value }) =>
      this.localCandidate(value, atByKey.get(key) ?? null, key)
    );
    const listed = new Set(this.choiceOrder.map(({ key }) => key));
    const others = this.gathered
      .filter((entry) => !listed.has(entry.key))
      .map((entry) => this.localCandidate(entry.value, entry.atMs, entry.key));
    return [...fromCode, ...others];
  }

  private localCandidate(value: string, atMs: number | null, key: string): NearbyLocalCandidate {
    const fields = readCandidate(value);
    let leftOut: NearbyLocalCandidate["leftOut"] = null;
    if (this.choices) leftOut = this.choices.has(key) ? this.choices.get(key) : "late";
    return {
      ...candidateOf({
        protocol: fields?.protocol ?? "",
        address: fields?.address ?? "",
        port: fields && Number.isInteger(fields.port) ? fields.port : null,
        type: fields?.type ?? "",
      }),
      tcpType: fields?.tcpType ?? null,
      atMs,
      inCode: this.choices !== null && leftOut === null,
      leftOut,
    };
  }

  private onCandidate(value: string) {
    const key = candidateKey(value);
    if (this.gathered.some((entry) => entry.key === key)) return;
    this.gathered.push({ key, value, atMs: this.elapsed() });
    this.notify();
  }

  private add(event: NearbyTimelineEntry["event"], value: string, notify = true) {
    // A state is only noted when it changes.
    const last = this.timeline
      .slice()
      .reverse()
      .find((entry) => entry.event === event);
    if (last && last.value === value) return;
    this.timeline.push({ atMs: this.elapsed(), event, value });
    if (this.timeline.length > TIMELINE_MAX) {
      this.timeline.splice(TIMELINE_HEAD, 1);
      this.timelineDropped++;
    }
    if (notify) this.notify();
  }

  private startPolling() {
    if (this.poller !== null || this.stage === "open" || this.stage === "closed") return;
    this.readStats();
    this.poller = this.clock.setInterval(() => this.readStats(), this.statsIntervalMs);
  }

  private stopPolling() {
    if (this.poller === null) return;
    this.clock.clearInterval(this.poller);
    this.poller = null;
  }

  private readStats() {
    if (this.reading || typeof this.pc.getStats !== "function") return;
    this.reading = true;
    let request: Promise<StatsReportLike>;
    try {
      request = this.pc.getStats();
    } catch {
      this.reading = false;
      return;
    }
    Promise.resolve(request)
      .then((report) => {
        const { pairs, dtlsState } = readStats(report);
        this.pairs = pairs;
        this.dtlsState = dtlsState ?? this.dtlsState;
        this.statsAt = this.elapsed();
        this.notify();
      })
      .catch(() => undefined)
      .then(() => {
        this.reading = false;
      });
  }

  private elapsed(): number {
    return this.clock.now() - this.startedAt;
  }

  private notify() {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot();
    Array.from(this.listeners).forEach((callback) => this.deliver(callback, snapshot));
  }

  private deliver(callback: (diagnostics: NearbyDiagnostics) => void, snapshot: NearbyDiagnostics) {
    try {
      callback(snapshot);
    } catch (e) {
      console.warn("[network] a connection details listener failed", e);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

/** Where the report was made: shown in its header. */
export interface ReportEnvironment {
  userAgent: string;
  /** window.isSecureContext; null when unknown. */
  secure: boolean | null;
  /** The camera permission ("granted", "denied", "prompt"); null when unknown. */
  camera: string | null;
  /** The tab's network mode. */
  mode: string | null;
  origin: string | null;
}

/** The label of the first pattern matching `ua` ("$1" is its first group); "" when none does. */
function firstMatch(ua: string, patterns: Array<[RegExp, string]>): string {
  for (const [pattern, label] of patterns) {
    const match = pattern.exec(ua);
    if (match) return label.replace("$1", match[1] ?? "");
  }
  return "";
}

/** "Chrome 152 · Android 17" from a user agent; "" when nothing is recognised. */
export function describeUserAgent(userAgent: string): string {
  const ua = userAgent || "";
  const browser = firstMatch(ua, [
    [/Edg\/(\d+)/, "Edge $1"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet $1"],
    [/Firefox\/(\d+)/, "Firefox $1"],
    [/CriOS\/(\d+)/, "Chrome $1 (iOS)"],
    [/Chrome\/(\d+)/, "Chrome $1"],
    [/Version\/(\d+)[\d.]* .*Safari/, "Safari $1"],
  ]);
  const system = firstMatch(ua, [
    [/Android (\d+)/, "Android $1"],
    [/(?:iPhone|CPU) OS (\d+)/, "iOS $1"],
    [/Windows NT/, "Windows"],
    [/Mac OS X/, "macOS"],
    [/CrOS/, "ChromeOS"],
    [/Linux/, "Linux"],
  ]);
  return [browser, system].filter(Boolean).join(" · ");
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/**
 * An address readable on a phone: mDNS names shortened to their first 8 characters. Browsers leave
 * the address out of their statistics when it is behind a .local name: "hidden".
 */
function shortAddress(address: string): string {
  if (!address) return "hidden";
  if (isMdnsName(address)) return `${address.slice(0, 8)}….local`;
  return address.includes(":") ? `[${address}]` : address;
}

function endpoint(candidate: NearbyCandidate | null): string {
  if (!candidate) return "?";
  return `${shortAddress(candidate.address)}:${candidate.port ?? "?"}`;
}

const LEFT_OUT: Record<string, string> = {
  "unreadable": "unreadable",
  "rtcp": "RTCP",
  "not-host": "not a host address",
  "active-tcp": "active TCP",
  "address": "address not supported",
  "duplicate": "duplicate",
  "limit": "over the 8-address limit",
  "late": "gathered after the code was made",
};

function candidateLine(candidate: NearbyCandidate, leftOut: string | null): string {
  const type = candidate.type && candidate.type !== "host" ? ` ${candidate.type}` : "";
  const line = `${candidate.protocol || "?"} ${endpoint(candidate)}  ${KIND_LABELS[candidate.kind]}${type}`;
  return leftOut ? `  - ${line} (left out: ${LEFT_OUT[leftOut] ?? leftOut})` : `  ${line}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "es"}`;
}

/** The status in a few words: "waiting for the reply", "checking", "failed"... */
export function statusOf(d: NearbyDiagnostics): string {
  if (d.stage === "open") return "connected";
  if (d.stage === "closed") return `closed (${d.closed})`;
  if (d.iceConnectionState === "failed" || d.connectionState === "failed") return "failed";
  if (d.stage === "preparing") return "finding this device's addresses";
  if (d.remote === null) return "waiting for the reply";
  return d.iceConnectionState === "checking" || d.connectionState === "connecting" ? "checking" : "waiting";
}

/** The plain-text report the player copies (see the module comment). */
export function formatReport(d: NearbyDiagnostics, env: ReportEnvironment): string {
  const header = [
    d.role === "inviter" ? "Inviter" : "Guest",
    describeUserAgent(env.userAgent) || "unknown browser",
    env.secure === null ? null : env.secure ? "secure page" : "not a secure page",
    env.camera ? `camera ${env.camera}` : null,
    env.mode ? `${env.mode} mode` : null,
  ].filter(Boolean);
  const lines = ["Hanab nearby connection report", header.join(" · ")];
  if (env.origin) lines.push(`Page: ${env.origin}`);
  lines.push(
    // A live snapshot is only refreshed on changes: its elapsed time would be stale.
    `Status: ${statusOf(d)}${d.stage === "open" || d.stage === "closed" ? ` after ${seconds(d.elapsedMs)}` : ""} (ICE ${
      d.iceConnectionState || "?"
    }, connection ${d.connectionState || "?"}${d.dtlsState ? `, DTLS ${d.dtlsState}` : ""})`
  );

  const carried = d.local.filter((candidate) => candidate.inCode);
  const gathering =
    d.gatheringEnd === "complete"
      ? `gathering complete after ${seconds(d.gatheringMs)}`
      : d.gatheringEnd === "timeout"
      ? `gathering cut short after ${seconds(d.gatheringMs)}`
      : "gathering…";
  lines.push(
    d.codeCandidates === null
      ? `This device gathered ${plural(d.local.length, "address")} so far (${gathering}):`
      : `This device offered ${carried.length} of ${plural(d.local.length, "address")} gathered (${gathering}):`
  );
  if (!d.local.length) lines.push("  none");
  d.local.forEach((candidate) => lines.push(candidateLine(candidate, candidate.leftOut)));

  if (d.remote === null) {
    lines.push("The other device's addresses: not known yet");
  } else {
    lines.push(`The other device offered ${plural(d.remote.length, "address")}:`);
    if (!d.remote.length) lines.push("  none");
    d.remote.forEach((candidate) => lines.push(candidateLine(candidate, null)));
  }

  const timeline = d.timeline.map((entry) => `${seconds(entry.atMs)} ${entry.event} ${entry.value}`);
  if (d.timelineDropped) timeline.splice(TIMELINE_HEAD, 0, `(${d.timelineDropped} more)`);
  lines.push(`Timeline: ${timeline.join(" · ") || "nothing yet"}`);

  if (d.statsAtMs === null) {
    lines.push("Checks: none yet");
  } else {
    lines.push(`Checks (at ${seconds(d.statsAtMs)}): ${d.pairs.length ? "" : "no candidate pairs"}`.trimEnd());
    d.pairs.forEach((pair) => {
      const flags = [pair.selected ? "selected" : null, pair.nominated ? "nominated" : null].filter(Boolean);
      const rtt = pair.currentRoundTripTime !== null ? ` · rtt ${Math.round(pair.currentRoundTripTime * 1000)}ms` : "";
      lines.push(
        `  ${endpoint(pair.local)} ⇄ ${endpoint(pair.remote)} ${pair.state || "?"}${
          flags.length ? ` (${flags.join(", ")})` : ""
        } · sent ${pair.requestsSent}, answered ${pair.responsesReceived} · received ${
          pair.requestsReceived
        }, answered ${pair.responsesSent}${rtt}`
      );
    });
  }
  return lines.join("\n");
}

/** Checks sent and answered, over every candidate pair (the summary line of the readout). */
export function checkCounts(d: NearbyDiagnostics): { sent: number; answered: number } {
  return d.pairs.reduce(
    (total, pair) => ({ sent: total.sent + pair.requestsSent, answered: total.answered + pair.responsesReceived }),
    { sent: 0, answered: 0 }
  );
}
