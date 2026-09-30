/**
 * Serverless SQL pool editor: what a caller who is not a tenant admin is told,
 * and how a query the route chose not to run is shown.
 *
 * The route (`app/api/items/synapse-serverless-sql-pool/[id]/query`) refuses a
 * non-admin query before running it with `{ ok:false, code, error, remediation }`.
 * The editor shows that as a WARNING titled "Query not run" carrying the
 * remediation; a query that ran and failed stays an error, "Query failed".
 *
 * Each test names the change that turns it red:
 *   - scope bar for a non-admin: the `!isAdmin` condition dropped (bar gone) or
 *     inverted (bar shown to the admin instead).
 *   - no scope bar for an admin: the bar rendered unconditionally.
 *   - refusal: `isRefusal` removed (the Messages tab falls back to the error
 *     bar "Query failed" with no "What to do" line), or the caption keeping
 *     "Query failed" for a refusal.
 *   - other failure: every failure turned into a warning, or a remediation
 *     line rendered for a body that has none.
 *   - the opening SQL: DEFAULT_SQL changed to text the route's classifier
 *     refuses for a non-admin (e.g. a `sys.` view), so the editor would open on
 *     a query its own users cannot run. The posted body is read from the real
 *     click, not transcribed here.
 *   - Connect to, opened with `?database=salesdb` (the mirror editor's link):
 *     for a non-admin the picker is disabled and reads master, and the query
 *     and the object explorer are sent master. Breaks if the editor keeps the
 *     linked database for a non-admin (the posted body says `salesdb`). For an
 *     admin the picker is enabled and `salesdb` is sent (the positive half).
 *   - the New view / procedure / function and Cost entries: disabled with the
 *     reason for a non-admin, enabled for an admin. Breaks if either side loses
 *     its `isAdmin` condition.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders, makeItem, installFetchMock } from './test-helpers';
import { SessionProvider } from '@/lib/components/session-context';
import { analyzeLakehouseQuery } from '@/app/api/items/lakehouse/_lib/query-scope';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/lib/components/editor/monaco-textarea', () => ({
  MonacoTextarea: (p: { value: string; onChange: (v: string) => void; ariaLabel?: string }) => (
    <textarea aria-label={p.ariaLabel} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));
// Record each MessageBar's intent on a wrapper, so the test reads the prop the editor passed.
vi.mock('@fluentui/react-components', async () => {
  const actual = await vi.importActual<any>('@fluentui/react-components');
  return {
    ...actual,
    MessageBar: (p: any) => <div data-intent={p.intent}><actual.MessageBar {...p} /></div>,
  };
});
// The shared setup stubs the chrome with bare ribbon buttons that drop `title`.
// This file renders the REAL Ribbon, so the reason a disabled entry shows is
// read from what the product renders, not from the editor's ribbon array.
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

import { SynapseServerlessSqlEditor } from '../synapse-serverless-sql-editor';

const REMEDIATION = 'Read files under a lakehouse root in this workspace. Remediation-5521.';
const REFUSAL_ERROR = "This editor runs read-only SELECT queries. The location 'https://x' is not accepted.";

function mount(isTenantAdmin: boolean, queryBody: unknown = { ok: true, columns: ['smoke'], rows: [[1]] }) {
  const mock = installFetchMock({
    '/schema': () => ({ endpoint: 'ws-ondemand.sql.azuresynapse.net', databases: ['salesdb'] }),
    '/objects': () => ({ ok: true, schemas: [] }),
    '/query': () => queryBody,
  });
  renderWithProviders(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      <SynapseServerlessSqlEditor item={makeItem('synapse-serverless-sql-pool', 'Serverless SQL pool')} id="pool-1" />
    </SessionProvider>,
  );
  return mock;
}

async function clickRun() {
  const runs = await screen.findAllByRole('button', { name: /^Run$/ }, { timeout: 5000 });
  fireEvent.click(runs[0]);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); nav.search = ''; });

const ADMIN_ONLY_ENTRIES = ['New view', 'New procedure', 'New function', 'Bytes processed', 'Cost cap'];

function postedQuery(calls: Array<{ url: string; init?: RequestInit }>) {
  return JSON.parse(String(calls.find((c) => c.url.includes('/query'))!.init!.body));
}

describe('SynapseServerlessSqlEditor — query scope', () => {
  it('tells a caller who is not a tenant admin what they can query', async () => {
    mount(false);
    const bar = await screen.findByTestId('sql-pool-query-scope', {}, { timeout: 5000 });
    expect(bar.textContent).toContain('What you can query here');
    expect(bar.textContent).toContain('OPENROWSET');
    expect(bar.textContent).toContain('Queries run in master');
    expect(bar.textContent).toContain('This limit is temporary');
    expect(Array.from(bar.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/fgarofalo56/csa-inabox/issues/4821',
      'https://github.com/fgarofalo56/csa-inabox/issues/4840',
    ]);
  });

  it('shows no scope bar to a tenant admin (the editor still renders)', async () => {
    mount(true);
    // Positive half: the editor mounted and its Run button is there.
    expect((await screen.findAllByRole('button', { name: /^Run$/ }, { timeout: 5000 })).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('sql-pool-query-scope')).toBeNull();
  });

  it('shows a refused query as a warning, "Query not run", with the route\'s remediation', async () => {
    mount(false, { ok: false, code: 'query_location_outside_root', error: REFUSAL_ERROR, remediation: REMEDIATION });
    await clickRun();
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-5521'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query not run');
    expect(text).toContain('What to do:');
    expect(text).toContain("is not accepted.");
    expect(text).not.toContain('Query failed');
    const intents = Array.from(document.querySelectorAll('[data-intent]')).map((n) => n.getAttribute('data-intent'));
    expect(intents).toContain('warning');
    expect(intents).not.toContain('error');
    // A failed run opens the Messages tab, so the Results-tab caption renders
    // only after the user switches back. Breaks if the caption keeps
    // "Query failed" for a refusal.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Query not run — see the'), { timeout: 5000 });
    expect(document.body.textContent).not.toContain('Query failed');
  });

  it('keeps a query that ran and failed as an error, "Query failed", with no remediation line', async () => {
    mount(false, { ok: false, error: 'Invalid object name Sentinel-8812.', sqlNumber: 208 });
    await clickRun();
    await waitFor(() => expect(document.body.textContent).toContain('Sentinel-8812'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query failed');
    expect(text).not.toContain('Query not run');
    expect(text).not.toContain('What to do:');
    const intents = Array.from(document.querySelectorAll('[data-intent]')).map((n) => n.getAttribute('data-intent'));
    expect(intents).toContain('error');
    // Breaks if the Results-tab caption says "Query not run" for every failure.
    fireEvent.click(screen.getByRole('tab', { name: /^Results/ }));
    await waitFor(() => expect(document.body.textContent).toContain('Query failed — see the'), { timeout: 5000 });
    expect(document.body.textContent).not.toContain('Query not run');
  });

  it('opens on SQL the route accepts from a caller who is not a tenant admin', async () => {
    const { calls } = mount(false);
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    const posted = JSON.parse(String(calls.find((c) => c.url.includes('/query'))!.init!.body));
    expect(typeof posted.sql).toBe('string');
    expect(posted.sql.length).toBeGreaterThan(0);
    expect(analyzeLakehouseQuery(posted.sql, { database: 'master' })).toEqual({ ok: true, locations: [] });
  });
  it('pins Connect to at master for a caller who is not a tenant admin, whatever the link names', async () => {
    nav.search = 'database=salesdb';
    const { calls } = mount(false);
    const picker = await screen.findByRole('combobox', {}, { timeout: 5000 });
    expect(picker.textContent).toContain('master');
    expect(picker.textContent).not.toContain('salesdb');
    expect(picker.hasAttribute('disabled') || picker.getAttribute('aria-disabled') === 'true').toBe(true);
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    // 'salesdb' here means the editor sent the linked database for a non-admin.
    expect(postedQuery(calls).database).toBe('master');
    const objects = calls.filter((c) => c.url.includes('/objects'));
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.every((c) => c.url.includes('database=master'))).toBe(true);
  });

  it('keeps Connect to live for a tenant admin, and sends the linked database (positive half)', async () => {
    nav.search = 'database=salesdb';
    const { calls } = mount(true);
    const picker = await screen.findByRole('combobox', {}, { timeout: 5000 });
    expect(picker.textContent).toContain('salesdb');
    expect(picker.hasAttribute('disabled') || picker.getAttribute('aria-disabled') === 'true').toBe(false);
    await clickRun();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/query'))).toBe(true), { timeout: 5000 });
    expect(postedQuery(calls).database).toBe('salesdb');
  });

  it('disables the DDL templates and cost scripts for a caller who is not a tenant admin, with the reason', async () => {
    mount(false);
    for (const label of ADMIN_ONLY_ENTRIES) {
      const btn = await screen.findByRole('button', { name: label }, { timeout: 5000 });
      expect(btn.hasAttribute('disabled')).toBe(true);
      expect(btn.getAttribute('title') || '').toContain('Tenant admins only');
    }
  });

  it('leaves the DDL templates and cost scripts enabled for a tenant admin', async () => {
    mount(true);
    for (const label of ADMIN_ONLY_ENTRIES) {
      const btn = await screen.findByRole('button', { name: label }, { timeout: 5000 });
      expect(btn.hasAttribute('disabled')).toBe(false);
      expect(btn.getAttribute('title') || '').not.toContain('Tenant admins only');
    }
  });
});
