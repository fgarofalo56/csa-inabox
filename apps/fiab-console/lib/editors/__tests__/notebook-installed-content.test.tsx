/**
 * notebook — no generic "New notebook" placeholder over a real bundle (#3539).
 *
 * THE DEFECT. `cells` was seeded with `starterCells()` — a markdown cell
 * reading "# New notebook / Double-click to edit…" plus a starter code cell —
 * and the cell list rendered it for the whole window between `notebookId`
 * resolving and `loadDetail` returning the notebook's real content. An
 * app-installed notebook therefore showed a generic empty-looking notebook on
 * open, and the user's reasonable conclusion was that the app install had
 * produced nothing.
 *
 * WHY THE TEST IS SHAPED THIS WAY. A test that mocks the detail fetch as an
 * already-resolved promise cannot see this bug at all — the placeholder and the
 * real content arrive in the same tick, so the flash is invisible and any
 * assertion about it is vacuously green. So the detail response here is held
 * OPEN by a deferred promise, the assertion is made while it is in flight, and
 * only then is it released.
 *
 * THE EMBEDDED CONTROL (second test) is the part that makes the first test mean
 * anything. Markdown cells render through `dangerouslySetInnerHTML`, so
 * "the placeholder text is absent" could be true simply because the harness
 * never renders that text under ANY circumstances — a guard with zero
 * population, green and blind. The control hydrates a notebook whose real
 * content IS the starter text and asserts it is findable, which establishes
 * that the absence asserted in test one is a real absence.
 *
 * MUTATION CONTROL. Restoring `useState<NotebookCell[]>(starterCells())`, or
 * dropping the `cellsFor !== notebookId` render gate, turns test one red on
 * the placeholder assertion while the control stays green.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NotebookEditor } from '../notebook-editor';
import { makeItem } from './test-helpers';

const ITEM_ID = 'b3d21f77-1c40-4a6e-9f18-2ee0c7a41b55';
const PLACEHOLDER = /Double-click to edit/i;

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

/**
 * Fetch mock where the notebook DETAIL read is deferred; everything else
 * resolves at once. Returns the gate so the test controls when hydration lands.
 */
function installDeferredNotebookFetch(definition: unknown) {
  const gate = deferred<void>();
  const detailUrl = `/api/items/notebook/${ITEM_ID}`;
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.includes(detailUrl) && !u.includes('/jobs') && !u.includes('/runs') && !u.includes('/lsp')) {
      await gate.promise;
      return jsonBody({ ok: true, definition });
    }
    // The item document: /api/cosmos-items GET returns the BARE doc (#3878).
    if (u.includes('/api/cosmos-items/notebook/')) {
      return jsonBody({ id: ITEM_ID, displayName: 'Installed notebook', workspaceId: 'ws-1', state: {} });
    }
    if (u.includes('/api/loom/workspaces')) {
      return jsonBody({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] });
    }
    if (u.includes('/api/loom/compute-targets')) {
      return jsonBody({ ok: true, targets: [] });
    }
    if (u.includes('/api/items/notebook')) {
      return jsonBody({ ok: true, workspaceId: 'ws-1', notebooks: [{ id: ITEM_ID, displayName: 'Installed notebook' }] });
    }
    return jsonBody({ ok: true });
  }) as any);
  return gate;
}

describe('NotebookEditor — installed content, never a placeholder (#3539)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows a loading state — NOT the "New notebook" starter — while the real content is in flight', async () => {
    const gate = installDeferredNotebookFetch({
      cells: [
        { id: 'c1', type: 'markdown', source: '# Contoso revenue baseline' },
        { id: 'c2', type: 'code', lang: 'pyspark', source: 'spark.read.parquet("abfss://gold@contoso/rev")' },
      ],
      defaultLang: 'pyspark',
    });

    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id={ITEM_ID} />);

    // In flight: the cell region is a loading state.
    await waitFor(
      () => expect(document.querySelector('[data-notebook-cells-loading]')).not.toBeNull(),
      { timeout: 5000 },
    );

    // THE ASSERTION THE BUG FAILS: no generic starter content over a real
    // notebook. Before the fix `starterCells()` was mounted right here.
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();

    // Release hydration; the real content replaces the loading state.
    gate.resolve();
    await waitFor(
      () => expect(screen.getAllByText(/Contoso revenue baseline/i).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    expect(document.querySelector('[data-notebook-cells-loading]')).toBeNull();
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it('CONTROL — the placeholder text IS findable in this harness when it is the real content', async () => {
    const gate = installDeferredNotebookFetch({
      cells: [
        {
          id: 'c1', type: 'markdown',
          source: '# New notebook\n\nDouble-click to edit. Use **+ Code** between cells to add code cells.',
        },
      ],
      defaultLang: 'pyspark',
    });

    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id={ITEM_ID} />);
    gate.resolve();

    // Non-zero population: the assertion in the test above is a REAL absence,
    // not an artefact of markdown never reaching the DOM.
    await waitFor(
      () => expect(screen.getAllByText(PLACEHOLDER).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
  });
});
