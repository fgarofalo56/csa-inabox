/**
 * #3904 — the TABLE path deliverables, asserted at the REQUEST.
 *
 * WHY THIS FILE EXISTS. The first cut of this fix shipped three real
 * corrections with no guard that could detect their removal:
 *
 *   - `previewTable(containerRelativePath(...))`  (tables-pane)
 *   - `openTableHistory(containerRelativePath(...))` (the live-catalog tree)
 *   - `tablesPrefix` in place of a hard-coded `'Tables'`
 *
 * Reverting all three to their pre-PR form left the suite GREEN, because the
 * only thing importing `containerRelativePath` in any spec was the helper's own
 * unit test — and **a pure-helper unit test cannot detect that the call sites
 * stopped calling it.** That is precisely the argument this PR makes for its own
 * binding spec ("an assertion about the REQUEST, not the helper"); it simply was
 * not applied here. It is now.
 *
 * `scanLakehouseTables` returns `adlsPath` as `<container>/<root>/Tables/<name>`
 * while `/api/lakehouse/{preview,history}` take a container PLUS a
 * container-relative path, so the pre-fix code asked for
 * `landing/landing/lakehouses/Foo/…`. Every assertion below is "the container
 * appears exactly once", which is the property that was broken.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { renderWithProviders, installFetchMock, makeItem } from '../../__tests__/test-helpers';
import { LakehouseEditor } from '../lakehouse-editor-shell';

const ROOT = 'lakehouses/Contoso Sales';

const CONTAINERS = {
  ok: true,
  containers: [
    { name: 'bronze', url: 'https://acct.dfs.core.windows.net/bronze' },
    { name: 'landing', url: 'https://acct.dfs.core.windows.net/landing' },
  ],
};

/** Exactly what scanLakehouseTables emits: adlsPath carries the container. */
const LIVE_TABLE = {
  schema: 'landing',
  name: 'dim_customer',
  adlsPath: `landing/${ROOT}/Tables/dim_customer`,
  bulkUrl: `https://acct.dfs.core.windows.net/landing/${ROOT}/Tables/dim_customer`,
  format: 'delta',
  status: 'ok',
  latestVersion: 3,
  rowCount: 6,
  sizeBytes: 2048,
  lastModified: '2026-08-20T00:00:00.000Z',
};

const ITEM = {
  id: 'lh-3904',
  workspaceId: 'ws-1',
  itemType: 'lakehouse',
  displayName: 'Contoso Sales',
  state: {
    provisioning: {
      status: 'created',
      secondaryIds: { backend: 'azure-native-adls', container: 'landing', rootPath: ROOT },
    },
  },
};

function mount(over: Record<string, (url: string, init?: RequestInit) => unknown> = {}) {
  const mock = installFetchMock({
    '/api/lakehouse/containers': () => CONTAINERS,
    '/api/lakehouse/paths': () => ({ ok: true, paths: [] }),
    '/api/cosmos-items/lakehouse/lh-3904': () => ITEM,
    '/api/lakehouse/tables': () => ({ ok: true, tables: [LIVE_TABLE] }),
    '/api/lakehouse/preview': () => ({ ok: true, columns: [], rows: [] }),
    '/api/lakehouse/history': () => ({ ok: true, versions: [] }),
    ...over,
  });
  renderWithProviders(<LakehouseEditor item={makeItem('lakehouse', 'Lakehouse')} id="lh-3904" />);
  return mock;
}

function paramsFor(calls: Array<{ url: string }>, route: string) {
  const hit = calls.find((c) => c.url.includes(route));
  return hit ? new URL(hit.url, 'http://localhost').searchParams : null;
}

/** Wait for the editor to bind to `landing`, then open the Tables tab. */
async function openTablesTab(calls: Array<{ url: string }>) {
  await waitFor(() => expect(calls.some((c) => c.url.includes('container=landing'))).toBe(true));
  fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }));
  await waitFor(() => expect(calls.some((c) => c.url.includes('/api/lakehouse/tables'))).toBe(true));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("#3904 — table actions address the lakehouse root ONCE, not twice", () => {
  it('Preview asks for container=landing + a path with a SINGLE landing', async () => {
    const { calls } = mount();
    await openTablesTab(calls);

    // The row's Preview (title disambiguates it from the ribbon's).
    fireEvent.click(await screen.findByTitle('Sample 1,000 rows'));

    await waitFor(() => expect(paramsFor(calls, '/api/lakehouse/preview')).not.toBeNull());
    const p = paramsFor(calls, '/api/lakehouse/preview')!;
    expect(p.get('container')).toBe('landing');
    expect(p.get('path')).toBe(`${ROOT}/Tables/dim_customer`);
    // The defect, stated as the property it broke.
    expect(p.get('path')).not.toContain('landing/landing');
    expect(p.get('path')!.startsWith('landing/')).toBe(false);
  });

  it('History asks for a tablePath with a SINGLE landing', async () => {
    const { calls } = mount();
    await openTablesTab(calls);

    fireEvent.click(await screen.findByTitle('Delta version history'));

    await waitFor(() => expect(paramsFor(calls, '/api/lakehouse/history')).not.toBeNull());
    const p = paramsFor(calls, '/api/lakehouse/history')!;
    expect(p.get('container')).toBe('landing');
    expect(p.get('tablePath')).toBe(`${ROOT}/Tables/dim_customer`);
    expect(p.get('tablePath')).not.toContain('landing/landing');
  });

  it('the container is stripped ONCE, at the catalog boundary', async () => {
    // Both call sites read `relPath` off the catalog response rather than
    // stripping it themselves, so this is the single derivation both depend on.
    // If it regressed to the raw `adlsPath`, BOTH requests above go wrong — and
    // a site that forgot to strip is no longer possible to write.
    const { calls } = mount();
    await openTablesTab(calls);
    // History first: Preview navigates to the Preview tab, which unmounts this pane.
    fireEvent.click(await screen.findByTitle('Delta version history'));
    fireEvent.click(await screen.findByTitle('Sample 1,000 rows'));

    await waitFor(() => {
      expect(paramsFor(calls, '/api/lakehouse/preview')).not.toBeNull();
      expect(paramsFor(calls, '/api/lakehouse/history')).not.toBeNull();
    });
    expect(paramsFor(calls, '/api/lakehouse/preview')!.get('path'))
      .toBe(paramsFor(calls, '/api/lakehouse/history')!.get('tablePath'));
  });

  it('the empty Tables surface names <root>/Tables, not the container root', async () => {
    // `tablesPrefix` — reverting it to the literal 'Tables' points every
    // table-scoped affordance at a directory this lakehouse does not own.
    const { calls } = mount({ '/api/lakehouse/tables': () => ({ ok: true, tables: [] }) });
    await openTablesTab(calls);

    await waitFor(() =>
      expect(screen.getAllByText(`/landing/${ROOT}/Tables/`).length).toBeGreaterThan(0));
    // …and never the container-root form the pre-fix code produced.
    expect(screen.queryByText('/landing/Tables/')).toBeNull();
  });
});
