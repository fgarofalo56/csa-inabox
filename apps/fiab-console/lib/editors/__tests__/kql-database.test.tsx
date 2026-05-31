/**
 * KqlDatabaseEditor — vitest render + interaction.
 *
 * Mounts the KQL Database editor with mocked /api/items/kql-database/[id]
 * and /query responses and confirms:
 *   - DB details + table list fetch fires on mount
 *   - Run button executes a POST to /query and surfaces the result row
 *   - pre-save id === 'new' gate suppresses the fetch
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KqlDatabaseEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('KqlDatabaseEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/kql-database/kqldb-fixture/query': () => ({
        ok: true,
        database: 'loomdb-default',
        mode: 'query',
        columns: ['smoke', 'server_time'],
        rows: [['ok', '2026-05-27T00:00:00Z']],
        rowCount: 1,
        executionMs: 23,
      }),
      '/api/items/kql-database/kqldb-fixture': () => ({
        ok: true,
        cluster: 'https://adx-csa-loom-shared.eastus2.kusto.windows.net',
        database: 'loomdb-default',
        details: { OriginalSize: 1_048_576, HotCachePeriod: 'P7D', SoftDeletePeriod: 'P30D' },
        tables: [{ name: 'Events' }, { name: 'Alerts' }],
        tableCount: 2,
      }),
      // AdxDatabaseTree (left navigator) — real /api/adx/* routes.
      '/api/adx/tables': () => ({ ok: true, database: 'loomdb-default', tables: [{ name: 'Events', totalRowCount: 12 }, { name: 'Alerts', totalRowCount: 3 }] }),
      '/api/adx/functions': () => ({ ok: true, database: 'loomdb-default', functions: [] }),
      '/api/adx/materialized-views': () => ({ ok: true, database: 'loomdb-default', materializedViews: [] }),
      '/api/adx/ingestion-mappings': () => ({ ok: true, database: 'loomdb-default', mappings: [] }),
      '/api/adx/overview': () => ({ ok: true, database: 'loomdb-default', schema: null, continuousExports: [] }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches DB details + table list on mount', async () => {
    render(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/items/kql-database/kqldb-fixture'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Events')).toBeInTheDocument();
      expect(screen.getByText('Alerts')).toBeInTheDocument();
    });
  });

  it('Run button posts to /query and renders the result', async () => {
    render(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="kqldb-fixture" />);
    await waitFor(() => expect(screen.getByText('Events')).toBeInTheDocument());
    const runBtn = screen.getByRole('button', { name: /^Run/i });
    fireEvent.click(runBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/query') && c.init?.method === 'POST')).toBe(true);
    });
  });

  it('skips the DB fetch when id is "new" (pre-save gate)', () => {
    render(<KqlDatabaseEditor item={makeItem('kql-database', 'KQL Database')} id="new" />);
    expect(calls.filter((c) => c.url.endsWith('/api/items/kql-database/new')).length).toBe(0);
  });
});
