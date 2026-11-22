import { entryKey, groupKey, HistoryEntry, MatchResult } from "./result";

type RecordedMatch = HistoryEntry & { result: MatchResult };

function latest(a: RecordedMatch, b: RecordedMatch): number {
  return (b.result.endedAt ?? -1) - (a.result.endedAt ?? -1) || entryKey(a).localeCompare(entryKey(b));
}

function average(values: (number | null)[]) {
  const known = values.filter((value) => value !== null);
  return {
    value: known.length ? known.reduce((total, value) => total + value, 0) / known.length : null,
    known: known.length,
    total: values.length,
  };
}

function byType(matches: RecordedMatch[]) {
  const types = new Map<string, RecordedMatch[]>();
  matches.forEach((match) => {
    const { roster, rules, maxScore } = match.result;
    // All bot seats use the same AI. Names, bot IDs, seating order, seeds,
    // privacy and appearance are immaterial. Rule/assistance settings are not.
    const key = JSON.stringify([rules, maxScore, roster.length, roster.filter((seat) => seat.bot).length]);
    const games = types.get(key) ?? [];
    games.push(match);
    types.set(key, games);
  });
  return Array.from(types, ([key, games]) => {
    const completed = games.filter(({ result }) => result.outcome === "completed");
    const best = completed.reduce<RecordedMatch>(
      (current, match) => (!current || match.result.score > current.result.score ? match : current),
      null
    );
    return {
      key,
      sample: games[0].result,
      completed: completed.length,
      forfeited: games.length - completed.length,
      averageScore: average(completed.map(({ result }) => result.score)),
      averageTime: average(completed.map(({ result }) => result.durationMs)),
      averageUndos: average(completed.map(({ result }) => result.undoCount)),
      best,
      lastFive: games.slice(0, 5),
    };
  });
}

export function summarizeHistory(entries: HistoryEntry[], playerId: string) {
  const groups = new Map<string, RecordedMatch[]>();
  entries
    .filter((entry): entry is RecordedMatch => !!entry.result && entry.group.includes(playerId))
    .sort(latest)
    .forEach((entry) => {
      const key = groupKey(entry.group);
      const matches = groups.get(key) ?? [];
      matches.push(entry);
      groups.set(key, matches);
    });
  return Array.from(groups, ([key, matches]) => ({
    key,
    humans: matches[0].result.roster.filter((seat) => !seat.bot),
    types: byType(matches),
  }));
}
