/**
 * #3698 (review follow-up) — the REAL `PipelineCanvas` collab-layer gate.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `lib/editors/__tests__/data-pipeline-item-type.test.tsx`
 * mocks `@/lib/components/pipeline/canvas` wholesale, so the two lines in
 * `canvas.tsx` that carry half of the #3698 fix were never executed by it.
 * Measured: restoring the old `itemType = 'data-pipeline'` default AND deleting
 * the `{itemType && …}` suppression left that spec at 6/6 passing. `vi.mock` is
 * file-scoped and hoisted, so pinning the real component needs its own file.
 *
 * WHAT THE FIX IS. The collab endpoints are generic item routes
 * (`/api/items/[type]/[id]/canvas-comments`) and match Cosmos `c.itemType`
 * EXACTLY. A DEFAULTED type is therefore worse than no type at all: it addresses
 * a real URL for the wrong item and 404s. So the canvas takes no default and
 * renders no overlay when the host cannot name the type.
 *
 * ---------------------------------------------------------------------------
 * BUDGET — why the cost was MOVED and a timeout is stated (#3756)
 * ---------------------------------------------------------------------------
 * MEASURED on this box, `vitest run <this file>`, before the change:
 *
 *     issues NO collab request …                6748ms   <- 82% of the file
 *     addresses the collab routes …               63ms
 *     forwards synapse-pipeline unchanged …       55ms
 *     a genuine data-pipeline item … (CONTROL)    56ms
 *     file total 8.25s
 *
 * None of that 6.7s is work the FIRST spec does. It is the cold
 * `await import('../canvas')` — an on-demand TS transform of the real
 * `PipelineCanvas` and its whole module graph — which happened to sit inside
 * that test body, so it was charged to that test's 30s `testTimeout`. #3756
 * measured the same file at 46.5s and FAILING inside a 4-file run on a loaded
 * box: the transform is what stretches under contention, and one test was
 * carrying all of it.
 *
 * TWO CHANGES, in the order that matters:
 *
 *   1. THE COST IS CUT, not merely budgeted for. The import is hoisted into
 *      `beforeAll`, so the transform is paid ONCE, outside every test body, and
 *      the four specs cost ~60ms each. This is #3756's preferred fix and it
 *      weakens nothing: the spec still mounts the REAL `PipelineCanvas` (the
 *      whole reason this file exists separately from
 *      `data-pipeline-item-type.test.tsx`, which mocks the canvas wholesale).
 *   2. THE REMAINING BUDGET IS STATED. The transform still has to happen, and
 *      it now lands in a hook. 60s is sized to the measured ~7s cold cost with
 *      room for the contention #3756 observed — deliberately explicit rather
 *      than resting on `vitest.config.ts`'s 30s default, because CI's
 *      `retry: 2` would otherwise hide the failure exactly as #3756 found (a
 *      test that passes only because it was retried is not passing, and the
 *      same retry would absorb a genuine regression). Same treatment as
 *      `lib/install/__tests__/pipeline-designer-provisioners.test.ts` and
 *      `lib/azure/__tests__/auto-bind-seed.test.ts` from #3696.
 *
 * MEASURED AFTER, same box, same command:
 *
 *     issues NO collab request …                 267ms   (was 6748ms, 25x)
 *     addresses the collab routes …              113ms
 *     forwards synapse-pipeline unchanged …       83ms
 *     a genuine data-pipeline item … (CONTROL)    94ms
 *
 * The FILE total barely moves (~8.2s -> ~11.7s here, run-to-run noise on a
 * loaded box) — and it is not supposed to. The transform still has to happen;
 * what changed is that no single TEST is anywhere near its budget any more,
 * which is the property #3756 is about. Stating this rather than claiming a
 * speed-up the change does not deliver.
 *
 * MUTATION RECEIPT for the change: with the #3698 defect restored in
 * `../canvas` (`<CanvasCollabLayer itemType={itemType ?? 'data-pipeline'} …>`
 * in place of the `{itemType && …}` suppression), this file goes RED — 1 failed
 * / 3 passed, the "issues NO collab request" spec. So hoisting the import did
 * not weaken what the spec proves.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

// See BUDGET above. The hook carries the cold transform; the tests no longer do.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ITEM_ID = '21c25022-3796-4d50-9140-f9af45135394';

/** Every URL the collab hooks requested. */
let urls: string[] = [];

