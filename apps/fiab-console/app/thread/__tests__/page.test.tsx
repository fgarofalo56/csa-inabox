/**
 * /thread (Lineage) — ViewToggle + tile/list behaviour (Vitest, jsdom).
 *
 *   - the Tile | List ViewToggle renders only when there are Weave edges,
 *   - toggling to List swaps the ItemTile grid for the LoomDataTable
 *     (the list-only "When" column header appears),
 *   - the chosen view persists to the documented localStorage key.
 *
 * Network is caught by installFetchMock; next/navigation is stubbed by
 * vitest.setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { installFetchMock } from '@/lib/editors/__tests__/test-helpers';
import ThreadLineagePage from '../page';

const LS_KEY = 'loom.thread.viewMode.v1';

const EDGES = [
  {
    id: 'e1', fromItemId: 'lh1', fromType: 'lakehouse', fromName: 'sales_lh',
    toItemId: 'nb1', toType: 'notebook', toName: 'explore_nb',
    action: 'analyze-in-notebook', createdAt: new Date('2026-06-01T10:00:00Z').toISOString(), createdBy: 'alice',
  },
];

function mount() {
  return render(
    <FluentProvider theme={webLightTheme}>
      <ThreadLineagePage />
    </FluentProvider>,
  );
}

describe('ThreadLineagePage view toggle', () => {
  beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('renders the ViewToggle and a tile when edges exist', async () => {
    installFetchMock({ '/api/thread/edges': () => ({ ok: true, edges: EDGES }) });
    mount();
    await waitFor(() => expect(screen.getByText('explore_nb')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'List view' })).toBeInTheDocument();
  });

  it('does NOT render the ViewToggle when there are zero edges', async () => {
    installFetchMock({ '/api/thread/edges': () => ({ ok: true, edges: [] }) });
    mount();
    // Default view is the graph canvas; with zero edges it renders the
    // "No lineage yet" empty state (the "No Weave edges yet" copy is the
    // list-view LoomDataTable empty prop, only reachable once edges exist).
    await waitFor(() => expect(screen.getByText(/No lineage yet/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
  });

  it('swaps tiles for the LoomDataTable and persists the choice on toggle', async () => {
    installFetchMock({ '/api/thread/edges': () => ({ ok: true, edges: EDGES }) });
    mount();
    await waitFor(() => expect(screen.getByText('explore_nb')).toBeInTheDocument());
    expect(screen.queryByText('When')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    // "When" is a list-only header for the createdAt column (LoomDataTable
    // renders the label in both the header cell and the date-filter row).
    await waitFor(() => expect(screen.getAllByText('When').length).toBeGreaterThan(0));
    expect(window.localStorage.getItem(LS_KEY)).toBe('list');
  });
});
