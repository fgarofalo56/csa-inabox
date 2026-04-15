/**
 * Custom Next.js Document for the CSA-in-a-Box Portal.
 * Sets base HTML attributes and includes global meta tags.
 */

import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta name="description" content="CSA-in-a-Box Data Onboarding Portal — Self-service data source registration and data marketplace." />
        <meta name="theme-color" content="#2563eb" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
