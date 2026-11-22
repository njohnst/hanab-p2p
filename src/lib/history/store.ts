import type { KeyValueStorage } from "~/lib/network/storage";
import { entryKey, groupKey, HistoryEntry, readEntry } from "./result";

export const HISTORY_PREFIX = "hanab.history.v1.";
const MAX_ENTRY_CHARS = 16 * 1024;

function parse(raw: string | null, key: string): HistoryEntry | null {
  if (!raw || raw.length > MAX_ENTRY_CHARS) return null;
  try {
    const entry = readEntry(JSON.parse(raw));
    return entry && entryKey(entry) === key ? entry : null;
  } catch {
    return null;
  }
}

function compare(a: HistoryEntry, b: HistoryEntry): number {
  if (a.version !== b.version) return a.version - b.version;
  if (a.author !== b.author) return a.author > b.author ? 1 : -1;
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Separate keys keep matches independent across tabs and outside resume eviction. */
export class HistoryStore {
  private readonly fallback = new Map<string, HistoryEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: () => KeyValueStorage | null) {}

  get(key: string): HistoryEntry | null {
    const pending = this.fallback.get(key);
    try {
      const saved = parse(this.storage()?.getItem(HISTORY_PREFIX + key) ?? null, key);
      return !saved || (pending && compare(pending, saved) > 0) ? pending ?? null : saved;
    } catch {
      return pending ?? null;
    }
  }

  list(): HistoryEntry[] {
    const keys = new Set(this.fallback.keys());
    try {
      const storage = this.storage();
      for (let i = 0; i < (storage?.length ?? 0); i++) {
        const key = storage.key(i);
        if (key?.startsWith(HISTORY_PREFIX)) keys.add(key.slice(HISTORY_PREFIX.length));
      }
    } catch {
      // Storage is optional, even when localStorage was available at startup.
    }
    return Array.from(keys, (key) => this.get(key)).filter(Boolean);
  }

  /** Return only the entries that advanced their match's accepted revision. */
  merge(entries: HistoryEntry[]): HistoryEntry[] {
    const changed = entries.filter((entry) => {
      const key = entryKey(entry);
      const previous = this.get(key);
      if (previous && (groupKey(previous.group) !== groupKey(entry.group) || compare(entry, previous) <= 0))
        return false;
      try {
        const storage = this.storage();
        if (storage) {
          storage.setItem(HISTORY_PREFIX + key, JSON.stringify(entry));
          this.fallback.delete(key);
        } else {
          this.fallback.set(key, entry);
        }
      } catch {
        this.fallback.set(key, entry);
      }
      return true;
    });
    if (changed.length) this.listeners.forEach((listener) => listener());
    return changed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
