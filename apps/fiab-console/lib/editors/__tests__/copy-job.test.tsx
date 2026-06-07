/**
 * CopyJobEditor — vitest render + interaction.
 *
 * The editor moved to ./copy-job-editor (F14 wizard + watermark). It is still
 * re-exported from phase2-misc-editors, so we import via that path to assert the
 * re-export stays wired. State is the flat CopyJobSpec the wizard emits.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { CopyJobEditor } from '../phase2-misc-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('CopyJobEditor', () => {
  beforeEach(() => {
    installFetchMock({
      '/api/adf/linked-services': () => ({
        ok: true,
        linkedServices: [
          { name: 'AzureSql_src', properties: { type: 'AzureSqlDatabase' } },
          { name: 'AzureSql_sink', properties: { type: 'AzureSqlDatabase' } },
        ],
      }),
      '/api/items/copy-job/cj-1/runs': () => ({ ok: true, runs: [] }),
      '/api/items/copy-job/cj-1/watermark': () => ({
        ok: true, configured: true,
        watermark: { source: 'orders', table_name: 'dbo.orders', last_value: '2026-01-01T00:00:00Z', updated_utc: '2026-01-01T00:05:00Z' },
      }),
      '/api/items/copy-job/cj-1': () => ({
        ok: true,
        item: {
          id: 'cj-1',
          workspaceId: 'ws-1',
          displayName: 'copy-fixture',
          state: {
            source: { linkedService: 'AzureSql_src', type: 'AzureSqlSource', sourceTable: 'dbo.orders' },
            sink: { linkedService: 'AzureSql_sink', type: 'AzureSqlSink', table: 'bronze.orders' },
            mode: 'Incremental',
            writeMode: 'Append',
            watermarkCol: 'updated_at',
            sourceName: 'orders',
            mappings: [],
          },
        },
      }),
    });
  });
  // vitest runs with globals:false, so React Testing Library's automatic
  // afterEach(cleanup) is never registered. Unmount explicitly so each test
  // starts from a clean DOM.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders editor chrome', async () => {
    render(<CopyJobEditor item={makeItem('copy-job', 'Copy Job')} id="cj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('chrome')).toBeInTheDocument();
    });
  });

  it('exposes ribbon actions', async () => {
    render(<CopyJobEditor item={makeItem('copy-job', 'Copy Job')} id="cj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('ribbon').querySelectorAll('button').length).toBeGreaterThan(0);
    });
  });

  it('shows the persisted configuration + incremental watermark', async () => {
    render(<CopyJobEditor item={makeItem('copy-job', 'Copy Job')} id="cj-1" />);
    await waitFor(() => {
      expect(screen.getByText(/AzureSql_src · AzureSqlSource · dbo\.orders/)).toBeInTheDocument();
    });
    // Watermark panel renders the last value read from the control table.
    await waitFor(() => {
      expect(screen.getByText('2026-01-01T00:00:00Z')).toBeInTheDocument();
    });
  });
});
