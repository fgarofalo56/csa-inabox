/**
 * SemanticModelEditor — Vitest contract test.
 *
 * Renders the editor with minimal props and asserts the chrome mounts, the
 * ribbon carries its actions, and that the three tabs lifted out by the R10
 * decomposition (Aggregations / Incremental refresh / Direct Lake (shim)) both
 * appear in the tab strip and RENDER when selected.
 *
 * NOTE (2026-07-28): this spec previously wrapped every assertion in
 * `try { … } catch (e) { err = e }` and then, if anything threw, asserted only
 * that the message matched /unauth|fetch|cannot read|undefined|null|require|import/i.
 * That made it unable to fail for the most likely regression — a render crash
 * ("Cannot read properties of undefined") matches that regex and the test
 * passed anyway. The assertions are now unconditional. Do not reintroduce the
 * catch.
 *
 * Per .claude/rules/no-vaporware.md grading rubric, this brings semantic-model
 * from B-grade (functional, untested) to A-grade (functional + Vitest).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SemanticModelEditor } from '../phase3-editors';
import { invalidatePlatformConfig } from '@/lib/components/platform-config';
import { makeItem, installFetchMock } from './test-helpers';

/**
 * The item-tab strip (which carries the three R10 tabs) only renders once a
 * `datasetId` is bound, which needs the Power BI opt-in ON plus a workspace +
 * dataset. Wire the runtime config + list routes so the strip is reachable.
 */
function installBoundDatasetMocks() {
  return installFetchMock({
    '/api/config/ui': () => ({ biBackend: 'powerbi' }),
    '/api/powerbi/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'Contoso WS' }] }),
    '/api/items/semantic-model?workspaceId=': () => ({
      ok: true,
      datasets: [{ id: 'ds-1', name: 'Sales model', isRefreshable: true, targetStorageMode: 'Import' }],
    }),
    '/api/items/semantic-model/ds-1/direct-lake': () => ({
      ok: true,
      shimEnabled: true,
      runs: [],
      config: { deltaSourcePath: 'abfss://gold@acct.dfs.core.windows.net/factsales', freshnessSlaSeconds: 300, tables: {} },
    }),
    '/api/items/semantic-model/ds-1?workspaceId=': () => ({
      ok: true,
      dataset: { id: 'ds-1', name: 'Sales model', isRefreshable: true, targetStorageMode: 'Import' },
      tables: [{ name: 'FactSales', columns: [{ name: 'Amount', dataType: 'double' }] }],
    }),
  });
}

function mount() {
  return render(<SemanticModelEditor item={makeItem('semantic-model', 'Semantic model')} id="new" />);
}

/** Bind a workspace so the dataset list loads and the item-tab strip renders. */
async function mountWithDataset() {
  mount();
  // With a single Power BI workspace the picker binds it and the dataset list
  // auto-selects its first entry, so the item-tab strip appears on its own.
  await screen.findByRole('tab', { name: /^Tables/ }, { timeout: 8000 });
}

/** Click a tab in the item-tab strip by its visible label. */
async function selectTab(label: RegExp) {
  const tab = await screen.findByRole('tab', { name: label }, { timeout: 5000 });
  await userEvent.click(tab);
  return tab;
}

