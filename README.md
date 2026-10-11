# Hanab, peer-to-peer

Play Hanab with friends straight from the browser: no accounts, no game server. Create a room, share
the link or let your friends scan its QR code, and the players' browsers connect to each other over
WebRTC.

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

The full design is in [docs/P2P_DESIGN.md](docs/P2P_DESIGN.md).

### Things to know

- **Playing online needs a secure page**: https, or `localhost` during development. A phone opening the
  dev server at `http://192.168.x.x:3000` cannot connect; use the deployed site or an https tunnel.
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

**Join a room** lists public rooms while their hosts wait in the lobby. Private rooms are only
reachable through their link.

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

### Tests, lint and the static build

```bash
yarn test       # vitest: merge rules, protocol, storage and sync scenarios of the network layer
yarn lint
yarn build      # static export in out/
yarn serve:static   # serves out/ on http://localhost:3000
```

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
| `src/lib/routes.ts` | Every in-app URL (games live at `/play/?gameId=…`) |
| `src/lib/playerId.ts` | Player identity (replaces upstream's server session) |
| `src/components/shareGame.tsx` | Invite panel with the QR code |
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

## Translations

The game is available in English, French, Spanish, Italian, Dutch, Russian, Portuguese, German, Slovak
and Chinese thanks to upstream's contributors. Screens added by this fork (the invite panel and the
"connecting to the game" screen) exist in English and French; other languages show them in English until
translated. Network error messages are English only.

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
