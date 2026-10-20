import { describe, expect, it } from "vitest";
import {
  buildSdp,
  CompactDescription,
  decodeDescription,
  encodeDescription,
  fromBase64Url,
  fromCode,
  MAX_CANDIDATES,
  nearbyUrl,
  parseNearbyText,
  parseSdp,
  toBase64Url,
  toCode,
} from "./codec";
import { NearbyError } from "./types";

const sdp = (...lines: string[]) => `${lines.join("\r\n")}\r\n`;

/** Captured from Chrome 152 (iceServers: []). */
const CHROME_OFFER = sdp(
  "v=0",
  "o=- 3382580790337246198 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:1524056103 1 udp 2113937151 6ac8474c-1cae-44d0-8c1e-87e74345fff7.local 53056 typ host generation 0 network-cost 999",
  "a=ice-ufrag:w3wW",
  "a=ice-pwd:6jyXApb38WnpXd0q0HEWv79V",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 4C:6F:3B:11:F3:CE:88:A5:5B:0D:8C:45:BA:B0:7C:C4:2E:D6:09:F3:D1:2D:19:27:FC:8E:53:AA:3F:EC:6E:F3",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144"
);

const CHROME_ANSWER = sdp(
  "v=0",
  "o=- 3382580790337246199 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:2419043500 1 udp 2113937151 6ac8474c-1cae-44d0-8c1e-87e74345fff7.local 62585 typ host generation 0 network-cost 999",
  "a=ice-ufrag:m7G6",
  "a=ice-pwd:nj254v61FUV740eYger4+cIW",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 CF:D1:1D:A6:23:79:77:CA:26:C5:3B:90:85:BB:EA:17:DC:E0:78:A6:68:25:3A:60:42:DE:2C:ED:26:77:24:0C",
  "a=setup:active",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144"
);

/** Firefox: fingerprint at session level, uppercase protocols, hex credentials, real addresses (camera granted). */
const FIREFOX_OFFER = sdp(
  "v=0",
  "o=mozilla...THIS_IS_SDPARTA-99.0 4934139885953732403 0 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=fingerprint:sha-256 6B:8B:5D:EA:59:04:20:23:29:C8:87:1C:CC:87:32:BE:DD:8C:66:A5:8E:50:55:EA:4C:D3:B6:5F:09:BF:52:6F",
  "a=group:BUNDLE 0",
  "a=ice-options:trickle",
  "a=msid-semantic:WMS *",
  "m=application 54473 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 192.168.1.23",
  "a=candidate:0 1 UDP 2122252543 192.168.1.23 54473 typ host",
  "a=candidate:1 1 UDP 2122187007 2a01:e0a:2b1:5c0:8d4c:3f0e:6a2b:91f4 60215 typ host",
  "a=candidate:2 1 UDP 2122121471 fe80::1c2b:3aff:fe4d:5e6f 49903 typ host",
  "a=candidate:3 1 TCP 2105524479 192.168.1.23 9 typ host tcptype active",
  "a=candidate:4 1 TCP 2105458943 2a01:e0a:2b1:5c0:8d4c:3f0e:6a2b:91f4 9 typ host tcptype active",
  "a=candidate:5 1 TCP 2105393407 192.168.1.23 43215 typ host tcptype passive",
  "a=sendrecv",
  "a=end-of-candidates",
  "a=ice-pwd:9d6f1c5ab3e24d07b8a1f2c3d4e5f607",
  "a=ice-ufrag:3b5e7a9c",
  "a=mid:0",
  "a=setup:actpass",
  "a=sctp-port:5000",
  "a=max-message-size:1073741823"
);

