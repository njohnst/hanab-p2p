import Head from "next/head";
import Link from "next/link";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import MatchHistory from "~/components/matchHistory";
import { useSession } from "~/hooks/session";
import type { HistoryEntry } from "~/lib/history/result";
import { HISTORY_PREFIX } from "~/lib/history/store";
import { getNetworkNode } from "~/lib/network";

export default function HistoryPage() {
  const { t } = useTranslation();
  const { playerId } = useSession();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    const history = getNetworkNode()?.history;
    if (!history) return;
    const refresh = () => setEntries(history.list());
    const storageChanged = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(HISTORY_PREFIX)) refresh();
    };
    const unsubscribe = history.subscribe(refresh);
    window.addEventListener("storage", storageChanged);
    refresh();
    return () => {
      unsubscribe();
      window.removeEventListener("storage", storageChanged);
    };
  }, []);

  const title = t("history.title", "Match history");
  return (
    <div className="h-100 overflow-y-auto">
      <main className="mw8 center pa3 pa4-ns near-white">
        <Head>
          <title>{title} · Hanab</title>
        </Head>
        <Link className="lavender" href="/">
          ‹ {t("history.home", "Home")}
        </Link>
        <h1 className="f2 normal">{title}</h1>
        {entries && <MatchHistory entries={entries} playerId={playerId} />}
      </main>
    </div>
  );
}
