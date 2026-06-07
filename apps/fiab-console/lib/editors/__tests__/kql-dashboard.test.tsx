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

  it('changing a parameter re-runs the dependent tile with the new value', async () => {
    // Fresh mock: a dashboard with a _state freetext param bound to a tile.
    const m = installFetchMock({
      '/api/items/kql-dashboard/dash-params/run': () => ({
        ok: true,
        tiles: [{ title: 'By State', kql: '...', viz: 'table', result: { ok: true, columns: ['State'], rows: [['Texas']] } }],
      }),
      '/api/items/kql-dashboard/dash-params': () => ({
        ok: true,
        database: 'loomdb-default',
        tiles: [{ title: 'By State', kql: 'StormEvents | where State == _state', viz: 'table' }],
        parameters: [{ variableName: '_state', label: 'State', type: 'freetext', dataType: 'string', value: '' }],
      }),
    });

    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-params" />);
    await waitFor(() => expect(screen.getByText('By State')).toBeInTheDocument());

    // The param bar renders a free-text input for _state. Type a new value, blur.
    const input = screen.getAllByRole('textbox')[0];
    fireEvent.change(input, { target: { value: 'Texas' } });
    fireEvent.blur(input);

    // The blur fires runDependentTiles → runTile → POST /run carrying the new
    // parameter value, which is what makes the tile re-query with new data.
    await waitFor(() => {
      expect(m.calls.some((c) =>
        c.url.includes('/dash-params/run') &&
        typeof c.init?.body === 'string' &&
        c.init.body.includes('"value":"Texas"'),
      )).toBe(true);
    });
  });
});
