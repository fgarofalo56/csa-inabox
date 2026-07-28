/**
 * EventstreamEditor — "Add source" regression + first-open pristine state.
 *
 * Operator-reported defects:
 *   (2) clicking "Add source" flashed and disappeared — ROOT CAUSE: the editor's
 *       `load` callback depended on the `useCanvasHistory` return OBJECT (a new
 *       identity every render), so the `useEffect(() => { load(); }, [load])`
 *       refired load() after every state change, refetching the persisted
 *       config and overwriting the just-added (unsaved) node.
 *   (1b) a brand-new eventstream opened with red validation errors — it must
 *       open pristine (guided "Set up" tab) until the user edits or saves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EventstreamEditor } from '../phase3-editors';
import { makeItem, installFetchMock } from './test-helpers';

describe('EventstreamEditor — add source persists (no load-loop revert)', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    const m = installFetchMock({
      '/api/loom/workspaces': () => ({
        ok: true,
        workspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
      }),
      // A freshly-minted eventstream: Cosmos has NO topology yet.
      '/api/items/eventstream/es-new-fixture': () => ({
        ok: true,
        runtimeStatus: 'draft',
        config: { transforms: [] },
      }),
      '/api/items/eventstream/spark-binding': () => ({
        ok: true, bound: true, kind: 'synapse', synapseWorkspace: 'syn-loom', source: 'env', isAdmin: true,
      }),
    });
    calls = m.calls;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  // NOTE: ItemEditorChrome performs its own one-time best-effort item fetch for
  // the display name, so a settled mount shows a small CONSTANT number of GETs.
  // The load-loop bug made this number GROW after every render/interaction —
  // the regression signal is stability, not an absolute count.
  // A14's collab push transport opens ONE `/collab/stream` SSE GET under the
  // same item path — a different subsystem, excluded so this stays a pure
  // CONFIG-fetch signal.
  const configCalls = () =>
    calls.filter((c) =>
      c.url.includes('/api/items/eventstream/es-new-fixture') &&
      !c.url.includes('/collab/') &&
      (!c.init?.method || c.init.method === 'GET')).length;

  it('the config fetch settles (the old bug re-fetched on every render)', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-new-fixture" />);
    await waitFor(() => expect(configCalls()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 150));
    const settled = configCalls();
    expect(settled).toBeLessThanOrEqual(2); // editor load + chrome name fetch
    // Stability: no further re-fetch storms after settling.
    await new Promise((r) => setTimeout(r, 200));
    expect(configCalls()).toBe(settled);
  });

  it('"Add source" really adds — the dirty state and the node are NOT reverted', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-new-fixture" />);
    await waitFor(() => expect(configCalls()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    const settled = configCalls();

    // Click the canvas palette "Add source" (the ribbon exposes one too — any
    // instance drives the same code path; pick the first enabled one).
    const addButtons = await screen.findAllByRole('button', { name: /^add source$/i });
    fireEvent.click(addButtons[0]);

    // Dirty badge appears (an edit happened)…
    await waitFor(() => expect(screen.getAllByText('unsaved').length).toBeGreaterThan(0));

    // …and STAYS: the old bug refired load() after the edit, refetching the
    // persisted config and resetting dirty + wiping the just-added node.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getAllByText('unsaved').length).toBeGreaterThan(0);
    expect(configCalls()).toBe(settled);
  });

  it('opens pristine: guided "Set up" tab instead of red authoring errors; validation arms after an edit', async () => {
    render(<EventstreamEditor item={makeItem('eventstream', 'Eventstream')} id="es-new-fixture" />);
    await waitFor(() => expect(configCalls()).toBeGreaterThan(0));

    // Pristine: the dock tab reads "Set up" (no danger badge, no red banners).
    await waitFor(() => expect(screen.getAllByRole('tab', { name: /set up/i }).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('tab', { name: /authoring errors/i })).toHaveLength(0);

    // The preview never ran against the unconfigured seeded source.
    expect(calls.filter((c) => c.url.includes('/es-new-fixture/events'))).toHaveLength(0);

    // First edit arms validation: the tab flips to "Authoring errors".
    const addButtons = await screen.findAllByRole('button', { name: /^add source$/i });
    fireEvent.click(addButtons[0]);
    await waitFor(() => expect(screen.getAllByRole('tab', { name: /authoring errors/i }).length).toBeGreaterThan(0));
  });
});
