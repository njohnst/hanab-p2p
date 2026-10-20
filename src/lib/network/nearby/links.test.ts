import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, fromCode, parseNearbyText, toBase64Url } from "./codec";
import { deliverReplyToOtherTab, LinkManager, LinkManagerOptions, MAX_FRAME_CHARS } from "./links";
import { FakeBroadcastHub, FakeDataChannel, FakeLan } from "./testing";
import { NearbyError } from "./types";

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

async function settle(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Let the fake clock run until `promise` settles (for at most `ms`). */
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

/** The reason `promise` rejects with (a NearbyError). */
async function rejection(promise: Promise<unknown>, ms = 5000): Promise<string> {
  try {
    await run(promise, ms);
  } catch (e) {
    expect(e).toBeInstanceOf(NearbyError);
    return (e as NearbyError).reason;
  }
  throw new Error("resolved");
}

/** The whole QR handshake: invite, reply, reply applied, both sides linked. */
async function qr(inviter: LinkManager, guest: LinkManager, gameId: string | null = null) {
  const invite = await run(inviter.createInvite({ gameId }));
  const reply = await run(guest.answerInvite(invite.url));
  await run(invite.acceptReply(reply.url));
  const link = await run(invite.connected);
  const joined = await run(reply.connected);
  return { invite, reply, link, joined };
}

function open(manager: LinkManager): string[] {
  return manager
    .links()
    .filter((link) => link.state === "open")
    .map((link) => link.peerId);
}

/** Watch a tab's room traffic like the transport does. */
function watch(manager: LinkManager) {
  const messages: Array<{ peerId: string; roomId: string; data: unknown }> = [];
  let changes = 0;
  manager.watchRooms({
    changed: () => changes++,
    message: (peerId, roomId, data) => messages.push({ peerId, roomId, data }),
  });
  return { messages, changes: () => changes };
}

/** Frames a tab sent on its data channel to another tab (every connection between them). */
function framesBetween(from: string, to: string): Array<Record<string, unknown>> {
  return lan
    .connectionsOf(from)
    .filter((pc) => pc.partner?.owner === to)
    .flatMap((pc) => pc.channels)
    .flatMap((channel) => channel.sent.map((frame) => JSON.parse(frame)));
}

/** A tab's data channel to another, to inject raw frames. */
function channelBetween(from: string, to: string): FakeDataChannel {
  const pc = lan.connectionsOf(from).find((candidate) => candidate.partner?.owner === to && !candidate.closed);
  return pc.channels.find((channel) => channel.readyState === "open");
}

describe("QR handshake", () => {
  it("links two tabs with an invite and its reply", async () => {
    const a = tab("a");
    const b = tab("b");
    const seen: string[][] = [];
    a.subscribe((links) => seen.push(links.map((link) => `${link.peerId}:${link.state}`)));

    const invite = await run(a.createInvite({ gameId: "SomeGame" }));
    expect(invite.url).toMatch(/^https:\/\/hanab\.test\/nearby\/#o=[A-Za-z0-9_-]+$/);
    expect(invite.url.length).toBeLessThan(170);
    expect(invite.token).toMatch(/^[0-9a-f]{8}$/);
    const offer = fromCode(parseNearbyText(invite.url).code);
    expect(offer).toMatchObject({ type: "offer", token: invite.token, setup: "actpass" });
    expect(offer.candidates).toHaveLength(1);

    const reply = await run(b.answerInvite(invite.url));
    expect(reply.url).toMatch(/^https:\/\/hanab\.test\/nearby\/#a=[A-Za-z0-9_-]+$/);
    expect(fromCode(parseNearbyText(reply.url).code)).toMatchObject({ type: "answer", token: invite.token });

    await run(invite.acceptReply(reply.url));
    expect(await run(invite.connected)).toEqual({
      peerId: "b",
      playerId: "player-b",
      state: "open",
      via: "invite",
    });
    expect(await run(reply.connected)).toEqual({ peerId: "a", gameId: "SomeGame" });
    expect(a.links()).toEqual([{ peerId: "b", playerId: "player-b", state: "open", via: "invite" }]);
    expect(b.links()).toEqual([{ peerId: "a", playerId: "player-a", state: "open", via: "invite" }]);
    expect(seen).toEqual([[], ["b:open"]]);

    // No server of any kind, and one ordered data channel.
    expect(lan.connections.map((pc) => pc.config)).toEqual([{ iceServers: [] }, { iceServers: [] }]);
    expect(lan.connectionsOf("a")[0].channels.map((channel) => channel.label)).toEqual(["hanab"]);
    // Applying the same reply again changes nothing; cancelling a connected invite neither.
    await run(invite.acceptReply(reply.url));
    invite.cancel();
    await settle(100);
    expect(open(a)).toEqual(["b"]);
  });

  it("waits at most ~3s for ICE gathering, and encodes what was gathered", async () => {
    lan.gatheringCompletes = false;
    const a = tab("a");
    const started = Date.now();
    const invite = await run(a.createInvite());
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(Date.now() - started).toBeLessThan(3100);
    expect(fromCode(parseNearbyText(invite.url).code).candidates).toHaveLength(1);
  });

  it("keeps several invites pending and matches replies by token", async () => {
    const a = tab("a");
    const b = tab("b");
    const c = tab("c");
    const first = await run(a.createInvite());
    const second = await run(a.createInvite());
    expect(first.token).not.toBe(second.token);

    const fromB = await run(b.answerInvite(second.url));
    const fromC = await run(c.answerInvite(first.url));
    expect(await run(a.acceptReply(`Here: ${fromC.url}`))).toBe(first);
    expect(await run(a.acceptReply(fromB.url))).toBe(second);
    expect((await run(first.connected)).peerId).toBe("c");
    expect((await run(second.connected)).peerId).toBe("b");
    expect(open(a)).toEqual(["b", "c"]);
    // Used invites are gone.
    expect(await rejection(a.acceptReply(fromB.url))).toBe("unknown-invite");
  });

  it("refuses codes of the wrong kind, other invites' replies, damaged codes and other versions", async () => {
    const a = tab("a");
    const b = tab("b");
    const c = tab("c");
    const first = await run(a.createInvite());
    const second = await run(a.createInvite());
    const reply = await run(b.answerInvite(first.url));

    expect(await rejection(c.answerInvite(reply.url))).toBe("not-an-invite");
    expect(await rejection(a.acceptReply(first.url))).toBe("not-a-reply");
    expect(await rejection(first.acceptReply("hello"))).toBe("malformed");
    expect(await rejection(c.answerInvite("https://hanab.test/nearby/#o=abc"))).toBe("malformed");
    expect(await rejection(c.answerInvite(first.url.slice(0, -12)))).toBe("malformed");

    const bytes = fromBase64Url(parseNearbyText(first.url).code);
    bytes[0] = 2;
    expect(await rejection(c.answerInvite(`o=${toBase64Url(bytes)}`))).toBe("unsupported-version");

    // A reply to the first invite is not the second's.
    expect(await rejection(second.acceptReply(reply.url))).toBe("unknown-invite");
    // A reply to another tab's invite.
    const elsewhere = await run(tab("d").createInvite());
    const foreign = await run(c.answerInvite(elsewhere.url));
    expect(await rejection(a.acceptReply(foreign.url))).toBe("unknown-invite");
    // An invite takes one reply.
    await run(first.acceptReply(reply.url));
    const late = await run(c.answerInvite(first.url));
    expect(await rejection(first.acceptReply(late.url))).toBe("unknown-invite");
    expect((await run(first.connected)).peerId).toBe("b");
  });

  it("refuses the tab's own invite and reply", async () => {
    const a = tab("a");
    const b = tab("b");
    const invite = await run(a.createInvite());
    expect(await rejection(a.answerInvite(invite.url))).toBe("own-invite");
    const reply = await run(b.answerInvite(invite.url));
    expect(await rejection(b.acceptReply(reply.url))).toBe("own-invite");
    // Still usable by the right tabs.
    await run(a.acceptReply(reply.url));
    expect((await run(invite.connected)).peerId).toBe("b");
  });

  it("expires invites and replies after ~10 minutes", async () => {
    const a = tab("a");
    const b = tab("b");
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));
    await settle(9 * 60 * 1000);
    expect(a.debugLinks()).toHaveLength(1);

    await settle(61 * 1000);
    expect(await rejection(invite.connected)).toBe("timeout");
    expect(await rejection(reply.connected)).toBe("timeout");
    expect(await rejection(invite.acceptReply(reply.url))).toBe("timeout");
    expect(await rejection(a.acceptReply(reply.url))).toBe("unknown-invite");
    expect(a.debugLinks()).toEqual([]);
    expect(lan.connections.every((pc) => pc.closed)).toBe(true);
  });

  it("fails at once when the devices cannot reach each other; the guest keeps waiting", async () => {
    lan.reachable = () => false;
    const a = tab("a");
    const b = tab("b");
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));
    await run(invite.acceptReply(reply.url));
    expect(await rejection(invite.connected, 1000)).toBe("failed");
    // The guest cannot tell a failure from an inviter that did not scan the reply yet.
    await settle(60000);
    expect(b.debugLinks()).toHaveLength(1);
    reply.cancel();
    expect(await rejection(reply.connected)).toBe("cancelled");
    expect(b.debugLinks()).toEqual([]);
  });

  it("gives up on a connection that does not open within ~20s of the reply", async () => {
    lan.stalls = () => true;
    const a = tab("a");
    const b = tab("b");
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));
    await run(invite.acceptReply(reply.url));
    await settle(19000);
    expect(a.debugLinks()).toHaveLength(1);
    expect(await rejection(invite.connected, 2000)).toBe("timeout");
  });

  it("cancels invites", async () => {
    const a = tab("a");
    const b = tab("b");
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));
    invite.cancel();
    expect(await rejection(invite.connected)).toBe("cancelled");
    expect(await rejection(invite.acceptReply(reply.url))).toBe("cancelled");
  });

  it("reports browsers without WebRTC", async () => {
    const a = tab("a");
    const invite = await run(a.createInvite());
    const none = tab("none", { createPeerConnection: null });
    expect(none.supported).toBe(false);
    expect(await rejection(none.createInvite())).toBe("no-webrtc");
    expect(await rejection(none.answerInvite(invite.url))).toBe("no-webrtc");
  });
});

