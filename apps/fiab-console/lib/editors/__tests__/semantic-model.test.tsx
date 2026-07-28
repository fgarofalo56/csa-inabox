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
