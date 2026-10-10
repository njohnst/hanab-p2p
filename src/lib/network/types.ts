import IGameState from "~/lib/state";

/**
 * local      - pass & play / tutorial game: never touches the network.
 * connecting - joining the signaling relays, no peer seen yet.
 * alone      - signaling works but no other peer is in the room right now.
 * connected  - at least one peer connected over WebRTC.
 * offline    - the browser is offline or every signaling relay failed.
 */
export type ConnectionStatus = "local" | "connecting" | "alone" | "connected" | "offline";

export interface PeerInfo {
  /** Transport-level peer id (changes on every page load). */
  peerId: string;
  /** Player id announced by the peer (see ~/lib/playerId); null until its hello arrives. */
  playerId: string | null;
}

export interface ConnectionInfo {
  gameId: string;
  status: ConnectionStatus;
  /** Peers currently connected to this tab for this game. */
  peers: PeerInfo[];
  /**
   * This tab currently orders updates for the game (and therefore must run the
   * bots' turns). Always true for local games and when alone with a replica.
   */
  isAuthority: boolean;
  /** A replica of the game exists in this tab (local copy or received from a peer). */
  hasState: boolean;
  /** Human-readable problem worth surfacing (e.g. a peer runs an incompatible app version). */
  error: string | null;
}

/** Lobby-stage public game, as listed on the "Join a room" page. */
export interface PublicGame {
  id: string;
  playersNames: string[];
  playersCount: number;
  variant: string;
  createdAt: number;
}

/** A game this browser holds a replica of (for "resume" lists). */
export interface RecentGame {
  id: string;
  status: IGameState["status"];
  playersNames: string[];
  updatedAt: number;
}

/**
 * Why the authority refused a write (see mergeGame):
 *
 * turn-conflict - the turn already moved on (someone else played first, or a rollback happened).
 * game-full     - the player tried to join a game whose seats are all taken.
 * game-started  - the player tried to join after the lobby.
 * wrong-game    - the write was for another game.
 * invalid       - the resulting game could not be rebuilt (corrupted or hostile write).
 */
export type RejectionReason = "turn-conflict" | "game-full" | "game-started" | "wrong-game" | "invalid";

/** A write of this tab that the authority refused. The authoritative state has already been delivered. */
export interface Rejection {
  gameId: string;
  proposalId: string;
  reason: RejectionReason;
}