/** Firefox without camera permission: mDNS names. */
const FIREFOX_ANSWER = sdp(
  "v=0",
  "o=mozilla...THIS_IS_SDPARTA-99.0 7710526389151832011 0 IN IP4 0.0.0.0",
  "s=-",
  "t=0 0",
  "a=fingerprint:sha-256 A0:3F:96:1B:7C:22:5E:D4:08:E1:99:4A:BC:63:0D:F2:5B:87:1E:C9:44:72:AE:30:D5:6B:0F:98:2C:E7:41:1A",
  "a=group:BUNDLE 0",
  "a=ice-options:trickle",
  "a=msid-semantic:WMS *",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=candidate:0 1 UDP 2122252543 0f9b6a52-3c1d-4e8f-a2b7-91c4d5e6f708.local 61002 typ host",
  "a=candidate:1 1 TCP 2105524479 0f9b6a52-3c1d-4e8f-a2b7-91c4d5e6f708.local 9 typ host tcptype active",
  "a=sendrecv",
  "a=end-of-candidates",
  "a=ice-pwd:0c1d2e3f405162738495a6b7c8d9eaf1",
  "a=ice-ufrag:5f2a9c01",
  "a=mid:0",
  "a=setup:active",
  "a=sctp-port:5000",
  "a=max-message-size:1073741823"
);

/** Safari (libwebrtc) with camera permission: raw private IPv4 and a global IPv6. */
const SAFARI_OFFER = sdp(
  "v=0",
  "o=- 7364123986412834512 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 61873 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 192.168.1.42",
  "a=candidate:2848716312 1 udp 2113937151 192.168.1.42 61873 typ host generation 0 network-cost 10",
  "a=candidate:842163049 1 udp 2113939711 2a02:8428:1a2b:3c01:14e2:9d3f:a1b2:c3d4 53002 typ host generation 0 network-cost 10",
  "a=candidate:3994613508 1 tcp 1518157311 192.168.1.42 9 typ host tcptype active generation 0 network-cost 10",
  "a=candidate:1985426144 1 tcp 1518283007 2a02:8428:1a2b:3c01:14e2:9d3f:a1b2:c3d4 9 typ host tcptype active generation 0 network-cost 10",
  "a=ice-ufrag:Kq7f",
  "a=ice-pwd:8yG3pL0aZr1nB5vX2cW4eQ7t",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 2E:7C:91:04:B8:3D:6A:F1:0E:52:C7:8B:19:A4:D6:3F:70:E8:2B:95:4C:1D:A3:F6:58:0B:E9:27:C4:6D:81:13",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144"
);

const SAFARI_ANSWER = sdp(
  "v=0",
  "o=- 2210457719836218874 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 59114 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 10.0.0.17",
  "a=candidate:3359213371 1 udp 2113937151 10.0.0.17 59114 typ host generation 0 network-cost 10",
  "a=candidate:1029410236 1 udp 2113939711 fe80::18f0:2ab4:9c3e:7d51 64011 typ host generation 0 network-cost 10",
  "a=ice-ufrag:x9Pz",
  "a=ice-pwd:T4b+0kQ/Lr8sYw2nVd6mJe1a",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 58:E2:0A:9F:C3:71:44:BD:16:8E:F0:2D:A7:65:39:CC:0B:D4:7A:E1:92:3F:6C:58:B0:1E:84:D7:2A:F9:63:05",
  "a=setup:active",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144"
);

const TOKEN = "a1b2c3d4";

function bytesOf(fingerprint: string): number[] {
  return fingerprint.split(":").map((hex) => parseInt(hex, 16));
}

