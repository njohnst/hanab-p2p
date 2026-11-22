import React from "react";
import { useTranslation } from "react-i18next";
import { entryKey, formatElapsed, HistoryEntry, MatchResult } from "~/lib/history/result";
import { summarizeHistory } from "~/lib/history/statistics";
import { GameMode, GameVariant, IGameHintsLevel } from "~/lib/state";

const variants: Record<GameVariant, [string, string]> = {
  [GameVariant.CLASSIC]: ["classicVariant", "Classic"],
  [GameVariant.MULTICOLOR]: ["multicolorVariant", "Multicolor"],
  [GameVariant.RAINBOW]: ["rainbowVariant", "Rainbow"],
  [GameVariant.CRITICAL_RAINBOW]: ["criticalRainbowVariant", "Critical rainbow"],
  [GameVariant.ORANGE]: ["orangeVariant", "Orange"],
  [GameVariant.SEQUENCE]: ["sequenceVariant", "Sequence"],
};

const hints: Record<IGameHintsLevel, [string, string]> = {
  [IGameHintsLevel.ALL]: ["history.hintsAll", "All"],
  [IGameHintsLevel.DIRECT]: ["history.hintsDirect", "Direct"],
  [IGameHintsLevel.NONE]: ["history.hintsNone", "None"],
};

function MatchRow({ result }: { result: MatchResult }) {
  const { t, i18n } = useTranslation();
  const unknown = t("history.unknown", "Unknown");
  const date =
    result.endedAt === null
      ? unknown
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(result.endedAt);
  const forfeited = result.outcome === "forfeited";
  const duration = result.durationMs === null ? unknown : formatElapsed(result.durationMs);
  return (
    <div className="pv2 bt b--white-20">
      <div className="flex flex-wrap justify-between">
        <strong className={forfeited ? "txt-yellow" : "near-white"}>
          {forfeited ? t("history.forfeited", "Forfeited") : t("history.completed", "Completed")}
          {" · "}
          {forfeited
            ? t("history.partialScore", "{{score}}/{{maxScore}} partial score", result)
            : `${result.score}/${result.maxScore}`}
        </strong>
        <span className="lavender">{date}</span>
      </div>
      <div className="f6 mt1">
        {t("history.matchMetrics", "Elapsed {{duration}} · Undos {{undos}}", {
          duration,
          undos: result.undoCount ?? unknown,
        })}
      </div>
      <div className="f6 mt1 lavender">
        {result.roster.map((seat) => seat.name || t("history.unnamed", "Unnamed player")).join(", ")}
      </div>
    </div>
  );
}

export default function MatchHistory({ entries, playerId }: { entries: HistoryEntry[]; playerId: string }) {
  const { t, i18n } = useTranslation();
  const groups = summarizeHistory(entries, playerId);
  const unknown = t("history.unknown", "Unknown");
  const numeric = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });

  function setting(value: boolean | null) {
    if (value === null) return unknown;
    return value ? t("history.on", "On") : t("history.off", "Off");
  }

  function metric(average: { value: number | null; known: number; total: number }, format: (n: number) => string) {
    if (average.value === null) return unknown;
    const value = format(average.value);
    return average.known === average.total
      ? value
      : t("history.limitedAverage", "{{value}} ({{known}} of {{total}})", { ...average, value });
  }

  if (!groups.length) {
    return <p className="lavender">{t("history.empty", "No saved results yet. Finish a match to start a history.")}</p>;
  }

  return (
    <>
      <p className="lavender">
        {t("history.scope", "Results are grouped by the same seated players and rules. Elapsed time includes breaks.")}
      </p>
      {groups.map((group) => (
        <section key={group.key} className="mt4">
          <h2 className="f4 normal mb3">
            {group.humans.map((seat) => seat.name || t("history.unnamed", "Unnamed player")).join(", ")}
          </h2>
          {group.types.map((type) => {
            const { roster, rules, maxScore } = type.sample;
            const bots = roster.filter((seat) => seat.bot).length;
            return (
              <section key={type.key} className="mb3 pa3 br2 ba b--white-20 bg-white-10">
                <h3 className="f5 mt0 mb2">
                  {t(...variants[rules.variant])} ·{" "}
                  {t("history.seatCount", "{{seats}} seats · {{bots}} bots", { seats: roster.length, bots })}
                </h3>
                <p className="f6 lavender mt0">
                  {t(
                    "history.ruleSettings",
                    "{{mode}} · Hints {{hints}} · Rollback {{undo}} · Prevent loss {{loss}} · Turn log {{log}}",
                    {
                      mode:
                        rules.gameMode === GameMode.NETWORK
                          ? t("history.network", "Network")
                          : t("history.passAndPlay", "Pass and play"),
                      hints: rules.hintsLevel === null ? unknown : t(...hints[rules.hintsLevel]),
                      undo: setting(rules.allowRollback),
                      loss: setting(rules.preventLoss),
                      log: setting(rules.turnsHistory),
                    }
                  )}
                  {bots > 0 && (
                    <>
                      {" · "}
                      {t("history.botDelay", "Bot delay {{delay}}", {
                        delay: rules.botsWait === null ? unknown : `${numeric.format(rules.botsWait / 1000)} s`,
                      })}
                    </>
                  )}
                </p>
                <p className="f6">
                  {t("history.matchCounts", "{{completed}} completed · {{forfeited}} forfeited", type)}
                </p>
                <dl className="flex flex-wrap mv3">
                  {[
                    [
                      t("history.avgScore", "Average score"),
                      metric(type.averageScore, (n) => `${numeric.format(n)}/${maxScore}`),
                    ],
                    [t("history.avgTime", "Average time"), metric(type.averageTime, formatElapsed)],
                    [t("history.avgUndos", "Average undos"), metric(type.averageUndos, numeric.format)],
                  ].map(([label, value]) => (
                    <div key={label} className="mr4 mb2">
                      <dt className="f6 lavender">{label}</dt>
                      <dd className="ma0 fw6">{value}</dd>
                    </div>
                  ))}
                </dl>
                {type.best && (
                  <>
                    <h4 className="f6 ma0 mb2">{t("history.best", "Best match")}</h4>
                    <MatchRow result={type.best.result} />
                  </>
                )}
                <h4 className="f6 ma0 mt3 mb2">{t("history.lastFive", "Last five matches")}</h4>
                <ul className="list pa0 ma0">
                  {type.lastFive.map((match) => (
                    <li key={entryKey(match)}>
                      <MatchRow result={match.result} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </section>
      ))}
    </>
  );
}