describe("mesh", () => {
  it("links every tab with every other through common neighbours, the smaller id initiating", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => tab(id));
    await qr(a, b);
    await qr(b, c);
    await qr(c, d);
    await settle(2000);

    expect(open(a)).toEqual(["b", "c", "d"]);
    expect(open(b)).toEqual(["a", "c", "d"]);
    expect(open(c)).toEqual(["a", "b", "d"]);
    expect(open(d)).toEqual(["a", "b", "c"]);
    expect(a.links().map((link) => link.via)).toEqual(["invite", "mesh", "mesh"]);
    expect(d.links().find((link) => link.peerId === "a")).toEqual({
      peerId: "a",
      playerId: "player-a",
      state: "open",
      via: "mesh",
    });

    // One connection per pair (two ends each): no glare, no retries.
    expect(lan.connections).toHaveLength(12);
    expect(lan.connections.every((pc) => !pc.closed)).toBe(true);
    // d never offered anything: it has the largest id and invited nobody.
    expect(lan.connectionsOf("d").every((pc) => pc.offersCreated === 0)).toBe(true);
    // a's mesh connections were signaled through a neighbour, with trickled candidates.
    const meshed = lan.connectionsOf("a").filter((pc) => pc.partner?.owner !== "b");
    expect(meshed).toHaveLength(2);
    meshed.forEach((pc) => expect(pc.remoteCandidates.length).toBeGreaterThan(0));
    expect(framesBetween("b", "c").some((frame) => frame.t === "sig" && frame.from === "a")).toBe(true);
  });

  it("relays only between two of its own links, and says so when it cannot", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    const toB = channelBetween("a", "b");
    toB.send(JSON.stringify({ t: "sig", to: "zz", d: { a: "probe1", k: "offer", sdp: "v=0" } }));
    toB.send(JSON.stringify({ t: "sig", to: "b", d: { a: "probe2", k: "offer", sdp: "v=0" } }));
    toB.send(JSON.stringify({ t: "sig", to: "zz", d: { a: "probe3", k: "fail" } }));
    await settle(100);
    const answers = framesBetween("b", "a").filter((frame) => frame.t === "sig");
    expect(answers).toEqual([{ t: "sig", from: "zz", d: { a: "probe1", k: "fail" } }]);

    const c = tab("c");
    await qr(b, c);
    await settle(1000);
    channelBetween("a", "b").send(
      JSON.stringify({
        t: "sig",
        to: "c",
        from: "x",
        d: { a: "probe4", k: "cand", c: "candidate:1 1 udp 1 1.2.3.4 9 typ host", extra: "x".repeat(1000) },
      })
    );
    await settle(100);
    const forwarded = framesBetween("b", "c").filter(
      (frame) => frame.t === "sig" && (frame.d as { a: string }).a === "probe4"
    );
    expect(forwarded).toEqual([
      // The real sender, and only the known fields.
      {
        t: "sig",
        from: "a",
        d: { a: "probe4", k: "cand", c: "candidate:1 1 udp 1 1.2.3.4 9 typ host", mid: null, idx: null },
      },
    ]);
  });

  it("retries a failed mesh connection with a backoff, then when the peer lists change", async () => {
    const blocked = (x: string, y: string) => [x, y].sort().join() === "a,c";
    lan.reachable = (x, y) => !blocked(x, y);
    const [a, b, c] = ["a", "b", "c"].map((id) => tab(id));
    await qr(a, b);
    await qr(b, c);
    const attempts = () => lan.connectionsOf("a").filter((pc) => pc.partner?.owner === "c").length;

    await settle(1000);
    expect(attempts()).toBe(1);
    expect(open(a)).toEqual(["b"]);
    // Backoff: 5s, 10s, 20s, 40s, then nothing more until something changes.
    await settle(10 * 60 * 1000);
    expect(attempts()).toBe(5);
    expect(c.links()).toEqual([expect.objectContaining({ peerId: "b", state: "open" })]);

    lan.reachable = () => true;
    await qr(b, tab("d"));
    await settle(6000);
    expect(attempts()).toBe(6);
    expect(open(a)).toEqual(["b", "c", "d"]);
    expect(open(c)).toEqual(["a", "b", "d"]);
  });

  it("replaces an older link to the same tab without dropping it from its rooms", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    const traffic = watch(b);
    await qr(a, b);
    a.setRooms(["Room"]);
    await settle(100);
    expect(b.roomPeers("Room")).toEqual(["a"]);
    const changes = traffic.changes();

    // The larger id invites this time: the smaller one still closes the old link.
    await qr(b, a);
    expect(a.debugLinks()).toHaveLength(2);
    for (let i = 0; i < 7; i++) {
      await settle(1000);
      expect(b.roomPeers("Room")).toEqual(["a"]);
      expect(open(a)).toEqual(["b"]);
    }
    expect(a.debugLinks()).toEqual([{ peerId: "b", state: "open", via: "invite", current: true }]);
    expect(b.debugLinks()).toEqual([{ peerId: "a", state: "open", via: "invite", current: true }]);
    const [first, second] = lan.connectionsOf("a");
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(traffic.changes()).toBe(changes);

    a.sendRoom("b", "Room", { hello: 1 });
    await settle(50);
    expect(traffic.messages).toEqual([{ peerId: "a", roomId: "Room", data: { hello: 1 } }]);
  });
});

