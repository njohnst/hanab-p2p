import { AppProps } from "next/app";
import Head from "next/head";
import Router from "next/router";
import NProgress from "nprogress";
import React, { useEffect, useState } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { TutorialProvider } from "~/components/tutorial";
import Txt, { TxtSize } from "~/components/ui/txt";
import useConnectivity from "~/hooks/connectivity";
import { Session, SessionContext } from "~/hooks/session";
import { initAnalytics, logPageView } from "~/lib/analytics";
import { logFailedPromise } from "~/lib/errors";
import { detectLanguage, i18n } from "~/lib/i18n";
import { getPlayerId } from "~/lib/playerId";
import { withBasePath } from "~/lib/routes";
import { registerServiceWorker } from "~/lib/serviceWorker";
import "../styles/style.css";

Router.events.on("routeChangeComplete", () => logPageView());

let nprogressTimeout: NodeJS.Timeout = null;

Router.events.on("routeChangeStart", () => {
  nprogressTimeout = setTimeout(() => NProgress.start(), 200);
});

Router.events.on("routeChangeComplete", () => {
  clearTimeout(nprogressTimeout);
  NProgress.done();
});

Router.events.on("routeChangeError", () => {
  clearTimeout(nprogressTimeout);
  NProgress.done();
});

export default function App(props: AppProps) {
  useEffect(() => {
    initAnalytics();
    registerServiceWorker();
  }, []);

  return <Hanab {...props} />;
}

function Hanab({ Component, pageProps }: AppProps) {
  const { t } = useTranslation();

  /**
   * The player's identity lives in this browser (see ~/lib/playerId).
   * It is null while pre-rendering at build time; pages that depend on it
   * (game, summary) only render on the client.
   */
  const [session] = useState<Session>(() => ({ playerId: getPlayerId() }));

  /**
   * Pages are pre-rendered in English: switch to the player's language once mounted.
   */
  useEffect(() => {
    const onLanguageChanged = (language: string) => {
      document.documentElement.lang = language;
    };

    i18n.on("languageChanged", onLanguageChanged);
    detectLanguage().catch(logFailedPromise);

    return () => i18n.off("languageChanged", onLanguageChanged);
  }, []);

  const [showOffline, setShowOffline] = useState(true);
  const online = useConnectivity();

  return (
    <>
      <I18nextProvider i18n={i18n}>
        <SessionContext.Provider value={session}>
          <TutorialProvider>
            <Meta />

            <div className="aspect-ratio--object">
              {/* Offline indicator */}
              {!online && showOffline && (
                <div className="relative flex items-center justify-center bg-red shadow-4 b--red ba pa2 z-99">
                  <Txt uppercase size={TxtSize.MEDIUM} value={t("offline")} />
                  <a className="absolute right-1" onClick={() => setShowOffline(false)}>
                    <Txt value="×" />
                  </a>
                </div>
              )}
              <Component {...pageProps} />
            </div>
          </TutorialProvider>
        </SessionContext.Provider>
      </I18nextProvider>
    </>
  );
}

function Meta() {
  const { t } = useTranslation();

  const tagline = `${t("tagline")} · ${t("subTagline")}`;
  const title = `${t("hanab")} · ${t("tagline")}`;
  const image = withBasePath("/static/hanab-192.png");

  return (
    <Head>
      <title>{title}</title>
      <link href={withBasePath("/static/favicon.ico")} rel="shortcut icon" type="image/x-icon" />
      <link href={image} rel="apple-touch-icon" />
      <link href={withBasePath("/static/manifest.json")} rel="manifest" />
      <meta content={tagline} name="Description" />

      <meta content={t("hanab")} property="og:title" />
      <meta content={tagline} property="og:description" />
      <meta content={image} property="og:image" />

      <meta content={t("hanab")} name="twitter:title" />
      <meta content={tagline} name="twitter:description" />
      <meta content={image} name="twitter:image" />
      <meta content="summary_large_image" name="twitter:card" />

      <meta content="#00153f" name="theme-color" />
    </Head>
  );
}
