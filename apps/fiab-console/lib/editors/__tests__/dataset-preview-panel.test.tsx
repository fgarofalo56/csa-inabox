/**
 * Foundry dataset editor, "Data & schema" tab — the preview and the schema
 * profile are both read from the dataset's own route,
 * GET /api/items/dataset/<id>/preview, which resolves the asset's data URI
 * server-side. The profile is the route's `profile` over a larger sample.
 *
 * What breaks these: the panel building a storage request from the data URI
 * itself (no call to the dataset route), the profile reading anything other than
 * the route's `profile`, or a refusal body being shown as a blank grid.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

type Handler = (url: string) => { status?: number; body: unknown };
let calls: string[] = [];

function installStatusFetch(handlers: Record<string, Handler>) {
  calls = [];
  const keys = Object.keys(handlers).sort((a, b) => b.length - a.length);
  vi.spyOn(global, 'fetch').mockImplementation((async (input: any) => {
    const u = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push(u);
    const key = keys.find((k) => u.includes(k));
    const { status = 200, body } = key ? handlers[key](u) : { body: { ok: true } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as any);
}

const DATA_URI = 'abfss://bronze@acct.dfs.core.windows.net/sales/orders.csv';
const DETAIL = { ok: true, asset: { name: 'orders', dataUri: DATA_URI }, versions: [{ version: '1', dataUri: DATA_URI, dataType: 'uri_file' }] };
// A distinctive cell value, so the grid assertion can only pass if these rows rendered.
const PREVIEW = {
  ok: true, previewable: true, columns: ['region', 'amount'],
  rows: [['north-7731', 10], ['south-7731', 20], ['east-7731', 30]], rowCount: 3, executionMs: 12, truncated: false,
  profile: { region: { count: 3, nullCount: 0, distinct: 3, min: 'east-7731', max: 'south-7731', mean: null, stddev: null },
    amount: { count: 3, nullCount: 0, distinct: 3, min: '10', max: '30', mean: 20, stddev: 8.16 } },
};

async function openDataTab() {
  const { DatasetEditor } = await import('../foundry-sub-editors');
  const { makeItem } = await import('./test-helpers');
  render(<FluentProvider theme={webLightTheme}><DatasetEditor item={makeItem('dataset', 'Data asset')} id="ds-1" /></FluentProvider>);
  fireEvent.click(await screen.findByRole('tab', { name: /Data & schema/ }, { timeout: 5000 }));
}

const datasetPreviewCalls = () => calls.filter((u) => u.includes('/api/items/dataset/ds-1/preview'));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Foundry dataset, Data & schema tab', () => {
  it('previews through the dataset route and profiles from its profile field', async () => {
    installStatusFetch({
      '/api/items/dataset/ds-1/preview': () => ({ body: PREVIEW }),
      '/api/items/dataset/ds-1/lineage': () => ({ body: { ok: true, producers: [], consumers: [] } }),
      '/api/items/dataset/ds-1': () => ({ body: DETAIL }),
    });
    await openDataTab();

    // Positive arm: the rows from the route render.
    expect(await screen.findByText('north-7731', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(datasetPreviewCalls()).toHaveLength(1);
    expect(new URL(datasetPreviewCalls()[0], 'http://x').searchParams.get('top')).toBe('50');
    // Breaks if the panel still derives a storage request from the data URI.
    expect(calls.filter((u) => u.includes('/api/lakehouse/'))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: /Profile schema/ }));
    // Breaks if the profile does not come from this route's sample (the caption carries rowCount=3).
    expect(await screen.findByText(/Profile computed over a sample of 3 rows\./, {}, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(datasetPreviewCalls()).toHaveLength(2));
    expect(new URL(datasetPreviewCalls()[1], 'http://x').searchParams.get('top')).toBe('1000');
    expect(calls.filter((u) => u.includes('/api/lakehouse/'))).toEqual([]);
  });

  it('shows the route refusal instead of an empty grid', async () => {
    installStatusFetch({
      '/api/items/dataset/ds-1/preview': () => ({ status: 422, body: { ok: false, previewable: false, error: 'dataUri is not an ADLS path (azureml://x); preview supports abfss:// / https:// DLZ paths.' } }),
      '/api/items/dataset/ds-1/lineage': () => ({ body: { ok: true, producers: [], consumers: [] } }),
      '/api/items/dataset/ds-1': () => ({ body: DETAIL }),
    });
    await openDataTab();
    expect(await screen.findByText(/dataUri is not an ADLS path/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Profile schema/ })).toBeNull();
  });
});