describe("liveness", () => {
  it("drops a link nothing was heard from for 30s", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    lan.silence("a", "b");
    await settle(25000);
    expect(open(a)).toEqual(["b"]);
    await settle(10000);
    expect(open(a)).toEqual([]);
    expect(open(b)).toEqual([]);
  });

  it("keeps links alive with pings, and expires nobody right after a throttled timer", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    await settle(120000);
    expect(open(a)).toEqual(["b"]);

    // Both tabs were in the background: their timers did not run for a minute.
    vi.setSystemTime(Date.now() + 60000);
    await settle(5000);
    expect(open(a)).toEqual(["b"]);
    await settle(10000);
    expect(open(a)).toEqual(["b"]);
    expect(open(b)).toEqual(["a"]);

    // A link that stays silent goes at the next regular tick.
    lan.silence("a", "b");
    vi.setSystemTime(Date.now() + 60000);
    await settle(5000);
    expect(open(a)).toEqual(["b"]);
    await settle(5000);
    expect(open(a)).toEqual([]);
  });

  it("drops a tab at once when it leaves the page (bye), and can invite again afterwards", async () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => tab(id));
    await qr(a, b);
    await qr(a, c);
    await settle(1000);
    expect(open(b)).toEqual(["a", "c"]);
    const pending = await run(a.createInvite());

    a.depart();
    await settle(20);
    expect(open(b)).toEqual(["c"]);
    expect(open(c)).toEqual(["b"]);
    expect(open(a)).toEqual([]);
    expect(await rejection(pending.connected)).toBe("cancelled");
    // b and c do not try to reach a again through each other.
    await settle(30000);
    expect(lan.connectionsOf("b").filter((pc) => !pc.closed)).toHaveLength(1);

    await qr(a, b);
    expect(open(a)).toEqual(["b"]);
  });

  it("drops a link whose connection fails or closes, not one that is only disconnected", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    const pc = lan.connectionsOf("b")[0];
    pc.connectionState = "disconnected";
    pc.dispatchEvent(new Event("connectionstatechange"));
    await settle(100);
    expect(open(b)).toEqual(["a"]);

    pc.connectionState = "failed";
    pc.dispatchEvent(new Event("connectionstatechange"));
    expect(open(b)).toEqual([]);
    // Closing it closed the data channel: the other side drops the link too.
    await settle(20);
    expect(open(a)).toEqual([]);
  });
});

