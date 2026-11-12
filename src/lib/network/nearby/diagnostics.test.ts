import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressKind, checkCounts, describeUserAgent, formatReport, readStats, statusOf } from "./diagnostics";
import { LinkManager, LinkManagerOptions } from "./links";
import { FakeBroadcastHub, FakeLan, mdnsNameOf } from "./testing";
import { NearbyDiagnostics } from "./types";

describe("addressKind", () => {
  it.each([
    ["192.168.43.1", "ipv4-private"],
    ["10.215.173.12", "ipv4-private"],
    ["172.16.0.1", "ipv4-private"],
    ["172.31.255.254", "ipv4-private"],
    ["172.15.0.1", "ipv4-public"],
    ["172.32.0.1", "ipv4-public"],
    ["100.64.0.1", "ipv4-cgnat"],
    ["100.127.255.1", "ipv4-cgnat"],
    ["100.63.0.1", "ipv4-public"],
    ["100.128.0.1", "ipv4-public"],
    ["169.254.10.1", "ipv4-link-local"],
    ["127.0.0.1", "ipv4-loopback"],
    ["8.8.8.8", "ipv4-public"],
    ["0.0.0.0", "ipv4-other"],
    ["239.255.255.250", "ipv4-other"],
    ["2607:fea8:1:2::3", "ipv6-global"],
    ["2001:DB8::1", "ipv6-global"],
    ["[2001:db8::2]", "ipv6-global"],
    ["fd12:3456::1", "ipv6-unique-local"],
    ["fe80::1%wlan0", "ipv6-link-local"],
    ["::1", "ipv6-loopback"],
    ["::ffff:192.168.1.5", "ipv6-other"],
    ["6ac8474c-1cae-44d0-8c1e-87e74345fff7.local", "mdns"],
    ["6AC8474C-1CAE-44D0-8C1E-87E74345FFF7.local", "mdns"],
    ["printer.local", "mdns"],
    ["my-host.lan", "hostname"],
    ["", "unknown"],
    ["not an address", "unknown"],
    ["1:2:3", "unknown"],
  ])("%s is %s", (address, kind) => {
    expect(addressKind(address)).toBe(kind);
  });
});

describe("describeUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 17; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.149 Mobile Safari/537.36",
      "Chrome 152 · Android 17",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
      "Safari 19 · iOS 19",
    ],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0", "Firefox 150 · Windows"],
    [
      "Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/140.0 Mobile Safari/537.36",
      "Samsung Internet 29 · Android 16",
    ],
    ["something else", ""],
  ])("%s", (userAgent, expected) => {
    expect(describeUserAgent(userAgent)).toBe(expected);
  });
});

describe("readStats", () => {
  it("joins candidate pairs with their candidates and finds the selected pair and the DTLS state", () => {
    const report = new Map<string, unknown>([
      [
        "L1",
        {
          id: "L1",
          type: "local-candidate",
          candidateType: "host",
          address: "192.168.43.1",
          port: 51234,
          protocol: "udp",
        },
      ],
      [
        "R1",
        {
          id: "R1",
          type: "remote-candidate",
          candidateType: "prflx",
          ip: "192.168.43.17",
          port: 40001,
          protocol: "udp",
        },
      ],
      ["R2", { id: "R2", type: "remote-candidate", candidateType: "host", address: "", port: 40002, protocol: "udp" }],
      [
        "P1",
        {
          id: "P1",
          type: "candidate-pair",
          localCandidateId: "L1",
          remoteCandidateId: "R1",
          state: "succeeded",
          nominated: true,
          requestsSent: 4,
          responsesReceived: 3,
          requestsReceived: 2,
          responsesSent: 2,
          bytesSent: 100,
          bytesReceived: 120,
          currentRoundTripTime: 0.012,
        },
      ],
      [
        "P2",
        {
          id: "P2",
          type: "candidate-pair",
          localCandidateId: "L1",
          remoteCandidateId: "R2",
          state: "failed",
          requestsSent: 7,
        },
      ],
      ["T", { id: "T", type: "transport", dtlsState: "connected", selectedCandidatePairId: "P1" }],
      ["junk", null],
    ]);
    const { pairs, dtlsState } = readStats(report);
    expect(dtlsState).toBe("connected");
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({
      state: "succeeded",
      nominated: true,
      selected: true,
      requestsSent: 4,
      responsesReceived: 3,
      currentRoundTripTime: 0.012,
      local: { address: "192.168.43.1", port: 51234, protocol: "udp", type: "host", kind: "ipv4-private" },
      remote: { address: "192.168.43.17", type: "prflx", kind: "ipv4-private" },
    });
    expect(pairs[1]).toMatchObject({
      state: "failed",
      selected: false,
      requestsSent: 7,
      responsesReceived: 0,
      currentRoundTripTime: null,
      remote: { address: "", kind: "unknown" },
    });
  });
});

