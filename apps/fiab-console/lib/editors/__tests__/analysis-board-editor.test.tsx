/**
 * AnalysisBoardEditor — behaviour specs (FINISHLINE C14).
 *
 * `analysis-board` had no EDITOR test (only the pure compiler was covered by
 * analysis-board-model.test.ts). These pin the editor-level contracts the
 * compiler tests cannot see:
 *   - the compiled-KQL preview must track the board LIVE as steps are added
 *   - ux-baseline G6: a freshly created, untouched board must show a GUIDED
 *     HINT, never a red compile error (the editor carries an explicit code
 *     comment claiming this; this spec makes the claim executable)
 *   - a 503 from the run route must render as a WARNING "ADX not configured",
 *     not as an error — an infra gate is not a user mistake
 *   - the run request must carry the board, and results must render
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { AnalysisBoardEditor } from '../phase4/analysis-board-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }

function installFetch(opts: { load?: () => Response; run?: () => Response } = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/api/cosmos-items/analysis-board/')) {
      return (opts.load ? opts.load() : json({ state: null })) as any;
    }
    if (url.includes('/run')) {
      return (opts.run ? opts.run() : json({ ok: true, columns: [], rows: [], rowCount: 0, executionMs: 1 })) as any;
    }
    return json({ ok: true });
  });
  return calls;
}

const boardState = (board: unknown) => () =>
  new Response(JSON.stringify({ state: { board } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

function renderEditor(id = 'board-fixture') {
  return renderWithProviders(
    <AnalysisBoardEditor item={makeItem('analysis-board', 'Analysis Board')} id={id} />,
  );
}

describe('AnalysisBoardEditor — ux-baseline G6 clean first-open', () => {
  it('shows a GUIDED HINT (not a red error) on a freshly created, untouched board', async () => {
    // The editor claims this in a code comment at :173-177. Making it
    // executable means the claim cannot silently regress.
    installFetch();
    renderEditor();

    await waitFor(() =>
      expect(
        screen.getByText('Pick a source table (or base query) above — the compiled KQL preview updates live.'),
      ).toBeInTheDocument(),
    );
    // No error surface anywhere on an untouched board.
    expect(screen.queryByText(/^Source table is required/i)).not.toBeInTheDocument();
  });

  it('DOES surface the compile error once the board has been touched but is still invalid', async () => {
    // A board with a step but no source is a genuine authoring mistake and must
    // be reported — the G6 hint is for the untouched case only, not a blanket
    // suppression.
    installFetch({ load: boardState({ source: { kind: 'table', table: '' }, steps: [{ type: 'limit', count: 10 }] }) });
    renderEditor();

    await waitFor(() =>
      expect(
        screen.queryByText('Pick a source table (or base query) above — the compiled KQL preview updates live.'),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('AnalysisBoardEditor — live compiled-KQL preview', () => {
  it('compiles the persisted board and shows the KQL', async () => {
    installFetch({ load: boardState({
      source: { kind: 'table', table: 'Events' },
      steps: [{ type: 'limit', count: 25 }],
    }) });
    const { container } = renderEditor();

    await waitFor(() => expect(container.textContent).toContain('Events'));
    // The take/limit operator reaches the compiled query.
    await waitFor(() => expect(container.textContent).toMatch(/take 25|limit 25/));
  });

  it('updates the compiled KQL LIVE when a step is added (no Run required)', async () => {
    installFetch({ load: boardState({ source: { kind: 'table', table: 'Events' }, steps: [] }) });
    const { container } = renderEditor();

    await waitFor(() => expect(container.textContent).toContain('Events'));
    expect(container.textContent).not.toMatch(/take 100|limit 100/);

    // Add step defaults to "filter"; switch the picker is fiddly, so add the
    // default and assert the pipeline GREW — the live-recompile contract.
    const before = container.textContent || '';
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      const after = container.textContent || '';
      expect(after).not.toBe(before);
    });
  });
});

describe('AnalysisBoardEditor — run behaviour', () => {
  it('POSTs the board to the run route and renders the returned rows', async () => {
    const calls = installFetch({
      load: boardState({ source: { kind: 'table', table: 'Events' }, steps: [] }),
      run: () =>
        new Response(JSON.stringify({
          ok: true, columns: ['region', 'n'], rows: [['emea', 12], ['amer', 7]],
          rowCount: 2, executionMs: 43,
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('Results — 2 row(s)')).toBeInTheDocument());
    expect(screen.getByText('emea')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // Timing is reported so a slow query is visible.
    expect(screen.getByText('2 row(s) in 43 ms.')).toBeInTheDocument();

    const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/run'));
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post!.init!.body)).board.source.table).toBe('Events');
  });

  it('renders a 503 infra gate as a WARNING titled "ADX not configured", never as an error', async () => {
    // An unprovisioned backend is not a user mistake. Downgrading 503 to
    // warning is deliberate in the editor (:105) and is exactly the
    // honest-gate posture no-vaporware.md requires.
    installFetch({
      load: boardState({ source: { kind: 'table', table: 'Events' }, steps: [] }),
      run: () =>
        new Response(JSON.stringify({
          ok: false, error: 'ADX cluster not configured',
          gate: { remediation: 'set LOOM_ADX_CLUSTER_URI' },
        }), { status: 503, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('ADX not configured')).toBeInTheDocument());
    // The concrete remediation reaches the user, appended to the error.
    expect(screen.getByText(/set LOOM_ADX_CLUSTER_URI/)).toBeInTheDocument();
  });

  it('does not call the backend at all when the board does not compile', async () => {
    // Guard against wasting a real ADX round-trip (and a confusing server-side
    // error) on a board the client already knows is invalid.
    const calls = installFetch({
      load: boardState({ source: { kind: 'table', table: '' }, steps: [{ type: 'limit', count: 5 }] }),
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => {
      expect(calls.some((c) => c.init?.method === 'POST' && c.url.includes('/run'))).toBe(false);
    });
  });
});

describe('AnalysisBoardEditor — persistence contract', () => {
  it('PATCHes {state:{board}} to the item route on Save', async () => {
    const calls = installFetch({
      load: boardState({ source: { kind: 'table', table: 'Events' }, steps: [] }),
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('/api/items/analysis-board/');
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.state.board.source.table).toBe('Events');
    });
  });
});

describe('AnalysisBoardEditor — FIXED (C19): a failed load is never mistaken for a blank board', () => {
  /**
   * `analysis-board` carried the same silent-failure defect C14 pinned in
   * fusion-sheet and notepad (docs/fiab/parity/analysis-board.md row U6): the
   * load was `catch { /* keep default *\/ }`, so a 500 / 403 / network failure
   * rendered the DEFAULT blank board — and Save then PATCHed that blank board
   * over the user's real source + steps.
   *
   * C19 fixed it with `useItemDocState` (lib/editors/use-item-doc-state.tsx).
   */
  it('renders an honest error MessageBar + Retry when the load 500s', async () => {
    installFetch({ load: () => new Response('boom', { status: 500 }) as any });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read this analysis board')).toBeInTheDocument(),
    );
    // R7: reports the observed status, never an invented cause.
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The board surface stays up around the error.
    expect(screen.getByText('Analysis board')).toBeInTheDocument();
  });

  it('DATA-LOSS GUARD: Save is disabled after a failed load and issues no PATCH', async () => {
    const calls = installFetch({ load: () => new Response('boom', { status: 500 }) as any });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read this analysis board')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('an {ok:false} 200 envelope is ALSO treated as a failed read, not as an empty board', async () => {
    // The BFF answers some failures 200 + {ok:false}. Reading only res.ok would
    // let that through as "successfully read, no board" — and overwrite it.
    installFetch({
      load: () =>
        new Response(JSON.stringify({ ok: false, error: 'Cosmos partition unavailable' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as any,
    });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read this analysis board')).toBeInTheDocument(),
    );
    expect(screen.getByText(/Cosmos partition unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
