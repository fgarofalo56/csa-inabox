/**
 * NotepadEditor — behaviour specs (FINISHLINE C14).
 *
 * `notepad` had no editor test. These pin the live-data-document contract:
 *   - persisted blocks reach the document, and each block TYPE renders its own
 *     control (a heading must not become a textarea)
 *   - a query block RUNS against ADX and renders real rows + timing
 *   - the gate remediation from the run-block route reaches the user
 *   - block reordering and removal actually mutate the persisted order — the
 *     PATCH body is the contract
 *   - the documented U5/U6 defect is pinned executably (see its comment)
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NotepadEditor } from '../phase4/notepad-editor';
import { makeItem, renderWithProviders } from './test-helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Call { url: string; init?: RequestInit }
type Block = { type: 'heading' | 'text' | 'query'; content: string };

function installFetch(opts: { load?: () => Response; runBlock?: () => Response } = {}) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as any;

    if (url.includes('/api/cosmos-items/notepad/')) {
      return (opts.load ? opts.load() : json({ state: { blocks: [] } })) as any;
    }
    if (url.includes('/run-block')) {
      return (opts.runBlock
        ? opts.runBlock()
        : json({ ok: true, columns: [], rows: [], rowCount: 0, executionMs: 1 })) as any;
    }
    return json({ ok: true });
  });
  return calls;
}

const withBlocks = (blocks: Block[]) => () =>
  new Response(JSON.stringify({ state: { blocks } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

function renderEditor(id = 'notepad-fixture') {
  return renderWithProviders(<NotepadEditor item={makeItem('notepad', 'Notepad')} id={id} />);
}

describe('NotepadEditor — block rendering', () => {
  it('renders persisted blocks and gives each TYPE its own control', async () => {
    installFetch({ load: withBlocks([
      { type: 'heading', content: 'Traffic review' },
      { type: 'text', content: 'Narrative paragraph' },
      { type: 'query', content: 'Events | count' },
    ]) });
    renderEditor();

    // Heading renders as an <input> AND is echoed below it.
    await waitFor(() => expect(screen.getByDisplayValue('Traffic review')).toBeInTheDocument());
    expect(screen.getByText('Traffic review')).toBeInTheDocument();
    // FINDING (a11y, docs/fiab/parity/notepad.md): the echoed heading is a
    // Fluent `Title3`, which renders a <span> — NOT an <h1>-<h6>. A document
    // surface whose headings carry no heading role gives screen-reader users no
    // structure to navigate by. Pinned as the current behaviour so that fixing
    // it (Title3 `as="h3"`) turns this red and the assertion gets upgraded to
    // `getByRole('heading')`.
    expect(screen.queryByRole('heading', { name: 'Traffic review' })).not.toBeInTheDocument();
    // Text + query render as textareas with their content.
    expect(screen.getByDisplayValue('Narrative paragraph')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Events | count')).toBeInTheDocument();
    // Only the QUERY block gets a Run button — a text block must not be runnable.
    expect(screen.getAllByRole('button', { name: 'Run' })).toHaveLength(1);
  });

  it('shows the guided-empty caption when the document has no blocks', async () => {
    installFetch();
    renderEditor();
    await waitFor(() =>
      expect(screen.getByText('No blocks yet — add a heading, text, or KQL query block.')).toBeInTheDocument(),
    );
  });

  it('adds a block of the selected type', async () => {
    installFetch();
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // Default add-type is "text": a textarea appears and the empty caption goes.
    await waitFor(() =>
      expect(screen.queryByText('No blocks yet — add a heading, text, or KQL query block.')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('NotepadEditor — running a query block against ADX', () => {
  it('POSTs the block KQL to the run-block route and renders rows + timing', async () => {
    const calls = installFetch({
      load: withBlocks([{ type: 'query', content: 'Events | summarize count() by region' }]),
      runBlock: () =>
        new Response(JSON.stringify({
          ok: true, columns: ['region', 'count_'], rows: [['emea', 41], ['amer', 9]],
          rowCount: 2, executionMs: 87,
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('emea')).toBeInTheDocument());
    expect(screen.getByText('41')).toBeInTheDocument();
    // Timing + row count are reported (ux-standards data-preview bar).
    expect(screen.getByText('2 row(s) · 87 ms')).toBeInTheDocument();

    const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/run-block'));
    expect(post).toBeTruthy();
    // The BLOCK's own KQL is what runs — not a stale or shared buffer.
    expect(JSON.parse(String(post!.init!.body)).kql).toBe('Events | summarize count() by region');
  });

  it('runs the CLICKED block, not the first one', async () => {
    // Index-keyed blocks make this an easy regression: a shared handler or a
    // stale closure would silently always run block 0.
    const calls = installFetch({
      load: withBlocks([
        { type: 'query', content: 'FIRST | count' },
        { type: 'query', content: 'SECOND | count' },
      ]),
    });
    renderEditor();

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Run' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Run' })[1]);

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/run-block'));
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post!.init!.body)).kql).toBe('SECOND | count');
    });
  });

  it('surfaces the run-block gate remediation rather than a bare failure', async () => {
    installFetch({
      load: withBlocks([{ type: 'query', content: 'Events | count' }]),
      runBlock: () =>
        new Response(JSON.stringify({
          ok: false, error: 'ADX not configured',
          gate: { remediation: 'set LOOM_ADX_CLUSTER_URI on loom-console' },
        }), { status: 200, headers: { 'content-type': 'application/json' } }) as any,
    });
    renderEditor();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(screen.getByText('ADX not configured — set LOOM_ADX_CLUSTER_URI on loom-console')).toBeInTheDocument(),
    );
  });
});

describe('NotepadEditor — persistence contract', () => {
  it('PATCHes {state:{blocks}} preserving block order and type', async () => {
    const calls = installFetch({ load: withBlocks([
      { type: 'heading', content: 'A' },
      { type: 'text', content: 'B' },
    ]) });
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue('A')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.url).toContain('/api/items/notepad/');
      expect(JSON.parse(String(patch!.init!.body))).toEqual({
        state: { blocks: [{ type: 'heading', content: 'A' }, { type: 'text', content: 'B' }] },
      });
    });
  });

  it('persists the NEW order after a block is moved up', async () => {
    const calls = installFetch({ load: withBlocks([
      { type: 'heading', content: 'first' },
      { type: 'heading', content: 'second' },
    ]) });
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue('first')).toBeInTheDocument());
    // Move the SECOND block up.
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const blocks = JSON.parse(String(patch!.init!.body)).state.blocks;
      expect(blocks.map((b: Block) => b.content)).toEqual(['second', 'first']);
    });
  });

  it('persists the removal of a block', async () => {
    const calls = installFetch({ load: withBlocks([
      { type: 'heading', content: 'keep' },
      { type: 'heading', content: 'drop' },
    ]) });
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue('drop')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove block' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((c) => c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const blocks = JSON.parse(String(patch!.init!.body)).state.blocks;
      expect(blocks.map((b: Block) => b.content)).toEqual(['keep']);
    });
  });

  it('reports a failed save instead of appearing to succeed', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.toString?.() ?? input);
      if (url.includes('/api/cosmos-items/notepad/')) {
        return new Response(JSON.stringify({ state: { blocks: [{ type: 'text', content: 'x' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }) as any;
      }
      return new Response('nope', { status: 500 }) as any;
    });
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue('x')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Save failed.')).toBeInTheDocument());
  });
});

describe('NotepadEditor — DOCUMENTED DEFECT: a failed load looks like an empty document', () => {
  /**
   * Asserts the CURRENT behaviour, which is WRONG, and says so.
   *
   * notepad-editor.tsx:40-49 wraps the load in `catch { /* keep empty *\/ }` and
   * has no loading state at all. A 500 / 403 / network failure renders "No
   * blocks yet", identical to a genuinely empty document — and Save then
   * PATCHes `{blocks:[]}` over the real content.
   *
   * Pinned executably so the defect is not merely prose, and so whoever fixes
   * it gets a RED test telling them to invert this assertion.
   *
   * See docs/fiab/parity/notepad.md rows U5/U6. Same class in fusion-sheet (U6)
   * and analysis-board (U6); already fixed in s3-gateway (apex A3) and
   * ducklake-catalog (C14).
   */
  it('CURRENT (defective): a 500 on load renders "No blocks yet" with no error surface', async () => {
    installFetch({ load: () => new Response('boom', { status: 500 }) as any });
    renderEditor();

    await waitFor(() =>
      expect(screen.getByText('No blocks yet — add a heading, text, or KQL query block.')).toBeInTheDocument(),
    );
    // No error anywhere. When U5/U6 is fixed, invert this to expect an honest
    // error MessageBar + Retry.
    expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
});
