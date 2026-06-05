'use client';

/**
 * Griffel SSR registry for the Next.js App Router.
 *
 * Without this, Fluent v9 (Griffel) injects its CSS on the CLIENT after
 * hydration, so the server-rendered HTML arrives unstyled for a beat and the
 * page visibly "loses all formatting" before re-rendering — a flash of
 * unstyled content (FOUC) on load and route transitions.
 *
 * This wraps the app in a per-request Griffel renderer and uses Next's
 * `useServerInsertedHTML` to flush the collected `<style>` elements INTO the
 * streamed server HTML for every route, so styles are present on first paint.
 * Must sit ABOVE <FluentProvider> so makeStyles uses this renderer.
 */

import * as React from 'react';
import { useServerInsertedHTML } from 'next/navigation';
import {
  createDOMRenderer,
  RendererProvider,
  renderToStyleElements,
  SSRProvider,
} from '@fluentui/react-components';

export function FluentSSR({ children }: { children: React.ReactNode }) {
  const [renderer] = React.useState(() => createDOMRenderer());

  useServerInsertedHTML(() => <>{renderToStyleElements(renderer)}</>);

  return (
    <RendererProvider renderer={renderer}>
      <SSRProvider>{children}</SSRProvider>
    </RendererProvider>
  );
}
