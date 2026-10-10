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
`public-game` (lobby summary). States are a few KB, and Trystero chunks larger payloads.

### Public rooms

Public network games in their lobby are listed on "Join a room" through a shared Trystero room
(`roomId` = `public-lobby`) where each such game's authority periodically announces a `PublicGame`
summary. Entries expire after about 30 seconds without an announcement. Private games are never
announced.

### Connection robustness

- On `visibilitychange` back to visible, or `online`, re-join or re-announce if no peers are
  connected (mobile browsers drop WebRTC when backgrounded).
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
