/**
 * Game replicas persisted in localStorage (`hanab.game.<id>`), so a game
 * survives any peer leaving or refreshing and can be resumed later.
 *
 * Every access is guarded: storage may be unavailable (private mode, SSR,
 * quota) and entries may be corrupted or written by an older version.
 */
import { GameDocument, toDocument } from "./document";
import { isGameDocument } from "./protocol";

export const REPLICA_PREFIX = "hanab.game.";
export const MAX_REPLICAS = 50;

export interface StoredReplica {
  /** Stamped by the authority on every change; (version, author) totally orders states. */
  version: number;
  /** authorKey of the authority that stamped the version. */
  author: string;
  /** When this browser last stored the replica (for "resume" lists and eviction). */
  updatedAt: number;
  /** Ids of the most recent proposals included in this state, oldest first. */
  applied: string[];
  game: GameDocument;
}

/** The subset of the Web Storage API the store uses (localStorage, or a fake in tests). */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** > 0 when `a` is newer than `b`: higher version first, then higher author key. */
export function compareVersions(a: { version: number; author: string }, b: { version: number; author: string }) {
  if (a.version !== b.version) {
    return a.version - b.version;
  }
  if (a.author === b.author) {
    return 0;
  }
  return a.author > b.author ? 1 : -1;
}

/** In-memory KeyValueStorage, for tests and when localStorage is unavailable. */
export function createMemoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index) => Array.from(data.keys())[index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function parseReplica(raw: string | null): StoredReplica | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }
    const game = toDocument(value.game);
    if (!isGameDocument(game)) {
      return null;
    }
    return {
      version: Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
      author: typeof value.author === "string" ? value.author : "",
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      applied: Array.isArray(value.applied) ? value.applied.filter((id) => typeof id === "string") : [],
      game,
    };
  } catch {
    return null;
  }
}

export class ReplicaStore {
  constructor(
    private readonly getStorage: () => KeyValueStorage | null,
    private readonly maxReplicas: number = MAX_REPLICAS
  ) {}

  private storage(): KeyValueStorage | null {
    try {
      return this.getStorage();
    } catch {
      return null;
    }
  }

  private replicaKeys(storage: KeyValueStorage): string[] {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(REPLICA_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  }

  read(gameId: string): StoredReplica | null {
    const storage = this.storage();
    if (!storage || !gameId) {
      return null;
    }
    try {
      return parseReplica(storage.getItem(REPLICA_PREFIX + gameId));
    } catch {
      return null;
    }
  }

  /**
   * Persist a replica unless the stored one is newer (another tab of this
   * browser may follow the same game). Evicts the least recently updated
   * replicas beyond the limit, never those in `protect`.
   * Returns whether the replica was written.
   */
  write(replica: StoredReplica, protect: Iterable<string> = []): boolean {
    const storage = this.storage();
    if (!storage) {
      return false;
    }

    const stored = this.read(replica.game.id);
    if (stored && compareVersions(stored, replica) > 0) {
      return false;
    }

    const key = REPLICA_PREFIX + replica.game.id;
    const value = JSON.stringify(replica);
    const protectedIds = new Set([replica.game.id, ...Array.from(protect)]);

    try {
      storage.setItem(key, value);
    } catch {
      // Most likely over quota: make room and try once more.
      try {
        this.evict(storage, protectedIds, Math.max(0, this.replicaKeys(storage).length - 5));
        storage.setItem(key, value);
      } catch (e) {
        console.warn("[network] could not persist game replica", e);
        return false;
      }
    }

    this.evict(storage, protectedIds, this.maxReplicas);
    return true;
  }

  remove(gameId: string) {
    try {
      this.storage()?.removeItem(REPLICA_PREFIX + gameId);
    } catch {
      // ignore
    }
  }

  /** Every readable replica (unordered). */
  list(): StoredReplica[] {
    const storage = this.storage();
    if (!storage) {
      return [];
    }
    try {
      return this.replicaKeys(storage)
        .map((key) => parseReplica(storage.getItem(key)))
        .filter((replica): replica is StoredReplica => replica !== null);
    } catch {
      return [];
    }
  }

  private evict(storage: KeyValueStorage, protectedIds: Set<string>, limit: number) {
    try {
      const keys = this.replicaKeys(storage);
      if (keys.length <= limit) {
        return;
      }
      const candidates = keys
        .filter((key) => !protectedIds.has(key.slice(REPLICA_PREFIX.length)))
        .map((key) => {
          let updatedAt = -1;
          try {
            const value = JSON.parse(storage.getItem(key));
            updatedAt = Number.isFinite(value?.updatedAt) ? value.updatedAt : -1;
          } catch {
            // Unreadable entries go first.
          }
          return { key, updatedAt };
        })
        .sort((a, b) => a.updatedAt - b.updatedAt);

      candidates.slice(0, keys.length - limit).forEach(({ key }) => storage.removeItem(key));
    } catch {
      // ignore
    }
  }
}
