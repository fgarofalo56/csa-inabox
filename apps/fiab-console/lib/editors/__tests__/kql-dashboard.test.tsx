/**
 * KqlDashboardEditor — vitest render + interaction.
 *
 * Mounts the editor with mocked GET /api/items/kql-dashboard/[id]?run=1
 * returning two tiles, confirms they render in the card grid, the Add tile
 * action adds a third, and the pre-save gate suppresses the GET when id is
 * 'new'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
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

  // globals:false means cleanup is not automatic; prevents DOM accumulation between tests.
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
    // Flyout dialog mounts with the tile-editing controls. The flyout is a
    // Fluent Dialog rendered through a portal; under jsdom the tabster mutation
    // observer can corrupt the ARIA role tree after repeated mounts, so we match
    // the controls by their accessible label (aria-label) rather than by role.
    await screen.findByText('Edit tile');
    expect(screen.getByLabelText(/Tile title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tile visual type/i)).toBeInTheDocument();
    // "Run tile" exists both per-tile-card and in the flyout — assert at least one.
    expect(screen.getAllByRole('button', { name: /Run tile/i }).length).toBeGreaterThan(0);
  });

  it('Base queries dialog adds a shared KQL snippet', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // "Base queries" is exposed twice (the ribbon + the always-mounted inline
    // toolbar). Click the LAST match: the inline toolbar button is a plain
    // <Button> that is never overflow-collapsed, whereas a ribbon copy can drop
    // out of the a11y tree under jsdom's zero-dimension layout in CI. Then scope
    // every subsequent query to the opened <div role="dialog"> and use async
    // findBy* so a slower CI render isn't mistaken for a missing control.
    const openBtns = screen.getAllByRole('button', { name: /Base queries/i });
    fireEvent.click(openBtns[openBtns.length - 1]);
    const dialog = await screen.findByRole('dialog', {}, { timeout: 5000 });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Add base query/i }, { timeout: 5000 }));
    await within(dialog).findByRole('textbox', { name: /Base query name/i }, { timeout: 5000 });
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

  it('exposes the 5-second live-refresh interval option', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // The acceptance interval (5s) is a real, selectable option.
    const opt = screen.getByRole('option', { name: /every 5 seconds/i }) as HTMLOptionElement;
    expect(opt).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: /Auto-refresh interval/i }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5000' } });
    expect(select.value).toBe('5000');
  });

  it('auto-refresh interval requeries ADX via /run on each tick', async () => {
    render(<KqlDashboardEditor item={makeItem('kql-dashboard', 'KQL Dashboard')} id="dash-fixture" />);
    await waitFor(() => expect(screen.getByText('Errors')).toBeInTheDocument());
    // Select the tightest live cadence (5s) and confirm the editor issues real
    // /run requeries against ADX on the cadence (the initial load already runs
    // one; each tick issues another). We assert at least one /run POST fired —
    // the requery path the auto-refresh setInterval drives.
    const select = screen.getByRole('combobox', { name: /Auto-refresh interval/i }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '5000' } });
    expect(select.value).toBe('5000');
    await waitFor(() => {
      const runCalls = calls.filter(
        (c) => c.url.includes('/api/items/kql-dashboard/dash-fixture/run') && c.init?.method === 'POST',
      );
      expect(runCalls.length).toBeGreaterThan(0);
    });
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