function expectNearbyError(run: () => unknown, reason: string) {
  let error: unknown = null;
  try {
    run();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(NearbyError);
  expect((error as NearbyError).reason).toBe(reason);
}

/** Through the whole pipeline: compact form, bytes, code, back, standard SDP, compact form again. */
function roundTrip(description: CompactDescription): CompactDescription {
  const decoded = fromCode(toCode(description));
  const rebuilt = buildSdp(decoded);
  expect(rebuilt.type).toBe(description.type);
  return parseSdp(rebuilt, decoded.token);
}

describe("parsing a local description", () => {
  it("keeps what the remote side needs from Chrome's offer and answer", () => {
    const offer = parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN);
    expect(offer).toEqual({
      type: "offer",
      ufrag: "w3wW",
      pwd: "6jyXApb38WnpXd0q0HEWv79V",
      fingerprint: {
        algorithm: "sha-256",
        bytes: new Uint8Array(
          bytesOf("4C:6F:3B:11:F3:CE:88:A5:5B:0D:8C:45:BA:B0:7C:C4:2E:D6:09:F3:D1:2D:19:27:FC:8E:53:AA:3F:EC:6E:F3")
        ),
      },
      setup: "actpass",
      mid: "0",
      candidates: [{ protocol: "udp", address: "6ac8474c-1cae-44d0-8c1e-87e74345fff7.local", port: 53056 }],
      token: TOKEN,
    });

    const answer = parseSdp({ type: "answer", sdp: CHROME_ANSWER }, TOKEN);
    expect(answer).toMatchObject({
      type: "answer",
      ufrag: "m7G6",
      pwd: "nj254v61FUV740eYger4+cIW",
      setup: "active",
      candidates: [{ protocol: "udp", address: "6ac8474c-1cae-44d0-8c1e-87e74345fff7.local", port: 62585 }],
    });
  });

  it("reads Firefox's session-level fingerprint and keeps host candidates, best first, without active TCP", () => {
    const offer = parseSdp({ type: "offer", sdp: FIREFOX_OFFER }, TOKEN);
    expect(offer).toMatchObject({ ufrag: "3b5e7a9c", pwd: "9d6f1c5ab3e24d07b8a1f2c3d4e5f607", setup: "actpass" });
    expect(offer.fingerprint.algorithm).toBe("sha-256");
    expect(offer.candidates).toEqual([
      { protocol: "udp", address: "192.168.1.23", port: 54473 },
      { protocol: "tcp", address: "192.168.1.23", port: 43215 },
      { protocol: "udp", address: "2a01:e0a:2b1:5c0:8d4c:3f0e:6a2b:91f4", port: 60215 },
      { protocol: "udp", address: "fe80::1c2b:3aff:fe4d:5e6f", port: 49903 },
    ]);

    const answer = parseSdp({ type: "answer", sdp: FIREFOX_ANSWER }, TOKEN);
    expect(answer.candidates).toEqual([
      { protocol: "udp", address: "0f9b6a52-3c1d-4e8f-a2b7-91c4d5e6f708.local", port: 61002 },
    ]);
  });

  it("reads Safari's raw addresses (link-local IPv6 last)", () => {
    expect(parseSdp({ type: "offer", sdp: SAFARI_OFFER }, TOKEN).candidates).toEqual([
      { protocol: "udp", address: "192.168.1.42", port: 61873 },
      { protocol: "udp", address: "2a02:8428:1a2b:3c01:14e2:9d3f:a1b2:c3d4", port: 53002 },
    ]);
    expect(parseSdp({ type: "answer", sdp: SAFARI_ANSWER }, TOKEN).candidates).toEqual([
      { protocol: "udp", address: "10.0.0.17", port: 59114 },
      { protocol: "udp", address: "fe80::18f0:2ab4:9c3e:7d51", port: 64011 },
    ]);
  });

  it("keeps at most 8 candidates, preferring IPv4 and mDNS over link-local IPv6, and drops duplicates", () => {
    const candidates = [
      ...Array.from({ length: 4 }, (_, i) => `a=candidate:${i} 1 udp 100 fe80::${i + 1} ${40000 + i} typ host`),
      "a=candidate:9 1 udp 100 192.168.0.9 40009 typ srflx raddr 0.0.0.0 rport 0",
      "a=candidate:10 2 udp 100 192.168.0.10 40010 typ host",
      ...Array.from(
        { length: 7 },
        (_, i) => `a=candidate:${20 + i} 1 udp 100 192.168.0.${20 + i} ${40020 + i} typ host`
      ),
      "a=candidate:30 1 udp 100 192.168.0.20 40020 typ host",
      "a=candidate:31 1 udp 100 6ac8474c-1cae-44d0-8c1e-87e74345fff7.local 40031 typ host",
    ];
    const many = CHROME_OFFER.replace(/a=candidate:[^\r]*\r\n/, `${candidates.join("\r\n")}\r\n`);
    const parsed = parseSdp({ type: "offer", sdp: many }, TOKEN);
    expect(parsed.candidates).toHaveLength(MAX_CANDIDATES);
    expect(parsed.candidates.map((c) => c.address)).toEqual([
      ...Array.from({ length: 7 }, (_, i) => `192.168.0.${20 + i}`),
      "6ac8474c-1cae-44d0-8c1e-87e74345fff7.local",
    ]);
  });

  it("rejects descriptions that lack what the remote side needs", () => {
    expectNearbyError(() => parseSdp({ type: "offer", sdp: "garbage" }, TOKEN), "malformed");
    expectNearbyError(() => parseSdp({ type: "rollback", sdp: CHROME_OFFER }, TOKEN), "malformed");
    expectNearbyError(() => parseSdp(null, TOKEN), "malformed");
    expectNearbyError(
      () => parseSdp({ type: "offer", sdp: CHROME_OFFER.replace(/a=fingerprint:[^\r]*\r\n/, "") }, TOKEN),
      "malformed"
    );
    expectNearbyError(
      () => parseSdp({ type: "offer", sdp: CHROME_OFFER.replace("m=application", "m=audio") }, TOKEN),
      "malformed"
    );
    expectNearbyError(() => parseSdp({ type: "offer", sdp: CHROME_OFFER }, "nothex!!"), "malformed");
    // No candidate at all is fine: the other side may still be reached (peer-reflexive).
    const bare = CHROME_OFFER.replace(/a=candidate:[^\r]*\r\n/, "");
    expect(parseSdp({ type: "offer", sdp: bare }, TOKEN).candidates).toEqual([]);
  });
});

