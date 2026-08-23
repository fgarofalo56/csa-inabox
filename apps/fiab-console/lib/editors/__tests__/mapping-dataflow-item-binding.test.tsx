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
 * name the editor puts on the wire, so that is what is asserted — every request
 * that carries the name as a path segment is checked against the ROUTE'S OWN
 * regex (`DATAFLOW_NAME_RE`, copied verbatim from `lib/azure/dataflow-debug.ts`,
 * so the test fails if the two ever drift apart in the direction that matters).
 *
 * WHY THE CALL LOG IS NOT ENOUGH ON ITS OWN — the review finding this spec was
 * rewritten to answer. The first version of this file asserted over whatever
 * requests happened to be in the log, and the log on a bare mount contains only
 * the two mount-time GETs. Three of the editor's five name-bearing call sites
 * fire on a USER ACTION and were therefore never observed, so each of these
 * shipped GREEN (RC=0, 6/6) against the previous spec:
 *
 *   - reverting the `<MappingDataFlowDesigner name=…>` prop to the raw `id`,
 *     which is the name the designer PUTs to on **Save**
 *     (`lib/components/pipeline/dataflow/mapping-dataflow-designer.tsx:1196`) —
 *     i.e. the editor's PRIMARY WRITE ACTION 400s again, silently;
 *   - reverting `startDebugPreview`'s POST URL to the raw `id`;
 *   - reverting the `<DataflowDebugPanel name=…>` prop to the raw `id`, whose
 *     routes validate the segment identically
 *     (`app/api/items/mapping-dataflow/[id]/debug/preview/route.ts:63` answers
 *     `400 invalid data flow name`).
 *
 * So this spec DRIVES those actions — Save, the U7 debug dock's session
 * toggle, and (with the U7 flag off) the designer's own debug toggle — instead
 * of waiting to see what a mount happens to emit.
 *
 * THE POPULATION FLOOR. A guard whose population can shrink to zero is green
 * and blind, and "the log no longer contains that request" is exactly how this
 * one would shrink. `SITES` below therefore names each call site individually
 * and asserts it is PRESENT before asserting its name is legal: if a refactor
 * stops firing one of them, this spec goes red rather than quietly narrowing to
 * the sites that remain.
 *
 * MUTATION CONTROL — every arm measured, both directions:
 *   | reverted to the raw item GUID at… | before | after |
 *   |---|---|---|
 *   | `loadFlow` GET                    | 1 | 1 |
 *   | debug-probe GET                   | 1 | 1 |
 *   | `<MappingDataFlowDesigner name=>` | 0 | 1 |
 *   | `startDebugPreview` POST          | 0 | 1 |
 *   | `<DataflowDebugPanel name=>`      | 0 | 1 |
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MappingDataFlowEditor, resolveFlowName } from '../mapping-dataflow-editor';
import { makeItem, installFetchMock, renderWithProviders } from './test-helpers';

/** Verbatim from lib/azure/dataflow-debug.ts — the regex the ROUTE enforces. */
const DATAFLOW_NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** A realistic Cosmos item id: `crypto.randomUUID()` shape, hyphens and all. */
const ITEM_GUID = '7c1f2a90-4d3b-4e51-9a02-6b8e5d0c1f34';

interface Call { url: string; init?: RequestInit }

const methodOf = (c: Call): string => String(c.init?.method || 'GET').toUpperCase();

/**
 * Every URL family that carries the ADF data-flow RESOURCE NAME as a path
 * segment, and whose route 400s a name the regex rejects.
 *   - `/api/adf/dataflows/<name>[/debug]`            — ADF control plane
 *   - `/api/items/mapping-dataflow/<name>/debug/...` — the U7 debug dock
 */
const NAME_IN_PATH: RegExp[] = [
  /\/api\/adf\/dataflows\/([^/?]+)/,
  /\/api\/items\/mapping-dataflow\/([^/?]+)\/debug\//,
];

/** Pull the resource-name segment out of every name-bearing URL in the log. */
function dataflowNamesRequested(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    for (const re of NAME_IN_PATH) {
      const m = re.exec(u);
      if (m) { out.push(decodeURIComponent(m[1])); break; }
    }
  }
  return out;
}

/**
 * The editor's name-bearing call sites, each keyed to the USER-VISIBLE action
 * that fires it. Presence of each is asserted before its name is checked — see
 * "THE POPULATION FLOOR" above.
 */
interface Site { id: string; firesOn: string; match: (c: Call) => boolean }

const MOUNT_SITES: Site[] = [
  {
    id: 'loadFlow GET',
    firesOn: 'mount',
    match: (c) => methodOf(c) === 'GET' && /\/api\/adf\/dataflows\/[^/?]+(\?|$)/.test(c.url),
  },
  {
    id: 'debug-probe GET',
    firesOn: 'mount',
    match: (c) => methodOf(c) === 'GET' && /\/api\/adf\/dataflows\/[^/?]+\/debug(\?|$)/.test(c.url),
  },
];

const SAVE_SITE: Site = {
  id: 'designer Save PUT',
  firesOn: 'the user clicks Save — the editor’s primary write action',
  match: (c) => methodOf(c) === 'PUT' && /\/api\/adf\/dataflows\/[^/?]+(\?|$)/.test(c.url),
};

const DEBUG_DOCK_SITE: Site = {
  id: 'U7 debug-dock session POST',
  firesOn: 'the user turns on Data flow debug in the debug dock',
  match: (c) =>
    methodOf(c) === 'POST' &&
    /\/api\/items\/mapping-dataflow\/[^/?]+\/debug\/session(\?|$)/.test(c.url),
};

