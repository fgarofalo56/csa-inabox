/**
 * Custom Next.js Document for the CSA-in-a-Box Portal.
 *
 * Sets base HTML attributes, includes global meta tags, and — for
 * CSA-0020 Phase 1 — reads the per-request CSP nonce set by
 * `src/middleware.ts` and propagates it to `<NextScript>` so every
 * Next.js runtime chunk carries the matching `nonce=` attribute that
 * the `script-src 'nonce-<n>'` directive requires.
 */

import Document, {
  Html,
  Head,
  Main,
  NextScript,
  DocumentContext,
  DocumentInitialProps,
} from 'next/document';

interface CsaDocumentProps extends DocumentInitialProps {
  nonce?: string;
}

export default class CsaDocument extends Document<CsaDocumentProps> {
  static async getInitialProps(
    ctx: DocumentContext
  ): Promise<CsaDocumentProps> {
    const initialProps = await Document.getInitialProps(ctx);

    // The middleware (`src/middleware.ts`) sets `x-nonce` on the
    // request headers. In the Edge middleware pipeline, that header
    // is forwarded to SSR; we read it here so the rendered HTML can
    // stamp the nonce onto every script tag.
    //
    // `ctx.req?.headers` can be either a Node IncomingHttpHeaders
    // object (dev/standalone) or a Fetch-style Headers instance
    // (Edge). Support both without importing runtime-specific types.
    const req = ctx.req as unknown as {
      headers?:
        | { get?: (name: string) => string | null | undefined }
        | Record<string, string | string[] | undefined>;
    } | undefined;

    let nonce: string | undefined;
    const headers = req?.headers;
    if (headers) {
      if (typeof (headers as { get?: unknown }).get === 'function') {
        const got = (headers as { get: (n: string) => string | null }).get(
          'x-nonce'
        );
        nonce = got ?? undefined;
      } else {
        const raw = (headers as Record<string, string | string[] | undefined>)[
          'x-nonce'
        ];
        if (Array.isArray(raw)) {
          nonce = raw[0];
        } else if (typeof raw === 'string') {
          nonce = raw;
        }
      }
    }

    return { ...initialProps, nonce };
  }

  render() {
    const { nonce } = this.props;
    return (
      <Html lang="en">
        <Head nonce={nonce}>
          <meta charSet="utf-8" />
          <meta
            name="description"
            content="CSA-in-a-Box Data Onboarding Portal — Self-service data source registration and data marketplace."
          />
          <meta name="theme-color" content="#2563eb" />
          <link rel="icon" href="/favicon.ico" />
        </Head>
        <body className="antialiased">
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