describe("messages", () => {
  it("splits messages over 16 KB and reassembles them, keeping surrogate pairs whole", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    const traffic = watch(b);
    const payloads = [
      { text: "x".repeat(50000) },
      { text: "🎴".repeat(30000) },
      { text: `a${"🎴".repeat(30000)}` },
      { small: true },
    ];
    payloads.forEach((data) => a.sendRoom("b", "Room", data));
    await settle(100);
    expect(traffic.messages.map((message) => message.data)).toEqual(payloads);

    const frames = lan.connectionsOf("a")[0].channels[0].sent.filter((frame) => !frame.includes('"ping"'));
    expect(frames.length).toBeGreaterThan(10);
    frames.forEach((frame) => expect(frame.length).toBeLessThanOrEqual(2 * MAX_FRAME_CHARS + 100));
  });

  it("ignores garbage, oversized and unknown frames", async () => {
    const [a, b] = ["a", "b"].map((id) => tab(id));
    await qr(a, b);
    const traffic = watch(b);
    const toB = channelBetween("a", "b");
    [
      "not json",
      "[]",
      "null",
      JSON.stringify({ t: "m" }),
      JSON.stringify({ t: "what" }),
      "x".repeat(200000),
    ].forEach((frame) => toB.send(frame));
    toB.send(JSON.stringify({ t: "part", id: "p", i: 0, n: 2, data: '{"t":"m",' }));
    toB.send(JSON.stringify({ t: "m", r: "Room", d: 1 }));
    await settle(100);
    expect(traffic.messages).toEqual([{ peerId: "a", roomId: "Room", data: 1 }]);
    expect(open(b)).toEqual(["a"]);
  });
});

