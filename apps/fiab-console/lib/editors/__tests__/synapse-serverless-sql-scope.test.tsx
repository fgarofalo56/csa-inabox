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
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders, makeItem, installFetchMock } from './test-helpers';
import { SessionProvider } from '@/lib/components/session-context';
import { analyzeLakehouseQuery } from '@/app/api/items/lakehouse/_lib/query-scope';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SynapseServerlessSqlEditor — query scope', () => {
  it('tells a caller who is not a tenant admin what they can query', async () => {
    mount(false);
    const bar = await screen.findByTestId('sql-pool-query-scope', {}, { timeout: 5000 });
    expect(bar.textContent).toContain('What you can query here');
    expect(bar.textContent).toContain('OPENROWSET');
    expect(bar.textContent).toContain('Queries run in master');
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
});
