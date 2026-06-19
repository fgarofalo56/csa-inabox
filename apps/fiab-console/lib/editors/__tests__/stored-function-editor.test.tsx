/**
 * Stored function editor — Vitest contract tests.
 *
 * Exercises the create / edit / delete flow of the structured stored-function
 * editor owned by KqlDatabaseEditor and surfaced from the AdxDatabaseTree
 * navigator. All network calls are intercepted via installFetchMock; the
 * Kusto cluster is never contacted.
 *
 * Acceptance criteria from Loom task "Stored function editor":
 *   1. The navigator lists functions from GET /api/adx/functions (body surfaced).
 *   2. Editing a function opens the dialog pre-populated; Save POSTs name + args
 *      + body to /api/adx/functions and shows a success receipt.
 *   3. Delete fires DELETE /api/adx/functions?name=… and shows a receipt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, fireEvent, cleanup } from '@testing-library/react';
import { KqlDatabaseEditor } from '../phase3-editors';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

const FIXTURE_ID = 'kqldb-fn-test';

describe('StoredFunctionEditor (inside KqlDatabaseEditor)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      [`/api/items/kql-database/${FIXTURE_ID}/query`]: () => ({
        ok: true, database: 'loomdb-default', columns: ['smoke'], rows: [['ok']], rowCount: 1, executionMs: 4,
      }),
      [`/api/items/kql-database/${FIXTURE_ID}`]: () => ({
        ok: true, cluster: 'https://adx-csa-loom-shared.eastus2.kusto.windows.net',
        database: 'loomdb-default', tables: [{ name: 'Events' }], tableCount: 1,
      }),
      '/api/adx/tables': () => ({ ok: true, database: 'loomdb-default', tables: [{ name: 'Events', totalRowCount: 12 }] }),
      '/api/adx/functions': (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return { ok: true, name: 'fn_existing', rowCount: 1 };
        if (init?.method === 'DELETE') return { ok: true };
        return {
          ok: true, database: 'loomdb-default',
          functions: [{ name: 'fn_existing', parameters: '(days:int)', body: '{ Events | take days }', folder: 'Loom' }],
        };
      },
      '/api/adx/materialized-views': () => ({ ok: true, database: 'loomdb-default', materializedViews: [] }),
      '/api/adx/ingestion-mappings': () => ({ ok: true, database: 'loomdb-default', mappings: [] }),
      '/api/adx/overview': () => ({ ok: true, database: 'loomdb-default', schema: null, continuousExports: [] }),
      '/api/adx/policies': () => ({ ok: true, policies: [] }),
    });
    calls = m.calls;
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // The navigator's Functions group is a collapsed Tree branch by default
  // (only Tables is open). Expand it so the function leaf + its inline "Edit"
  // action mount, then return once fn_existing is in the DOM.
  async function expandFunctions() {
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/adx/functions') && !c.init?.method)).toBe(true);
    });
    const branch = await screen.findByText(/^Functions \(\d+\)/);
    fireEvent.click(branch);
    await waitFor(() => expect(screen.getByText('fn_existing')).toBeInTheDocument());
  }

  it('lists functions from GET /api/adx/functions on mount', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id={FIXTURE_ID} />);
    await expandFunctions();
  });

  it('Edit → Save POSTs name + args + body to /api/adx/functions and shows a receipt', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id={FIXTURE_ID} />);
    await expandFunctions();

    fireEvent.click(screen.getByRole('button', { name: /Edit fn_existing/i }));

    const dialog = await screen.findByRole('dialog', { hidden: true });
    // Pre-populated in edit mode: name locked to the selected function.
    expect(within(dialog).getByDisplayValue('fn_existing')).toBeInTheDocument();

    // Fluent's Dialog surface is aria-hidden under jsdom (tabster cannot
    // establish a real focus trap), so role queries inside it need hidden:true.
    fireEvent.click(within(dialog).getByRole('button', { name: /^Save$/i, hidden: true }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.includes('/api/adx/functions') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      const payload = JSON.parse(String(post!.init!.body));
      expect(payload.name).toBe('fn_existing');
      expect(payload.args).toBe('days:int');
      expect(payload.body).toBe('Events | take days');
    });
    await waitFor(() => expect(within(dialog).getByText(/Saved/i)).toBeInTheDocument());
  });

  it('Delete fires DELETE /api/adx/functions with the function name', async () => {
    renderWithProviders(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id={FIXTURE_ID} />);
    await expandFunctions();

    fireEvent.click(screen.getByRole('button', { name: /Edit fn_existing/i }));
    const dialog = await screen.findByRole('dialog', { hidden: true });

    fireEvent.click(within(dialog).getByRole('button', { name: /Delete function/i, hidden: true }));

    await waitFor(() => {
      const del = calls.find((c) => c.url.includes('/api/adx/functions') && c.init?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del!.url).toContain('name=fn_existing');
    });
  });
});