/* ------------------------------------------------------------------ */
/* Through the link manager                                            */
/* ------------------------------------------------------------------ */

let lan: FakeLan;
let hub: FakeBroadcastHub;
let tabs: LinkManager[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  lan = new FakeLan();
  hub = new FakeBroadcastHub();
  tabs = [];
});

afterEach(() => {
  tabs.forEach((t) => t.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

function tab(id: string, options: LinkManagerOptions = {}): LinkManager {
  const manager = new LinkManager({
    selfId: id,
    createPeerConnection: lan.factory(id),
    createBroadcastChannel: hub.factory,
    getPlayerId: () => `player-${id}`,
    origin: () => "https://hanab.test",
    ...options,
  });
  tabs.push(manager);
  return manager;
}

async function run<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error })
  );
  for (let elapsed = 0; !state.done && elapsed < ms; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10);
  }
  if (!state.done) throw new Error("still pending");
  if (state.error !== undefined) throw state.error;
  return state.value;
}

const HOTSPOT = (owner: string) =>
  owner === "a"
    ? [
        "candidate:1 1 udp 2122260223 192.168.43.1 51234 typ host generation 0",
        "candidate:2 1 tcp 1518280447 192.168.43.1 9 typ host tcptype active generation 0",
        "candidate:3 1 udp 2122187007 2607:fea8:1:2::3 51235 typ host generation 0",
      ]
    : [`candidate:4 1 udp 2122260223 ${mdnsNameOf(owner)} 40001 typ host generation 0`];

