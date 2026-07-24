/**
 * N1 — /admin/catalog federation surface.
 *
 * Pins: real namespaces/tables with FORMAT BADGES sourced from the backend, the
 * grant mapping, the external-engine connect strings, and the honest-gate state
 * — with LOOM_ICEBERG_CATALOG_URL unset the FULL page still renders (tables Loom
 * already emitted Iceberg metadata for are listed, plus an inline Fix-it), never
 * an empty page.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders, installFetchMock } from '@/lib/editors/__tests__/test-helpers';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/catalog',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminCatalogPage from '../page';

const CONFIGURED = {
  ok: true,
  catalog: { configured: true, uri: 'https://loom.test/api/catalog/iceberg', warehouse: 'loom' },
  namespaces: ['gold', 'silver'],
  tables: [
    {
      namespace: 'gold', name: 'orders', delta: true, iceberg: true, source: 'both',
      metadataLocation: 'abfss://gold@stloom.dfs.core.windows.net/Tables/orders/metadata',
      via: 'delta-uniform', container: 'gold',
    },
    {
      namespace: 'silver', name: 'events', delta: true, iceberg: true, source: 'catalog',
      metadataLocation: null, via: null, container: null,
    },
  ],
  grants: [
    { namespace: 'gold', supported: true, assignments: [{ principal: 'analysts', privileges: ['SELECT'] }] },
    { namespace: 'silver', supported: false, assignments: [], note: 'The catalog server did not serve the permissions API (HTTP 501).' },
  ],
  snippets: [
    { id: 'spark', label: 'Apache Spark', language: 'properties', code: 'spark.sql.catalog.loom.type=rest', note: 'Iceberg Spark runtime 1.5+ required.' },
    { id: 'trino', label: 'Trino', language: 'properties', code: 'iceberg.catalog.type=rest', note: 'Trino 435+ required.' },
  ],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('/admin/catalog — configured', () => {
  it('renders KPI tiles, format badges and the catalog endpoint from real data', async () => {
    installFetchMock({ '/api/catalog/iceberg/overview': () => CONFIGURED });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('https://loom.test/api/catalog/iceberg')).toBeInTheDocument());
    expect(screen.getByText('Live')).toBeInTheDocument();

    // Both tables render with BOTH format badges — the Delta/Iceberg duality.
    expect(screen.getByText('orders')).toBeInTheDocument();
    expect(screen.getByText('events')).toBeInTheDocument();
    expect(screen.getAllByText('Delta ✓')).toHaveLength(2);
    expect(screen.getAllByText('Iceberg ✓')).toHaveLength(2);

    // KPI tiles reflect the real counts (2 namespaces, 2 tables, 2 iceberg, 1 grant).
    expect(screen.getByText('Namespaces')).toBeInTheDocument();
    expect(screen.getByText('Iceberg-readable')).toBeInTheDocument();
    expect(screen.getByText('Grant assignments')).toBeInTheDocument();
  });

  it('renders the grant mapping, including an honest unsupported note', async () => {
    installFetchMock({ '/api/catalog/iceberg/overview': () => CONFIGURED });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('analysts')).toBeInTheDocument());
    expect(screen.getByText('SELECT')).toBeInTheDocument();
    // A server with no ACL API says so instead of showing a fabricated empty ACL.
    expect(screen.getByText(/did not serve the permissions API/)).toBeInTheDocument();
  });

  it('renders the external-engine connect snippets returned by the BFF', async () => {
    installFetchMock({ '/api/catalog/iceberg/overview': () => CONFIGURED });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('Connect an external engine')).toBeInTheDocument());
    // getAllByText: an engine name appears in both the selector label and its
    // note/snippet — the assertion is "offered", not "appears exactly once".
    expect(screen.getAllByText('Apache Spark').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Trino').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/spark\.sql\.catalog\.loom\.type=rest/).length).toBeGreaterThan(0);
  });
});

describe('/admin/catalog — honest gate (catalog not deployed)', () => {
  const GATED = {
    ...CONFIGURED,
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
    namespaces: ['gold'],
    tables: [{
      namespace: 'gold', name: 'orders', delta: true, iceberg: true, source: 'lake',
      metadataLocation: 'abfss://gold@stloom.dfs.core.windows.net/Tables/orders/metadata',
      via: 'delta-uniform', container: 'gold',
    }],
    grants: [],
  };

  it('renders the gate WITH a Fix-it and still shows the lake-sourced tables', async () => {
    installFetchMock({ '/api/catalog/iceberg/overview': () => GATED });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getAllByText(/LOOM_ICEBERG_CATALOG_URL/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /fix it/i })).toBeInTheDocument();
    expect(screen.getByText('Direct-metadata mode')).toBeInTheDocument();

    // The page is NOT empty: the table Loom already exposed is listed, marked as
    // known from the lake rather than from the catalog.
    expect(screen.getByText('orders')).toBeInTheDocument();
    expect(screen.getByText('lake')).toBeInTheDocument();
  });
});

describe('/admin/catalog — guided empty state', () => {
  it('teaches the operator how to publish a table instead of rendering nothing', async () => {
    installFetchMock({
      '/api/catalog/iceberg/overview': () => ({
        ...CONFIGURED, namespaces: [], tables: [], grants: [],
      }),
    });
    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() =>
      expect(screen.getByText('No tables published to the catalog yet')).toBeInTheDocument());
    expect(screen.getByText(/Interop tab/)).toBeInTheDocument();
    expect(screen.getByText('Browse lakehouses')).toBeInTheDocument();
  });
});
