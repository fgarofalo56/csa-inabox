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
        lakehouseId: 'lh-1', tableName: 'customers', iceberg: true,
      });
      // The state read names the item too (breaks if it goes back to ?container=).
      const get = calls.find((c) => c.url.includes('/api/lakehouse/interop?') && c.init?.method !== 'PUT');
      expect(get?.url).toContain('lakehouseId=lh-1');
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

describe('InteropPane — namespace', () => {
  const WITH_DEFAULT = { ...CONFIGURED, defaultNamespace: 'lh_0123456789ab' };

  it('shows the lakehouse default namespace for a table with no state', async () => {
    installFetchMock({ '/api/lakehouse/interop': () => WITH_DEFAULT });
    mount();
    // Breaks if the fallback goes back to the container name ('gold (default)').
    await waitFor(() => expect(screen.getByText('lh_0123456789ab (default)')).toBeInTheDocument());
    expect(screen.queryByText('gold (default)')).toBeNull();
  });

  it('offers the lakehouse namespace when the catalog name is taken, and re-sends with it', async () => {
    let puts = 0;
    const { calls } = installFetchMock({
      '/api/lakehouse/interop': (_u, init) => {
        if (init?.method !== 'PUT') return WITH_DEFAULT;
        puts += 1;
        return puts === 1
          ? {
            ...WITH_DEFAULT, ok: true, pool: 'loompool',
            catalogNote: 'The catalog already has gold.customers pointing at a different table.',
            catalogCode: 'catalog_name_taken',
            catalogRemediation: 'Register the table under lh_0123456789ab.',
            suggestedNamespace: 'lh_0123456789ab',
          }
          : { ...WITH_DEFAULT, ok: true, pool: 'loompool' };
      },
    });
    mount();
    await waitFor(() => expect(screen.getByLabelText('Expose customers as Iceberg')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Expose customers as Iceberg'));

    // Breaks if the pane ignores catalogCode (no offer is rendered).
    await waitFor(() => expect(screen.getByText('Catalog name in use')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Register as lh_0123456789ab.customers' }));

    await waitFor(() => {
      const bodies = calls.filter((c) => c.init?.method === 'PUT').map((c) => JSON.parse(String(c.init!.body)));
      // Breaks if the retry omits the offered namespace.
      expect(bodies).toEqual([
        { lakehouseId: 'lh-1', tableName: 'customers', iceberg: true },
        { lakehouseId: 'lh-1', tableName: 'customers', iceberg: true, namespace: 'lh_0123456789ab' },
      ]);
    });
    await waitFor(() => expect(screen.queryByText('Catalog name in use')).toBeNull());
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

describe('InteropPane — refused toggle', () => {
  const ERROR = 'Your role on this lakehouse is read-only.';
  const REMEDIATION = 'Ask a workspace Member or Admin to make the change.';

  it('reports the error and the remediation together', async () => {
    installFetchMock({
      '/api/lakehouse/interop': (_u, init) =>
        init?.method === 'PUT' ? { ok: false, code: 'read_only', error: ERROR, remediation: REMEDIATION } : CONFIGURED,
    });
    const setActionError = vi.fn();
    const setActionStatus = vi.fn();
    mount({ setActionError, setActionStatus });
    await waitFor(() => expect(screen.getByLabelText('Expose customers as Iceberg')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Expose customers as Iceberg'));
    // Breaks if `remediation` is dropped (the message would be ERROR alone).
    await waitFor(() => expect(setActionError).toHaveBeenLastCalledWith(`${ERROR} ${REMEDIATION}`));
    // Breaks if a refusal is reported as a submitted job.
    expect(setActionStatus).not.toHaveBeenCalled();
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