describe("connection details", () => {
  it("records what each device offered, the timeline and the checks, and stops reading stats once open", async () => {
    lan.candidatesOf = (owner) => HOTSPOT(owner);
    const [a, b] = ["a", "b"].map((id) => tab(id));
    const invite = await run(a.createInvite());
    const atCode = invite.diagnostics();
    expect(atCode).toMatchObject({
      role: "inviter",
      stage: "waiting",
      gatheringEnd: "complete",
      codeCandidates: 2,
      remote: null,
    });
    expect(atCode.local.map((c) => [c.protocol, c.address, c.port, c.kind, c.inCode, c.leftOut])).toEqual([
      ["udp", "192.168.43.1", 51234, "ipv4-private", true, null],
      ["tcp", "192.168.43.1", 9, "ipv4-private", false, "active-tcp"],
      ["udp", "2607:fea8:1:2::3", 51235, "ipv6-global", true, null],
    ]);
    expect(atCode.local[0].atMs).not.toBeNull();
    expect(statusOf(atCode)).toBe("waiting for the reply");

    const reply = await run(b.answerInvite(invite.url));
    expect(reply.diagnostics()).toMatchObject({ role: "guest", stage: "waiting", codeCandidates: 1 });
    expect(reply.diagnostics().remote.map((c) => [c.address, c.kind])).toEqual([
      ["192.168.43.1", "ipv4-private"],
      ["2607:fea8:1:2::3", "ipv6-global"],
    ]);

    const updates: NearbyDiagnostics[] = [];
    const unsubscribe = invite.onDiagnostics((d) => updates.push(d));
    await run(invite.acceptReply(reply.url));
    await run(invite.connected);
    await vi.advanceTimersByTimeAsync(100);
    const opened = invite.diagnostics();
    expect(opened.stage).toBe("open");
    expect(opened.remote.map((c) => c.kind)).toEqual(["mdns"]);
    expect(opened.timeline.map((e) => e.event)).toEqual(
      expect.arrayContaining(["gathering", "code", "remote", "connection", "channel", "link"])
    );
    expect(opened.pairs.length).toBeGreaterThan(0);
    expect(opened.pairs.some((pair) => pair.state === "succeeded" && pair.selected)).toBe(true);
    expect(checkCounts(opened).answered).toBeGreaterThan(0);
    expect(updates.length).toBeGreaterThan(1);
    expect(updates[updates.length - 1].stage).toBe("open");

    // No more reading once open, and the snapshot stays frozen.
    const pc = lan.connectionsOf("a")[0];
    const calls = pc.statsCalls;
    await vi.advanceTimersByTimeAsync(10000);
    expect(pc.statsCalls).toBe(calls);
    expect(invite.diagnostics().elapsedMs).toBe(opened.elapsedMs);
    unsubscribe();

    const report = formatReport(opened, {
      userAgent: "Mozilla/5.0 (Linux; Android 17) Chrome/152.0 Mobile Safari/537.36",
      secure: true,
      camera: "granted",
      mode: "nearby",
      origin: "https://hanab.test",
    });
    expect(report).toContain("Inviter · Chrome 152 · Android 17 · secure page · camera granted · nearby mode");
    expect(report).toContain("This device offered 2 of 3 addresses gathered (gathering complete");
    expect(report).toContain("udp 192.168.43.1:51234  IPv4 private (LAN or hotspot)");
    expect(report).toContain("- tcp 192.168.43.1:9  IPv4 private (LAN or hotspot) (left out: active TCP)");
    expect(report).toContain("udp [2607:fea8:1:2::3]:51235  IPv6 global");
    expect(report).toMatch(
      /The other device offered 1 address:\n {2}udp [0-9a-f]{8}….local:40001 {2}hidden behind a .local name/
    );
    expect(report).toMatch(/Checks \(at [\d.]+s\):\n {2}192\.168\.43\.1:51234 ⇄ .* succeeded \(selected, nominated\)/);
  });

  it("keeps the details of a connection that failed, with the checks nobody answered", async () => {
    lan.reachable = () => false;
    const [a, b] = ["a", "b"].map((id) => tab(id));
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));
    await run(invite.acceptReply(reply.url));
    await expect(run(invite.connected)).rejects.toMatchObject({ reason: "failed" });
    await vi.advanceTimersByTimeAsync(100);

    const failed = invite.diagnostics();
    expect(failed).toMatchObject({ stage: "closed", closed: "failed" });
    expect(failed.timeline.map((e) => `${e.event} ${e.value}`)).toEqual(
      expect.arrayContaining(["connection failed", "closed failed"])
    );
    expect(failed.pairs.length).toBeGreaterThan(0);
    expect(checkCounts(failed)).toMatchObject({ answered: 0 });
    expect(statusOf(failed)).toBe("closed (failed)");

    // The guest keeps waiting (its inviter may scan the reply later) and keeps reading.
    expect(reply.diagnostics().stage).toBe("waiting");
    expect(statusOf(reply.diagnostics())).toBe("failed");
    const guestPc = lan.connectionsOf("b")[0];
    const calls = guestPc.statsCalls;
    await vi.advanceTimersByTimeAsync(3000);
    expect(guestPc.statsCalls).toBeGreaterThan(calls);

    // Cancelled: no more reading, the last statistics stay.
    reply.cancel();
    const afterCancel = guestPc.statsCalls;
    await vi.advanceTimersByTimeAsync(5000);
    expect(guestPc.statsCalls).toBe(afterCancel);
    expect(reply.diagnostics()).toMatchObject({ stage: "closed", closed: "cancelled" });
    expect(reply.diagnostics().pairs.length).toBeGreaterThan(0);
  });

  it("says when gathering was cut short, and lists candidates gathered after the code as late", async () => {
    lan.gatheringCompletes = false;
    const a = tab("a");
    const invite = await run(a.createInvite());
    const d = invite.diagnostics();
    expect(d.gatheringEnd).toBe("timeout");
    expect(d.gatheringMs).toBeGreaterThanOrEqual(3000);
    expect(d.timeline.map((e) => `${e.event} ${e.value}`)).toContain("gathering timeout");

    const pc = lan.connectionsOf("a")[0];
    pc.dispatchEvent(
      Object.assign(new Event("icecandidate"), {
        candidate: { candidate: "candidate:9 1 udp 1 10.0.0.7 6000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      })
    );
    const late = invite.diagnostics().local.find((c) => c.address === "10.0.0.7");
    expect(late).toMatchObject({ inCode: false, leftOut: "late", kind: "ipv4-private" });
    expect(
      formatReport(invite.diagnostics(), { userAgent: "", secure: null, camera: null, mode: null, origin: null })
    ).toContain("gathering cut short after");
  });

  it("matches Chrome's icecandidate events (with ufrag and network-id) with the description's lines", async () => {
    lan.candidatesOf = () => ["candidate:1 1 udp 2122260223 192.168.43.1 51234 typ host generation 0 network-cost 999"];
    const a = tab("a");
    const invite = await run(a.createInvite());
    const pc = lan.connectionsOf("a")[0];
    pc.dispatchEvent(
      Object.assign(new Event("icecandidate"), {
        candidate: {
          candidate:
            "candidate:1 1 udp 2122260223 192.168.43.1 51234 typ host generation 0 ufrag F001 network-id 1 network-cost 10",
        },
      })
    );
    const local = invite.diagnostics().local;
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ address: "192.168.43.1", inCode: true, leftOut: null });
  });

  it("is not read before the other device's code is known, and stops when an invite expires", async () => {
    const a = tab("a");
    const invite = await run(a.createInvite());
    const pc = lan.connectionsOf("a")[0];
    await vi.advanceTimersByTimeAsync(5000);
    expect(pc.statsCalls).toBe(0);
    expect(invite.diagnostics().statsAtMs).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(invite.diagnostics()).toMatchObject({ stage: "closed", closed: "timeout" });
  });
});
