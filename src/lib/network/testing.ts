/**
 * Helpers for the network tests: simulated browsers (NetworkNode + fake
 * localStorage) on an in-memory network, and real game states built with the
 * game's own actions so that rebuilds are exercised. Not used by the app.
 */
import { commitAction, joinGame, MaxHints, newGame } from "~/lib/actions";
import { play } from "~/lib/ai";
import IGameState, { GameMode, GameVariant, IAction, IGameHintsLevel, IGameOptions, IGameStatus } from "~/lib/state";
import { NetworkNode, NetworkTimings } from "./node";
import { createMemoryStorage, KeyValueStorage } from "./storage";
import { MemoryNetwork } from "./transports/memory";
import { Transport } from "./transports/types";
import { ConnectionInfo, Rejection } from "./types";

export const TEST_TIMINGS: NetworkTimings = {
  syncWindowMs: 300,
  graceMs: 1000,
  helloIntervalMs: 2000,
  retryMs: 500,
  electionTimeoutMs: 800,
  tickMs: 100,
  rejoinDelayMs: 1000,
  lobby: {
    announceIntervalMs: 10000,
    expireMs: 30000,
    graceMs: 1000,
    tickMs: 1000,
  },
};

export function gameOptions(overrides: Partial<IGameOptions> = {}): IGameOptions {
  return {
    id: "TestGame",
    variant: GameVariant.CLASSIC,
    playersCount: 3,
    seed: "seed-1",
    allowRollback: true,
    preventLoss: false,
    private: false,
    hintsLevel: IGameHintsLevel.DIRECT,
    turnsHistory: true,
    botsWait: 0,
    colorBlindMode: false,
    gameMode: GameMode.NETWORK,
    ...overrides,
  };
}

/** A lobby-stage game, as the new-game page creates it. */
export function lobbyGame(overrides: Partial<IGameOptions> = {}): IGameState {
  return newGame(gameOptions(overrides));
}

/** A started game with the given seats (bot seats end with "-bot"). */
export function startedGame(seats: string[], overrides: Partial<IGameOptions> = {}): IGameState {
  let game = lobbyGame({ playersCount: seats.length, ...overrides });
  seats.forEach((id) => {
    game = joinGame(game, { id, name: id.toUpperCase(), bot: id.endsWith("-bot") });
  });
  return { ...game, status: IGameStatus.ONGOING, startedAt: 1000 };
}

/**
 * A legal move for the current player: a hint to the next player, or another
 * kind of move (a discard, or a play when the hints are maxed out).
 */
export function someMove(game: IGameState, kind: "hint" | "other" = "hint"): IAction {
  const from = game.currentPlayer;
  const to = (from + 1) % game.options.playersCount;
  if (kind === "hint" && game.tokens.hints > 0) {
    return { action: "hint", from, to, type: "number", value: game.players[to].hand[0].number };
  }
  if (game.tokens.hints < MaxHints) {
    return { action: "discard", from, cardIndex: 0 };
  }
  return { action: "play", from, cardIndex: 0 };
}

export function move(game: IGameState, kind: "hint" | "other" = "hint"): IGameState {
  return commitAction(game, someMove(game, kind));
}

/**
 * The game rolled back to `turn`, like the rollback area does with
 * getStateAtTurn (which is memoised per game id and turn, so unusable with
 * the many same-id games of the tests).
 */
export function rollbackTo(game: IGameState, turn: number): IGameState {
  let state = newGame(game.options);
  game.players.forEach((player) => {
    state = joinGame(state, player);
  });
  game.turnsHistory.slice(0, turn).forEach((t) => {
    state = commitAction(state, { ...t.action });
  });
  return { ...state, messages: game.messages, status: IGameStatus.ONGOING, createdAt: game.createdAt };
}

export interface TestPeer {
  name: string;
  node: NetworkNode;
  storage: KeyValueStorage;
  /** Latest game delivered to `follow` subscribers, per game. */
  games: Map<string, IGameState>;
  connections: Map<string, ConnectionInfo>;
  rejections: Rejection[];
  /** How many states each game delivered. */
  deliveries: Map<string, number>;
  /** Subscribe like the game page does (game + connection + rejections). */
  follow(gameId: string): () => void;
  game(gameId: string): IGameState | null;
}

export function createPeer(
  network: MemoryNetwork | null,
  name: string,
  options: {
    storage?: KeyValueStorage;
    authorKey?: string;
    playerId?: string;
    timings?: Partial<NetworkTimings>;
    /** Instead of the in-memory network's (e.g. the nearby transport over fake WebRTC). */
    transport?: Transport;
  } = {}
): TestPeer {
  const storage = options.storage ?? createMemoryStorage();
  const node = new NetworkNode({
    transport: options.transport ?? network.transport(name),
    storage,
    authorKey: options.authorKey ?? `key-${name}`,
    getPlayerId: () => options.playerId ?? name,
    timings: { ...TEST_TIMINGS, ...options.timings },
  });

  const peer: TestPeer = {
    name,
    node,
    storage,
    games: new Map(),
    connections: new Map(),
    rejections: [],
    deliveries: new Map(),
    follow(gameId: string) {
      const unsubscribers = [
        node.subscribeToGame(gameId, (game) => {
          peer.games.set(gameId, game);
          peer.deliveries.set(gameId, (peer.deliveries.get(gameId) ?? 0) + 1);
        }),
        node.subscribeToConnection(gameId, (info) => peer.connections.set(gameId, info)),
        node.subscribeToRejections(gameId, (rejection) => peer.rejections.push(rejection)),
      ];
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
    game(gameId: string) {
      return peer.games.get(gameId) ?? null;
    },
  };
  return peer;
}

/**
 * Plays the bots' turns like the game page does: only while this tab is the
 * authority, `delayMs` after each state (the botsWait), and the pending move
 * is cancelled whenever a new state arrives. Counts the moves it proposed.
 */
export function runBots(peer: TestPeer, gameId: string, delayMs = 100) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: IGameState | null = null;
  const runner = { moves: 0, turnsPlayed: [] as number[], stop: () => undefined as void };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const game = latest;
    if (!game || game.status !== IGameStatus.ONGOING) return;
    if (!peer.node.isAuthority(gameId)) return;
    if (!game.players[game.currentPlayer]?.bot) return;
    timer = setTimeout(() => {
      timer = null;
      if (!peer.node.isAuthority(gameId)) return;
      runner.moves++;
      runner.turnsPlayed.push(game.turnsHistory.length);
      peer.node.updateGame(play(game));
    }, delayMs);
  };

  const unsubscribeGame = peer.node.subscribeToGame(gameId, (game) => {
    latest = game;
    schedule();
  });
  const unsubscribeConnection = peer.node.subscribeToConnection(gameId, () => schedule());
  runner.stop = () => {
    if (timer) clearTimeout(timer);
    unsubscribeGame();
    unsubscribeConnection();
  };
  return runner;
}

/** The persisted replica of each peer: (version, author) and document. */
export function replicaOf(peer: TestPeer, gameId: string) {
  return peer.node.store.read(gameId);
}
