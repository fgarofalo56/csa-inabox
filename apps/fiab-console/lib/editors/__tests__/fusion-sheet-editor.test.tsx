/**
 * FusionSheetEditor — behaviour specs (FINISHLINE C14).
 *
 * `fusion-sheet` had no editor test (only the pure engine was covered). These
 * pin the editor's REAL contract — what it loads, what it evaluates, and
 * critically what it PERSISTS — not that a div renders.
 *
 * Cells are addressed by GRID POSITION rather than by text, because the row
 * headers are the numbers 1-20 and would otherwise collide with cell values
 * (a `getByText('7')` matches both cell A7's header and any cell containing 7).
 *
 * Each spec goes red on a specific plausible regression:
 *   - load  : persisted cells must reach the grid (a changed state shape or a
 *             broken response path silently renders an empty sheet)
 *   - eval  : the grid must show EVALUATED values, never raw formula text
 *   - save  : the PATCH body shape is the persistence contract
 *   - the "documented defect" spec at the end is the important one — see it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { FusionSheetEditor } from '../phase4/fusion-sheet-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const COLS = 10; // must track fusion-sheet-editor.tsx's COLS constant

/** Resolve an A1-style ref to its <td> in the rendered grid. */
function cell(container: HTMLElement, ref: string): HTMLElement {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  const col = m[1].split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const row = Number(m[2]) - 1;
  const tds = container.querySelectorAll('tbody tr td');
  const td = tds[row * COLS + col] as HTMLElement | undefined;
  if (!td) throw new Error(`no cell rendered at ${ref}`);
  return td;
}

const shown = (container: HTMLElement, ref: string) => cell(container, ref).textContent?.trim() ?? '';

interface Call { url: string; init?: RequestInit }

/** Mock fetch: `loadResponse` answers the cosmos-items GET; PATCH answers 200. */
function installFetch(loadResponse: () => Response | never) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    if (url.includes('/api/cosmos-items/fusion-sheet/')) return loadResponse() as any;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  });
  return calls;
}

const okCells = (cells: Record<string, string>) => () =>
  new Response(JSON.stringify({ state: { cells } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function renderEditor() {
  return renderWithProviders(
    <FusionSheetEditor item={makeItem('fusion-sheet', 'Fusion Sheet')} id="sheet-fixture" />,
  );
}

describe('FusionSheetEditor — load + evaluate', () => {
  it('renders persisted cells and shows the EVALUATED value of a formula, not the formula text', async () => {
    installFetch(okCells({ A1: '2', A2: '3', B1: '=SUM(A1:A2)' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'A1')).toBe('2'));
    expect(shown(container, 'A2')).toBe('3');
    // B1 shows 5 — the computed value, not "=SUM(A1:A2)".
    expect(shown(container, 'B1')).toBe('5');
    expect(screen.queryByText('=SUM(A1:A2)')).not.toBeInTheDocument();
  });

  it('recomputes dependents when a cell is edited (the grid is live, not a snapshot)', async () => {
    installFetch(okCells({ A1: '2', A2: '3', B1: '=SUM(A1:A2)' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'B1')).toBe('5'));

    // Click A1 to edit, type 10, commit with Enter.
    fireEvent.click(cell(container, 'A1').querySelector('div')!);
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // B1 must now read 13. Stale memoisation would leave it at 5.
    await waitFor(() => expect(shown(container, 'B1')).toBe('13'));
    expect(shown(container, 'A1')).toBe('10');
  });

  it('abandons an in-progress edit on Escape without changing the cell', async () => {
    installFetch(okCells({ A1: '2' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'A1')).toBe('2'));
    fireEvent.click(cell(container, 'A1').querySelector('div')!);
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(shown(container, 'A1')).toBe('2'));
  });

  it('surfaces an engine error value in the grid rather than rendering a blank cell', async () => {
    installFetch(okCells({ A1: '=A1' })); // self-reference -> cycle
    const { container } = renderEditor();

    // A broken formula must be VISIBLE. A blank cell would hide it.
    await waitFor(() => expect(shown(container, 'A1')).not.toBe(''));
    expect(shown(container, 'A1')).toMatch(/#/); // Excel-style error token
  });
});

describe('FusionSheetEditor — persistence contract', () => {
  it('PATCHes the item route with the exact {state:{cells}} shape', async () => {
    const calls = installFetch(okCells({ A1: '7' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'A1')).toBe('7'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch, 'a PATCH must be issued on Save').toBeTruthy();
      expect(patch!.url).toContain('/api/items/fusion-sheet/');
      const body = JSON.parse(String(patch!.init!.body));
      expect(body).toEqual({ state: { cells: { A1: '7' } } });
    });
  });

  it('persists the RAW formula text, never the evaluated value', async () => {
    // Saving "5" instead of "=SUM(A1:A2)" would destroy the sheet's logic on the
    // next load — silent, unrecoverable corruption.
    const calls = installFetch(okCells({ A1: '2', A2: '3', B1: '=SUM(A1:A2)' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'B1')).toBe('5'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body)).state.cells.B1).toBe('=SUM(A1:A2)');
    });
  });

  it('removes a cell from the persisted map when its content is cleared', async () => {
    const calls = installFetch(okCells({ A1: '7' }));
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'A1')).toBe('7'));
    fireEvent.click(cell(container, 'A1').querySelector('div')!);
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      // Cleared cells are DELETED, not stored as empty strings — otherwise the
      // map grows without bound as cells are cleared and re-entered.
      expect(body.state.cells).not.toHaveProperty('A1');
    });
  });

  it('reports a failed save instead of silently appearing to succeed', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/cosmos-items/fusion-sheet/')) {
        return new Response(JSON.stringify({ state: { cells: { A1: '1' } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as any;
      }
      return new Response('nope', { status: 500 }) as any;
    });
    const { container } = renderEditor();

    await waitFor(() => expect(shown(container, 'A1')).toBe('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Save failed.')).toBeInTheDocument());
  });
});

