/**
 * Nearby play end to end: NetworkNode instances (the real sync engine) over
 * the nearby transport, on fake WebRTC. Only the QR codes are skipped: the
 * URLs go straight from one tab to the other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinGame, sendMessage } from "~/lib/actions";
import { IGameStatus } from "~/lib/state";
import { documentOf } from "../document";
import { createMemoryStorage } from "../storage";
import { createPeer, lobbyGame, move, replicaOf, TestPeer } from "../testing";
import { isRememberedNearbyGame } from "./games";
import { LinkManager } from "./links";
import { FakeLan } from "./testing";
import { createNearbyTransport } from "./transport";

const G = "NearbyGame";

let lan: FakeLan;
let peers: Array<TestPeer & { links: LinkManager }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  lan = new FakeLan();
  peers = [];
});

afterEach(() => {
  peers.forEach((p) => {
    p.node.dispose();
    p.links.dispose();
  });
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A browser tab in nearby mode. */
function nearbyPeer(name: string) {
  const links = new LinkManager({
    selfId: name,
    createPeerConnection: lan.factory(name),
    createBroadcastChannel: null,
    getPlayerId: () => name,
    origin: () => "https://hanab.test",
  });
  const storage = createMemoryStorage();
  const peer = Object.assign(
    createPeer(null, name, { storage, transport: createNearbyTransport(links, { storage: () => storage }) }),
    { links }
  );
  peers.push(peer);
  return peer;
}

async function settle(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}

async function run<T>(promise: Promise<T>): Promise<T> {
  await settle(200);
  return promise;
}

/** The QR handshake, URLs passed by hand. */
async function invite(inviter: LinkManager, guest: LinkManager, gameId: string) {
  const sent = await run(inviter.createInvite({ gameId }));
  const reply = await run(guest.answerInvite(sent.url));
  await run(sent.acceptReply(reply.url));
  await run(sent.connected);
  return run(reply.connected);
}

function peerIds(p: TestPeer) {
  return p.connections
    .get(G)
    .peers.map((info) => info.peerId)
    .sort();
}

function authorities(group: TestPeer[]) {
  return group.filter((p) => p.node.isAuthority(G)).map((p) => p.name);
}

function expectConverged(group: TestPeer[]) {
  const reference = replicaOf(group[0], G);
  expect(reference).not.toBeNull();
  group.forEach((p) => {
    const replica = replicaOf(p, G);
    expect([p.name, replica.version, replica.author]).toEqual([p.name, reference.version, reference.author]);
    expect(replica.game).toEqual(reference.game);
    expect(documentOf(p.game(G))).toEqual(reference.game);
  });
}

function seat(p: TestPeer) {
  return p.node.updateGame(joinGame(p.game(G), { id: p.name, name: p.name.toUpperCase(), bot: false }));
}

describe("nearby play", () => {
  it("syncs a game over QR-bootstrapped links and a mesh, and survives its authority leaving", async () => {
    const [a, b, c] = ["a", "b", "c"].map(nearbyPeer);

    // A creates the game, alone.
    await a.node.updateGame(lobbyGame({ id: G, playersCount: 3 }));
    a.follow(G);
    await settle(500);
    expect(a.connections.get(G)).toMatchObject({ status: "alone", isAuthority: true });

    // A invites B to it; B opens the game the invite named.
    const joinedB = await invite(a.links, b.links, G);
    expect(joinedB).toEqual({ peerId: "a", gameId: G });
    b.follow(joinedB.gameId);
    await settle(1000);
    expect(b.game(G)).not.toBeNull();
    expect(peerIds(b)).toEqual(["a"]);

    // B invites C; C gets linked with A through B, with no more QR codes.
    const joinedC = await invite(b.links, c.links, G);
    c.follow(joinedC.gameId);
    await settle(2000);
    expect(a.links.links()).toEqual([
      { peerId: "b", playerId: "b", state: "open", via: "invite" },
      { peerId: "c", playerId: "c", state: "open", via: "mesh" },
    ]);
    expect(peerIds(a)).toEqual(["b", "c"]);
    expect(peerIds(c)).toEqual(["a", "b"]);
    expect(authorities([a, b, c])).toEqual(["a"]);
    expectConverged([a, b, c]);

    // Everyone takes a seat: B's and C's writes go to A, which applies them.
    await seat(a);
    await settle(200);
    await seat(b);
    await settle(200);
    await seat(c);
    await settle(500);
    expect(a.game(G).players.map((player) => player.id)).toEqual(["a", "b", "c"]);
    expectConverged([a, b, c]);

    await a.node.updateGame({ ...a.game(G), status: IGameStatus.ONGOING, startedAt: Date.now() });
    await settle(200);
    await b.node.updateGame(move(b.game(G)));
    await settle(500);
    expect(a.game(G).turnsHistory).toHaveLength(1);
    expectConverged([a, b, c]);

    // A leaves the page: B and C notice at once and carry on with a new authority.
    a.node.depart();
    a.links.depart();
    await settle(100);
    expect(peerIds(b)).toEqual(["c"]);
    expect(peerIds(c)).toEqual(["b"]);
    await settle(1000);
    expect(authorities([b, c])).toEqual(["b"]);

    await c.node.updateGame(move(c.game(G)));
    await settle(500);
    const game = c.game(G);
    await c.node.updateGame(
      sendMessage(game, { id: "after", content: "still here", from: 2, turn: game.turnsHistory.length })
    );
    await settle(500);
    expect(b.game(G).turnsHistory).toHaveLength(2);
    expect(b.game(G).messages.map((message) => message.id)).toEqual(["after"]);
    expectConverged([b, c]);

    // Every tab remembers the game as a nearby one.
    [a, b, c].forEach((p) => expect(isRememberedNearbyGame(p.storage, G)).toBe(true));
  });
});
