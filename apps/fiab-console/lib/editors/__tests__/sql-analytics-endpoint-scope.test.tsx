/**
 * SQL analytics endpoint editor: what a caller who is not a tenant admin is
 * told and can pick, and how a query the route chose not to run is shown.
 *
 * The editor posts to `/api/items/sql-analytics-endpoint/[id]/query`, which
 * re-exports the serverless SQL pool query route: for a caller who is not a
 * tenant admin that route runs only classifier-accepted SELECT text in master,
 * and refuses anything else with `{ ok:false, code, error, remediation }`.
 *
 * What breaks each case:
 *   - scope note: `<SqlPoolQueryScopeNote />` removed, or shown to an admin.
 *   - Connect to, opened with `?database=reports`: a non-admin's picker left
 *     live, or the query sent `reports` for a non-admin (the editor ignoring the
 *     pin). The admin case is the positive half: live picker, `reports` sent.
 *   - refusal: the Messages tab keeping the red "Query failed" bar with no
 *     "What to do:" line, or the Results caption keeping "Query failed".
 *   - ribbon templates: a non-admin's New view / Grant access left enabled, or an
 *     admin's disabled. The REAL Ribbon renders here so the reason (`title`) is
 *     read from what the product shows. For a non-admin they stay focusable
 *     (`aria-disabled`) and are named in the visible scope note.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeItem, installFetchMock } from './test-helpers';
import { SessionProvider } from '@/lib/components/session-context';
import { analyzeLakehouseQuery } from '@/app/api/items/lakehouse/_lib/query-scope';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@fluentui/react-components', async () => {
  const actual = await vi.importActual<any>('@fluentui/react-components');
  return {
    ...actual,
    MessageBar: (p: any) => <div data-intent={p.intent}><actual.MessageBar {...p} /></div>,
  };
});
vi.mock('@/lib/editors/item-editor-chrome', async () => {
  const { Ribbon } = await vi.importActual<any>('@/lib/components/ribbon');
  return {
    ItemEditorChrome: ({ ribbon, leftPanel, main }: any) => (
      <div data-testid="chrome">
        <Ribbon tabs={ribbon} />
        <div data-testid="left-panel">{leftPanel}</div>
        <main data-testid="main-panel">{main}</main>
      </div>
    ),
  };
});

import { SqlAnalyticsEndpointEditor } from '../sql-analytics-endpoint-editor';

const REMEDIATION = 'Read files under a lakehouse root in this workspace. Remediation-6120.';

function mount(isTenantAdmin: boolean, queryBody: unknown = { ok: true, columns: ['smoke'], rows: [[1]] }) {
  const mock = installFetchMock({
    '/schema': () => ({ ok: true, endpoint: 'loom-ondemand.sql.azuresynapse.net', databases: ['reports'] }),
    '/objects': () => ({ ok: true, database: 'master', views: [], procedures: [], functions: [], externalTables: [], columns: {} }),
    '/query': () => queryBody,
  });
  render(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      <SqlAnalyticsEndpointEditor item={makeItem('sql-analytics-endpoint', 'SQL analytics endpoint')} id="ep-1" />
    </SessionProvider>,
  );
  return mock;
}

async function clickRun() {
  const runs = await screen.findAllByRole('button', { name: /^Run$/ }, { timeout: 5000 });
  fireEvent.click(runs[runs.length - 1]);
}

function postedQuery(calls: Array<{ url: string; init?: RequestInit }>) {
  return JSON.parse(String(calls.find((c) => c.url.includes('/query'))!.init!.body));
}

const intents = () =>
  Array.from(document.querySelectorAll('[data-intent]')).map((n) => n.getAttribute('data-intent'));

afterEach(() => { cleanup(); vi.restoreAllMocks(); nav.search = ''; });

describe('SqlAnalyticsEndpointEditor — query scope', () => {
  it('tells a caller who is not a tenant admin what they can query, and pins Connect to at master', async () => {
    nav.search = 'database=reports';
    const { calls } = mount(false);
    const note = await screen.findByTestId('sql-pool-query-scope', {}, { timeout: 5000 });
    expect(note.textContent).toContain('Queries run in master');
    const picker = await screen.findByRole('combobox', {}, { timeout: 5000 });
    expect(picker.textContent).toContain('master');
    expect(picker.hasAttribute('disabled') || picker.getAttribute('aria-disabled') === 'true').toBe(true);
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    // 'reports' here means the linked database was sent for a non-admin.
    expect(postedQuery(calls).database).toBe('master');
  });

  it('shows a tenant admin no note and a live picker, and sends the linked database (positive half)', async () => {
    nav.search = 'database=reports';
    const { calls } = mount(true);
    const picker = await screen.findByRole('combobox', {}, { timeout: 5000 });
    expect(picker.textContent).toContain('reports');
    expect(picker.hasAttribute('disabled') || picker.getAttribute('aria-disabled') === 'true').toBe(false);
    expect(screen.queryByTestId('sql-pool-query-scope')).toBeNull();
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    expect(postedQuery(calls).database).toBe('reports');
  });

  it('shows a refused query as a warning, "Query not run", with the route\'s remediation', async () => {
    mount(false, {
      ok: false, code: 'query_location_outside_root',
      error: "This editor runs read-only SELECT queries. The location 'https://x' is not accepted.",
      remediation: REMEDIATION,
    });
    await clickRun();
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-6120'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query not run');
    expect(text).toContain('What to do:');
    expect(text).not.toContain('Query failed');
    expect(intents()).toContain('warning');
    expect(intents()).not.toContain('error');
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Query not run — see the'), { timeout: 5000 });
  });

  it('keeps a query that ran and failed as an error, "Query failed"', async () => {
    mount(false, { ok: false, error: 'Invalid object name Sentinel-2290.', sqlNumber: 208 });
    await clickRun();
    await waitFor(() => expect(document.body.textContent).toContain('Sentinel-2290'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query failed (Msg 208)');
    expect(text).not.toContain('Query not run');
    expect(intents()).toContain('error');
  });

  it('opens on SQL the route accepts from a caller who is not a tenant admin', async () => {
    // Breaks if the opening SQL uses anything the route's classifier refuses
    // for a non-admin (e.g. SUSER_NAME(), a `sys.` view): the editor would open
    // on a query its own users cannot run. The posted body is read from the
    // real click, and the verdict from the real classifier.
    const { calls } = mount(false);
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    const posted = postedQuery(calls);
    expect(posted.sql).toContain('SELECT');
    expect(analyzeLakehouseQuery(posted.sql, { database: 'master' })).toEqual({ ok: true, locations: [] });
  });

  it('disables the templates the route refuses for a caller who is not a tenant admin, with the reason, and keeps them focusable', async () => {
    mount(false);
    for (const label of ADMIN_ONLY_ENTRIES) {
      const btn = await screen.findByRole('button', { name: label }, { timeout: 5000 });
      // aria-disabled, not native `disabled` (breaks if the editor stops setting
      // `disabledFocusable`, or the Ribbon drops it).
      expect(btn.getAttribute('aria-disabled')).toBe('true');
      expect(btn.hasAttribute('disabled')).toBe(false);
      btn.focus();
      expect(document.activeElement).toBe(btn);
      expect(btn.getAttribute('title') || '').toContain('Tenant admins only');
    }
  });

  it('names those entries in the visible scope note, not only in their tooltips', async () => {
    mount(false);
    const named = await screen.findByTestId('sql-pool-admin-only-entries', {}, { timeout: 5000 });
    // Breaks if the editor stops passing `adminOnlyEntries`, or drops one.
    for (const label of ADMIN_ONLY_ENTRIES) expect(named.textContent).toContain(label);
    expect(named.textContent).toContain('tenant admins only');
  });

  it('leaves those templates enabled for a tenant admin', async () => {
    mount(true);
    for (const label of ADMIN_ONLY_ENTRIES) {
      const btn = await screen.findByRole('button', { name: label }, { timeout: 5000 });
      expect(btn.hasAttribute('disabled')).toBe(false);
      expect(btn.getAttribute('aria-disabled')).not.toBe('true');
    }
  });
});

const ADMIN_ONLY_ENTRIES = ['New view', 'New procedure', 'New function', 'Grant access', 'Row-level security'];
