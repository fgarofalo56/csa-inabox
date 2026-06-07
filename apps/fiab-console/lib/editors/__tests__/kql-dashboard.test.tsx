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

  it('Edit on a tile opens the tile flyout with its editable fields', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // Each tile card exposes an "Edit tile" action; click the first.
    const editBtns = screen.getAllByRole('button', { name: /Edit tile/i });
    fireEvent.click(editBtns[0]);
    await waitFor(() => {
      // Flyout dialog mounts with the tile-editing controls.
      expect(screen.getByText('Edit tile')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /Tile title/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /Tile visual type/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Run tile/i })).toBeInTheDocument();
    });
  });

  it('Base queries dialog adds a shared KQL snippet', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    const openBtns = screen.getAllByRole('button', { name: /Base queries/i });
    fireEvent.click(openBtns[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: /Add base query/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Add base query/i }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /Base query name/i })).toBeInTheDocument();
    });
  });
});
