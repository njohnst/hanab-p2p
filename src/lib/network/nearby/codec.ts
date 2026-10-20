/**
 * Compact WebRTC descriptions for the nearby handshake's QR codes
 * (docs/P2P_DESIGN.md, "Compact codes").
 *
 * A browser's SDP is ~600-1500 characters; a QR code that a phone scans
 * reliably from another phone's screen holds far less. Only what the remote
 * side needs travels: ICE ufrag and pwd, the DTLS fingerprint and role
 * (`setup`), the `mid`, the host candidates and a 4-byte token that the
 * reply echoes. The other side rebuilds a standard data-channel-only SDP
 * from it (buildSdp).
 *
 * Binary layout (format version 1), then base64url without padding:
 *
 *   version (1 byte) = 1
 *   flags (1 byte): bit 0 answer; bits 1-2 setup (actpass, active, passive);
 *                   bits 3-4 fingerprint algorithm (sha-256, sha-384, sha-512)
 *   token (4 bytes)
 *   ufrag, pwd: ICE strings (1 byte: bit 7 packed, bits 0-6 length; then
 *               6 bits per ice-char when packed, else ASCII)
 *   mid: 1 byte length + UTF-8
 *   fingerprint: 32, 48 or 64 bytes (by algorithm)
 *   candidate count (1 byte, at most 8), then per candidate:
 *     1 byte: bit 0 tcp; bits 1-2 address kind (IPv4, IPv6, mDNS, hostname)
 *     port (2 bytes, big-endian)
 *     address: IPv4 4 bytes, IPv6 16, mDNS "<uuid>.local" 16, hostname 1 byte length + UTF-8
 *
 * A Chrome invite with one mDNS candidate is ~83 bytes (111 characters).
 *
 * Codes are untrusted input: decoding validates everything and throws a
 * NearbyError ("malformed" or "unsupported-version"), never anything else.
 */
import { BASE_PATH } from "~/lib/routes";
import { NearbyCode, NearbyError } from "./types";

export const CODE_VERSION = 1;
/** The smallest version 1 description is 63 bytes; other versions are assumed no smaller than this. */
const MIN_DESCRIPTION_BYTES = 48;
/** At most this many candidates travel (the QR code must stay small). */
export const MAX_CANDIDATES = 8;

export type FingerprintAlgorithm = "sha-256" | "sha-384" | "sha-512";
export type DtlsSetup = "actpass" | "active" | "passive";

export interface CompactCandidate {
  protocol: "udp" | "tcp";
  /** IPv4, IPv6, "<uuid>.local" (mDNS) or a host name. */
  address: string;
  port: number;
}

export interface CompactDescription {
  type: "offer" | "answer";
  ufrag: string;
  pwd: string;
  fingerprint: { algorithm: FingerprintAlgorithm; bytes: Uint8Array };
  setup: DtlsSetup;
  mid: string;
  /** Host candidates only (TCP ones passive); at most MAX_CANDIDATES. */
  candidates: CompactCandidate[];
  /** 8 hex characters: chosen by the inviter, echoed by the reply. */
  token: string;
}

const SETUPS: DtlsSetup[] = ["actpass", "active", "passive"];
const ALGORITHMS: FingerprintAlgorithm[] = ["sha-256", "sha-384", "sha-512"];
const FINGERPRINT_LENGTHS: Record<FingerprintAlgorithm, number> = { "sha-256": 32, "sha-384": 48, "sha-512": 64 };

const ADDRESS_IPV4 = 0;
const ADDRESS_IPV6 = 1;
const ADDRESS_MDNS = 2;
const ADDRESS_HOSTNAME = 3;

/** RFC 8839 ice-char: exactly the standard base64 alphabet. */
const ICE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_SHORT_STRING = 127;
const TOKEN = /^[0-9a-f]{8}$/;
const MDNS_NAME = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function malformed(detail: string): NearbyError {
  return new NearbyError("malformed", `Malformed nearby code: ${detail}.`);
}

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return null;
  }
  return new Uint8Array(parts.map(Number));
}

function parseIpv6(text: string): Uint8Array | null {
  // A zone ("%eth0") means nothing to another device.
  let address = text
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase();
  if (!address.includes(":")) return null;

  let embedded: Uint8Array | null = null;
  const withIpv4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (withIpv4) {
    embedded = parseIpv4(withIpv4[2]);
    if (!embedded) return null;
    address = `${withIpv4[1]}0:0`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part ? part.split(":") : []);
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  if (embedded) bytes.set(embedded, 12);
  return bytes;
}

