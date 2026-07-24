/**
 * N1 — Lakehouse → Interop tab.
 *
 * Pins the behaviours the item is judged on: real format badges per table
 * (Delta ✓ always, Iceberg ✓ only when the backend says so), a toggle that
 * PUTs the real BFF, connect snippets for every external engine, and the
 * HONEST-GATE state — when the catalog service is unset the FULL surface still
 * renders (no empty tab, no red-on-first-open) because dual metadata works
 * without it.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '../../__tests__/test-helpers';
import { InteropPane } from '../panes/interop-pane';
import { LakehouseEditorContext } from '../lakehouse-editor-context';
import type { LakehouseEditorCtx } from '../lakehouse-editor-context';

function ctx(overrides: Partial<LakehouseEditorCtx> = {}): LakehouseEditorCtx {
  return {
    id: 'lh-1',
    activeContainer: 'gold',
    liveTables: [
      { schema: 'dbo', name: 'orders', adlsPath: 'Tables/orders', bulkUrl: '', format: 'delta', status: 'ok', latestVersion: 3, rowCount: 10, sizeBytes: 1, lastModified: null },
      { schema: 'dbo', name: 'customers', adlsPath: 'Tables/customers', bulkUrl: '', format: 'delta', status: 'ok', latestVersion: 1, rowCount: 5, sizeBytes: 1, lastModified: null },
    ],
    liveTablesLoading: false,
    liveTablesError: null,
    liveTablesGate: null,
    setActionError: () => {},
    setActionStatus: () => {},
    ...overrides,
  } as unknown as LakehouseEditorCtx;
}

function mount(overrides: Partial<LakehouseEditorCtx> = {}) {
  return renderWithProviders(
    <LakehouseEditorContext.Provider value={ctx(overrides)}>
      <InteropPane />
    </LakehouseEditorContext.Provider>,
  );
}

const CONFIGURED = {
  ok: true,
  container: 'gold',
  account: 'stloom',
  defaultPool: 'loompool',
  catalog: { configured: true, uri: 'https://loom.test/api/catalog/iceberg', warehouse: 'loom' },
  tables: [
    {
      table: 'orders',
      namespace: 'gold',
      delta: true,
      iceberg: true,
      via: 'delta-uniform',
      metadataLocation: 'abfss://gold@stloom.dfs.core.windows.net/Tables/orders/metadata',
      updatedAt: '2026-07-23T00:00:00.000Z',
      updatedBy: 'admin@contoso.com',
      icebergTableName: 'orders',
    },
  ],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('InteropPane — configured catalog', () => {
  it('shows the live catalog endpoint and per-table format badges', async () => {
    installFetchMock({ '/api/lakehouse/interop': () => CONFIGURED });
    mount();

    await waitFor(() => expect(screen.getByText('https://loom.test/api/catalog/iceberg')).toBeInTheDocument());
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('warehouse: loom')).toBeInTheDocument();

    // Both live Delta tables render; only `orders` is Iceberg-exposed.
    expect(screen.getByText('orders')).toBeInTheDocument();
    expect(screen.getByText('customers')).toBeInTheDocument();
    expect(screen.getAllByText('Delta ✓')).toHaveLength(2);
    expect(screen.getAllByText('Iceberg ✓')).toHaveLength(1);
    expect(screen.getAllByText('Iceberg —')).toHaveLength(1);
  });

  it('PUTs the real BFF when a table is switched on', async () => {
    const { calls } = installFetchMock({
      '/api/lakehouse/interop': (_u, init) =>
        init?.method === 'PUT'
          ? { ...CONFIGURED, ok: true, pool: 'loompool', table: 'customers', iceberg: true }
          : CONFIGURED,
    });
    mount();

    await waitFor(() => expect(screen.getByLabelText('Expose customers as Iceberg')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Expose customers as Iceberg'));

    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT');
      expect(put, 'a PUT to /api/lakehouse/interop must be issued').toBeTruthy();
      expect(JSON.parse(String(put!.init!.body))).toEqual({
        container: 'gold', tableName: 'customers', iceberg: true,
      });
    });
  });

  it('renders a connect snippet for every external engine', async () => {
    installFetchMock({ '/api/lakehouse/interop': () => CONFIGURED });
    mount();

    // Wait for the CONFIGURED signal specifically — "Connect an external engine"
    // renders in the direct-metadata (unconfigured) state too, so waiting on it
    // let the assertions run before the catalog payload landed.
    await waitFor(() =>
      expect(screen.getByText('https://loom.test/api/catalog/iceberg')).toBeInTheDocument(),
    );
    for (const engine of ['Apache Spark', 'Trino', 'DuckDB', 'Snowflake', 'Databricks']) {
      // getAllByText: an engine name legitimately appears more than once (the
      // selector label AND its snippet/note) — the assertion is "offered", not "unique".
      expect(screen.getAllByText(engine).length).toBeGreaterThan(0);
    }
    // The default (Spark) snippet is real Iceberg REST catalog configuration
    // pointed at the audited Loom proxy — never at the internal container.
    // Assert on concatenated textContent, not a single element: the code block
    // may tokenize a line across spans, which breaks per-element text matching.
    const rendered = document.body.textContent ?? '';
    expect(rendered).toContain('org.apache.iceberg.spark.SparkCatalog');
    // SECURITY: the snippet must point external engines at the AUDITED Loom
    // proxy, never at the internal-ingress catalog container.
    expect(rendered).toContain('uri=https://loom.test/api/catalog/iceberg');
  });
});

describe('InteropPane — honest gate (catalog not deployed)', () => {
  const GATED = {
    ...CONFIGURED,
    tables: [],
    catalog: {
      configured: false,
      uri: 'https://loom.test/api/catalog/iceberg',
      warehouse: 'loom',
      gate: {
        id: 'svc-iceberg-catalog',
        title: 'Iceberg REST Catalog (Unity Catalog OSS container)',
        remediation: 'Set LOOM_ICEBERG_CATALOG_URL to the internal-ingress FQDN of the iceberg-catalog Container App.',
        fixItHref: '/admin/gates?gate=svc-iceberg-catalog',
        missing: ['LOOM_ICEBERG_CATALOG_URL'],
      },
    },
  };

  it('still renders the FULL surface — tables, snippets and the gate with Fix-it', async () => {
    installFetchMock({ '/api/lakehouse/interop': () => GATED });
    mount();

    // The gate names the exact env var and offers a Fix-it — not a dead banner.
    await waitFor(() => expect(screen.getAllByText(/LOOM_ICEBERG_CATALOG_URL/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();

    // …and the rest of the tab is intact: tables still listed as Delta ✓,
    // snippets still rendered. Nothing is hidden behind the gate.
    expect(screen.getAllByText('Delta ✓')).toHaveLength(2);
    expect(screen.getByText('Connect an external engine')).toBeInTheDocument();
    expect(screen.getByText('Direct-metadata mode')).toBeInTheDocument();
  });

  it('surfaces an honest lake-storage gate without turning the tab red', async () => {
    installFetchMock({
      '/api/lakehouse/interop': () => ({
        ...GATED,
        account: null,
        accountGate: 'No Loom ADLS Gen2 account is configured. Set LOOM_GOLD_URL on the Console Container App.',
      }),
    });
    mount();
    await waitFor(() => expect(screen.getByText('Lake storage not configured')).toBeInTheDocument());
    expect(screen.getAllByText(/LOOM_GOLD_URL/).length).toBeGreaterThan(0);
  });
});

describe('InteropPane — guided empty states', () => {
  it('guides the user to pick a container instead of rendering an empty pane', () => {
    installFetchMock({ '/api/lakehouse/interop': () => CONFIGURED });
    mount({ activeContainer: null });
    expect(screen.getByText('Pick a lakehouse container')).toBeInTheDocument();
  });

  it('guides the user to create a table when the container has none', async () => {
    installFetchMock({ '/api/lakehouse/interop': () => ({ ...CONFIGURED, tables: [] }) });
    mount({ liveTables: [] });
    await waitFor(() =>
      expect(screen.getByText('No Delta tables in this container yet')).toBeInTheDocument());
  });
});
