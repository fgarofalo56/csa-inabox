/**
 * SqlAnalyticsEndpointEditor — vitest render + the UX-baseline lift
 * (SC-8 item-view tab strip: Query editor ⇄ Schema diagram, SC-6 teaching
 * banner). Backend calls are mocked; this asserts the surface renders the new
 * shared chrome without disturbing the real serverless-SQL query flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { SqlAnalyticsEndpointEditor } from '../sql-analytics-endpoint-editor';
import { makeItem, installFetchMock } from './test-helpers';

describe('SqlAnalyticsEndpointEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/items/sql-analytics-endpoint/ep-1/schema': () => ({
        ok: true, endpoint: 'loom-ondemand.sql.azuresynapse.net', databases: ['reports'],
      }),
      '/api/items/sql-analytics-endpoint/ep-1/objects': () => ({
        ok: true, database: 'master',
        views: [{ schema: 'reports', name: 'vw_sales', definition: '' }],
        procedures: [], functions: [], externalTables: [],
        columns: { '[reports].[vw_sales]': [{ name: 'id', dataType: 'int' }, { name: 'amount', dataType: 'decimal' }] },
      }),
    });
  });
  // vitest.config sets globals:false → RTL does not auto-cleanup. Unmount here.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<SqlAnalyticsEndpointEditor item={makeItem('sql-analytics-endpoint', 'SQL analytics endpoint')} id="ep-1" />);
    await waitFor(() => { expect(screen.getByTestId('chrome')).toBeInTheDocument(); });
  });

  it('exposes the Query editor / Schema diagram item-view tabs (SC-8)', async () => {
    render(<SqlAnalyticsEndpointEditor item={makeItem('sql-analytics-endpoint', 'SQL analytics endpoint')} id="ep-1" />);
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Query editor/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Schema diagram/ })).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<SqlAnalyticsEndpointEditor item={makeItem('sql-analytics-endpoint', 'SQL analytics endpoint')} id="ep-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });
});
