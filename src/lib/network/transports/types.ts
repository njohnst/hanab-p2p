/**
 * The one small interface every transport implements: Trystero/WebRTC in
 * production, BroadcastChannel between tabs of one browser (`?net=local`),
 * nearby links with no internet (`?net=nearby`, ../nearby/transport.ts), and
 * an in-memory network for tests.
 *
 * A transport only moves JSON-serialisable messages between the peers of a
 * room and reports who is connected; ordering, authority and merging live in
 * the sync engine. Messages between two peers arrive in the order they were
 * sent (WebRTC data channels are ordered), but may be lost when a peer drops.
 */

export interface TransportHandlers {
  onMessage(data: unknown, peerId: string): void;
  onPeerJoin(peerId: string): void;
  onPeerLeave(peerId: string): void;
  /** A non-fatal problem joining (e.g. a peer could not be reached). */
  onError?(error: string): void;
}

export interface TransportRoom {
  /** This tab's peer id in the room. */
  readonly selfId: string;
  /** Send to one peer, or to every peer of the room when `target` is omitted. Never throws. */
  send(data: unknown, target?: string): void;
  /** Peers currently connected. */
  getPeers(): string[];
  /** Leave the room; no handler is called afterwards. */
  leave(): Promise<void>;
}

export interface JoinOptions {
  /** Shared secret of the room (encrypts the signaling for WebRTC). */
  password: string;
}

export interface Transport {
  readonly kind: "webrtc" | "local" | "nearby" | "memory";
  /**
   * Join a room. Handlers may be called as soon as the returned promise
   * resolves. Rejects when the room cannot be joined at all.
   */
  join(roomId: string, options: JoinOptions, handlers: TransportHandlers): Promise<TransportRoom>;
}

/**
 * A transport that cannot work in this browser or page (no WebRTC, no secure
 * context...). Its message is shown to the player; joining is not retried.
 */
export function transportUnavailable(message: string): Error {
  const error = new Error(message);
  error.name = "TransportUnavailable";
  return error;
}

export function isTransportUnavailable(error: unknown): error is Error {
  return error instanceof Error && error.name === "TransportUnavailable";
}
