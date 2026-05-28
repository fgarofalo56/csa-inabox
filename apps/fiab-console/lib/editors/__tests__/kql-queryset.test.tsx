/**
 * KqlQuerysetEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked GET /api/items/kql-queryset/[id] returning
 * a saved query, confirms it renders, clicking Run posts to /run, and the
 * "id === 'new'" pre-save gate skips the GET.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KqlQuerysetEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('KqlQuerysetEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/kql-queryset/qs-fixture/run': () => ({
        ok: true,
        database: 'loomdb-default',
        mode: 'query',
        columns: ['v'],
        rows: [[1]],
        rowCount: 1,
        executionMs: 11,
      }),
      '/api/items/kql-queryset/qs-fixture': () => ({
        ok: true,
        database: 'loomdb-default',
        defaultDatabase: 'loomdb-default',
        queries: [
          { title: 'Smoke', kql: 'print v = 1' },
          { title: 'Errors last hour', kql: 'AlertsTable | where ts > ago(1h)' },
        ],
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('lists saved queries on mount', async () => {
    render(<KqlQuerysetEditor item={makeItem('kql-queryset', 'KQL Queryset')} id="qs-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/items/kql-queryset/qs-fixture'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Smoke')).toBeInTheDocument();
      expect(screen.getByText('Errors last hour')).toBeInTheDocument();
    });
  });

  it('Run button posts to /run', async () => {
    render(<KqlQuerysetEditor item={makeItem('kql-queryset', 'KQL Queryset')} id="qs-fixture" />);
    await waitFor(() => expect(screen.getByText('Smoke')).toBeInTheDocument());
    const runBtns = screen.getAllByRole('button', { name: /^Run/i });
    fireEvent.click(runBtns[0]);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/run') && c.init?.method === 'POST')).toBe(true);
    });
  });

  it('skips the GET when id is "new" (pre-save gate)', () => {
    render(<KqlQuerysetEditor item={makeItem('kql-queryset', 'KQL Queryset')} id="new" />);
    expect(calls.filter((c) => c.url.endsWith('/api/items/kql-queryset/new')).length).toBe(0);
  });
});