describe("compact codes", () => {
  const fixtures: Array<[string, "offer" | "answer", string]> = [
    ["Chrome offer", "offer", CHROME_OFFER],
    ["Chrome answer", "answer", CHROME_ANSWER],
    ["Firefox offer", "offer", FIREFOX_OFFER],
    ["Firefox answer", "answer", FIREFOX_ANSWER],
    ["Safari offer", "offer", SAFARI_OFFER],
    ["Safari answer", "answer", SAFARI_ANSWER],
  ];

  it.each(fixtures)("round-trips the %s: parse, encode, decode, rebuild, parse", (_, type, text) => {
    const parsed = parseSdp({ type, sdp: text }, TOKEN);
    expect(decodeDescription(encodeDescription(parsed))).toEqual(parsed);
    expect(roundTrip(parsed)).toEqual(parsed);
  });

  it("keeps a Chrome invite under 100 bytes (140 characters)", () => {
    const offer = parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN);
    expect(encodeDescription(offer).length).toBeLessThan(100);
    const code = toCode(offer);
    expect(code.length).toBeLessThan(140);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nearbyUrl("invite", code, "https://hanab.test/")).toBe(`https://hanab.test/nearby/#o=${code}`);
    expect(nearbyUrl("reply", code, "http://192.168.1.20:3000")).toBe(`http://192.168.1.20:3000/nearby/#a=${code}`);
  });

  it("rebuilds the SDP that Chrome accepts", () => {
    const answer = fromCode(toCode(parseSdp({ type: "answer", sdp: CHROME_ANSWER }, TOKEN)));
    expect(buildSdp(answer)).toEqual({
      type: "answer",
      sdp: sdp(
        "v=0",
        "o=- 1 2 IN IP4 127.0.0.1",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "a=msid-semantic: WMS",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0",
        "a=candidate:1 1 udp 2113937151 6ac8474c-1cae-44d0-8c1e-87e74345fff7.local 62585 typ host",
        "a=end-of-candidates",
        "a=ice-ufrag:m7G6",
        "a=ice-pwd:nj254v61FUV740eYger4+cIW",
        "a=fingerprint:sha-256 CF:D1:1D:A6:23:79:77:CA:26:C5:3B:90:85:BB:EA:17:DC:E0:78:A6:68:25:3A:60:42:DE:2C:ED:26:77:24:0C",
        "a=setup:active",
        "a=mid:0",
        "a=sctp-port:5000",
        "a=max-message-size:262144"
      ),
    });
    const firefox = buildSdp(fromCode(toCode(parseSdp({ type: "offer", sdp: FIREFOX_OFFER }, TOKEN))));
    expect(firefox.sdp).toContain("a=candidate:1 1 udp 2113937151 192.168.1.23 54473 typ host\r\n");
    expect(firefox.sdp).toContain("a=candidate:2 1 tcp 2113937150 192.168.1.23 43215 typ host tcptype passive\r\n");
  });

  it("encodes addresses by kind and compares IPv6 by value", () => {
    const base = parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN);
    const withAddresses = (...addresses: string[]): CompactDescription => ({
      ...base,
      candidates: addresses.map((address, i) => ({ protocol: "udp", address, port: 1000 + i })),
    });
    const decoded = fromCode(
      toCode(
        withAddresses("2001:0DB8:0000:0000:0000:0000:0000:0001", "::ffff:192.168.1.5", "fe80::1%en0", "my-laptop.lan")
      )
    );
    expect(decoded.candidates.map((c) => c.address)).toEqual([
      "2001:db8::1",
      "::ffff:c0a8:105",
      "fe80::1",
      "my-laptop.lan",
    ]);
    // An IPv4 or an mDNS name costs its 4 or 16 bytes plus 3 (kind and port), whatever its text.
    const one = encodeDescription(withAddresses("192.168.1.5")).length;
    expect(encodeDescription(withAddresses("192.168.1.5", "10.0.0.1")).length).toBe(one + 7);
    expect(encodeDescription(withAddresses("192.168.1.5", "6AC8474C-1CAE-44D0-8C1E-87E74345FFF7.local")).length).toBe(
      one + 19
    );
    expectNearbyError(() => encodeDescription(withAddresses("not an address!")), "malformed");
  });

  it("rejects garbage, damaged codes and other versions", () => {
    const code = toCode(parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN));
    expectNearbyError(() => fromCode(""), "malformed");
    expectNearbyError(() => fromCode("hello"), "malformed");
    expectNearbyError(() => fromCode("not base64 at all!"), "malformed");
    expectNearbyError(() => fromCode(code.slice(0, -10)), "malformed");
    expectNearbyError(() => fromCode(`${code}AAAA`), "malformed");
    expectNearbyError(() => fromCode(toBase64Url(new Uint8Array([1, 0xff, 0, 0, 0, 0]))), "malformed");
    const bytes = fromBase64Url(code);
    bytes[0] = 2;
    expectNearbyError(() => fromCode(toBase64Url(bytes)), "unsupported-version");
    bytes[0] = 1;
    bytes[bytes.length - 20] = 0xff; // the candidate count
    expectNearbyError(() => fromCode(toBase64Url(bytes)), "malformed");
  });

  it("decodes base64 tolerantly: padding, whitespace, standard alphabet", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252, 253]);
    const code = toBase64Url(bytes);
    expect(fromBase64Url(code)).toEqual(bytes);
    expect(fromBase64Url(` ${code.slice(0, 4)}\n${code.slice(4)}== `)).toEqual(bytes);
    expect(fromBase64Url(code.replace(/-/g, "+").replace(/_/g, "/"))).toEqual(bytes);
    expect(Array.from({ length: 6 }, (_, n) => fromBase64Url(toBase64Url(bytes.slice(0, n + 1))))).toEqual(
      Array.from({ length: 6 }, (_, n) => bytes.slice(0, n + 1))
    );
  });
});