describe('FusionSheetEditor — FIXED (C19): a failed load is never mistaken for an empty sheet', () => {
  /**
   * C14 pinned this as a DOCUMENTED DEFECT: the load was wrapped in
   * `catch { /* keep empty *\/ }`, so a 500 / 403 / network failure rendered an
   * empty grid visually identical to a genuinely empty sheet — and Save then
   * PATCHed `{cells:{}}` over the user's real persisted cells. A transient
   * backend error silently destroyed work.
   *
   * C19 fixed it with `useItemDocState` (lib/editors/use-item-doc-state.tsx),
   * which makes the failure an EXPLICIT status and refuses to save while the
   * stored content is unknown. The C14 assertions below are inverted, as their
   * comment instructed — the defect is gone, so the specs now pin the fix.
   *
   * See docs/fiab/parity/fusion-sheet.md row U6.
   */
  it('renders an honest error MessageBar + Retry — not a blank grid — when the load 500s', async () => {
    installFetch(() => new Response('boom', { status: 500 }));
    const { container } = renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read this fusion sheet')).toBeInTheDocument(),
    );
    // R7: the message reports what was actually observed (the status code),
    // never an invented cause.
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The grid still renders around the error — the surface is not replaced.
    expect(shown(container, 'A1')).toBe('');
    expect(screen.getByText('Fusion sheet')).toBeInTheDocument();
  });

  it('DATA-LOSS GUARD: Save is disabled after a failed load, so a blank grid cannot overwrite real cells', async () => {
    const calls = installFetch(() => new Response('boom', { status: 500 }));
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('Could not read this fusion sheet')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    // And even if the disabled attribute were bypassed, NO PATCH is issued.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('recovers on Retry: a successful re-read restores the cells and re-enables Save', async () => {
    let attempt = 0;
    const calls: Call[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      calls.push({ url, init });
      if (url.includes('/api/cosmos-items/fusion-sheet/')) {
        attempt += 1;
        return (attempt === 1
          ? new Response('boom', { status: 500 })
          : new Response(JSON.stringify({ state: { cells: { A1: '42' } } }), {
              status: 200, headers: { 'content-type': 'application/json' },
            })) as any;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as any;
    });

    const { container } = renderEditor();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(shown(container, 'A1')).toBe('42'));
    expect(screen.queryByText('Could not read this fusion sheet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
