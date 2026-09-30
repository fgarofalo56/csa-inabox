/**
 * Semantic model editor, "Direct Lake query" tab: what a caller who is not a
 * tenant admin is told about a model's own SQL, and how a query the route
 * chose not to run is shown.
 *
 * `POST /api/items/semantic-model/[id]/direct-lake` refuses a non-admin model's
 * SQL before running it with `{ ok:false, code, error, remediation }`
 * (`app/api/items/semantic-model/_lib/direct-lake-scope.ts`). The tab shows that
 * as a WARNING titled "Query not run" carrying the remediation; a query that
 * ran and failed stays an error, "Query failed".
 *
 * Each test names the change that turns it red:
 *   - scope note for a non-admin: `<DirectLakeSqlScopeNote />` removed from the
 *     tab, or its `isAdmin` early return inverted (note shown to the admin only).
 *   - no scope note for an admin: the early return removed (note shown to all).
 *   - refusal: the tab keeps its old error bar instead of
 *     `DirectLakeQueryFailure` (title "Query failed", intent error, no
 *     "What to do" line).
 *   - other failure: every failure rendered as a warning, or a "What to do"
 *     line rendered for a body with no remediation.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionProvider } from '@/lib/components/session-context';
import { invalidatePlatformConfig } from '@/lib/components/platform-config';
import { makeItem, installFetchMock } from './test-helpers';

// Record each MessageBar's intent on a wrapper, so the test reads the prop the editor passed.
vi.mock('@fluentui/react-components', async () => {
  const actual = await vi.importActual<any>('@fluentui/react-components');
  return {
    ...actual,
    MessageBar: (p: any) => <div data-intent={p.intent}><actual.MessageBar {...p} /></div>,
  };
});

import { SemanticModelEditor } from '../phase3-editors';

const REMEDIATION = 'Read files under a lakehouse root in this workspace. Remediation-7340.';
const REFUSAL_ERROR = "Direct Lake SQL for a semantic model runs read-only SELECT queries. The location 'https://x' is not accepted.";

/** Bound-dataset mocks (as in semantic-model.test.tsx), with the Direct Lake POST answering `queryBody`. */
function mount(isTenantAdmin: boolean, queryBody: unknown = { ok: true, columns: ['c'], rows: [[1]] }) {
  const mock = installFetchMock({
    '/api/config/ui': () => ({ biBackend: 'powerbi' }),
    '/api/powerbi/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'Contoso WS' }] }),
    '/api/items/semantic-model?workspaceId=': () => ({
      ok: true,
      datasets: [{ id: 'ds-1', name: 'Sales model', isRefreshable: true, targetStorageMode: 'Import' }],
    }),
    '/api/items/semantic-model/ds-1/direct-lake': (_u, init) =>
      init?.method === 'POST'
        ? queryBody
        : { ok: true, shimEnabled: true, runs: [], config: null },
    '/api/items/semantic-model/ds-1?workspaceId=': () => ({
      ok: true,
      dataset: { id: 'ds-1', name: 'Sales model', isRefreshable: true, targetStorageMode: 'Import' },
      tables: [{ name: 'FactSales', columns: [{ name: 'Amount', dataType: 'double' }] }],
    }),
  });
  render(
    <SessionProvider value={{ authenticated: true, user: null, isTenantAdmin, loading: false }}>
      <SemanticModelEditor item={makeItem('semantic-model', 'Semantic model')} id="new" />
    </SessionProvider>,
  );
  return mock;
}

async function openQueryTab() {
  const tab = await screen.findByRole('tab', { name: /^Direct Lake query/ }, { timeout: 8000 });
  await userEvent.click(tab);
  await screen.findByText('Direct Lake query with transparent Serverless fallback', {}, { timeout: 5000 });
}

async function runOnFactSales() {
  await waitFor(() => expect(document.getElementById('dl-table-picker')).not.toBeNull(), { timeout: 5000 });
  await userEvent.click(document.getElementById('dl-table-picker') as HTMLElement);
  await userEvent.click(await screen.findByRole('option', { name: 'FactSales' }, { timeout: 5000 }));
  await userEvent.click(screen.getByRole('button', { name: /^Run$/ }));
}

const intents = () =>
  Array.from(document.querySelectorAll('[data-intent]')).map((n) => n.getAttribute('data-intent'));

beforeEach(() => { invalidatePlatformConfig(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); invalidatePlatformConfig(); });

describe('SemanticModelEditor — Direct Lake SQL scope', () => {
  it('tells a caller who is not a tenant admin what a model\'s own SQL can read', async () => {
    mount(false);
    await openQueryTab();
    const note = await screen.findByTestId('direct-lake-sql-scope', {}, { timeout: 5000 });
    expect(note.textContent).toContain("What a model's own SQL can read");
    expect(note.textContent).toContain('OPENROWSET(BULK');
    expect(note.textContent).toContain('INFORMATION_SCHEMA');
    expect(note.textContent).toContain('ask a tenant admin');
  }, 20_000);

  it('shows no scope note to a tenant admin (the tab still renders)', async () => {
    mount(true);
    await openQueryTab();
    // Positive half: the tab body is there, Run button included.
    expect(screen.getByRole('button', { name: /^Run$/ })).toBeTruthy();
    expect(screen.queryByTestId('direct-lake-sql-scope')).toBeNull();
  }, 20_000);

  it('shows a refused query as a warning, "Query not run", with the route\'s remediation', async () => {
    const { calls } = mount(false, {
      ok: false, code: 'query_location_outside_root', error: REFUSAL_ERROR, remediation: REMEDIATION,
    });
    await openQueryTab();
    await runOnFactSales();
    await waitFor(() => expect(document.body.textContent).toContain('Remediation-7340'), { timeout: 5000 });
    // The POST really went to the Direct Lake route (the fixture is not rendered from nowhere).
    expect(calls.some((c) => c.url.includes('/ds-1/direct-lake') && c.init?.method === 'POST')).toBe(true);
    const text = document.body.textContent || '';
    expect(text).toContain('Query not run');
    expect(text).toContain('What to do:');
    expect(text).toContain('is not accepted.');
    expect(text).not.toContain('Query failed');
    expect(intents()).toContain('warning');
    expect(intents()).not.toContain('error');
  }, 20_000);

  it('keeps a query that ran and failed as an error, "Query failed", with no remediation line', async () => {
    mount(false, { ok: false, error: 'Serverless query failed: Sentinel-6618.' });
    await openQueryTab();
    await runOnFactSales();
    await waitFor(() => expect(document.body.textContent).toContain('Sentinel-6618'), { timeout: 5000 });
    const text = document.body.textContent || '';
    expect(text).toContain('Query failed');
    expect(text).not.toContain('Query not run');
    expect(text).not.toContain('What to do:');
    expect(intents()).toContain('error');
  }, 20_000);
});