/** RFC 5952 text form: lowercase, no leading zeros, the longest run of zero groups as "::". */
function formatIpv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; i++) {
    let length = 0;
    while (i + length < 8 && groups[i + length] === 0) length++;
    if (length > bestLength) {
      bestStart = i;
      bestLength = length;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOfHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

interface ClassifiedAddress {
  kind: number;
  bytes: Uint8Array;
  /** The address as decoding writes it back (IPv6 in RFC 5952 form, mDNS names in lowercase). */
  text: string;
  /** Lower is better: IPv4 and mDNS names first, link-local and loopback last. */
  rank: number;
}

function classifyAddress(address: string): ClassifiedAddress | null {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const local = ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254) || ipv4[0] === 0;
    return { kind: ADDRESS_IPV4, bytes: ipv4, text: Array.from(ipv4).join("."), rank: local ? 2 : 0 };
  }
  const mdns = MDNS_NAME.exec(address);
  if (mdns) {
    return {
      kind: ADDRESS_MDNS,
      bytes: bytesOfHex(mdns.slice(1).join("").toLowerCase()),
      text: address.toLowerCase(),
      rank: 0,
    };
  }
  const ipv6 = parseIpv6(address);
  if (ipv6) {
    const linkLocal = ipv6[0] === 0xfe && (ipv6[1] & 0xc0) === 0x80;
    const loopback = ipv6.every((byte, i) => byte === (i === 15 ? 1 : 0));
    return { kind: ADDRESS_IPV6, bytes: ipv6, text: formatIpv6(ipv6), rank: linkLocal || loopback ? 2 : 1 };
  }
  if (HOSTNAME.test(address)) {
    const bytes = new TextEncoder().encode(address);
    return bytes.length <= 255 ? { kind: ADDRESS_HOSTNAME, bytes, text: address, rank: 1 } : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Base64url                                                           */
/* ------------------------------------------------------------------ */

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += BASE64URL[(value >> (18 - 6 * j)) & 63];
  }
  return out;
}

/**
 * Decode base64url (standard base64 too), ignoring whitespace and padding.
 * Strict otherwise: unused trailing bits must be zero, which tells a code from
 * the same code with a character appended (chat formatting such as `_..._`).
 */
export function fromBase64Url(text: string): Uint8Array {
  const clean = text
    .replace(/[\s=]+/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  if (!clean || clean.length % 4 === 1) throw malformed("bad length");
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = BASE64URL.indexOf(clean[i]);
    if (value < 0) throw malformed("bad character");
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw malformed("bad padding");
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Binary encoding                                                     */
/* ------------------------------------------------------------------ */

class Writer {
  private bytes: number[] = [];

  byte(value: number) {
    this.bytes.push(value & 0xff);
  }

  raw(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i++) this.bytes.push(bytes[i]);
  }

  uint16(value: number) {
    this.byte(value >> 8);
    this.byte(value);
  }

  /** ICE ufrag/pwd: 6 bits per character when they are all ice-chars (they always are in practice). */
  iceString(value: string) {
    if (!value || value.length > MAX_SHORT_STRING) throw malformed("ICE credential length");
    const packable = Array.from(value).every((char) => ICE_CHARS.includes(char));
    if (!packable) {
      if (!/^[\x21-\x7e]+$/.test(value)) throw malformed("ICE credential characters");
      this.byte(value.length);
      this.raw(new TextEncoder().encode(value));
      return;
    }
    this.byte(0x80 | value.length);
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < value.length; i++) {
      buffer = ((buffer << 6) | ICE_CHARS.indexOf(value[i])) & 0xffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        this.byte(buffer >> bits);
      }
    }
    if (bits > 0) this.byte(buffer << (8 - bits));
  }

  shortString(value: string) {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > 255) throw malformed("string length");
    this.byte(bytes.length);
    this.raw(bytes);
  }

  result(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done() {
    return this.offset === this.bytes.length;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw malformed("truncated");
    return this.bytes[this.offset++];
  }

  raw(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw malformed("truncated");
    const slice = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  uint16(): number {
    return (this.byte() << 8) | this.byte();
  }

  iceString(): string {
    const header = this.byte();
    const length = header & 0x7f;
    if (!length) throw malformed("empty ICE credential");
    if (!(header & 0x80)) {
      const text = String.fromCharCode(...Array.from(this.raw(length)));
      if (!/^[\x21-\x7e]+$/.test(text)) throw malformed("ICE credential characters");
      return text;
    }
    const packed = this.raw(Math.ceil((length * 6) / 8));
    let out = "";
    let buffer = 0;
    let bits = 0;
    let index = 0;
    while (out.length < length) {
      if (bits < 6) {
        buffer = ((buffer << 8) | packed[index++]) & 0xffff;
        bits += 8;
      }
      bits -= 6;
      out += ICE_CHARS[(buffer >> bits) & 63];
    }
    return out;
  }

  shortString(): string {
    const bytes = this.raw(this.byte());
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw malformed("text encoding");
    }
  }
}

