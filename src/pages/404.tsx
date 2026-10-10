import Router from "next/router";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LoadingScreen from "~/components/loadingScreen";
import Button from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { logFailedPromise } from "~/lib/errors";
import { gameUrl, stripBasePath, summaryUrl } from "~/lib/routes";

const LEGACY_GAME_PATH = /^\/([A-Z][A-Za-z]+)\/?$/;
const LEGACY_SUMMARY_PATH = /^\/([A-Z][A-Za-z]+)\/summary\/?$/;

/**
 * Where a legacy (pre static export) URL now lives:
 * /<GameId> -> /play/?gameId=<GameId>, /<GameId>/summary -> /summary/?gameId=<GameId>.
 */
function legacyRedirect(pathname: string, search: string): string | null {
  const path = stripBasePath(pathname);
  const params = Object.fromEntries(new URLSearchParams(search));

  const game = LEGACY_GAME_PATH.exec(path);
  if (game) {
    return gameUrl(game[1], { ...params, gameId: game[1] });
  }

  const summary = LEGACY_SUMMARY_PATH.exec(path);
  if (summary) {
    return summaryUrl(summary[1]);
  }

  return null;
}

/**
 * Static hosts (GitHub Pages...) serve this page for every unknown path, with
 * the original URL kept in the address bar.
 */
export default function NotFound() {
  const { t } = useTranslation();
  const [redirecting, setRedirecting] = useState(true);

  useEffect(() => {
    const target = legacyRedirect(window.location.pathname, window.location.search);
    if (!target) {
      setRedirecting(false);
      return;
    }

    Router.replace(target).catch((e) => {
      logFailedPromise(e);
      setRedirecting(false);
    });
  }, []);

  if (redirecting) {
    return <LoadingScreen />;
  }

  return (
    <div className="pa2 pv4-l ph3-l shadow-5 br3 bg-main-dark flex flex-column justify-center items-center w-100 h-100">
      <Txt className="orange" size={TxtSize.LARGE} value={404} />
      <Txt className="mb4" value={t("pageNotFound", "Page not found")} />

      <Button text={t("backMenu", "Back to menu")} onClick={() => Router.replace("/")} />
    </div>
  );
}
