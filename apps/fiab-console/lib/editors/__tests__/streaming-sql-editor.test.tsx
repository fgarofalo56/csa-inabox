/**
 * N7a — Streaming SQL (RisingWave) editor.
 *
 * Pins the behaviours the surface is judged on:
 *   • it renders FULLY in both states — badging the real engine when the
 *     RisingWave tier is wired, and rendering the Author surface + an honest
 *     Fix-it gate (never a blocked / red-on-first-open surface) when not;
 *   • Materialize / Preview post to the audited BFF;
 *   • the FLAG0 kill switch reverts the surface to a guided notice.
 *
 * The editor chrome is substituted so the spec exercises THIS surface.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from './test-helpers';

vi.mock('../item-editor-chrome', () => ({
  ItemEditorChrome: ({ main }: { main: React.ReactNode }) => <div data-testid="chrome">{main}</div>,
}));
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: ({ value, onChange, ariaLabel }: any) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// #3546 — spy on the REAL clientFetch (not a fetch-level mock) so the test can
// read the third (options) argument each call site passes, which is where the
// call-site-specific timeout copy lives.
vi.mock('@/lib/client-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/client-fetch')>();
  return { ...actual, clientFetch: vi.fn(actual.clientFetch) };
});

let flagValue = true;
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => flagValue }));

import { StreamingSqlEditor, RISINGWAVE_TIMEOUT_HINT } from '../streaming-sql-editor';
import { clientFetch } from '@/lib/client-fetch';

const ITEM = makeItem('streaming-sql', 'Streaming SQL');

const CONFIGURED = {
  ok: true, configured: true, engine: 'risingwave', version: 'RisingWave 2.1.3 (single-node)',
  kafkaBootstrap: 'loomhub.servicebus.windows.net:9093',
  materializedViews: [{ name: 'orders_enriched', schema: 'public', rowCount: 42, progress: undefined }],
  sourceCount: 2, sinkCount: 1,
};

const GATED = {
  ok: true, configured: false, engine: 'risingwave', kafkaBootstrap: null,
  note: 'The RisingWave stateful-streaming tier is not deployed in this environment.',
  gate: {
    id: 'svc-loom-risingwave',
    title: 'Streaming SQL tier (RisingWave Container App)',
    remediation: 'Set LOOM_RISINGWAVE_URL to the internal-ingress FQDN of the loom-risingwave Container App.',
    fixItHref: '/admin/gates?gate=svc-loom-risingwave',
    missing: ['LOOM_RISINGWAVE_URL'],
  },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); flagValue = true; (clientFetch as unknown as ReturnType<typeof vi.fn>).mockClear?.(); });

describe('StreamingSqlEditor — tier wired', () => {
  it('badges the real engine version and shows the live view counts', async () => {
    installFetchMock({ '/api/streaming-sql/status': () => CONFIGURED });
    renderWithProviders(<StreamingSqlEditor item={ITEM} id="ss-1" />);
    await waitFor(() => expect(screen.getByText('RisingWave 2.1.3')).toBeInTheDocument());
    expect(screen.getByText('1 views · 2 sources · 1 sinks')).toBeInTheDocument();
  });

  it('Materialize posts the authored DDL to the audited BFF', async () => {
    const { calls } = installFetchMock({
      '/api/streaming-sql/status': () => CONFIGURED,
      '/api/streaming-sql/mv': () => ({ ok: true, command: 'CREATE_MATERIALIZED_VIEW' }),
    });
    renderWithProviders(<StreamingSqlEditor item={ITEM} id="ss-1" />);
    await waitFor(() => expect(screen.getByText('RisingWave 2.1.3')).toBeInTheDocument());
    // The primary Materialize button in the toolbar.
    fireEvent.click(screen.getAllByRole('button', { name: /Materialize/ })[0]);
    await waitFor(() => expect(screen.getByText(/maintaining it incrementally/)).toBeInTheDocument());
    const post = calls.find((c) => c.url.includes('/api/streaming-sql/mv'));
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post!.init!.body))).toMatchObject({ itemId: 'ss-1' });
  });

  // #3546 (deploy-integrity.md R7) — every clientFetch call this surface makes
  // must carry RISINGWAVE_TIMEOUT_HINT, never clientFetch's default "heavier
  // across multiple subscriptions" copy, which asserts a cause (sub fan-out)
  // this single-instance streaming engine never has. BREAKS if the third
  // argument is dropped from any call site, or if the hint text regresses to
  // mention "subscriptions".
  it('every clientFetch call carries the RisingWave-accurate timeout hint, never the generic cross-subscription one', async () => {
    installFetchMock({
      '/api/streaming-sql/status': () => CONFIGURED,
      '/api/streaming-sql/mv': () => ({ ok: true, command: 'CREATE_MATERIALIZED_VIEW' }),
    });
    renderWithProviders(<StreamingSqlEditor item={ITEM} id="ss-1" />);
    await waitFor(() => expect(screen.getByText('RisingWave 2.1.3')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /Materialize/ })[0]);
    await waitFor(() => expect(screen.getByText(/maintaining it incrementally/)).toBeInTheDocument());

    const mock = clientFetch as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(2); // status + mv
    for (const args of mock.mock.calls) {
      const opts = args[2] as { timeoutHint?: string } | number | undefined;
      expect(typeof opts).toBe('object');
      expect((opts as { timeoutHint?: string }).timeoutHint).toBe(RISINGWAVE_TIMEOUT_HINT);
    }
    expect(RISINGWAVE_TIMEOUT_HINT).not.toMatch(/multiple subscriptions/i);
  });
});

describe('StreamingSqlEditor — tier not deployed (honest gate, clean first-open)', () => {
  it('renders the full Author surface + the Fix-it gate, no error banner', async () => {
    installFetchMock({ '/api/streaming-sql/status': () => GATED });
    renderWithProviders(<StreamingSqlEditor item={ITEM} id="ss-1" />);
    await waitFor(() => expect(screen.getByText('Not deployed')).toBeInTheDocument());
    // The authoring surface is present, not gated away.
    expect(screen.getByLabelText('Streaming SQL editor')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Materialize/ }).length).toBeGreaterThan(0);
    // All three tabs remain reachable.
    expect(screen.getByRole('tab', { name: /Materialized views/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Sources & sinks/ })).toBeInTheDocument();
    // No error MessageBar on a freshly-opened, untouched item.
    expect(screen.queryByText('That statement failed')).toBeNull();
  });
});

describe('StreamingSqlEditor — FLAG0 kill switch', () => {
  it('reverts to a guided notice that says the backend is untouched', async () => {
    flagValue = false;
    installFetchMock({ '/api/streaming-sql/status': () => CONFIGURED });
    renderWithProviders(<StreamingSqlEditor item={ITEM} id="ss-1" />);
    await waitFor(() => expect(screen.getByText('Streaming SQL is turned off for this deployment')).toBeInTheDocument());
    expect(screen.getByText(/Runtime flags/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Author/ })).toBeNull();
  });
});
