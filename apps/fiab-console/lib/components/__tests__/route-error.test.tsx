/**
 * RouteError render tests (apex A2).
 *
 * Pins the shared error-boundary body's real behavior:
 * - plain error: digest + section rendered, Try again calls reset(),
 *   Go-to-home escape hatch links to '/'
 * - chunk-load error, no guard: ONE-SHOT reload fired + sessionStorage guard
 *   set + spinner (never a flash of the error card)
 * - chunk-load error, guard already set: NO auto-reload; honest deploy-skew
 *   card with a manual Reload action
 *
 * window.location.reload is [LegacyUnforgeable] in jsdom, so the component
 * routes reloads through routeErrorInternals (swapped here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('@/lib/components/error-boundary', () => ({
  autoReport: vi.fn(async () => {}),
}));

import {
  RouteError,
  routeErrorInternals,
  isChunkLoadError,
  CHUNK_RELOAD_GUARD_PREFIX,
} from '../route-error';
import { autoReport } from '@/lib/components/error-boundary';

const realReload = routeErrorInternals.reload;
let reloadSpy: ReturnType<typeof vi.fn>;

function renderError(err: Error & { digest?: string }, opts?: { section?: string; reset?: () => void }) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <RouteError error={err} reset={opts?.reset ?? (() => {})} section={opts?.section} />
    </FluentProvider>,
  );
}

function chunkError(): Error {
  const e = new Error('Loading chunk 4821 failed. (missing: /_next/static/chunks/4821.js)');
  e.name = 'ChunkLoadError';
  return e;
}

const guardKey = `${CHUNK_RELOAD_GUARD_PREFIX}${window.location.pathname}`;

beforeEach(() => {
  reloadSpy = vi.fn();
  routeErrorInternals.reload = reloadSpy;
  window.sessionStorage.clear();
  vi.mocked(autoReport).mockClear();
});

afterEach(() => {
  routeErrorInternals.reload = realReload;
  cleanup();
});

describe('RouteError - plain render error', () => {
  it('renders section label, digest, and a working Try again -> reset()', () => {
    const reset = vi.fn();
    const err = Object.assign(new Error('boom'), { digest: 'digest-abc123' });
    renderError(err, { section: 'Governance', reset });

    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('Governance hit an unexpected error');
    expect(card).toHaveTextContent('Error digest: digest-abc123');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
    // a plain error must never trigger the skew reload
    expect(reloadSpy).not.toHaveBeenCalled();
    // the redacted auto-report funnel fired
    expect(autoReport).toHaveBeenCalledWith(err, 'render');
  });

  it('offers a Go-to-home escape hatch linking to /', () => {
    renderError(Object.assign(new Error('boom'), { digest: 'd1' }));
    const home = screen.getByRole('link', { name: /Go to home/i });
    expect(home).toHaveAttribute('href', '/');
  });
});

describe('RouteError - chunk-load (deploy-skew) branch', () => {
  it('fires a ONE-SHOT reload with a sessionStorage guard and shows a spinner (no error card flash)', () => {
    renderError(chunkError(), { section: 'Admin' });

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(guardKey)).toBe('1');
    // spinner, not the error card
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/reloading this page/i)).toBeInTheDocument();
    // skew reloads are expected, not reportable errors
    expect(autoReport).not.toHaveBeenCalled();
  });

  it('with the guard already set: no auto-reload, honest deploy-skew card with manual Reload', () => {
    window.sessionStorage.setItem(guardKey, '1');
    renderError(chunkError(), { section: 'Admin' });

    expect(reloadSpy).not.toHaveBeenCalled();
    const card = screen.getByRole('alert');
    expect(card).toHaveTextContent('This page needs a refresh');
    expect(card).toHaveTextContent(/new version of CSA Loom was deployed/i);

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // the unhealed chunk failure IS reported
    expect(autoReport).toHaveBeenCalledTimes(1);
  });
});

describe('isChunkLoadError', () => {
  it('matches webpack + native dynamic-import failure shapes and rejects plain errors', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/y.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