describe("reply hand-off between tabs", () => {
  it("hands a reply opened in another tab to the tab holding the invite", async () => {
    const a = tab("a");
    const b = tab("b", { createBroadcastChannel: null });
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));

    expect(await run(deliverReplyToOtherTab(reply.url, 1500, { createBroadcastChannel: hub.factory }))).toBe(true);
    expect((await run(invite.connected)).peerId).toBe("b");
    // Once linked, the invite is gone: delivering the reply again finds no taker.
    expect(await run(deliverReplyToOtherTab(reply.url, 1500, { createBroadcastChannel: hub.factory }))).toBe(false);
  });

  it("answers false when no tab of this browser holds the invite", async () => {
    const elsewhere = new FakeLan();
    const a = new LinkManager({
      selfId: "a",
      createPeerConnection: elsewhere.factory("a"),
      createBroadcastChannel: null,
    });
    const b = tab("b");
    tabs.push(a);
    const invite = await run(a.createInvite());
    const reply = await run(b.answerInvite(invite.url));

    const started = Date.now();
    expect(await run(deliverReplyToOtherTab(reply.url, 1500, { createBroadcastChannel: hub.factory }))).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(await run(deliverReplyToOtherTab("hello", 1500, { createBroadcastChannel: hub.factory }))).toBe(false);
    expect(await run(deliverReplyToOtherTab(invite.url, 1500, { createBroadcastChannel: hub.factory }))).toBe(false);
    expect(await run(deliverReplyToOtherTab(reply.url, 1500, { createBroadcastChannel: null }))).toBe(false);
  });
});