describe("parseNearbyText", () => {
  const invite = toCode(parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN));
  const reply = toCode(parseSdp({ type: "answer", sdp: CHROME_ANSWER }, TOKEN));

  /** A valid invite code ending with "_", like chat italics would wrap. */
  const underscored = (() => {
    const offer = parseSdp({ type: "offer", sdp: CHROME_OFFER }, TOKEN);
    // Only codes of 3n bytes use all the bits of their last character.
    for (let extra = 0; extra < 3; extra++) {
      for (let last = 0; last < 256; last++) {
        const candidates = [...offer.candidates];
        for (let i = 0; i < extra; i++) candidates.push({ protocol: "udp", address: `10.0.${i}.${last}`, port: 9000 });
        const code = toCode({ ...offer, candidates });
        if (code.endsWith("_")) return code;
      }
    }
    throw new Error("no code ends with _");
  })();

  it("finds invites and replies in URLs from any origin and base path", () => {
    expect(parseNearbyText(`https://hanab.test/nearby/#o=${invite}`)).toEqual({ kind: "invite", code: invite });
    expect(parseNearbyText(`http://192.168.1.20:3000/hanab/nearby/#a=${reply}`)).toEqual({
      kind: "reply",
      code: reply,
    });
    expect(parseNearbyText(`hanab.example.org/some/base/nearby/?x=1#o=${invite}`)).toEqual({
      kind: "invite",
      code: invite,
    });
  });

  it("finds bare o= / a= strings and bare codes", () => {
    expect(parseNearbyText(`o=${invite}`)).toEqual({ kind: "invite", code: invite });
    expect(parseNearbyText(`a=${reply}`)).toEqual({ kind: "reply", code: reply });
    expect(parseNearbyText(` ${reply} `)).toEqual({ kind: "reply", code: reply });
    expect(parseNearbyText(`"${invite}"`)).toEqual({ kind: "invite", code: invite });
  });

  it("tolerates quotes, brackets, chat formatting, messages and invisible characters", () => {
    const url = `https://hanab.test/nearby/#o=${invite}`;
    const expected = { kind: "invite", code: invite };
    [
      `"${url}"`,
      `“${url}”`,
      `«${url}»`,
      `<${url}>`,
      `(${url})`,
      `*${url}*`,
      `_${url}_`,
      `\`${url}\``,
      `${url}.`,
      `Join my game: ${url} see you!`,
      `${url.slice(0, 40)}​${url.slice(40)}﻿`,
      `⁦${url}⁩`,
    ].forEach((text) => expect(parseNearbyText(text)).toEqual(expected));

    const italic = `https://hanab.test/nearby/#o=${underscored}`;
    expect(parseNearbyText(italic)).toEqual({ kind: "invite", code: underscored });
    expect(parseNearbyText(`_${italic}_`)).toEqual({ kind: "invite", code: underscored });
  });

  it("returns damaged codes that are clearly meant as codes, and null for anything else", () => {
    expect(parseNearbyText("https://hanab.test/nearby/#o=abc")).toEqual({ kind: "invite", code: "abc" });
    expect(parseNearbyText(`https://hanab.test/nearby/#a=${reply.slice(0, 50)}`)).toEqual({
      kind: "reply",
      code: reply.slice(0, 50),
    });
    expect(parseNearbyText("")).toBeNull();
    expect(parseNearbyText("hello")).toBeNull();
    expect(parseNearbyText("https://example.com/?a=1")).toBeNull();
    expect(parseNearbyText("https://hanab.test/play/?gameId=ExcitingHookwormPink")).toBeNull();
    expect(parseNearbyText("A".repeat(120))).toBeNull();
  });
});
