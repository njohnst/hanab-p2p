/**
 * Nearby transport (`kind: "nearby"`, docs/P2P_DESIGN.md, "Rooms over
 * links"): game rooms over this tab's nearby links (./links.ts).
 *
 * Joining a room adds it to the room list this tab sends to every linked
 * tab; a room's peers are the linked tabs whose list has it. Room messages
 * travel on the links (`m`). Room passwords are not used: links are
 * authenticated by the DTLS fingerprint that came through a QR code, from
 * someone physically present.
 *
 * Like the Trystero transport, handlers only run once join() resolved: the
 * room's current members are then reported as joining. Every room joined
 * here except the public lobby is remembered as a nearby game (./games.ts).
 */
import { PUBLIC_LOBBY_ROOM } from "../publicLobby";
import { KeyValueStorage } from "../storage";
import { JoinOptions, Transport, TransportHandlers, TransportRoom, transportUnavailable } from "../transports/types";
import { rememberNearbyGame } from "./games";
import { isRoom, LinkManager } from "./links";

export interface NearbyTransportOptions {
  /** Where nearby games are remembered (localStorage in browsers). */
  storage?: () => KeyValueStorage | null;
}

interface Membership {
  roomId: string;
  handlers: TransportHandlers;
  members: Set<string>;
  ready: boolean;
  left: boolean;
  queued: Array<() => void>;
}

export function createNearbyTransport(links: LinkManager, options: NearbyTransportOptions = {}): Transport {
  /** Live memberships per room (a room is left, then joined again, by a re-join). */
  const rooms = new Map<string, Set<Membership>>();

  const dispatch = (membership: Membership, event: () => void) => {
    if (membership.left) return;
    if (!membership.ready) {
      membership.queued.push(event);
      return;
    }
    try {
      event();
    } catch (e) {
      console.warn("[network] error in a room handler", e);
    }
  };

  /** Report who came and went since the membership's last look. */
  const refresh = (membership: Membership) => {
    if (membership.left) return;
    const now = new Set(links.roomPeers(membership.roomId));
    membership.members.forEach((peerId) => {
      if (!now.has(peerId)) {
        membership.members.delete(peerId);
        dispatch(membership, () => membership.handlers.onPeerLeave(peerId));
      }
    });
    now.forEach((peerId) => {
      if (!membership.members.has(peerId)) {
        membership.members.add(peerId);
        dispatch(membership, () => membership.handlers.onPeerJoin(peerId));
      }
    });
  };

  const announce = () => links.setRooms(Array.from(rooms.keys()));

  links.watchRooms({
    changed: () => rooms.forEach((memberships) => memberships.forEach(refresh)),
    message: (peerId, roomId, data) => {
      rooms.get(roomId)?.forEach((membership) => {
        if (membership.members.has(peerId)) {
          dispatch(membership, () => membership.handlers.onMessage(data, peerId));
        }
      });
    },
  });

  return {
    kind: "nearby",
    async join(roomId: string, _options: JoinOptions, handlers: TransportHandlers): Promise<TransportRoom> {
      if (!links.supported) {
        throw transportUnavailable("This browser cannot play with nearby devices (no WebRTC support).");
      }
      if (!isRoom(roomId)) {
        throw transportUnavailable("This game's name is too long to play with nearby devices.");
      }
      const membership: Membership = { roomId, handlers, members: new Set(), ready: false, left: false, queued: [] };
      const memberships = rooms.get(roomId) ?? new Set<Membership>();
      const first = memberships.size === 0;
      memberships.add(membership);
      rooms.set(roomId, memberships);
      if (first) announce();
      refresh(membership);

      if (roomId !== PUBLIC_LOBBY_ROOM) {
        try {
          rememberNearbyGame(options.storage?.() ?? null, roomId);
        } catch (e) {
          console.warn("[network] could not remember a nearby game", e);
        }
      }

      // Handlers only run once the caller has the room (see Transport.join).
      setTimeout(() => {
        membership.ready = true;
        membership.queued.splice(0).forEach((event) => dispatch(membership, event));
      }, 0);

      return {
        selfId: links.selfId,
        send(data: unknown, target?: string) {
          if (membership.left) return;
          try {
            if (target) {
              if (membership.members.has(target)) links.sendRoom(target, roomId, data);
            } else {
              membership.members.forEach((peerId) => links.sendRoom(peerId, roomId, data));
            }
          } catch (e) {
            console.warn("[network] could not send to nearby peers", e);
          }
        },
        getPeers: () => (membership.left ? [] : Array.from(membership.members)),
        async leave() {
          if (membership.left) return;
          membership.left = true;
          membership.queued = [];
          membership.members.clear();
          const current = rooms.get(roomId);
          current?.delete(membership);
          if (current && !current.size) {
            rooms.delete(roomId);
            announce();
          }
        },
      };
    },
  };
}
