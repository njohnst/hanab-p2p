# Serverless, peer-to-peer Hanab

This fork of [bstnfrmry/hanabi](https://github.com/bstnfrmry/hanabi) (hanab.cards) removes every
server: no Firebase, no Next.js server, no API routes. The app is a static site (GitHub Pages or any
static host) and players' browsers talk to each other directly over WebRTC data channels.

## Goals

1. **No deployment beyond static files.** `next build` with `output: "export"` produces `out/`, which
   can be served from any path (GitHub Pages project sites live under `/<repo>/`).
2. **WebRTC game sync.** Signaling uses free public infrastructure through
   [Trystero](https://github.com/dmotz/trystero) (`trystero` = Nostr relays). NAT traversal uses public
   STUN; an optional TURN server can be configured at build time.
3. **QR codes and share links** to invite players: the lobby shows a QR code for the game link.
4. **Feature parity with upstream**: lobby, bots, variants, pass & play, tutorial, chat, reactions,
   rollback, replay, summary, stats, i18n.

## Routing (static export)

Dynamic routes cannot be pre-rendered for unknown ids, so game pages move to query strings:

| Upstream                | Static export               |
|-------------------------|-----------------------------|
| `/<gameId>`             | `/play/?gameId=<gameId>`    |
| `/<gameId>/summary`     | `/summary/?gameId=<gameId>` |
| `/reset-session` (SSR)  | client-side `resetPlayerId()` |

- Build all game/summary URLs through one helper module (`src/lib/routes.ts`); never hand-write them.
- `basePath` comes from `NEXT_PUBLIC_BASE_PATH` at build time (empty by default). Absolute asset URLs
  (`/static/...`, manifest, notification icons, CSS `url()`) must honour it.
- `trailingSlash: true`; `images.unoptimized: true`; `public/.nojekyll` so GitHub Pages serves `_next/`.
- The exported `404.html` redirects legacy `/<GameId>` URLs to `/play/?gameId=<GameId>`.
- Next's built-in i18n routing is incompatible with export; language comes from i18next's browser
  detector plus the language selector (persisted in localStorage).

## Identity

`src/lib/playerId.ts` replaces the iron-session cookie: a stable id per browser in localStorage.
`?as=<label>` on any URL gives a tab its own identity (sessionStorage), which is how several seats
are played from one browser during testing.

## Network layer: `src/lib/network`

`src/lib/network/index.ts` is the API contract the UI uses. Its exported signatures and documented
behaviour are fixed; implementations change behind it.

### Model: replicated document + one authority

- A game is the same document Firebase stored: `cleanState(game)` (options, players, turnsHistory,
  messages, reviewComments, status, timestamps, nextGameId). Derived data (hands, piles) is rebuilt
  deterministically with `rebuildGame` (the deck comes from `options.seed`).
- **Every peer keeps a full replica**, persisted in localStorage (`hanab.game.<id>`), so the game
  survives any peer leaving or refreshing, including its creator, and can be resumed later.
- Each game is a Trystero room: `appId` is fixed for the app, `roomId` = game id, and
  `password` = game id (encrypts SDP on the public relays). Pass & play and tutorial games never join
  a room (`status: "local"`).
- At any time **one peer is the authority**. It orders writes by stamping a monotonically increasing
  `version`, runs the bots' turns, broadcasts the resulting state, and answers newcomers. Every other
  peer sends its writes to the authority as proposals.
- Replicas adopt any received state with a higher `version`. `(version, authorKey)` totally orders
  states, so a temporary split brain converges.

### Authority election

- Each tab has an `authorKey`, unique per tab and stable for its lifetime.
- The authority is sticky: while connected, it stays the authority. When it leaves, the remaining
  peers deterministically pick a new one among the peers that hold state (smallest key).
- A peer that (re)joins first syncs (adopts the highest version it hears) before it can act as the
  authority. When two authorities meet, the one holding the higher `(version, authorKey)` wins, and
  the other re-proposes its unacknowledged local writes.
- Bots run only on the authority, so a bot never plays the same turn twice.

### Writes: proposals and 3-way merge

`updateGame(newGame)` sends `{ baseVersion, base, proposed }`, where `base` is the replica the writer
last saw. The authority merges `proposed` into its current state with `mergeGame(base, current,
proposed)`, a pure, unit-tested function:

| Field | Merge rule |
|-------|-----------|
| `turnsHistory` | If unchanged from base: keep current. If current is still equal to base: take proposed (action or rollback). If both changed: equal → no-op (e.g. a duplicate bot turn), else **reject** the proposal (the turn already moved). |
| `players` | Union by `id`, keeping current order and appending new joiners in arrival order (join order deals the hands); field changes (name, reaction, notified, bot) applied where proposed differs from base. Joins beyond `playersCount` or after the lobby are rejected. |
| `messages` | Union by `id`, current order first. |
| `reviewComments` | Union keyed by (`playerId`, `afterTurnNumber`), proposed wins for its changed keys; rollbacks may drop comments after the rollback turn. |
| `status`, `options`, `startedAt`, `endedAt`, `nextGameId` | Take proposed where it differs from base, else current. |

A rejected writer receives `reject` plus the current state; the UI may tell the player that the turn
already moved on. Writes made while alone apply locally (the tab is the authority of its own replica)
and reconcile through versions when peers return.

### Wire protocol (JSON over Trystero actions)

Every message carries `protocol` (an integer). Peers with a different `protocol` are ignored and
reported through `ConnectionInfo.error` ("someone is running a different version — reload").
Suggested messages: `hello` (authorKey, playerId, version, isAuthority), `state` (version, authorKey,
game), `propose` (proposalId, baseVersion, base, proposed), `reject` (proposalId, reason),
`bye` (the sender is leaving the room: drop it now), `public-game` (lobby summary). States are a few
KB, and Trystero chunks larger payloads.

### Public rooms

Public network games in their lobby are listed on "Join a room" through a shared Trystero room
(`roomId` = `public-lobby`) where each such game's authority periodically announces a `PublicGame`
summary. Entries expire after about 30 seconds without an announcement. Private games are never
announced.

### Connection robustness

- On `pagehide`, send `bye` and leave every room, so peers drop the tab and hand the authority over
  at once instead of after WebRTC's ~25s timeout. `beforeunload` is not used: it also fires for
  navigations that never happen (cancelled, `mailto:` links) and keeps Firefox from caching the page.
- On `pageshow` from the back/forward cache, `visibilitychange` back to visible, or `online`, re-join
  (as a follower that syncs first) or re-announce if no peers are connected (mobile browsers drop
  WebRTC when backgrounded).
- STUN: Trystero defaults plus `stun:stun.l.google.com:19302`. TURN from `NEXT_PUBLIC_TURN_URLS`,
  `NEXT_PUBLIC_TURN_USERNAME` and `NEXT_PUBLIC_TURN_CREDENTIAL` when set.
- Keep at most about 50 replicas in localStorage, evicting the least recently updated.

### Testing

- Transports implement one small interface: Trystero (production), BroadcastChannel (`?net=local`,
  same-browser tabs, no internet needed), and in-memory (unit tests, including injectable delays,
  drops and partitions).
- Vitest covers `mergeGame`, election, convergence (concurrent joins, chat, duplicate bot moves,
  rejected conflicting turns, authority leaving mid-game, stale peer rejoining, split brain healing),
  persistence and protocol mismatch.

## Nearby play (no internet)

Players on the same local network (home Wi-Fi, a phone's hotspot, an office intranet that blocks the
internet) can play with **no server of any kind**: no signaling relay, no STUN. The WebRTC offer and
answer are exchanged as QR codes, one in each direction.

### Mode

- A tab is in one network mode for its lifetime, chosen when its network node is created:
  `webrtc` (Trystero, default), `local` (`?net=local`) or **`nearby`**: `?net=nearby`, or any page
  under `/nearby/`. The choice is kept in sessionStorage like `local`; `?net=webrtc` switches back.
  Switching mode is a full page load (the node is a per-tab singleton).
- Nearby mode uses only the nearby transport (no Trystero). `isOnline` is always true there: the
  browser's online flag says nothing about the LAN.
- Games joined in nearby mode are remembered in localStorage (`hanab.nearbyGames`, at most 50), so
  the UI can offer to switch mode when one is opened from an online tab.
- Inside nearby mode every in-app navigation must be client-side (Next router): a full page load
  closes the WebRTC connections, and getting them back takes a new QR exchange.

### Handshake (two QR codes)

1. The **inviter** (any connected player) calls `createInvite()`: a new RTCPeerConnection with
   `iceServers: []` and an ordered data channel, `createOffer`, then waits for ICE gathering to
   complete (at most ~3s). Its compact description becomes the **invite URL**
   `<origin><basePath>/nearby/#o=<code>`, shown as a QR code.
2. The **guest** scans it, with the phone's own camera app (the URL opens the app) or the in-app
   scanner, and calls `answerInvite(text)`: `setRemoteDescription(offer)`, `createAnswer`, gather,
   and shows the **reply URL** `<origin><basePath>/nearby/#a=<code>` as a QR code.
3. The inviter scans the reply (`invite.acceptReply(text)`): `setRemoteDescription(answer)`. The data
   channel opens; both sides exchange `hi` (the inviter's carries the game id, so the guest's page can
   open the game).

The fragment never reaches a server. A reply URL opened by the inviter's camera app lands in a new tab
of the same browser, which hands it to the inviting tab over BroadcastChannel (`hanab-nearby`) and
says so.

### Compact codes

Only what the remote side needs travels: ICE ufrag and pwd, the DTLS fingerprint, the DTLS role
(`setup`), the `mid`, host candidates (protocol, address, port) and a 4-byte invite token that the
reply echoes (an inviter keeps several invites pending and matches replies by token). The other side
rebuilds a standard SDP from it (`m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `sctp-port:5000`,
`max-message-size:262144`, `end-of-candidates`). Binary, versioned (first byte), base64url: about 90
bytes, so ~120 characters and a QR code of version 8-10 with error correction M. Addresses are encoded
by kind: IPv4 (4 bytes), IPv6 (16), mDNS `<uuid>.local` (16), other hostnames (length-prefixed);
at most 8 candidates, host candidates only.

Browsers hide host addresses behind mDNS names (`<uuid>.local`) unless the page has camera or
microphone permission. Networks that block multicast cannot resolve them, so the UI starts the camera
(needed anyway to scan the reply) **before** creating an invite: the invite then carries real
addresses, and one side with real addresses is enough (the other side is discovered as a
peer-reflexive candidate).

### Links and the mesh

- A **link** is one RTCPeerConnection + data channel to another tab, identified by a random per-tab
  `selfId`. Links carry a small JSON protocol: `hi` (id, rooms, open links, game id, player id,
  protocol), `rooms`, `peers`, `m` (a room message), `sig` (relayed signaling), `ping`/`pong`, `bye`,
  and `part` (messages over 16 KB are split).
- **Mesh**: QR codes only bootstrap the first link. Each tab announces its open links (`peers`); when
  a tab learns of a peer it has no link with, the one with the smaller `selfId` sends it an offer
  relayed by the common neighbour (`sig`, trickle ICE), so every pair ends up directly connected
  without more QR codes. A relay only forwards between two of its own open links (one hop). Mesh
  attempts that fail are retried when the peer list next changes.
- A link is dropped when its data channel closes, its connection fails, or nothing was heard for 30s
  (heartbeat every 5s; a throttled background timer does not expire anyone). `pagehide` closes every
  link with `bye`.
- **Rooms over links**: the nearby transport implements `Transport` (`kind: "nearby"`). Joining a
  room adds it to the tab's room list sent to every link; a room's peers are the open links that
  listed it. Room passwords are not used: links are authenticated by the DTLS fingerprint that came
  through the QR code, from someone physically present.

### Getting the app without internet

- **Offline cache**: the build writes `sw.js`, a service worker that precaches the whole export
  (except source maps), versioned by a content hash. Pages and assets come from the cache first, so a
  device that opened the site once can open it again with no internet, including from the camera app.
  A new version installs in the background, activates at once (`skipWaiting`, `clients.claim`) and is
  used from the next page load; the previous cache is kept so an already open page can still load its
  lazy chunks. It only registers in production builds on secure pages.
- **Self-hosted on the LAN**: `yarn serve:static` listens on every interface and prints the LAN
  URLs. Pages opened at `http://<lan-ip>` are not secure contexts: no in-app camera (scan with the
  camera app or a photo instead), no service worker, but nearby play works. On `localhost` the page
  asks the server for its LAN origins (`<basePath>/nearby-origins.json`) so that invite URLs open on
  other devices. `TLS_CERT`/`TLS_KEY` serve https (e.g. with certificates from mkcert).

### Limits

- Reloading a page, or a phone killing a background tab, ends that tab's links: any connected player
  invites it again (☰ → Invite players). The game itself is safe in every replica.
- Links are direct only: two tabs that cannot reach each other (client isolation on some guest Wi-Fi)
  do not see each other, even if both reach a third.

## UI additions

- Lobby: share panel with the link, a QR code (`qrcode` package, rendered as SVG), copy, and Web Share
  on supported devices.
- In-game menu: "Invite / show QR" for latecomers and spectators.
- Connection indicator: status, connected peers, authority marker, a "waiting for players to
  connect" screen when the game is unknown locally, and the version-mismatch error.
- Join page: join by room name or link, plus the live public-room list.
- Home: "Resume" list from local replicas.

## Removed

Firebase, Sentry, Google Analytics, FullStory, next-iron-session, next-offline (the service worker was
already empty), `now.json`, and the Firebase config files. `logEvent` and friends become no-ops so
call sites stay untouched.

## Trust model

As with upstream (where every client could read the whole Firebase document), every peer holds the
full game, including its own hand, and the UI simply doesn't show it. Hanab is cooperative and played
with friends; peeking is possible via devtools, exactly as before.
