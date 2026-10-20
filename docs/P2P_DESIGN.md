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
5. **Nearby play without internet**: devices on one local network play with no server at all, the
   WebRTC handshake travelling as two QR codes; the app works offline after one visit and can be
   served from a computer on the LAN (see [Nearby play](#nearby-play-no-internet)).

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
  at once instead of after WebRTC's ~25s timeout. The network layer does not use `beforeunload`: it
  also fires for navigations that never happen (cancelled, `mailto:` links) and keeps Firefox from
  caching the page. (The play page registers one in nearby mode, only while links are open, to warn
  before a reload: see [Limits](#limits).)
- On `pageshow` from the back/forward cache, `visibilitychange` back to visible, or `online`, re-join
  (as a follower that syncs first) or re-announce if no peers are connected (mobile browsers drop
  WebRTC when backgrounded).
- STUN: Trystero defaults plus `stun:stun.l.google.com:19302`. TURN from `NEXT_PUBLIC_TURN_URLS`,
  `NEXT_PUBLIC_TURN_USERNAME` and `NEXT_PUBLIC_TURN_CREDENTIAL` when set.
- Keep at most about 50 replicas in localStorage, evicting the least recently updated.

### Testing

- Transports implement one small interface: Trystero (production), BroadcastChannel (`?net=local`,
  same-browser tabs, no internet needed), nearby links (`?net=nearby`, see below), and in-memory
  (unit tests, including injectable delays, drops and partitions).
- Vitest covers `mergeGame`, election, convergence (concurrent joins, chat, duplicate bot moves,
  rejected conflicting turns, authority leaving mid-game, stale peer rejoining, split brain healing),
  persistence and protocol mismatch.
- Nearby play, in Node with a simulated WebRTC (`nearby/testing.ts`: two fake connections connect
  only when each one's remote description carries the other's ICE credentials and fingerprint, and
  a pair can be made unreachable, stalled or silent):
  - codes: SDP captured from Chrome (offer and answer), Firefox- and Safari-like SDP written by hand,
    size, the rebuilt SDP, address encoding, damaged codes and other versions, `parseNearbyText`;
  - links: the handshake, the gathering cap, several pending invites, wrong kinds and own codes,
    expiry and the connect timeout, cancel, no WebRTC, a 4-tab mesh with relaying rules and retry
    backoff, replaced links, silence, throttled timers, `bye`, split messages, the reply hand-off;
  - the nearby transport, and a scenario with real nodes: A invites B, B invites C, A and C link
    through the mesh, the game syncs, A leaves and B takes over as the authority;
  - mode selection, and the `pagehide` order (rooms, then links).
- Offline cache and LAN hosting: the generated `sw.js` runs against stand-ins for fetch, Cache
  Storage and the clients (install, hash mismatch, missing file, resumed install, cache cleanup,
  routing, Range); the order of the LAN origins (`scripts/*.test.mjs`); registration and `?sw=off`
  (`serviceWorker.test.ts`); invite origins on localhost (`nearbyOrigin.test.ts`).
- UI helpers: invite origins, failure messages, player names, QR geometry and camera problems; the
  English and French `nearby` translations have the same keys and interpolations.
- Left to manual testing: the camera, real WebRTC between browsers and devices, the wake lock, the
  leave warning. Two tabs of one browser can play nearby with the paste fields; then phones on one
  Wi-Fi.

## Nearby play (no internet)

Players on the same local network (home Wi-Fi, a phone's hotspot, an office intranet that blocks the
internet) can play with **no server of any kind**: no signaling relay, no STUN. The WebRTC offer and
answer of the first connection are exchanged as QR codes, one in each direction; the tabs then
connect to each other on their own.

| `src/lib/network/`          | Role |
|-----------------------------|------|
| `nearby/types.ts`           | Public types: `NearbyApi`, `NearbyInvite`, `NearbyReply`, `NearbyLink`, `NearbyError` and its reasons |
| `nearby/codec.ts`           | Compact codes, SDP parsing and rebuilding, invite and reply URLs, `parseNearbyText` |
| `nearby/links.ts`           | `LinkManager`: the QR handshake, links, the mesh, liveness, the reply hand-off between tabs |
| `nearby/transport.ts`       | The `nearby` transport: game rooms over the links |
| `nearby/games.ts`           | Games joined in nearby mode |
| `nearby/testing.ts`         | Simulated WebRTC and BroadcastChannel for the tests |
| `browser.ts`, `lifecycle.ts` | Mode selection, wiring, `pagehide` |

`index.ts` adds `getNetworkMode()`, `getNearby()` (this tab's `NearbyApi`: `createInvite`,
`answerInvite`, `acceptReply`, `links`, `subscribe`; null outside nearby mode), `parseNearbyText`,
`deliverReplyToOtherTab`, `isNearbyGame`, and `NearbyError`/`isNearbyError`.

### Mode

- A tab's network mode is decided the first time `~/lib/network` is used after a page load
  (`getNetworkMode()`, or anything that creates the node) and kept in sessionStorage (`hanab.net`),
  so reloads keep it:
  - `webrtc`: Trystero, the default;
  - `local`: `?net=local`;
  - **`nearby`**: `?net=nearby`, or any page under `/nearby/` (after the base path).

  An explicit `?net=` wins over the path, and `?net=webrtc` clears the stored mode. Switching mode
  takes a full page load (the node is a per-tab singleton): `/nearby/` reached client-side from
  another mode reloads itself with `?net=nearby`, and "Play online instead" loads `/?net=webrtc`.
- Nearby mode uses only the nearby transport (no Trystero, no public relays). `isOnline` is always
  true there: the browser's online flag says nothing about the LAN.
- The sync engine runs with shorter timings than online: sync window 2s, election timeout 2.5s,
  retry 2s (online: 4s, 4s, 3s). Links are open before any room is joined, so a room's members are
  known one LAN round trip later; the margin is for phones on Wi-Fi, whose power saving can delay
  packets by a few hundred ms.
- Every room joined in nearby mode except the public lobby is remembered in localStorage
  (`hanab.nearbyGames`, most recent first, at most 50). `isNearbyGame()` reads it from any tab, so a
  tab in another mode can offer to switch when it opens one of those games.
- Inside nearby mode every in-app navigation must be client-side (Next router): a full page load
  closes the WebRTC connections, and getting them back takes a new QR exchange.

### Handshake (two QR codes)

1. The **inviter** (any player of the game) calls `createInvite({ gameId, origin })`: a new
   RTCPeerConnection with `iceServers: []` and an ordered data channel (`hanab`), `createOffer`, then
   waits for ICE gathering to complete (at most 3s; then what was gathered is used). Its compact
   description becomes the **invite URL** `<origin><basePath>/nearby/#o=<code>`, shown as a QR code.
   An invite lasts 10 minutes, and a tab can hold several: each has a random token that its reply
   echoes.
2. The **guest** scans it, with the phone's own camera app (the URL opens the app, which answers it)
   or the in-app scanner, and calls `answerInvite(text)`: `setRemoteDescription` (the rebuilt offer),
   `createAnswer`, gather, and shows the **reply URL** `<origin><basePath>/nearby/#a=<code>` as a QR
   code. The reply takes the invitation's origin when the invitation was a URL (see below).
3. The inviter scans the reply: `acceptReply(text)` finds the pending invite by its token and calls
   `setRemoteDescription`. The link must then open within 20s. Once the data channel is open, both
   sides send `hi`; the inviter's carries the game id, and the guest's page opens that game with the
   router.

- The guest cannot tell a failing connection from an inviter who has not scanned the reply yet, so
  before its link opens an ICE "failed" is ignored: the reply is only given up when it is cancelled
  (the UI offers Cancel), closed or expired (10 minutes).
- `parseNearbyText` finds the code in what was scanned or pasted: invite and reply URLs from any
  origin or base path, bare `o=…`/`a=…`, bare codes (the kind is read from the code), in quotes,
  brackets, chat formatting (a trailing `_` from italics is tried with and without) or a whole
  message, with invisible characters removed.
- Every failure is a `NearbyError` whose `reason` the UI turns into a message: `malformed`,
  `not-an-invite`, `not-a-reply`, `unknown-invite` (another invite's reply, or an invite already
  used), `own-invite` (the tab's own code, recognised by its ICE credentials), `unsupported-version`,
  `no-webrtc`, `timeout`, `failed` or `cancelled`.

The fragment never reaches a server, and the `/nearby/` page removes it from the address once read,
so a reload does not reuse a code. A reply URL opened by the inviter's camera app lands in a new tab
of the same browser, on the inviting tab's origin since the reply took the invitation's. That tab
applies the reply if it holds the invite itself, else hands it over BroadcastChannel
(`hanab-nearby`) to the tab that does (waiting 3s for an acknowledgement), says so and tries to close
itself. When no tab answers (another browser, a closed tab), it explains and offers to copy the reply
link, to paste on the invitation screen.

### Compact codes

Only what the remote side needs travels: ICE ufrag and pwd, the DTLS fingerprint (SHA-256, -384 or
-512), the DTLS role (`setup`), the `mid`, host candidates (protocol, address, port) and the 4-byte
invite token that the reply echoes. The other side rebuilds a standard SDP from it
(`m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `sctp-port:5000`, `max-message-size:262144`,
`end-of-candidates`), in the format checked against Chrome. The code is binary, starts with a
format version (1), and is written in base64url without padding; `nearby/codec.ts` documents the
layout.

- ICE ufrag and pwd take 6 bits per character (with an ASCII fallback).
- Addresses are encoded by kind: IPv4 (4 bytes), IPv6 (16), mDNS `<uuid>.local` (16), other host
  names (length-prefixed).
- Host candidates only, at most 8: active TCP candidates and duplicates are dropped; IPv4 and mDNS
  come first, then global IPv6 and host names, then link-local and loopback, UDP before TCP.

A Chrome invite with one mDNS candidate is 83 bytes (111 characters): with the URL around it, a QR
code of version 8-10 at error correction M. Decoding tolerates padding, whitespace and the standard
base64 alphabet, and is otherwise strict (unused bits must be zero, no trailing data). A code that
decodes to fewer than 48 bytes is `malformed` whatever its first byte, so a truncated code is not
reported as another version; any version other than 1 is `unsupported-version`.

Browsers hide host addresses behind mDNS names (`<uuid>.local`) unless the page has camera or
microphone permission. Networks that block multicast cannot resolve them, so the UI starts the camera
(needed anyway to scan the reply) **before** creating an invite: the invite then carries real
addresses, and one side with real addresses is enough (the other side is discovered as a
peer-reflexive candidate).

### Links and the mesh

- A **link** is one RTCPeerConnection + data channel (`hanab`) to another tab, identified by a
  random per-tab `selfId`, which is also the tab's peer id in game rooms. A link is open once its
  channel is open and the other tab's `hi` has arrived. Links carry one JSON text per message:
  - `hi`: link protocol version, id, rooms, open links, game id, player id, sequence number;
  - `rooms` and `peers`: the tab's room list and the tabs it has open links with;
  - `m`: a room message; `sig`: mesh signaling, relayed;
  - `ping`/`pong`, `bye`;
  - `part`: a slice of a message over 16 KB (never cutting a surrogate pair).

  Room and peer lists share one sequence counter per tab, so the newest wins whichever link it
  arrives on. A tab speaking another link protocol is refused (`unsupported-version`).
- **Mesh**: QR codes only bootstrap. When a tab learns from a neighbour's `peers` about a tab it has
  no link with, the one with the smaller `selfId` sends it a standard SDP offer through that
  neighbour (`sig`, with trickled ICE candidates), so every pair ends up directly connected without
  more QR codes.
  - A relay only forwards between two of its own open links (one hop), rebuilding the message from
    its validated fields, and answers `fail` when it cannot.
  - A mesh connection must open within 20s. Failed attempts are retried after 5, 10, 20 and 40s;
    after 5 failures in a row, only when a neighbour's peer list changes, and never sooner than 5s
    after the last attempt.
  - At most 16 mesh connections are set up at once, and a tab that said `bye` is not reconnected for
    30s.
- **Liveness**: a ping every 5s on every link. A link nothing was heard from for 30s is dropped,
  except when this tab's own timer fired more than two intervals late (a throttled background tab:
  the others had no chance to answer). A link
  whose data channel closes, or whose connection fails or closes, is dropped at once; "disconnected"
  is left alone, as it may recover. On `pagehide` the rooms are left first, so their `bye`s go out on
  the links; then every link gets a link-level `bye` and is closed, with pending invites and replies.
- **Two links to the same tab** (a QR exchange between tabs already linked, a mesh connection made
  again after one side dropped the old one): the newest carries what this tab sends, messages are
  accepted on all of them, and the tab with the smaller id closes the older ones after 5s, so both
  sides settle on the same link even if they saw them open in a different order. The other tab is
  not reported as leaving its rooms.
- `links()` and `subscribe()` list the linked tabs (one entry per tab, sorted by peer id) and the
  mesh connections being set up: the "Nearby devices" list and the play page use them.
- **Rooms over links**: the nearby transport implements `Transport` (`kind: "nearby"`). Joining a
  room adds it to the tab's room list sent to every link; a room's peers are the linked tabs that
  listed it, and room messages are only accepted from them. As with Trystero, handlers run only once
  `join()` has resolved. Without WebRTC, `join()` fails with `transportUnavailable`. Room passwords
  are not used: links are authenticated by the DTLS fingerprint that came through the QR code, from
  someone physically present.

### Getting the app without internet

**Offline cache.** A device that opened the site once can open it again with no internet, including
from the camera app (an invite URL).

- `yarn build` runs `scripts/generate-sw.mjs` after `next build`. It writes `out/sw.js` from
  `scripts/service-worker.mjs`, whose functions are inlined as they were tested
  (`Function.prototype.toString`). It precaches every file of the export except source maps, `sw.js`
  and dotfiles, each with a hash of its content; the version is a hash of the whole list. Files are
  keyed relative to the worker's scope, so one build works under any base path.
- `src/lib/serviceWorker.ts` registers it once the page has loaded, in production builds on secure
  pages only (https, localhost), for the whole base path, with `updateViaCache: "none"`.
- **Install** downloads the files 8 at a time, bypassing the HTTP cache, and checks each against its
  hash: a mismatch (a deployment in progress) or an HTTP error fails the install, and the browser
  tries again later, resuming from what was stored. Files whose hash did not change are copied from
  the previous version's cache.
- Then the worker activates at once (`skipWaiting`, `clients.claim`). Its caches are named
  `hanab-offline:<scope>:<version>`, so deployments sharing an origin (GitHub Pages project sites)
  never touch each other's. Only this version's cache and the previous one's are kept, as an open page
  may still load the previous version's lazy chunks. A new version is used from the next page load.
- **Fetch**: only same-origin GET requests inside the scope are answered.
  - Navigations to precached pages come from the cache, ignoring the query string
    (`/play/?gameId=X` is the page `play/`); `<dir>` redirects to `<dir>/`.
  - Unknown paths try the network, then the cached `404.html`. Not the cache first: a GitHub Pages
    user site hosts its owner's project sites under the same scope.
  - Precached files, and anything under `_next/static/`, come from the cache, else the network;
    Range requests get 206 or 416 (Safari only plays media answered that way). Everything else,
    `nearby-origins.json` included, is left to the browser.
  - On localhost, pages come from the server while it answers and from the cache when it doesn't, so
    `next dev` and a production build can take turns on one port.
- `?sw=off` on any page, and any development build, unregisters this app's worker for the scope and
  deletes its caches.
- The manifest's `start_url` and `scope` are relative (`../`), so the app can be installed under any
  base path.
- Not available offline: Google Fonts (another origin: the fallback fonts show) and the base path
  without its trailing slash (outside the scope). A host that rewrites files (minification, injected
  scripts) makes every install fail. Cache Storage is best-effort (`navigator.storage.persist()` is
  not requested), so a browser short of space may evict it.

**Self-hosted on the LAN.** `yarn serve:static` (`scripts/serve-static.mjs`) serves `out/` like
GitHub Pages (trailing-slash redirects, `404.html`) and prints the URLs this computer and other
devices can open.

- `PORT` (default 3000); `HOST` (default: every interface; `0.0.0.0` means IPv4 only); `BASE_PATH`
  (default: the base path the export was built with, read from `out/index.html`; a mismatch prints a
  warning, which also catches Git Bash rewriting `/hanabi-app` into a Windows path).
- `TLS_CERT` and `TLS_KEY` (PEM files, both or neither) serve https, e.g. with certificates from
  mkcert that include the LAN address (`mkcert localhost 192.168.1.5`).
- Every file is revalidated (`Cache-Control: no-cache`, `Last-Modified`, 304) except the hashed ones
  under `_next/static/`, which are immutable. Range requests (with `If-Range`) and HEAD are supported;
  other methods get 405.
- Pages opened at `http://<lan-ip>` are not secure contexts: no in-app camera (scan with the camera
  app, take a photo or paste instead), no service worker, no wake lock. Nearby play works.

**Invite origins on localhost.** Invite and reply URLs carry the page's origin, and on localhost it
names this computer only. On a loopback page (`localhost`, `*.localhost`, 127.0.0.0/8, `::1`),
`src/lib/nearbyOrigin.ts` fetches `<basePath>/nearby-origins.json` (2s timeout), which
`serve:static` answers with `{"origins": [...]}`: this server's addresses, IPv4 before IPv6, physical
interfaces before virtual ones (Docker, WSL, VPNs), then 192.168/16, 10/8 and 172.16/12 first;
link-local addresses are left out. The invitation uses the first one, and offers a choice when there
are several. Other hosts, `next dev` included, don't answer it: the invitation then keeps the
localhost origin and warns that other devices can't open its link (scanning it from the app still
works).

### Limits

- Reloading a page, or a phone killing a background tab, ends that tab's links: any connected player
  invites it again (☰ → Invite players, or the connection indicator). The game itself is safe in
  every replica. To make this rarer, the play page holds a Screen Wake Lock and warns before the page
  unloads (`beforeunload`) while links are open, and nearby mode turns off pull-to-refresh.
- Links are direct only: two tabs that cannot reach each other (client isolation on some guest Wi-Fi)
  do not see each other, even if both reach a third.
- A mesh connection between two tabs that both lack camera permission relies on mDNS names: on
  networks that block multicast it fails, and is retried with the backoff above.
- The inviter learns that another tab applied a reply (the BroadcastChannel hand-off) only when the
  link opens or fails, and a `timeout` may be an expired invite or a link that did not open in 20s:
  the invitation panel tells them apart by the invitation's age.

## UI additions

- Lobby: share panel with the link, a QR code (`qrcode` package, rendered as SVG), copy, and Web Share
  on supported devices.
- In-game menu: "Invite players" shows the same panel, for latecomers and spectators.
- Connection indicator: status, connected peers, authority marker, a "waiting for players to
  connect" screen when the game is unknown locally, and the version-mismatch error.
- Join page: join by room name or link, plus the live public-room list.
- Home: "Your games" list from local replicas.

Nearby play (all its strings are under `nearby` in `en.ts` and `fr.ts`):

- Home: "Play without internet" opens `/nearby/` with a page load. In nearby mode a banner replaces
  it, with "Scan an invitation" and "Play online instead".
- `/nearby/` (`src/pages/nearby.tsx`): `#o=` answers the invitation; `#a=` hands the reply to the
  inviting tab; otherwise a landing page with a short explanation, the scanner, "Create a room",
  "Play online instead" and the "Nearby devices" list (named after the players of local replicas).
- Inviting (`nearbyInvite.tsx`), in nearby mode: the lobby's share panel becomes an "Invite a nearby
  player" button that opens a dialog; ☰ → Invite players shows the panel inline; the connection
  indicator's popover has the same button.
  - The panel starts the camera first. The invitation is made once the camera is live or unavailable,
    or when the player clicks "Continue without the camera".
  - It shows the invitation QR code (large, on white, with a 4-module quiet zone), "Can't scan it?
    Copy the link" (Copy, and Share where available), and the reply scanner below.
  - On localhost it uses the first LAN origin, with a select when there are several and a warning when
    there are none.
  - Replies it can't use show a message and scanning goes on. Once connected: "Invite another
    player".
  - Closing it cancels pending invitations, except those whose reply was scanned there.
- Guest (`nearbyJoin.tsx`): after answering, the reply QR code with Cancel; once linked, the game
  opens client-side. A reply scanned there instead of an invitation is applied by this tab, or handed
  to the tab of this browser that holds its invitation.
- Scanner (`qrScanner.tsx`): the live camera on secure pages (back camera, 4 frames per second, the
  centred square scaled down to at most 640 px, `BarcodeDetector` where it reads QR codes, else
  jsQR, loaded on demand), stopped while the page is hidden. "Take a photo" (a file input with `capture`) and a paste
  field are always offered.
- Connection indicator: "Nearby" and "x/y nearby"; with no peers, a hint and "Scan an invitation".
  The waiting-for-game screen gets the nearby wording and the same button.
- Join page: in nearby mode the scanner replaces the name/link form and the public rooms; online, a
  "No internet? Play nearby" link.
- New game: in nearby mode the Private option is hidden and games are always private.
- Play page: in nearby mode, while links are open, a Screen Wake Lock (taken again when the page is
  visible) and a leave warning. In another mode, a game that `isNearbyGame()` knows shows a "Switch
  to nearby play" banner, which reloads the page with `net=nearby`.
- The screen is also kept awake while an invitation or a reply is shown. In nearby mode,
  `overscroll-behavior-y: contain` on `<html class="nearby-mode">` turns off pull-to-refresh.
- Client-side navigation in nearby mode: the rematch ("New game") uses the router there (online it
  still loads the page, as upstream does), and the tutorial's "Back to game" is a `next/link` in
  both modes.

## Removed

Firebase, Sentry, Google Analytics, FullStory, next-iron-session, next-offline (its service worker was
already empty; the offline cache is now `scripts/service-worker.mjs`), `now.json`, and the Firebase
config files. `logEvent` and friends become no-ops so call sites stay untouched.

## Trust model

As with upstream (where every client could read the whole Firebase document), every peer holds the
full game, including its own hand, and the UI simply doesn't show it. Hanab is cooperative and played
with friends; peeking is possible via devtools, exactly as before.
