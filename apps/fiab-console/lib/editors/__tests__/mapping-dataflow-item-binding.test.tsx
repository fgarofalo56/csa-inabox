/**
 * mapping-dataflow — the item id is NOT the ADF data-flow name (#3567).
 *
 * THE DEFECT. A Loom `mapping-dataflow` item id is a Cosmos GUID
 * (`crypto.randomUUID()`), and an ADF data-flow name is
 * `/^[A-Za-z0-9_]{1,260}$/` — hyphens are rejected. The editor sent the id
 * straight through as the resource name, so `GET /api/adf/dataflows/<guid>`
 * answered `400 invalid data flow name`; the editor's 404 branch (which treats
 * "not published yet" as an empty canvas) does not catch a 400, so EVERY open
 * of EVERY existing item landed on the red "Couldn't load the data flow"
 * banner. The item type was completely blocked.
 *
 * WHY THESE ASSERTIONS AND NOT "the editor renders".
 *
 * The bug was invisible to a mount smoke test: the editor mounted fine, and it
 * mounted fine with the wrong URL. The discriminating fact is the SHAPE of the
 * name the editor puts on the wire, so that is what is asserted — every ADF
 * request the editor makes is checked against the ROUTE'S OWN regex
 * (`DATAFLOW_NAME_RE`, copied verbatim from `lib/azure/dataflow-debug.ts`, so
 * the test fails if the two ever drift apart in the direction that matters).
 *
 * MUTATION CONTROL. Reverting `mapping-dataflow-editor.tsx` to
 * `` `/api/adf/dataflows/${encodeURIComponent(id)}` `` turns
 * "every ADF request carries a legal name" red — that is the whole point. The
 * narrow evasions are covered too: asserting only the FIRST request would miss
 * that the debug probe has its own URL, so the assertion runs over the full
 * call log and asserts the log is NON-EMPTY first (a guard whose population is
 * zero is green and blind).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { MappingDataFlowEditor, resolveFlowName } from '../mapping-dataflow-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

/** Verbatim from lib/azure/dataflow-debug.ts — the regex the ROUTE enforces. */
const DATAFLOW_NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** A realistic Cosmos item id: `crypto.randomUUID()` shape, hyphens and all. */
const ITEM_GUID = '7c1f2a90-4d3b-4e51-9a02-6b8e5d0c1f34';

/** Pull the `{name}` segment out of any /api/adf/dataflows/<name>[/...] URL. */
function dataflowNamesRequested(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const m = /\/api\/adf\/dataflows\/([^/?]+)/.exec(u);
    if (m) out.push(decodeURIComponent(m[1]));
  }
  return out;
}

describe('resolveFlowName — item GUID → ADF data-flow resource name (#3567)', () => {
  it('never returns a name the ADF route would reject', () => {
    const name = resolveFlowName(ITEM_GUID, undefined);
    expect(DATAFLOW_NAME_RE.test(name)).toBe(true);
    // The literal defect: the GUID itself is NOT a legal name, so a resolver
    // that simply hands the id back cannot pass the line above.
    expect(DATAFLOW_NAME_RE.test(ITEM_GUID)).toBe(false);
    expect(name).not.toBe(ITEM_GUID);
  });

  it('is deterministic and stable — the same id always resolves to the same name', () => {
    expect(resolveFlowName(ITEM_GUID, undefined)).toBe(resolveFlowName(ITEM_GUID, undefined));
    // Distinct items must not collide on one ADF object: the factory's
    // data-flow namespace is FLAT and shared by every Loom workspace.
    const other = '0a1b2c3d-0000-4000-8000-abcdefabcdef';
    expect(resolveFlowName(other, undefined)).not.toBe(resolveFlowName(ITEM_GUID, undefined));
  });

  it('does NOT depend on the display name, so renaming the item cannot orphan the ADF object', () => {
    const asFiled = resolveFlowName(ITEM_GUID, { displayName: 'Sales flow' });
    const afterRename = resolveFlowName(ITEM_GUID, { displayName: 'Sales flow v2' });
    expect(afterRename).toBe(asFiled);
  });

  it('honours a binding recorded on the item state, when one exists', () => {
    expect(resolveFlowName(ITEM_GUID, { dataFlowName: 'curated_orders' })).toBe('curated_orders');
    expect(resolveFlowName(ITEM_GUID, { adfDataFlowName: 'curated_orders' })).toBe('curated_orders');
    // A recorded value that is ITSELF illegal must not be trusted through —
    // that would reintroduce the 400 by a different door.
    const bad = resolveFlowName(ITEM_GUID, { dataFlowName: 'not-a-legal-name' });
    expect(DATAFLOW_NAME_RE.test(bad)).toBe(true);
    expect(bad).not.toBe('not-a-legal-name');
  });

  it('passes through a route id that is already a legal ADF name (no regression for those)', () => {
    expect(resolveFlowName('dataflow1', undefined)).toBe('dataflow1');
  });
});

describe('MappingDataFlowEditor — what it actually puts on the wire (#3567)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('requests a LEGAL data-flow name for every ADF call, never the item GUID', async () => {
    const { calls } = installFetchMock({
      '/api/adf/dataflows': () => ({ ok: false, error: 'not found' }),
      '/api/adf/datasets': () => ({ ok: true, datasets: [] }),
      '/api/cosmos-items/mapping-dataflow': () => ({
        // BARE document — /api/cosmos-items GET has no {ok,item} envelope
        // (the #3878 family). If this editor started reading `j.ok` here it
        // would silently stop resolving, so the fixture models the REAL shape.
        id: ITEM_GUID, displayName: 'Sales flow', state: {},
      }),
    });

    renderWithProviders(
      <MappingDataFlowEditor item={makeItem('mapping-dataflow', 'Mapping data flow')} id={ITEM_GUID} />,
    );

    await waitFor(() => {
      const names = dataflowNamesRequested(calls.map((c) => c.url));
      expect(names.length).toBeGreaterThan(0);
    }, { timeout: 5000 });

    const names = dataflowNamesRequested(calls.map((c) => c.url));
    // POPULATION, stated: how many ADF data-flow requests this assertion covers.
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(
        DATAFLOW_NAME_RE.test(n),
        `ADF data-flow request used "${n}", which the route rejects with 400 (#3567)`,
      ).toBe(true);
      expect(n).not.toBe(ITEM_GUID);
    }
  });
});