describe('SemanticModelEditor', () => {
  beforeEach(() => { invalidatePlatformConfig(); installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); invalidatePlatformConfig(); });

  it('mounts and surfaces at least one ribbon button', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    const ribbon = screen.getByTestId('ribbon');
    expect(ribbon.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('exposes a "Model view" ribbon action for the relationship diagram + hierarchies', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('ribbon')).toBeInTheDocument(), { timeout: 5000 });
    const ribbon = screen.getByTestId('ribbon');
    const hasModelView = Array.from(ribbon.querySelectorAll('button'))
      .some((b) => /model view/i.test(b.textContent || ''));
    expect(hasModelView).toBe(true);
  });

  // ── R10 decomposition coverage ────────────────────────────────────────────
  // The three tabs below moved into sibling modules in PR #2565. Before that PR
  // nothing in the suite ever selected them, so the suite would have passed
  // identically if they had been deleted outright. These cases render each one.

  it('offers the three R10-extracted tabs in the item-tab strip', async () => {
    installBoundDatasetMocks();
    await mountWithDataset();
    expect(await screen.findByRole('tab', { name: /^Aggregations/ })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Incremental refresh/ })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Direct Lake \(shim\)/ })).toBeInTheDocument();
  });

  it('renders the Aggregations tab body when selected', async () => {
    installBoundDatasetMocks();
    await mountWithDataset();
    await selectTab(/^Aggregations/);
    expect(await screen.findByText(/Automatic aggregations/i)).toBeInTheDocument();
  });

  it('renders the Incremental refresh tab body when selected', async () => {
    installBoundDatasetMocks();
    await mountWithDataset();
    await selectTab(/Incremental refresh/);
    expect(await screen.findByText(/Incremental refresh \+ hybrid table/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply refresh policy/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run enhanced refresh/i })).toBeInTheDocument();
  });

  it('renders the Direct Lake (shim) tab body when selected', async () => {
    installBoundDatasetMocks();
    await mountWithDataset();
    await selectTab(/Direct Lake \(shim\)/);
    // The always-on honest disclosure + the config field the shim route seeded.
    expect(await screen.findByText(/AAS incremental-refresh shim, not a Fabric F-SKU/i)).toBeInTheDocument();
    expect(await screen.findByText(/ADLS Gen2 Delta source path/i)).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/factsales/i)).toBeInTheDocument();
  });

  it('keeps an in-progress Incremental-refresh draft across a tab switch (state lives in the parent)', async () => {
    // This is the behaviour the "hook stays in the parent" shape exists to
    // protect: if the cluster's useState moved into the conditionally-mounted
    // tab body, switching away and back would reset the draft.
    installBoundDatasetMocks();
    await mountWithDataset();
    await selectTab(/Incremental refresh/);
    const polling = await screen.findByPlaceholderText(/Table\.Max\(FactSales/);
    await userEvent.type(polling, 'DRAFT_VALUE');
    expect((polling as HTMLInputElement).value).toContain('DRAFT_VALUE');

    await selectTab(/^Aggregations/);
    expect(screen.queryByPlaceholderText(/Table\.Max\(FactSales/)).not.toBeInTheDocument();

    await selectTab(/Incremental refresh/);
    const again = await screen.findByPlaceholderText(/Table\.Max\(FactSales/);
    expect((again as HTMLInputElement).value).toContain('DRAFT_VALUE');
  });
});

// ── #2649 — the two workspace id namespaces must never be crossed ────────────
// The editor kept ONE `workspaceId` and fed it to BOTH `/api/powerbi/*` (which
// wants a Power BI groupId) and the assertOwner-guarded Loom item routes
// `/api/items/semantic-model/[id]/{model,roles,datasource}` (which want the
// item's own Loom workspace and answer 404 "semantic model not found" for
// anything else) — then auto-bound it to `powerBiWorkspaces[0]`. Result: two
// 404s on EVERY open. Second half: `datasetId` auto-selected
// `datasets[0]` — on a real estate a bundle template from a DIFFERENT
// workspace — so every tab edited a model the user never opened.
//
// These cases are written to go RED on that tree: revert either half of the fix
// and the corresponding expectation fails.
describe('SemanticModelEditor — workspace id namespaces (#2649)', () => {
  /** A Power BI groupId, as returned by /api/powerbi/workspaces. */
  const PBI_WS = 'a3f1be79-855a-41b6-a719-d9d51e72d473';
  /** The Loom workspace that actually owns the opened item. */
  const LOOM_WS = 'b8720200-0000-4000-8000-000000000001';
  /** The item the user opened (the id in the URL / breadcrumb). */
  const ITEM_ID = 'b572e1c3-4cfb-4ba9-9d40-b905334b2500';
  /** A DIFFERENT tenant-owned template that the list route returns FIRST. */
  const FOREIGN_ID = 'loom:cfe580db-26c6-452d-817e-05422bc8e287';

  /** Loom item sub-routes that `assertOwner` the `workspaceId` they are given. */
  const LOOM_SUBROUTE = /\/api\/items\/semantic-model\/[^/?]+\/(model|roles|datasource)/;

  /**
   * EVERY `/api/items/semantic-model/<id>/…` call, not just the assertOwner'd
   * three. The original spec only ever looked at `LOOM_SUBROUTE`, which is why
   * it stayed green while the item-detail GET, `/refreshes` and `/direct-lake`
   * carried on sending the Power BI groupId — the live click-walk (#2817) found
   * all three on the deployed build after #2797 shipped. This is the same rule
   * the E2E applies (`e2e/sm-tab-clickwalk.spec.ts`, assertion (f)).
   */
  const SM_ITEM_CALL = /\/api\/items\/semantic-model\/([^/?#]+)(?:[/?#]|$)/;
  /** `/api/items/semantic-model/<seg>/…` segments that are NOT a model id. */
  const NON_ID_SEGMENTS = new Set(['build', 'scaffold', 'aas-databases', 'workspace-pane']);
  const smItemCalls = (calls: Array<{ url: string }>) =>
    calls.filter((c) => {
      const seg = SM_ITEM_CALL.exec(c.url)?.[1];
      if (!seg) return false;
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
      return !NON_ID_SEGMENTS.has(decoded);
    });

  function installCrossedNamespaceMocks() {
    return installFetchMock({
      '/api/config/ui': () => ({ biBackend: 'powerbi' }),
      '/api/powerbi/workspaces': () => ({ ok: true, workspaces: [{ id: PBI_WS, name: 'fabric-csa-dev' }] }),
      // The item record — the ONLY source of the opened item's Loom workspace.
      '/api/cosmos-items/semantic-model/': () => ({
        id: ITEM_ID, workspaceId: LOOM_WS, itemType: 'semantic-model',
        displayName: 'Sales Semantic Model (Direct Lake)',
        createdBy: '', createdAt: '', updatedAt: '', state: {},
      }),
      // The list route merges tenant-wide Cosmos templates with the bound Power
      // BI workspace's live datasets. The FOREIGN template sorts first, exactly
      // as on the estate where this was reproduced.
      '/api/items/semantic-model?workspaceId=': () => ({
        ok: true,
        datasets: [
          { id: FOREIGN_ID, name: 'Sales Analytics (Premium Import)', isRefreshable: false, targetStorageMode: 'Template' },
          { id: `loom:${ITEM_ID}`, name: 'Sales Semantic Model (Direct Lake)', isRefreshable: false, targetStorageMode: 'Template' },
        ],
      }),
      '/direct-lake': () => ({ ok: true, shimEnabled: true, runs: [], config: null }),
      '/model': () => ({ ok: true, tables: [{ name: 'FactSales', columns: [], measures: [] }], relationships: [], hierarchies: [] }),
    });
  }

  async function mountOpenedItem() {
    const mocks = installCrossedNamespaceMocks();
    render(<SemanticModelEditor item={makeItem('semantic-model', 'Semantic model')} id={ITEM_ID} />);
    // Wait for a Loom sub-route call that carries a `workspaceId=` — i.e. the
    // BOUND-dataset path, after the list resolved and a workspace was picked.
    // (The Loom-native model view fires an unqualified `…/model` on mount; that
    // one is not evidence of binding.) This condition is satisfied on the buggy
    // tree too — with the Power BI groupId — so it does not mask the defect.
    await waitFor(
      () => expect(mocks.calls.some((c) => LOOM_SUBROUTE.test(c.url) && c.url.includes('workspaceId='))).toBe(true),
      { timeout: 8000 },
    );
    return mocks;
  }

  /** Loom sub-route calls that actually carry a workspace id. */
  const qualified = (calls: Array<{ url: string }>) =>
    calls.filter((c) => LOOM_SUBROUTE.test(c.url) && c.url.includes('workspaceId='));

  beforeEach(() => { invalidatePlatformConfig(); installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); invalidatePlatformConfig(); });

  it('never sends the Power BI workspace id to an assertOwner-guarded Loom item route', async () => {
    const { calls } = await mountOpenedItem();
    const loomCalls = qualified(calls);
    expect(loomCalls.length).toBeGreaterThan(0);
    // The exact 404 signature from the issue: a Power BI groupId on a Loom route.
    expect(loomCalls.filter((c) => c.url.includes(PBI_WS)).map((c) => c.url)).toEqual([]);
  });

  it("sends the item's OWN Loom workspace to the Loom model route", async () => {
    const { calls } = await mountOpenedItem();
    expect(qualified(calls).some((c) => c.url.includes(LOOM_WS))).toBe(true);
  });

  it('binds to the OPENED item, not to the first entry the list route happens to return', async () => {
    const { calls } = await mountOpenedItem();
    const loomCalls = qualified(calls);
    // `datasetId` lands in the PATH segment, so the bound model is observable.
    expect(loomCalls.some((c) => c.url.includes(encodeURIComponent(`loom:${ITEM_ID}`)))).toBe(true);
    expect(calls.filter((c) => c.url.includes(encodeURIComponent(FOREIGN_ID))).map((c) => c.url)).toEqual([]);
  });

  it('still makes ZERO Power BI calls on the DEFAULT (Loom-native) render — no-fabric-dependency.md', async () => {
    const { calls } = installFetchMock({
      // biBackend absent = the Azure-native default; Power BI stays opt-in.
      '/api/config/ui': () => ({}),
      '/api/cosmos-items/semantic-model/': () => ({
        id: ITEM_ID, workspaceId: LOOM_WS, itemType: 'semantic-model',
        displayName: 'Sales Semantic Model (Direct Lake)',
        createdBy: '', createdAt: '', updatedAt: '', state: {},
      }),
    });
    render(<SemanticModelEditor item={makeItem('semantic-model', 'Semantic model')} id={ITEM_ID} />);
    await waitFor(() => expect(screen.getByTestId('chrome')).toBeInTheDocument(), { timeout: 5000 });
    // Give any opt-in fetch a chance to fire before asserting it never did.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/cosmos-items/'))).toBe(true), { timeout: 5000 });
    expect(calls.filter((c) => c.url.includes('/api/powerbi/'))).toEqual([]);
  });

  // ── The legs #2797 missed (reopened 2026-08-01 on the live click-walk) ──────
  // #2797 split the state correctly but only re-pointed the assertOwner'd
  // sub-routes. The item-detail GET, `/refreshes` and `/direct-lake` kept the
  // auto-picked Power BI groupId, so the deployed build still emitted
  //   GET /api/items/semantic-model/<id>?workspaceId=<pbi groupId>
  //   GET /api/items/semantic-model/<id>/refreshes?workspaceId=<pbi groupId>
  //   GET /api/items/semantic-model/<id>/direct-lake?workspaceId=<pbi groupId>
  // and 404'd two of them. These cases widen the rule from three named
  // sub-routes to EVERY `/api/items/semantic-model/<id>/…` call.

  it('sends the Power BI groupId to NO /api/items/semantic-model/* call — every leg, not just the assertOwner\'d three', async () => {
    const { calls } = await mountOpenedItem();
    const smCalls = smItemCalls(calls);
    expect(smCalls.length).toBeGreaterThan(0);
    expect(smCalls.filter((c) => c.url.includes(PBI_WS)).map((c) => c.url)).toEqual([]);
  });

  it('does not ask Power BI for the detail/refresh history of a model that is not IN Power BI', async () => {
    // The bound dataset is the `loom:` Cosmos template — there is no Power BI
    // dataset by that id in the bound group, so `getDataset` / `listRefreshHistory`
    // can only 404. The detail route DOES serve the template from Cosmos, so that
    // one call stays (with the item's own Loom workspace); the Power BI-only
    // refresh-history call must not be made at all.
    const { calls } = await mountOpenedItem();
    expect(calls.filter((c) => c.url.includes('/refreshes')).map((c) => c.url)).toEqual([]);
    const detail = calls.filter((c) => new RegExp(`semantic-model/${encodeURIComponent(`loom:${ITEM_ID}`)}\\?`, 'i').test(c.url));
    expect(detail.length, 'the Cosmos-backed template detail must still load').toBeGreaterThan(0);
    expect(detail.every((c) => c.url.includes(LOOM_WS))).toBe(true);
  });

  it('opens the Direct Lake (shim) tab without stamping a Power BI groupId into the Loom item URL', async () => {
    const { calls } = await mountOpenedItem();
    const tab = await screen.findByRole('tab', { name: /Direct Lake \(shim\)/ }, { timeout: 8000 });
    await userEvent.click(tab);
    await waitFor(
      () => expect(calls.some((c) => c.url.includes('/direct-lake'))).toBe(true),
      { timeout: 8000 },
    );
    const dl = calls.filter((c) => c.url.includes('/direct-lake'));
    expect(dl.filter((c) => c.url.includes(PBI_WS)).map((c) => c.url)).toEqual([]);
    // …and it still addresses the OPENED model.
    expect(dl.every((c) => c.url.includes(encodeURIComponent(`loom:${ITEM_ID}`)))).toBe(true);
  });
});

// ── #2912 — the Azure-native tabs must be reachable with Power BI OFF ─────────
// no-fabric-dependency.md violation: Aggregations / Incremental refresh / Direct
// Lake have Azure-native backends (XMLA alternateOf / AAS refresh-policy / ADLS
// Delta shim) but their UI only mounted through the Power BI opt-in (`datasetId`
// binds ONLY via a bound Power BI workspace). On the DEFAULT estate a user lost
// all three, and `LoomNativeModelView` has no equivalent.
//
// These cases mount the editor with Power BI OFF (biBackend absent) on a
// PERSISTED item, reach each tab through its ribbon entry, and assert the tab
// BODY mounts — with ZERO Power BI calls. Each goes RED on the pre-fix tree:
// the ribbon entries are absent / disabled (`disabled:!datasetId`) and the tabs
// are not in the keep-mounted allowlist, so `LoomNativeModelView` renders
// instead of the tab body.
describe('SemanticModelEditor — Azure-native tabs reachable with Power BI OFF (#2912)', () => {
  const ITEM_ID = 'c1a2b3c4-0000-4000-8000-00000000abcd';
  const LOOM_WS = 'd5e6f700-0000-4000-8000-000000000042';

  function installDefaultEstateMocks() {
    return installFetchMock({
      // biBackend absent = the Azure-native default; Power BI stays opt-in OFF.
      '/api/config/ui': () => ({}),
      // The item record — the only source of the opened item's Loom workspace.
      '/api/cosmos-items/semantic-model/': () => ({
        id: ITEM_ID, workspaceId: LOOM_WS, itemType: 'semantic-model',
        displayName: 'Sales Semantic Model', createdBy: '', createdAt: '', updatedAt: '', state: {},
      }),
      // Loom-native model definition (LoomNativeModelView + Azure-native tabs).
      '/model': () => ({
        ok: true, modelName: 'Sales', tables: [{ name: 'FactSales', columns: [{ name: 'Amount', type: 'double' }] }],
        measures: [], relationships: [],
      }),
      // Incremental-refresh policy route: honest AAS infra-gate (default backend
      // is loom-native, so the route reports the exact env var to set).
      '/refresh-policy': () => ({ ok: false, error: 'Incremental refresh policy requires LOOM_SEMANTIC_BACKEND=analysis-services' }),
      // Direct Lake shim: honest "not enabled" Azure infra-gate (no Power BI).
      '/direct-lake': () => ({ ok: true, shimEnabled: false, hint: 'Set LOOM_DIRECT_LAKE_SHIM_ENABLED=true', runs: [], config: null }),
    });
  }

  async function mountDefaultEstate() {
    render(<SemanticModelEditor item={makeItem('semantic-model', 'Semantic model')} id={ITEM_ID} />);
    await waitFor(() => expect(screen.getByTestId('ribbon')).toBeInTheDocument(), { timeout: 5000 });
  }

  /** Find an ENABLED ribbon button by its visible label. */
  function ribbonButton(label: RegExp): HTMLButtonElement | undefined {
    const ribbon = screen.getByTestId('ribbon');
    return Array.from(ribbon.querySelectorAll('button')).find((b) => label.test(b.textContent || '')) as HTMLButtonElement | undefined;
  }

  beforeEach(() => { invalidatePlatformConfig(); installFetchMock({}); });
  afterEach(() => { vi.restoreAllMocks(); invalidatePlatformConfig(); });

  it('reaches the Aggregations tab body from the ribbon with Power BI OFF', async () => {
    const { calls } = installDefaultEstateMocks();
    await mountDefaultEstate();
    const btn = ribbonButton(/manage aggregations/i);
    expect(btn, 'the "Manage aggregations" ribbon entry must exist').toBeDefined();
    expect(btn!.disabled, 'it must be enabled on the default estate (fell back to the item id)').toBe(false);
    await userEvent.click(btn!);
    // The tab BODY mounts — not LoomNativeModelView.
    expect(await screen.findByText(/Automatic aggregations/i)).toBeInTheDocument();
    // no-fabric-dependency.md: reaching the tab made ZERO Power BI calls.
    expect(calls.filter((c) => c.url.includes('/api/powerbi/'))).toEqual([]);
  });

  it('reaches the Incremental refresh tab body from the ribbon with Power BI OFF', async () => {
    const { calls } = installDefaultEstateMocks();
    await mountDefaultEstate();
    const btn = ribbonButton(/incremental refresh/i);
    expect(btn, 'the "Incremental refresh" ribbon entry must exist').toBeDefined();
    expect(btn!.disabled).toBe(false);
    await userEvent.click(btn!);
    expect(await screen.findByText(/Incremental refresh \+ hybrid table/i)).toBeInTheDocument();
    // The AAS-native policy action is reachable (button present, not a Power BI gate).
    expect(screen.getByRole('button', { name: /Load partitions/i })).toBeInTheDocument();
    expect(calls.filter((c) => c.url.includes('/api/powerbi/'))).toEqual([]);
  });

  it('reaches the Direct Lake (shim) tab body from the ribbon with Power BI OFF', async () => {
    const { calls } = installDefaultEstateMocks();
    await mountDefaultEstate();
    const btn = ribbonButton(/^direct lake$/i);
    expect(btn, 'the "Direct Lake" ribbon entry must exist').toBeDefined();
    expect(btn!.disabled).toBe(false);
    await userEvent.click(btn!);
    // The tab BODY mounts with its honest, cloud-invariant disclosure.
    expect(await screen.findByText(/AAS incremental-refresh shim, not a Fabric F-SKU/i)).toBeInTheDocument();
    // …and it addressed the OPENED item's own model route (no Power BI groupId).
    const dl = calls.filter((c) => c.url.includes('/direct-lake'));
    expect(dl.length, 'the Direct Lake config route must have been queried').toBeGreaterThan(0);
    expect(dl.every((c) => c.url.includes(ITEM_ID))).toBe(true);
    expect(calls.filter((c) => c.url.includes('/api/powerbi/'))).toEqual([]);
  });
});
