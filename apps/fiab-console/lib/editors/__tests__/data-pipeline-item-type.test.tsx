/**
 * #3698 — the pipeline editor addressed GENERIC item routes under a HARDCODED
 * `'data-pipeline'`, so every `adf-pipeline` / `synapse-pipeline` item 404'd.
 *
 * Measured live (Commercial, SHA d5804399) on
 * `/items/adf-pipeline/21c25022-…`:
 *
 *   GET /api/cosmos-items/data-pipeline/21c25022-…   404   ← what it requested
 *   GET /api/cosmos-items/adf-pipeline/21c25022-…    200   ← the item's real type
 *
 * A clean A/B: same item, same id, same session, only the type segment differs.
 *
 * WHY THE EDITOR SEES THREE SLUGS. `adf-pipeline` AND `synapse-pipeline` both
 * carry `aliasOf:'data-pipeline'` (catalog/item-types/azure-data-factory.ts and
 * synapse-analytics.ts), so `/items/[type]/[id]/page.tsx` resolves BOTH onto
 * this ONE unified editor — while the URL and the PERSISTED `c.itemType` stay
 * the original slug. Every generic route (`/api/cosmos-items/[type]/[id]` and
 * `/api/items/[type]/[id]/…`) matches `c.itemType` EXACTLY, so the literal
 * could never resolve those items.
 *
 * These specs assert the editor addresses the ITEM'S OWN slug, and that the
 * canvas is handed that slug for the shared collaboration layer (the
 * canvas-comments / canvas-presence / collab-stream calls of #3697).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

/** Captures the props the editor hands the canvas (which owns the collab layer). */
const canvasProps: Array<Record<string, unknown>> = [];

// Same rationale as data-pipeline.test.tsx: the real React Flow canvas OOMs the
// jsdom worker. Stub it, but RECORD its props so we can assert the item type
// the collaboration layer would address.
vi.mock('@/lib/components/pipeline/canvas', () => ({
  PipelineCanvas: React.forwardRef((props: any, _ref: any) => {
    canvasProps.push(props);
    return React.createElement('div', { 'data-testid': 'pipeline-canvas-stub' }, 'canvas');
  }),
}));

import { DataPipelineEditor } from '../data-pipeline-editor';
import { makeItem, installFetchMock } from './test-helpers';

const ITEM_ID = '21c25022-3796-4d50-9140-f9af45135394';

function mountFor(slug: string) {
  const { calls } = installFetchMock({
    '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
    // The generic item-hydrate route answers ONLY for the item's real type —
    // exactly like Cosmos, which matches `c.itemType` exactly. A wrong-type
    // request therefore yields no workspaceId, reproducing the live 404.
    [`/api/cosmos-items/${slug}/${ITEM_ID}`]: () => ({ id: ITEM_ID, workspaceId: 'ws-1', itemType: slug }),
    '/api/items/': () => ({ ok: true, pipelines: [] }),
  });
  render(<DataPipelineEditor item={makeItem(slug, 'Pipeline')} id={ITEM_ID} />);
  return calls;
}

/** Every cosmos-items URL the editor requested, in order. */
function cosmosItemsCalls(calls: Array<{ url: string }>) {
  return calls.map((c) => c.url).filter((u) => u.includes('/api/cosmos-items/'));
}

describe('#3698 the pipeline editor hydrates the item under its OWN type', () => {
  beforeEach(() => { canvasProps.length = 0; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('an adf-pipeline item is fetched as adf-pipeline, never as data-pipeline', async () => {
    const calls = mountFor('adf-pipeline');
    await waitFor(() => {
      expect(cosmosItemsCalls(calls).length).toBeGreaterThan(0);
    });
    const urls = cosmosItemsCalls(calls);
    // The live defect, asserted directly: the wrong-type URL must never be sent.
    expect(urls.some((u) => u.includes(`/api/cosmos-items/data-pipeline/${ITEM_ID}`)),
      `editor requested the WRONG type; urls=${JSON.stringify(urls)}`).toBe(false);
    expect(urls.some((u) => u.includes(`/api/cosmos-items/adf-pipeline/${ITEM_ID}`)),
      `editor did not request its own type; urls=${JSON.stringify(urls)}`).toBe(true);
  });

  it('a synapse-pipeline item is fetched as synapse-pipeline (it is ALSO aliasOf data-pipeline)', async () => {
    const calls = mountFor('synapse-pipeline');
    await waitFor(() => {
      expect(cosmosItemsCalls(calls).length).toBeGreaterThan(0);
    });
    const urls = cosmosItemsCalls(calls);
    expect(urls.some((u) => u.includes(`/api/cosmos-items/data-pipeline/${ITEM_ID}`))).toBe(false);
    expect(urls.some((u) => u.includes(`/api/cosmos-items/synapse-pipeline/${ITEM_ID}`))).toBe(true);
  });

  it('CONTROL — a genuine data-pipeline item is still fetched as data-pipeline', async () => {
    const calls = mountFor('data-pipeline');
    await waitFor(() => {
      expect(cosmosItemsCalls(calls).length).toBeGreaterThan(0);
    });
    expect(cosmosItemsCalls(calls).some((u) => u.includes(`/api/cosmos-items/data-pipeline/${ITEM_ID}`))).toBe(true);
  });
});

describe('#3698 the canvas collab layer is addressed with the item\'s real type', () => {
  beforeEach(() => { canvasProps.length = 0; });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  /**
   * The canvas is reached through the DELEGATION path, not this editor's own
   * body: for the Azure-native runtimes DataPipelineEditor renders
   * AdfPipelineEditor / SynapsePipelineEditor → PipelineEditorCore →
   * PipelineDesigner → PipelineCanvas. Assert the plumbing at PipelineDesigner,
   * the link that previously dropped the type on the floor.
   *
   * The bug was a DEFAULT — `itemType = 'data-pipeline'` in PipelineCanvas'
   * parameter list. PipelineDesigner never forwarded a type, so every host
   * silently addressed the collab routes under the head slug.
   */
  async function renderDesigner(props: Record<string, unknown>) {
    const { PipelineDesigner } = await import('@/lib/components/pipeline/pipeline-designer');
    render(<PipelineDesigner activities={[]} {...(props as any)} />);
    await waitFor(() => { expect(canvasProps.length).toBeGreaterThan(0); });
    return canvasProps;
  }

  it('forwards the item type to the canvas that owns the collab layer', async () => {
    const seen = await renderDesigner({ itemId: ITEM_ID, itemType: 'adf-pipeline' });
    const types = new Set(seen.map((p) => p.itemType));
    expect(types.has('data-pipeline'),
      `designer mislabelled the item; saw ${JSON.stringify([...types])}`).toBe(false);
    expect(types.has('adf-pipeline')).toBe(true);
  });

  it('forwards synapse-pipeline unchanged', async () => {
    const seen = await renderDesigner({ itemId: ITEM_ID, itemType: 'synapse-pipeline' });
    expect(new Set(seen.map((p) => p.itemType)).has('synapse-pipeline')).toBe(true);
  });

  it('passes NO type when the host cannot name one — the canvas must not guess', async () => {
    // Guessing is precisely what produced the 404 storm. Absent a type the
    // canvas suppresses the overlay rather than pointing it at the wrong item.
    const seen = await renderDesigner({ itemId: ITEM_ID });
    expect(seen.every((p) => p.itemType === undefined),
      `a type was invented; saw ${JSON.stringify(seen.map((p) => p.itemType))}`).toBe(true);
  });
});
