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
 * THE FIX IS TWO INDEPENDENT LAYERS, SO THIS SPEC IS TWO INDEPENDENT TESTS.
 * The header this file carried until the review claimed one test caught both:
 * "Restoring `starterCells()`, OR dropping the `cellsFor !== notebookId` render
 * gate, turns test one red." That was measured and it is FALSE — each disjunct
 * on its own shipped GREEN (RC=0, 2/2), and only both together went red. An
 * untrue mutation-control claim is worse than none: it is how the next person
 * talks themselves into deleting one of the two layers. What is actually true:
 *
 *   LAYER 1 — the render gate (`notebookId && cellsFor === notebookId`) is what
 *   keeps ANY cell list off the screen while hydration is in flight. Test one
 *   owns it, and to own it the test must assert the cell-list surface is ABSENT,
 *   not merely that the loading spinner is PRESENT: reverting the gate leaves
 *   the sibling loading block in place, so "the spinner is up" stays true while
 *   the list renders underneath it.
 *
 *   LAYER 2 — the empty seed (`id === 'new' ? starterCells() : []`) is what
 *   keeps fabricated content out of `cells` in the first place. The render gate
 *   hides it DURING hydration, so a seed regression is invisible to test one by
 *   construction. It becomes visible the moment the gate legitimately opens on
 *   a notebook whose cells were never replaced — which is exactly what a FAILED
 *   detail load does: `loadDetail` returns early on `!j.ok` without calling
 *   `setCells`, and its `finally` still sets `cellsFor`, so the list renders
 *   whatever the seed put there. Test two owns that. (It is also a real defect
 *   in its own right: a notebook whose content could not be read must not show
 *   a generic starter notebook as if that WERE its content.)
 *
 * THE EMBEDDED CONTROL (third test) is the part that makes the absences mean
 * anything. Markdown cells render through `dangerouslySetInnerHTML`, so "the
 * placeholder text is absent" could be true simply because the harness never
 * renders that text under ANY circumstances — a guard with zero population,
 * green and blind. The control hydrates a notebook whose real content IS the
 * starter text and asserts it is findable.
 *
 * MUTATION CONTROL — each arm measured in BOTH directions, one layer at a time:
 *   | reverted layer                          | before | after |
 *   |-----------------------------------------|--------|-------|
 *   | seed -> `starterCells()`, gate intact    |   0    |   1  (test two)  |
 *   | render gate dropped, empty seed intact   |   0    |   1  (test one)  |
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NotebookEditor } from '../notebook-editor';
import { makeItem } from './test-helpers';

const ITEM_ID = 'b3d21f77-1c40-4a6e-9f18-2ee0c7a41b55';
const PLACEHOLDER = /Double-click to edit/i;

/**
 * The cell-list surface itself — everything inside the `cellsFor === notebookId`
 * branch, of which this `<Select>` is the cheapest unambiguous marker (it is the
 * only "Default cell language" control in the editor). Its PRESENCE means the
 * render gate is open and cells are on screen; its ABSENCE means they are not.
 */
const cellList = () => document.querySelector('select[aria-label="Default cell language"]');
const loadingCells = () => document.querySelector('[data-notebook-cells-loading]');

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
 * `detail` is what that read finally answers — a definition for the success
 * path, or `{ok:false,…}` for the failure path test two needs.
 */
function installDeferredNotebookFetch(detail: unknown) {
  const gate = deferred<void>();
  const detailUrl = `/api/items/notebook/${ITEM_ID}`;
  vi.spyOn(global, 'fetch').mockImplementation((async (url: any) => {
    const u = typeof url === 'string' ? url : String(url);
    if (u.includes(detailUrl) && !u.includes('/jobs') && !u.includes('/runs') && !u.includes('/lsp')) {
      await gate.promise;
      return jsonBody(detail);
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

const REAL_CONTENT = {
  ok: true,
  definition: {
    cells: [
      { id: 'c1', type: 'markdown', source: '# Contoso revenue baseline' },
      { id: 'c2', type: 'code', lang: 'pyspark', source: 'spark.read.parquet("abfss://gold@contoso/rev")' },
    ],
    defaultLang: 'pyspark',
  },
};

describe('NotebookEditor — installed content, never a placeholder (#3539)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('LAYER 1 (render gate) — no cell list at all while the real content is in flight', async () => {
    const gate = installDeferredNotebookFetch(REAL_CONTENT);

    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id={ITEM_ID} />);

    // In flight: the cell region is a loading state…
    await waitFor(() => expect(loadingCells()).not.toBeNull(), { timeout: 5000 });

    // …and the cell list is NOT rendered underneath it. This is the assertion
    // the gate owns. Asserting only that the spinner is present does NOT catch
    // a reverted gate: the loading block is a SIBLING of the list, so dropping
    // the gate renders both and leaves the spinner assertion true.
    expect(cellList()).toBeNull();

    // THE ASSERTION THE ORIGINAL BUG FAILS: no generic starter content over a
    // real notebook. Before the fix `starterCells()` was mounted right here.
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();

    // Release hydration; the real content replaces the loading state.
    gate.resolve();
    await waitFor(
      () => expect(screen.getAllByText(/Contoso revenue baseline/i).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
    expect(loadingCells()).toBeNull();
    expect(cellList()).not.toBeNull();
    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it('LAYER 2 (empty seed) — a notebook whose detail read FAILS shows no fabricated starter content', async () => {
    // `loadDetail` returns early on `!j.ok` without ever calling `setCells`, and
    // its `finally` still sets `cellsFor` — so the gate opens over whatever the
    // seed left in `cells`. With the seed reverted that is the starter
    // placeholder, presented as if it were this notebook's content.
    const gate = installDeferredNotebookFetch({ ok: false, error: 'notebook detail unavailable' });

    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id={ITEM_ID} />);
    await waitFor(() => expect(loadingCells()).not.toBeNull(), { timeout: 5000 });
    gate.resolve();

    // The gate is OPEN and the cell list IS mounted — so the absence below is a
    // real absence at the exact moment content WOULD be on screen, not an
    // artefact of the list never rendering.
    await waitFor(() => expect(cellList()).not.toBeNull(), { timeout: 5000 });
    expect(loadingCells()).toBeNull();

    expect(screen.queryByText(PLACEHOLDER)).toBeNull();
  });

  it('CONTROL — the placeholder text IS findable in this harness when it is the real content', async () => {
    const gate = installDeferredNotebookFetch({
      ok: true,
      definition: {
        cells: [
          {
            id: 'c1', type: 'markdown',
            source: '# New notebook\n\nDouble-click to edit. Use **+ Code** between cells to add code cells.',
          },
        ],
        defaultLang: 'pyspark',
      },
    });

    render(<NotebookEditor item={makeItem('notebook', 'Notebook')} id={ITEM_ID} />);
    gate.resolve();

    // Non-zero population: the absences asserted in the two tests above are REAL
    // absences, not an artefact of markdown never reaching the DOM.
    await waitFor(
      () => expect(screen.getAllByText(PLACEHOLDER).length).toBeGreaterThan(0),
      { timeout: 5000 },
    );
  });
});
