import { Head, Html, Main, NextScript } from "next/document";
import React from "react";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/*
          The game's fonts. A <link> rather than an @import inside a <style>: React escapes the
          quotes and ampersands of a <style>'s text in the pre-rendered HTML, which broke the URLs
          (the browser requested "<page>/&") until the page hydrated.
        */}
        <link
          href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Kalam&display=swap"
          rel="stylesheet"
        />
        {/* this font is used by the BuymeacoffeeButton component*/}
        <link href="https://fonts.googleapis.com/css?family=Cookie&display=optional" rel="stylesheet" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