function checkDescription(description: CompactDescription) {
  if (description.type !== "offer" && description.type !== "answer") throw malformed("type");
  if (!TOKEN.test(description.token)) throw malformed("token");
  if (!SETUPS.includes(description.setup)) throw malformed("DTLS setup");
  const { algorithm, bytes } = description.fingerprint;
  if (!ALGORITHMS.includes(algorithm) || bytes.length !== FINGERPRINT_LENGTHS[algorithm]) {
    throw malformed("fingerprint");
  }
  if (!description.mid || /\s/.test(description.mid)) throw malformed("mid");
  if (description.candidates.length > MAX_CANDIDATES) throw malformed("too many candidates");
}

export function encodeDescription(description: CompactDescription): Uint8Array {
  checkDescription(description);
  const writer = new Writer();
  writer.byte(CODE_VERSION);
  writer.byte(
    (description.type === "answer" ? 1 : 0) |
      (SETUPS.indexOf(description.setup) << 1) |
      (ALGORITHMS.indexOf(description.fingerprint.algorithm) << 3)
  );
  writer.raw(bytesOfHex(description.token));
  writer.iceString(description.ufrag);
  writer.iceString(description.pwd);
  writer.shortString(description.mid);
  writer.raw(description.fingerprint.bytes);
  writer.byte(description.candidates.length);
  description.candidates.forEach((candidate) => {
    const address = classifyAddress(candidate.address);
    if (!address) throw malformed("candidate address");
    if (!Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) {
      throw malformed("candidate port");
    }
    writer.byte((candidate.protocol === "tcp" ? 1 : 0) | (address.kind << 1));
    writer.uint16(candidate.port);
    if (address.kind === ADDRESS_HOSTNAME) writer.byte(address.bytes.length);
    writer.raw(address.bytes);
  });
  return writer.result();
}

export function decodeDescription(bytes: Uint8Array): CompactDescription {
  // Shorter than any description (a fingerprint alone is 32 bytes): damaged,
  // whatever its first byte says, rather than from another version.
  if (bytes.length < MIN_DESCRIPTION_BYTES) throw malformed("too short");
  const reader = new Reader(bytes);
  const version = reader.byte();
  if (version !== CODE_VERSION) {
    throw new NearbyError("unsupported-version");
  }
  const flags = reader.byte();
  const setup = SETUPS[(flags >> 1) & 3];
  const algorithm = ALGORITHMS[(flags >> 3) & 3];
  if (!setup || !algorithm || flags >> 5) throw malformed("flags");
  const token = hexOf(reader.raw(4));
  const ufrag = reader.iceString();
  const pwd = reader.iceString();
  const mid = reader.shortString();
  const fingerprint = { algorithm, bytes: reader.raw(FINGERPRINT_LENGTHS[algorithm]) };

  const count = reader.byte();
  if (count > MAX_CANDIDATES) throw malformed("too many candidates");
  const candidates: CompactCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const header = reader.byte();
    if (header >> 3) throw malformed("candidate header");
    const port = reader.uint16();
    if (!port) throw malformed("candidate port");
    const kind = header >> 1;
    let address: string;
    if (kind === ADDRESS_IPV4) {
      address = Array.from(reader.raw(4)).join(".");
    } else if (kind === ADDRESS_IPV6) {
      address = formatIpv6(reader.raw(16));
    } else if (kind === ADDRESS_MDNS) {
      const hex = hexOf(reader.raw(16));
      address = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(
        20
      )}.local`;
    } else {
      address = reader.shortString();
      if (!HOSTNAME.test(address)) throw malformed("candidate host name");
    }
    candidates.push({ protocol: header & 1 ? "tcp" : "udp", address, port });
  }
  if (!reader.done) throw malformed("trailing data");

  const description: CompactDescription = {
    type: flags & 1 ? "answer" : "offer",
    ufrag,
    pwd,
    fingerprint,
    setup,
    mid,
    candidates,
    token,
  };
  checkDescription(description);
  return description;
}

/** The base64url code of a description (what follows `#o=` / `#a=`). */
export function toCode(description: CompactDescription): string {
  return toBase64Url(encodeDescription(description));
}

/** Decode a code. Throws NearbyError "malformed" or "unsupported-version". */
export function fromCode(code: string): CompactDescription {
  return decodeDescription(fromBase64Url(code));
}

/* ------------------------------------------------------------------ */
/* SDP                                                                 */
/* ------------------------------------------------------------------ */

interface SdpSection {
  media: string | null;
  attributes: Array<[string, string]>;
}

function sectionsOf(sdp: string): SdpSection[] {
  const sections: SdpSection[] = [{ media: null, attributes: [] }];
  sdp.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.startsWith("m=")) {
      sections.push({ media: line.slice(2), attributes: [] });
    } else if (line.startsWith("a=")) {
      const colon = line.indexOf(":");
      const name = colon < 0 ? line.slice(2) : line.slice(2, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).trim();
      sections[sections.length - 1].attributes.push([name.toLowerCase(), value]);
    }
  });
  return sections;
}

