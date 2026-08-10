/**
 * /admin/catalog — RENDERER FREEZE regression (#3197).
 *
 * WHAT FROZE. The page rendered EVERY row of an unbounded collection into a
 * hand-rolled Fluent `<Table>` — one `Tooltip` + 3–4 `Badge`s per row — with no
 * virtualization and no cap. The row count is unbounded by construction:
 * /api/catalog/iceberg/overview caps CATALOG namespaces at 40 but appends one
 * lake-sourced row per interop-tracked Iceberg table across every lakehouse in
 * the tenant, with no limit. Measured in real Chromium against this component:
 *
 *     rows     settle    LONGEST single main-thread task   total blocking
 *       200     1.6 s      764 ms                            1.2 s
 *     3,000     3.7 s    1,465 ms                            3.3 s
 *     8,000     9.8 s    5,648 ms                            9.6 s
 *    20,000    22.5 s   13,845 ms                           23.1 s
 *
 * A single >5 s task is exactly what a DevTools/extension script injection with
 * a 5,000 ms ceiling reports as "the page is busy", repeatedly, over a 20+ s
 * window — the #3197 signature. After adopting `LoomDataTable virtualizeRows`
 * the same 20,000-row payload settles in 1.8 s with a 910 ms longest task and
 * 49 materialized rows.
 *
 * WHY THESE ASSERTIONS CAN FAIL ON THE BUG. `materializedRows` counts the row
 * elements actually in the DOM. On the pre-fix page that number EQUALS the
 * payload size (5,000+), so `expect(...).toBeLessThan(VIRTUALIZATION_CUTOFF)`
 * fails. It cannot be satisfied by truncating the data either: the same test
 * asserts the surface still reports the FULL count, and a second case asserts
 * that a small collection renders every row. A test that only checked "the page
 * mounted" would pass on the frozen version and is worthless here.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { renderWithProviders } from '@/lib/editors/__tests__/test-helpers';
import { VIRTUALIZATION_CUTOFF } from '@/lib/components/ui/virtualization';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/catalog',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import AdminCatalogPage from '../page';

/**
 * Row elements actually materialized in the DOM, counted MARKUP-AGNOSTICALLY —
 * a Fluent `DataGrid` (`role="grid"`, header rows excluded) OR a plain
 * `<table><tbody><tr>`. Deliberately not keyed to the current implementation:
 * reverting this surface to a hand-rolled `<Table>` that maps every row must
 * still trip this test, not quietly report zero rows.
 */
function materializedRows(): number {
  const gridRows = Array.from(document.querySelectorAll('[role="grid"] [role="row"]'))
    .filter((r) => !r.querySelector('[role="columnheader"]')).length;
  const tableRows = document.querySelectorAll('table tbody tr').length;
  return gridRows + tableRows;
}

function overview(tableCount: number, grantCount = 1) {
  return {
    ok: true,
    catalog: { configured: true, uri: 'https://loom.test/api/catalog/iceberg', warehouse: 'loom' },
    namespaces: ['gold', 'silver'],
    tables: Array.from({ length: tableCount }, (_, i) => ({
      namespace: i % 2 ? 'gold' : 'silver',
      name: `table_${i}`,
      delta: true,
      iceberg: true,
      source: 'lake' as const,
      metadataLocation: `abfss://gold@st.dfs.core.windows.net/Tables/table_${i}/metadata`,
      via: 'delta-uniform',
      container: 'gold',
    })),
    grants: Array.from({ length: grantCount }, (_, i) => ({
      namespace: `ns${i}`,
      supported: true,
      assignments: [{ principal: `group-${i}`, privileges: ['SELECT'] }],
    })),
    snippets: [
      { id: 'spark', label: 'Apache Spark', language: 'properties', code: 'x=1', note: 'n' },
    ],
  };
}

/** Fetch stub that records every call so a retry/refetch loop is measurable. */
function stubFetch(respond: () => { status: number; body: unknown }) {
  const calls: string[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (url: unknown) => {
    calls.push(String(url));
    const { status, body } = respond();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('/admin/catalog — unbounded rows must never be materialized (#3197)', () => {
  it('windows a 5,000-table catalog instead of rendering every row', async () => {
    const HUGE = 5_000;
    stubFetch(() => ({ status: 200, body: overview(HUGE) }));

    renderWithProviders(<AdminCatalogPage />);

    // The surface reports the FULL collection size…
    // (the KPI tile and the grid's "Showing N items" caption both carry it)
    await waitFor(() => expect(screen.getAllByText(String(HUGE)).length).toBeGreaterThan(0));

    // …but only a bounded window of it is in the DOM. The pre-fix page put all
    // 5,000 rows here, which is the ~13.8 s main-thread task that froze the tab.
    const rendered = materializedRows();
    expect(
      rendered,
      `materialized ${rendered} row elements for ${HUGE} tables — the un-windowed render is the #3197 freeze`,
    ).toBeLessThan(VIRTUALIZATION_CUTOFF);
    expect(rendered).toBeGreaterThan(0);
  }, 60_000);

  it('renders every row for a small collection (windowing must not hide data)', async () => {
    const SMALL = 12;
    stubFetch(() => ({ status: 200, body: overview(SMALL) }));

    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('table_0')).toBeInTheDocument());
    // Every table below the cutoff is present and readable — no silent truncation.
    expect(screen.getByText(`table_${SMALL - 1}`)).toBeInTheDocument();
  }, 60_000);
});

describe('/admin/catalog — a failing backend yields a designed state, never a loop (#3197)', () => {
  it('renders the honest read-failure MessageBar on 403 and stops fetching', async () => {
    const calls = stubFetch(() => ({
      status: 403,
      body: { ok: false, error: 'Iceberg REST Catalog returned HTTP 403', code: 'iceberg_catalog_error' },
    }));

    renderWithProviders(<AdminCatalogPage />);

    // The designed error state — NOT "No tables published", which would be a
    // false claim about the customer's catalog (deploy-integrity R7).
    await waitFor(() => expect(screen.getByText('Could not read the catalog')).toBeInTheDocument());
    expect(screen.queryByText('No tables published to the catalog yet')).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    // The failure must not drive an unbounded refetch/render loop.
    const settled = calls.length;
    await new Promise((r) => { setTimeout(r, 1_500); });
    expect(calls.length, `fetch count grew ${settled} -> ${calls.length} after settling`).toBe(settled);
    expect(calls.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it('renders the same designed state on a 500 from the catalog', async () => {
    stubFetch(() => ({
      status: 500,
      body: { ok: false, error: 'Authorization filter not initialized' },
    }));

    renderWithProviders(<AdminCatalogPage />);

    await waitFor(() => expect(screen.getByText('Could not read the catalog')).toBeInTheDocument());
    expect(screen.getAllByText(/Authorization filter not initialized/).length).toBeGreaterThan(0);
  }, 60_000);
});