/**
 * The REAL component, imported ONCE. Still the real `../canvas` — this is a cost
 * move, not a substitution; a mocked canvas would delete the only thing this
 * file measures.
 */
let PipelineCanvas: (props: Record<string, unknown>) => React.ReactElement;

beforeAll(async () => {
  ({ PipelineCanvas } = (await import('../canvas')) as never);
});

beforeEach(() => {
  urls = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (u: any) => {
    urls.push(typeof u === 'string' ? u : (u?.toString?.() ?? String(u)));
    return new Response(JSON.stringify({ ok: true, comments: [], peers: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** URLs that address the shared collaboration endpoints. */
const collabUrls = () => urls.filter((u) => /canvas-comments|canvas-presence|collab\/stream/.test(u));

async function renderCanvas(props: Record<string, unknown>) {
  // CONTROL — if the beforeAll import ever silently fails, every spec below
  // would assert over a canvas that never mounted, and the "issues NO collab
  // request" case would pass VACUOUSLY. Fail loudly instead.
  //
  // Not `typeof === 'function'`: the real export is a `React.memo` wrapper,
  // whose typeof is 'object'. Measured — asserting 'function' failed all four
  // specs against a perfectly good component, which is the wrong kind of red.
  expect(PipelineCanvas, 'the real PipelineCanvas was not imported').toBeTruthy();
  const { container } = render(<PipelineCanvas activities={[]} {...(props as any)} />);
  expect(container.firstChild, 'the real PipelineCanvas rendered NOTHING').not.toBeNull();
  return collabUrls;
}

describe('#3698 PipelineCanvas never guesses the item type for the collab layer', () => {
  it('issues NO collab request when the host supplies an itemId but no itemType', async () => {
    await renderCanvas({ itemId: ITEM_ID });
    // Give any effect-driven fetch a chance to fire before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(collabUrls(),
      `the canvas invented a type and addressed the collab routes: ${JSON.stringify(collabUrls())}`,
    ).toEqual([]);
    // CONTROL — proves the assertion above is not vacuous because the whole
    // component failed to mount or fetch is unreachable: the SAME render with a
    // type DOES issue collab requests (asserted in the next spec).
  });

  it('addresses the collab routes under the SUPPLIED type when the host names one', async () => {
    await renderCanvas({ itemId: ITEM_ID, itemType: 'adf-pipeline' });
    await waitFor(() => { expect(collabUrls().length).toBeGreaterThan(0); });
    const hit = collabUrls();
    expect(hit.some((u) => u.includes(`/api/items/adf-pipeline/${ITEM_ID}/`)),
      `collab layer did not use the supplied type; urls=${JSON.stringify(hit)}`).toBe(true);
    // The live defect, asserted directly: the head slug must never appear.
    expect(hit.some((u) => u.includes('/api/items/data-pipeline/')),
      `collab layer fell back to the head slug; urls=${JSON.stringify(hit)}`).toBe(false);
  });

  it('forwards synapse-pipeline unchanged (the second aliasOf slug)', async () => {
    await renderCanvas({ itemId: ITEM_ID, itemType: 'synapse-pipeline' });
    await waitFor(() => { expect(collabUrls().length).toBeGreaterThan(0); });
    expect(collabUrls().some((u) => u.includes(`/api/items/synapse-pipeline/${ITEM_ID}/`))).toBe(true);
    expect(collabUrls().some((u) => u.includes('/api/items/data-pipeline/'))).toBe(false);
  });

  it('a genuine data-pipeline item still addresses data-pipeline (CONTROL)', async () => {
    await renderCanvas({ itemId: ITEM_ID, itemType: 'data-pipeline' });
    await waitFor(() => { expect(collabUrls().length).toBeGreaterThan(0); });
    expect(collabUrls().some((u) => u.includes(`/api/items/data-pipeline/${ITEM_ID}/`))).toBe(true);
  });
});
