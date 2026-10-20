# Hanab, peer-to-peer

Play Hanab with friends straight from the browser: no accounts, no game server. Create a room, share
the link or let your friends scan its QR code, and the players' browsers connect to each other over
WebRTC. No internet? Devices on the same Wi-Fi can still play together by scanning each other's
codes.

This is a fork of [bstnfrmry/hanabi](https://github.com/bstnfrmry/hanabi), the code behind
[hanab.cards](https://hanab.cards), by Bastien Formery and its contributors. The game, the bots, the
variants, the tutorial and the whole interface are theirs. This fork replaces the Firebase backend with
peer-to-peer sync, so the app is a static site you can host for free, for example on GitHub Pages.

Hanab is a cooperative card game inspired by, but unaffiliated with, a game made by French designer
Antoine Bauza published in 2010 by Asmodée Éditions. If you like it, please buy the
[physical version](https://fr.asmodee.com/fr/games/hanabi/products/hanabi/) to support its creator.
You can also [buy the hanab.cards authors a coffee](https://www.buymeacoffee.com/hanabicards) ☕️.

## How it works

- **Static site.** `yarn build` produces plain files in `out/`, with no server-side code.
- **WebRTC between players.** Each game is a room found through public
  [Nostr](https://nostr.com) relays via [Trystero](https://github.com/dmotz/trystero). The relays only
  help browsers find each other; game data then flows directly between players. Signaling is encrypted
  with the room name. Connections use public STUN servers, and an optional TURN relay can be configured
  (see [TURN](#optional-turn-relay)).
- **Every player keeps a copy of the game** in their browser (localStorage, the 50 most recent games).
  One player's browser coordinates: it puts moves in order and plays the bots' turns. If that player
  leaves, another one takes over, so the game survives anyone closing a tab or a phone going to sleep.
  Changes made at the same moment, such as two people joining the lobby or chatting, are merged instead
  of overwriting each other.
- **Pass & play and the tutorial never go online.**
- **Nearby play needs no server at all.** On a local network, the two browsers' connection details are
  exchanged as two QR codes, one each way, instead of through the relays. Once a device is in, it
  connects to the other players by itself. See [Playing without internet](#playing-without-internet).
- **The app works offline after one visit.** On https, the site installs a service worker that keeps a
  copy of the whole app in the browser. A new version downloads in the background and is used from the
  next page load. While developing, `?sw=off` on any URL removes it (see
  [Tests, lint and the static build](#tests-lint-and-the-static-build)).

The full design is in [docs/P2P_DESIGN.md](docs/P2P_DESIGN.md).

### Things to know

- **Playing online needs a secure page**: https, or `localhost` during development. A phone opening the
  dev server at `http://192.168.x.x:3000` cannot connect; use the deployed site or an https tunnel.
  Nearby play works on plain http pages too (see
  [Self-hosting on a local network](#self-hosting-on-a-local-network)).
- **Some networks block direct connections.** Players behind strict NATs or corporate firewalls need a
  TURN relay.
- **Anyone with the link can join** the room, and every player's browser holds the whole game (as with
  upstream, where every client could read the Firebase document). Someone determined could peek at
  their own hand in the developer tools. It's a cooperative game for friends.
- **A game exists only in its players' browsers.** If nobody who has it is online, newcomers wait until
  someone who has it comes back.

## Playing

1. **Create a room**, pick the number of players and the variant.
2. **Invite**: the lobby shows the game link, a QR code, a Copy button and, where the browser can share
   (most phones, some desktop browsers), a Share button. The ☰ menu has an **Invite players** entry with
   the same QR code during the game too, though anyone joining after the start can only watch.
3. Fill empty seats with AI players if you like, then start.

Your seat belongs to the browser you joined from: opening the link on another device lets you watch, not
play your hand.

**Join a room** takes a room name (like `ExcitingHookwormPink`) or a pasted game link, and lists public
rooms while their players wait in the lobby. Private rooms aren't listed: join them by name or link.

The home page lists the games you're in, so you can get back to them. If the host's action wins a race
with yours (two people taking the last seat, a move after the turn has passed), you'll see a short
message saying why yours wasn't applied.

## Playing without internet

Phones and computers on the same network can play with no internet connection: on a phone's hotspot
on a train, on a holiday Wi-Fi with no connection behind it, or on an office network that blocks the
internet. The devices talk to each other directly, with no server in between.

### Starting a game

1. On the home page, tap **Play without internet**, then **Create a room**.
2. In the lobby, tap **Invite a nearby player** and allow the camera: you'll need it to scan the
   reply, and it helps the devices find each other on some networks.
3. The other player scans your code with their phone's camera app, or in the app (**Play without
   internet**, then **Scan with the camera**). Their screen then shows a reply code.
4. Scan the reply in the same dialog. The devices connect and the game opens on their screen.

**More players:** invite each one the same way, from any player who is already in: ☰ → **Invite
players**, or tap the connection status at the top of the game. A new player then connects to
everyone else by itself, with no more codes.

**No camera that can read the code?** Under each code, open **Can't scan it? Copy the link** to copy
it (or share it, where the device can), then paste it on the other device under the scanner, in **Or
paste the code or link**. **Take a photo** works too.

### If a device drops out

Reloading the page disconnects that device, and so can a phone that is locked or leaves the app in the
background for a while. The game itself is safe: every device keeps a copy. To bring the device back,
any connected player invites it again (☰ → **Invite players**) and it scans the new code; the
connection status on the dropped device also has **Scan an invitation**.

To make this rarer, while connected the game keeps the screen awake (on https pages) and asks before
you leave or reload the page, and pull-down-to-refresh is turned off.

### What you need

- **The same network for everyone**: one Wi-Fi, or everyone on one phone's hotspot (that phone can play
  too). Some guest and public Wi-Fi networks keep devices from seeing each other; a hotspot works
  instead. Each pair of devices connects directly, so a device that can't reach another one can't play
  with it.
- **The app on each device**, one of two ways:
  - open the site (https) once while online, in the browser your phone opens links with, and give it
    a moment to store itself. It then opens with no internet, also from the camera app scanning an
    invitation. Adding it to the home screen is optional. Offline, open the address with its final
    slash (e.g. `…/hanabi-app/`) or from the home-screen icon.
  - or serve it from a computer on the network (see
    [Self-hosting on a local network](#self-hosting-on-a-local-network)).
- **Scan within 10 minutes**: an invitation expires after that. Once the reply is scanned, the devices
  have 20 seconds to connect.

A tab stays in nearby mode, reloads included, until you tap **Play online instead**. In this mode
players join by scanning: game links and public rooms are for online play, and games are always
private. Opening a game you played nearby from an online tab offers **Switch to nearby play**.

## Development

Requirements: Node 20 (see `.nvmrc`) and Yarn 1. If you don't have Yarn, prefix the commands with
`npx yarn@1.22.22`.

```bash
yarn install
yarn dev        # http://localhost:3000
```

### Playing several seats from one browser

All tabs of a browser share one player identity. To be several players at once:

- Add `?as=<name>` to a URL (e.g. `/play/?gameId=FooBarBaz&as=bob`). That tab keeps its own identity for
  as long as it stays open.
- Add `?net=local` to sync tabs of the same browser through BroadcastChannel instead of WebRTC, with no
  internet needed. Every tab of the game needs it (e.g. `/play/?gameId=FooBarBaz&as=bob&net=local`):
  invite links don't carry it. The tab remembers the choice until it closes; `?net=webrtc` switches it
  back.
- Add `?net=nearby`, or open any page under `/nearby/`, for nearby mode. It is remembered the same way.

### Testing nearby play

Two or three tabs of one browser can play nearby, exchanging the codes by copy and paste. Use
`yarn dev`: on localhost every link stays on one origin (the invitation's yellow warning about
localhost is expected).

1. Tab A: open `http://localhost:3000/?as=alice`, click **Play without internet**, then **Create a
   room** (3 players), and join the game.
2. In the lobby, click **Invite a nearby player** (allow the camera or click **Continue without the
   camera**). Open **Can't scan it? Copy the link** and click **Copy**.
3. Tab B: open `http://localhost:3000/nearby/?as=bob` and paste the link under **Or paste the code or
   link**. Copy the reply link the same way.
4. Paste the reply in tab A's dialog, in the same paste field under the reply scanner. Tab A says
   **Connected!** and tab B opens the game.
5. For the mesh, join as Bob, then invite tab C (`/nearby/?as=carol`) from Bob's ☰ → **Invite
   players**. A and C connect by themselves: once Carol takes a seat, A's connection status shows
   3/3 nearby.

Opening the copied reply link in a new tab instead of pasting it tests the hand-off between tabs: it
says the reply was sent, and tab A connects. The camera, the wake lock and real devices still need a
manual pass on phones on one Wi-Fi (see [Self-hosting](#self-hosting-on-a-local-network)).

### Tests, lint and the static build

```bash
yarn test       # vitest: merge rules, protocol, storage and sync scenarios, nearby codes and links,
                # the offline cache
yarn lint
yarn build      # static export in out/, then the offline cache's service worker (out/sw.js)
yarn serve:static   # serves out/ on http://localhost:3000 and the local network
```

Production builds register the service worker, on `localhost` too, where it takes pages from the
server while the server runs (and from its cache when it doesn't). Elsewhere, a new deployment is used
from the next page load once the worker has downloaded it. Add `?sw=off` to any URL to remove the
worker and its caches; `yarn dev` removes it by itself.

To reproduce a GitHub Pages project site, which lives under `/<repo>/`, build and serve with a base path:

```bash
NEXT_PUBLIC_BASE_PATH=/hanabi-app yarn build
BASE_PATH=/hanabi-app yarn serve:static   # http://localhost:3000/hanabi-app/
```

On Windows, Git Bash rewrites `/hanabi-app` into a Windows path (`C:/Program Files/Git/hanabi-app`)
before Node sees it. Prefix both commands with `MSYS_NO_PATHCONV=1` there. In PowerShell, set the
variables first; they stay set for the rest of the session:

```powershell
$env:NEXT_PUBLIC_BASE_PATH = "/hanabi-app"; yarn build
$env:BASE_PATH = "/hanabi-app"; yarn serve:static
Remove-Item Env:NEXT_PUBLIC_BASE_PATH, Env:BASE_PATH   # back to normal builds
```

### Where things are

| Path | What |
|------|------|
| `src/lib/actions.ts`, `src/lib/ai.ts` | Game rules and bots (from upstream) |
| `src/lib/network/` | Peer-to-peer sync: transports, the coordinating peer, merging, storage, public lobby |
| `src/lib/network/nearby/` | Nearby play: QR codes, links between tabs and the mesh, game rooms over links |
| `src/lib/routes.ts` | Every in-app URL (games live at `/play/?gameId=…`) |
| `src/lib/playerId.ts` | Player identity (replaces upstream's server session) |
| `src/components/shareGame.tsx` | Invite panel: the game link's QR code online, nearby invitations otherwise |
| `src/pages/nearby.tsx`, `src/components/nearby*.tsx` | Nearby screens: invitation, reply, hand-off, linked devices |
| `src/components/qrScanner.tsx`, `src/lib/qr.ts` | QR scanner (camera, photo, paste) and QR rendering |
| `scripts/service-worker.mjs`, `scripts/generate-sw.mjs`, `src/lib/serviceWorker.ts` | Offline cache: the worker, its generator, its registration |
| `scripts/serve-static.mjs`, `src/lib/nearbyOrigin.ts` | Static server for testing the build and LAN hosting; LAN addresses for invitations |
| `docs/P2P_DESIGN.md` | The design, including nearby play |
| `.github/workflows/deploy.yml` | GitHub Pages deployment |

## Deploying to GitHub Pages

1. Push the repository to GitHub, with `main` or `master` as the default branch.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to the default branch, or run the **Deploy to GitHub Pages** workflow manually. It runs the
   tests, builds with the base path `/<repo>` (or none for a `<owner>.github.io` repository) and
   publishes `out/`.

Using a custom domain on a project site? The site is then served from the root: change the workflow so
it builds with an empty `NEXT_PUBLIC_BASE_PATH`.

Any other static host works too: build with the base path the site will live under, then upload `out/`.

### Optional TURN relay

To help players on restrictive networks, point the app at a TURN server when building:

| Variable | Meaning |
|----------|---------|
| `NEXT_PUBLIC_TURN_URLS` | Comma-separated TURN URLs, e.g. `turn:turn.example.com:3478` |
| `NEXT_PUBLIC_TURN_USERNAME` | TURN username |
| `NEXT_PUBLIC_TURN_CREDENTIAL` | TURN password |

The deploy workflow reads them from the repository variables `TURN_URLS` and `TURN_USERNAME` and the
secret `TURN_CREDENTIAL`. **These values are compiled into the public JavaScript**, so anyone can read
them, even when stored as a GitHub secret. Use a TURN service whose credentials are restricted or
usage-limited.

### Self-hosting on a local network

With no internet at all, a computer on the network can serve the app to the other devices:

```bash
yarn install    # while online, once
yarn build
yarn serve:static
```

It prints the addresses to open, for example:

```text
  This computer:  http://localhost:3000/
  Other devices:  http://192.168.1.5:3000/
```

`PORT` changes the port (3000 by default) and `HOST` the interface (all of them by default).
`BASE_PATH` defaults to the base path the build used. If other devices can't open the address, check
that the computer's firewall lets Node accept connections on this network.

- **Plain http pages aren't "secure" for browsers**: at `http://192.168.x.x` there is no in-app camera
  (scan with the phone's camera app, take a photo, or paste the link instead), no offline copy and no
  keep-awake. Nearby play itself works.
- **For https**, make a certificate with [mkcert](https://github.com/FiloSottile/mkcert) that includes
  the computer's network address, and install mkcert's root certificate on each device (see its
  documentation):

  ```bash
  mkcert localhost 192.168.1.5     # writes localhost+1.pem and localhost+1-key.pem
  TLS_CERT=localhost+1.pem TLS_KEY=localhost+1-key.pem yarn serve:static
  ```

  In PowerShell, set `$env:TLS_CERT` and `$env:TLS_KEY` first. `*.pem` files are ignored by git.
- **Playing on the computer itself, at `localhost`:** invitations need an address the other devices
  can open, so the app asks `serve:static` for the computer's network addresses and puts the first one
  in its invitations (with a choice when there are several). `yarn dev` can't tell it: invitations
  made there show a warning, and other devices can only use them by scanning from the app or pasting.

## Translations

The game is available in English, French, Spanish, Italian, Dutch, Russian, Portuguese, German, Slovak
and Chinese thanks to upstream's contributors. Screens added by this fork (the invite panel, the
"connecting to the game" screen and every nearby play screen) exist in English and French; other
languages show them in English until translated. Network error messages are English only.

### Adding a language

1. Duplicate `src/locales/en.ts` (the only file with every key) and name it after the language's
   [ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes), e.g. `pl.ts`, then rename
   the exported constant (`export const pl = {`).
2. Translate the values. The first element of each line is the key: keep it as is and translate only the
   text in quotes.
3. Register it in `src/lib/i18n.ts` (import it and add it to `resources`).
4. Add it to `Languages` in `src/components/languageSelector.tsx`.

The language comes from the player's choice in the selector, saved in the browser, otherwise from the
browser's language.

#### HTML elements in translations

- Text in double braces is a variable: don't translate it. `discardPile: "discard ({{ discardLength }})"`
  shows `discard (13)` when 13 cards are discarded.
- `<1>...</1>` or `<0>...</0>` wrap part of the text (for a color, a link, a style). Translate the text
  inside and keep the tags.

#### Pluralization

Plurals use the `_plural` suffix, triggered by a variable named `count`:

```ts
turnsLeftDisclaimer: "· 1 turn left",
turnsLeftDisclaimer_plural: "· {{count}} turns left",
```

`count` doesn't have to appear in the text itself; it can just pick singular or plural. Some languages,
such as Russian or Arabic, have more plural forms: see the
[suffixes they use](https://jsfiddle.net/sm9wgLze).

## License

MIT, see [licence](licence). Copyright (c) 2020 Bastien Formery. This fork keeps upstream's license.