const PREVIEW_SITE: Site = {
  id: 'startDebugPreview POST',
  firesOn: 'the user starts a debug session from the designer (U7 flag off)',
  match: (c) => methodOf(c) === 'POST' && /\/api\/adf\/dataflows\/[^/?]+\/debug(\?|$)/.test(c.url),
};

/**
 * Install the fetch mock. `u7` selects which Debug surface mounts:
 *   - `true`  (the product default — `useRuntimeFlag` is default-ON) mounts
 *     <DataflowDebugPanel/> and hides the designer's own debug toggle.
 *   - `false` mounts the pre-U7 in-designer toggle, which is the only route to
 *     `startDebugPreview`.
 */
function installMock(u7: boolean) {
  return installFetchMock({
    '/api/runtime-flags': () => ({ ok: true, flags: { 'u7-dataflow-debug': u7 } }),
    // GET hydrate answers "not published yet"; PUT (Save) succeeds so the
    // designer's own error path is not what this spec ends up measuring.
    '/api/adf/dataflows': (_u, init) =>
      String(init?.method || 'GET').toUpperCase() === 'PUT'
        ? { ok: true }
        : { ok: false, error: 'not found' },
    '/api/adf/datasets': () => ({ ok: true, datasets: [] }),
    '/api/items/mapping-dataflow': () => ({ ok: true, sessionId: 'sess-1', expiresAt: null }),
    '/api/cosmos-items/mapping-dataflow': () => ({
      // BARE document — /api/cosmos-items GET has no {ok,item} envelope
      // (the #3878 family). If this editor started reading `j.ok` here it
      // would silently stop resolving, so the fixture models the REAL shape.
      id: ITEM_GUID, displayName: 'Sales flow', state: {},
    }),
  });
}

/**
 * The Debug toggle, found on a NAMED surface rather than by accessible name.
 *
 * Fluent's `Switch` renders `<input role="switch">` with a sibling `<label>`;
 * jsdom does not compute an accessible name from it, so `getByRole('switch',
 * {name})` finds nothing. Scoping to the surface is the stronger form anyway:
 * it pins WHICH component's toggle was driven, so a future refactor that moves
 * Debug elsewhere fails here instead of silently exercising a different one.
 */
async function debugToggleOn(surface: string): Promise<HTMLElement> {
  const host = await waitFor(() => {
    const el = document.querySelector(`[data-component="${surface}"]`);
    expect(el, `[data-component="${surface}"] never mounted`).not.toBeNull();
    return el as HTMLElement;
  }, { timeout: 5000 });
  return within(host).getByRole('switch');
}

/** Assert a site fired, then assert the name it carried is one ADF accepts. */
function assertSiteLegal(calls: Call[], site: Site): void {
  const hits = calls.filter(site.match);
  expect(
    hits.length,
    `${site.id} never fired (${site.firesOn}) — this assertion would cover nothing`,
  ).toBeGreaterThan(0);
  for (const c of hits) {
    const [name] = dataflowNamesRequested([c.url]);
    expect(name, `${site.id} produced no name segment from ${c.url}`).toBeTruthy();
    expect(
      DATAFLOW_NAME_RE.test(name),
      `${site.id} used "${name}", which the route rejects with 400 (#3567)`,
    ).toBe(true);
    expect(name).not.toBe(ITEM_GUID);
  }
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

  it('sends a LEGAL name on mount, on SAVE, and when the debug dock opens a session', async () => {
    const { calls } = installMock(true);

    renderWithProviders(
      <MappingDataFlowEditor item={makeItem('mapping-dataflow', 'Mapping data flow')} id={ITEM_GUID} />,
    );

    // ── mount ───────────────────────────────────────────────────────────────
    for (const site of MOUNT_SITES) {
      await waitFor(() => expect(calls.some(site.match)).toBe(true), { timeout: 5000 });
    }

    // ── Save — the designer PUTs to the `name` prop the editor handed it ─────
    const save = await screen.findByRole('button', { name: /^Save$/ }, { timeout: 5000 });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(SAVE_SITE.match)).toBe(true), { timeout: 5000 });

    // ── U7 debug dock — its session/preview/schema/stats routes validate the
    //    name segment exactly as the ADF routes do ──────────────────────────
    const toggle = await debugToggleOn('dataflow-debug-panel');
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some(DEBUG_DOCK_SITE.match)).toBe(true), { timeout: 5000 });

    // Per-site: fired AND legal. Presence is asserted first so a site that
    // stops firing fails HERE instead of silently leaving the guard narrower.
    for (const site of [...MOUNT_SITES, SAVE_SITE, DEBUG_DOCK_SITE]) assertSiteLegal(calls, site);

    // Belt-and-braces over the whole log, with its population stated.
    const names = dataflowNamesRequested(calls.map((c) => c.url));
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const n of names) {
      expect(
        DATAFLOW_NAME_RE.test(n),
        `a data-flow request used "${n}", which the route rejects with 400 (#3567)`,
      ).toBe(true);
      expect(n).not.toBe(ITEM_GUID);
    }
  });

  it('sends a LEGAL name when the pre-U7 designer toggle starts a debug preview', async () => {
    // `startDebugPreview` is reachable only with the U7 dock OFF — with it on,
    // `hideDebugControls` removes the designer's toggle and the dock owns Debug.
    const { calls } = installMock(false);

    renderWithProviders(
      <MappingDataFlowEditor item={makeItem('mapping-dataflow', 'Mapping data flow')} id={ITEM_GUID} />,
    );

    const toggle = await debugToggleOn('mapping-dataflow-designer');
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some(PREVIEW_SITE.match)).toBe(true), { timeout: 5000 });

    assertSiteLegal(calls, PREVIEW_SITE);
  });
});
