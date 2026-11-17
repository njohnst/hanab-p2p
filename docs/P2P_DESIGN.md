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

### Unified connections

The default `webrtc` transport combines automatic Trystero connections with QR-created connections.
One LinkManager exists for the browser tab in both cases. `/nearby/` is the connection scanner,
not a mode switch; navigating there never reloads the game or discards its live links.

`transports/combined.ts` exposes one logical room over both transports. A stable tab id, a sequence
number, and a bounded recent-message cache prevent duplicate peers and messages when both paths
connect the same devices. Presence is announced every 5s; silent peers expire after 20s. Explicit
leaves are forwarded immediately. Room envelopes can be forwarded through other participants so
a QR-only player can reach an internet-only authority. There is an 8-hop limit and a 128-peer limit;
game payloads still pass through the sync engine's validation. A bridging participant must stay
connected until another route exists. Internet join failures do not block the QR transport, and
failed joins are retried. The room protocol requires all participants to reload the updated app.

The browser's offline flag does not disable local networking. The default uses the normal sync
timings; explicit `?net=nearby` is a relay-free diagnostic override with shorter timings, and
`?net=local` keeps BroadcastChannel testing. Old stored nearby modes are migrated to the default.
The room link, privacy setting and player identity do not depend on the connection method.

### Handshake (two QR codes)

1. The **inviter** (any player of the game) calls `createInvite({ gameId, origin, manualStart: true })`: a new
   RTCPeerConnection with `iceServers: []` and an ordered data channel (`hanab`), `createOffer`, then
   waits for ICE gathering to complete (at most 3s; then what was gathered is used). Its compact
   description becomes the **invite URL** `<origin><basePath>/nearby/#o=<code>`, shown as a QR code.
   An invite lasts 10 minutes, and a tab can hold several: each has a random token that its reply
   echoes.
2. The **guest** scans it, with the phone's own camera app (the URL opens the app, which answers it)
   or the in-app scanner, and calls `answerInvite(text, { manualStart: true })`: `setRemoteDescription` (the rebuilt offer
   without candidates or end-of-candidates),
   `createAnswer`, gather, and shows the **reply URL** `<origin><basePath>/nearby/#a=<code>` as a QR
   code. The reply takes the invitation's origin when the invitation was a URL (see below).
3. The inviter scans the reply: `acceptReply(text)` finds the pending invite by its token and calls
   `setRemoteDescription` without candidates or end-of-candidates. Both screens then offer **Connect now**
   (the guest first confirms the reply was scanned). Each tap calls `startConnecting()`, releasing the
   saved remote candidates with `addIceCandidate` and then end-of-candidates. The 20s connection timeout
   starts on the tap. Taps should be roughly simultaneous so checks overlap. Calls are idempotent; the
   10-minute invitation expiry still applies. The API retains automatic start when `manualStart` is
   omitted, and mesh connections remain automatic. Once the data channel is open, both
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

### Connection details

Every QR link records how it went (`nearby/diagnostics.ts`, `DiagnosticsRecorder`), exposed as
`diagnostics()` / `onDiagnostics()` on `NearbyInvite` and `NearbyReply` and shown, folded, under both
QR codes (`components/nearbyDetails.tsx`):

- the host candidates this device gathered (`icecandidate` events and the local description), which
  of them its code carries and why the others are left out (the codec's reasons, or gathered after the
  code was made), and whether gathering completed or hit the ~3s cap;
- the other device's candidates, from its code;
- a timeline of state changes (gathering, ICE, connection, data channel, code made, other code read,
  link open, closed and why), at most 60 entries;
- the ICE candidate pairs from `getStats()` (state, selected, checks sent and answered both ways, round
  trip), read every second from the moment the other device's code is known until the link opens or
  closes; the last reading is kept, since a closed connection has no statistics.

Addresses are classified (private IPv4, carrier-grade NAT, link-local, IPv6 global or unique-local,
an mDNS name hiding the address...). **Copy** produces a plain-text report in English with the browser,
the page, the camera permission and the network mode, meant to be sent to the developer: it shows
whether each side offered an address on the shared network and whether any check was answered.

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

Unified connection UI (strings under `unified` and `nearby` in English and French):

- Home has one Create / Join flow. No online/offline mode choice or switching banner.
- The lobby and in-game Invite players panel always show the room link, QR, Copy and supported Share.
  **Connect by QR** opens the optional connection handshake, without changing the room.
- Join accepts a room name/link and offers a scanner accepting both room and connection QR codes.
- The waiting-for-game screen offers the same connection scanner while automatic discovery continues.
- `/nearby/#o=` answers a connection invitation; `#a=` hands the reply to its inviting tab.
- The connection handshake still uses two QR codes and the coordinated **Connect now** buttons.
  After failure, both screens show Android Nearby devices permission troubleshooting and diagnostics.
- Status says connected, rather than choosing online/nearby labels. The connection popover offers
  QR reconnection. An invitation opened from the menu is owned by the game, surviving turn changes.
- QR links survive in-app navigation and rematches. While they are open, the game takes a screen
  wake lock where supported and warns before leaving. Pull-to-refresh is disabled for network play.
- Private/public rooms remain a room setting; the connection method does not change it.

## Removed

Firebase, Sentry, Google Analytics, FullStory, next-iron-session, next-offline (its service worker was
already empty; the offline cache is now `scripts/service-worker.mjs`), `now.json`, and the Firebase
config files. `logEvent` and friends become no-ops so call sites stay untouched.

## Trust model

As with upstream (where every client could read the whole Firebase document), every peer holds the
full game, including its own hand, and the UI simply doesn't show it. Hanab is cooperative and played
with friends; peeking is possible via devtools, exactly as before.
