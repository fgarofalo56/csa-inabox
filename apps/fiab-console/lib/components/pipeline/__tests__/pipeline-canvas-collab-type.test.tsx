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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

const ITEM_ID = '21c25022-3796-4d50-9140-f9af45135394';

/** Every URL the collab hooks requested. */
let urls: string[] = [];

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
  const { PipelineCanvas } = await import('../canvas');
  render(<PipelineCanvas activities={[]} {...(props as any)} />);
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
