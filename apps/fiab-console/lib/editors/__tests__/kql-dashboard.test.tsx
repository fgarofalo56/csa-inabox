/**
 * KqlDashboardEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked GET /api/items/kql-dashboard/[id]?run=1
 * returning two tiles, confirms they render in the card grid, the Add tile
 * action adds a third, and the pre-save gate suppresses the GET when id is
 * 'new'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { KqlDashboardEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('KqlDashboardEditor', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/items/kql-dashboard/dash-fixture': () => ({
        ok: true,
        database: 'loomdb-default',
        tiles: [
          { title: 'Errors', kql: 'AlertsTable | count', viz: 'table' },
          { title: 'P50 latency', kql: 'Telemetry | summarize percentile(latency, 50)', viz: 'line' },
        ],
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders tiles from GET ?run=1', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/items/kql-dashboard/dash-fixture'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Errors')).toBeInTheDocument();
      expect(screen.getByText('P50 latency')).toBeInTheDocument();
    });
  });

  it('Add tile button appends a new tile', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // Toolbar "Add tile" button.
    const addBtns = screen.getAllByRole('button', { name: /Add tile/i });
    fireEvent.click(addBtns[0]);
    await waitFor(() => {
      expect(screen.getByText(/Tile 3/i)).toBeInTheDocument();
    });
  });

  it('skips the GET when id is "new" (pre-save gate)', () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="new" />);
    expect(calls.filter((c) => c.url.includes('/api/items/kql-dashboard/new')).length).toBe(0);
  });

  it('renders the auto-refresh interval Select defaulting to off', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    const select = screen.getByRole('combobox', { name: /Auto-refresh interval/i }) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe('0'); // default autoRefreshMs = 0 → off
    // The 30-second acceptance option is present.
    expect(screen.getByRole('option', { name: /every 30 seconds/i })).toBeInTheDocument();
  });

  it('changing the auto-refresh Select updates the selected interval', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    const select = screen.getByRole('combobox', { name: /Auto-refresh interval/i }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '30000' } });
    expect(select.value).toBe('30000');
  });

  it('shows the drill-through config when a tile is expanded', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // Expand the first tile editor.
    const editBtns = screen.getAllByRole('button', { name: /Edit tile/i });
    fireEvent.click(editBtns[0]);
    await waitFor(() => {
      expect(screen.getByText('Drill-through')).toBeInTheDocument();
      // No params yet → the section prompts to add a parameter first.
      expect(screen.getByText(/Add at least one dashboard/i)).toBeInTheDocument();
    });
  });
});