function parseFingerprint(value: string): CompactDescription["fingerprint"] | null {
  const [algorithm, hex] = value.split(/\s+/);
  const name = (algorithm || "").toLowerCase() as FingerprintAlgorithm;
  if (!ALGORITHMS.includes(name) || !/^[0-9a-f]{2}(:[0-9a-f]{2})+$/i.test(hex || "")) return null;
  const bytes = bytesOfHex(hex.replace(/:/g, ""));
  return bytes.length === FINGERPRINT_LENGTHS[name] ? { algorithm: name, bytes } : null;
}

interface RankedCandidate extends CompactCandidate {
  rank: number;
  order: number;
}

/** A host candidate worth sending, from a candidate attribute's value; null to skip it. */
function parseCandidate(value: string, order: number): RankedCandidate | null {
  const fields = value.replace(/^candidate:/i, "").split(/\s+/);
  if (fields.length < 8 || fields[1] !== "1") return null;
  const protocol = fields[2].toLowerCase();
  const port = Number(fields[5]);
  if ((protocol !== "udp" && protocol !== "tcp") || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const extensions = new Map<string, string>();
  for (let i = 6; i + 1 < fields.length; i += 2) extensions.set(fields[i].toLowerCase(), fields[i + 1]);
  if (extensions.get("typ") !== "host") return null;
  // Active TCP candidates only connect out (port 9): the remote side cannot use them.
  if (protocol === "tcp" && extensions.get("tcptype")?.toLowerCase() !== "passive") return null;
  const address = classifyAddress(fields[4]);
  if (!address) return null;
  return { protocol, address: address.text, port, rank: address.rank * 2 + (protocol === "tcp" ? 1 : 0), order };
}

/**
 * The compact form of a local description (RTCPeerConnection.localDescription
 * once ICE gathering is over). Throws NearbyError "malformed" if it lacks
 * something the remote side needs.
 */
export function parseSdp(
  description: { type?: string | null; sdp?: string | null } | null,
  token: string
): CompactDescription {
  const type = description?.type;
  if (type !== "offer" && type !== "answer") throw malformed("description type");
  const sections = sectionsOf(description.sdp || "");
  const media = sections.find((section) => section.media && section.media.startsWith("application "));
  if (!media) throw malformed("no data channel section");
  const attribute = (name: string) =>
    media.attributes.find(([key]) => key === name)?.[1] ?? sections[0].attributes.find(([key]) => key === name)?.[1];

  const ufrag = attribute("ice-ufrag");
  const pwd = attribute("ice-pwd");
  const mid = attribute("mid");
  const setup = attribute("setup")?.toLowerCase() as DtlsSetup;
  if (!ufrag || !pwd) throw malformed("no ICE credentials");
  if (!mid) throw malformed("no mid");

  const fingerprint = [...media.attributes, ...sections[0].attributes]
    .filter(([key]) => key === "fingerprint")
    .map(([, value]) => parseFingerprint(value))
    .find(Boolean);
  if (!fingerprint) throw malformed("no usable fingerprint");

  const seen = new Set<string>();
  const candidates = media.attributes
    .filter(([key]) => key === "candidate")
    .map(([, value], i) => parseCandidate(value, i))
    .filter((candidate): candidate is RankedCandidate => {
      if (!candidate) return false;
      const key = `${candidate.protocol} ${candidate.address} ${candidate.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_CANDIDATES)
    .map(({ protocol, address, port }) => ({ protocol, address, port }));

  const compact: CompactDescription = { type, ufrag, pwd, fingerprint, setup, mid, candidates, token };
  checkDescription(compact);
  return compact;
}

/** A standard SDP for setRemoteDescription, rebuilt from a compact description. */
export function buildSdp(description: CompactDescription): { type: "offer" | "answer"; sdp: string } {
  const fingerprint = Array.from(description.fingerprint.bytes, (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase()
  ).join(":");
  const lines = [
    "v=0",
    "o=- 1 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=group:BUNDLE ${description.mid}`,
    "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    ...description.candidates.map(
      (candidate, i) =>
        `a=candidate:${i + 1} 1 ${candidate.protocol} ${2113937151 - i} ${candidate.address} ${
          candidate.port
        } typ host` + (candidate.protocol === "tcp" ? " tcptype passive" : "")
    ),
    "a=end-of-candidates",
    `a=ice-ufrag:${description.ufrag}`,
    `a=ice-pwd:${description.pwd}`,
    `a=fingerprint:${description.fingerprint.algorithm} ${fingerprint}`,
    `a=setup:${description.setup}`,
    `a=mid:${description.mid}`,
    "a=sctp-port:5000",
    "a=max-message-size:262144",
  ];
  return { type: description.type, sdp: `${lines.join("\r\n")}\r\n` };
}

/* ------------------------------------------------------------------ */
/* URLs and pasted text                                                */
/* ------------------------------------------------------------------ */

/** `<origin><basePath>/nearby/#o=<code>` (invite) or `#a=<code>` (reply). */
export function nearbyUrl(kind: NearbyCode["kind"], code: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${BASE_PATH}/nearby/#${kind === "invite" ? "o" : "a"}=${code}`;
}

/** Same set as in ~/lib/routes.ts: what copying from chat apps can leave in a text. */
const INVISIBLE_CHARACTERS = /[­؜᠎​-‏‪-‮⁠-⁯﻿]/g;

/** `o=<code>` / `a=<code>` at the start, or after a non-code character (`#`, `?`, `&`, a quote, a space...). */
const CODE_PARAM = /(^|[^A-Za-z0-9_-])([oa])=([A-Za-z0-9_-]+)/g;

/** An undecodable `o=`/`a=` value still counts as a (damaged) code in a fragment, or when this long. */
const MIN_DAMAGED_CODE = 16;

/** A bare code is at least this long (the smallest possible description is ~70 bytes). */
const MIN_BARE_CODE = 80;

/**
 * The code itself, or with chat formatting (`_..._` italics) stripped from its
 * end, whichever decodes (an "unsupported-version" code counts: the UI
 * reports it). null if none does.
 */
function decodable(code: string): { code: string; type: CompactDescription["type"] | null } | null {
  for (let variant = code, i = 0; i < 3 && variant; variant = variant.replace(/_$/, ""), i++) {
    try {
      return { code: variant, type: fromCode(variant).type };
    } catch (e) {
      if (e instanceof NearbyError && e.reason === "unsupported-version") return { code: variant, type: null };
    }
    if (!variant.endsWith("_")) break;
  }
  return null;
}

/**
 * The nearby code in what a player scanned or pasted, or null if there is none:
 * - an invite or reply URL, from any origin and base path: ".../nearby/#o=<code>", ".../nearby/#a=<code>",
 * - "o=<code>" or "a=<code>",
 * - a bare code (its kind is read from the code),
 * each possibly in a message, in quotes, brackets or chat formatting, or carrying invisible characters.
 * A code that does not decode is still returned when it is clearly meant as one
 * (`#o=...`): answerInvite and acceptReply then say why it is unusable.
 */
export function parseNearbyText(text: string): NearbyCode | null {
  const clean = (text || "").replace(INVISIBLE_CHARACTERS, "");

  let fallback: NearbyCode | null = null;
  let match: RegExpExecArray | null;
  CODE_PARAM.lastIndex = 0;
  while ((match = CODE_PARAM.exec(clean))) {
    const [, before, letter, code] = match;
    const kind = letter === "o" ? "invite" : "reply";
    const found = decodable(code);
    if (found) return { kind, code: found.code };
    if (!fallback && (before === "#" || code.length >= MIN_DAMAGED_CODE)) fallback = { kind, code };
  }
  if (fallback) return fallback;

  for (const token of clean.split(/\s+/)) {
    const bare = token.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, "");
    if (bare.length < MIN_BARE_CODE || !/^[A-Za-z0-9_-]+$/.test(bare)) continue;
    const found = decodable(bare);
    if (found?.type) return { kind: found.type === "offer" ? "invite" : "reply", code: found.code };
  }
  return null;
}
