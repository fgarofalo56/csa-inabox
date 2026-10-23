/**
 * DataPipelineEditor designer — ONE 3-pane StackedSplit (#3699 Phase 3).
 *
 * Two halves:
 *  1. `pxToStackShares` / `migrateDesignerStackLayout` / `writeOutputDockCollapsed`
 *     (pure, storage-injected) — the legacy px -> share migration.
 *  2. Component level: the ribbon's output-dock toggle and the pane's own
 *     chevron drive the SAME state (no desync).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

// Heavy children stubbed (same reasoning as data-pipeline.test.tsx: the React
// Flow canvas OOMs the jsdom worker; PropertiesPanel / OutputPane fetch ARM).
vi.mock('@/lib/components/pipeline/canvas', () => ({
  PipelineCanvas: React.forwardRef(function CanvasStub(_props: any, _ref: any) {
    return React.createElement('div', { 'data-testid': 'pipeline-canvas-stub' }, 'canvas');
  }),
}));
vi.mock('@/lib/components/pipeline/properties-panel', () => ({
  PropertiesPanel: () => React.createElement('div', { 'data-testid': 'properties-stub' }, 'props'),
}));
vi.mock('@/lib/components/pipeline/output-pane', () => ({
  OutputPane: () => React.createElement('div', { 'data-testid': 'output-pane-stub' }, 'output'),
}));

import {
  DESIGNER_STACK_STORAGE_KEY,
  DataPipelineEditor,
  migrateDesignerStackLayout,
  pxToStackShares,
  writeOutputDockCollapsed,
} from '../data-pipeline-editor';
import { makeItem, installFetchMock, selectOptionValue } from './test-helpers';

const LEGACY_SPLITPANE = 'loom.splitpane.adf-data-pipeline.config-dock';
const LEGACY_DOCKHEIGHT = 'loom.dockHeight.adf-data-pipeline';
const LEGACY_OUTPUT = 'loom.canvasHeight.data-pipeline-output-dock';

function memStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

describe('pxToStackShares', () => {
  // REF = 640. config 260 / output 180 (DISTINCT so a swapped argument breaks it):
  //   canvas = 640-260 = 380, config = 260, output = 180*640/(640-180) = 250.435
  it('maps distinct config/output px to the exact shares', () => {
    const sh = pxToStackShares(260, 180);
    expect(sh.canvas).toBe(380);
    expect(sh.configDock).toBe(260);
    expect(sh.outputDock).toBeCloseTo(250.435, 3);
  });

  it('gives the output dock output/REF of the stack when all three are open', () => {
    const sh = pxToStackShares(260, 180);
    const frac = sh.outputDock / (sh.canvas + sh.configDock + sh.outputDock);
    // 180/640 = 0.28125; a swapped (config<->output) conversion gives 0.4063.
    expect(frac).toBeCloseTo(180 / 640, 3);
  });

  it('clamps absurd px so no pane gets a non-positive share', () => {
    const sh = pxToStackShares(100000, 1);
    expect(sh.canvas).toBe(120);       // canvas floor
    expect(sh.configDock).toBe(520);   // REF - canvas floor
    expect(sh.outputDock).toBeGreaterThan(0);
  });
});

describe('migrateDesignerStackLayout', () => {
  it('seeds the new key from distinct legacy values (splitpane + output)', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: '260', [LEGACY_OUTPUT]: '180' });
    migrateDesignerStackLayout(st);
    const stored = JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!);
    expect(stored.v).toBe(1);
    expect(stored.shares.canvas).toBe(380);
    expect(stored.shares.configDock).toBe(260);
    expect(stored.shares.outputDock).toBeCloseTo(250.435, 3);
    expect(stored.collapsed).toEqual({ outputDock: true });
  });

  it('prefers the A5 splitpane key over the pre-A5 dockHeight key', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: '260', [LEGACY_DOCKHEIGHT]: '400' });
    migrateDesignerStackLayout(st);
    // 260 -> canvas 380; 400 would give 240. Only the splitpane value yields 380.
    expect(JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!).shares.canvas).toBe(380);
  });

  it('falls back to the pre-A5 dockHeight key when there is no splitpane key', () => {
    const st = memStorage({ [LEGACY_DOCKHEIGHT]: '400' });
    migrateDesignerStackLayout(st);
    expect(JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!).shares.configDock).toBe(400);
  });

  it('uses the default output px when only the config dock was ever dragged', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: '260' });
    migrateDesignerStackLayout(st);
    expect(JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!).shares.outputDock)
      .toBeCloseTo(pxToStackShares(260, 300).outputDock, 3);
  });

  it('NEVER overwrites an existing new-format key', () => {
    const existing = JSON.stringify({ v: 1, shares: { canvas: 1, configDock: 2, outputDock: 3 }, collapsed: {} });
    const st = memStorage({
      [DESIGNER_STACK_STORAGE_KEY]: existing, [LEGACY_SPLITPANE]: '260', [LEGACY_OUTPUT]: '180',
    });
    migrateDesignerStackLayout(st);
    // Seeding from the legacy values would have produced canvas=380.
    expect(st.getItem(DESIGNER_STACK_STORAGE_KEY)).toBe(existing);
  });

  it('ignores malformed legacy values without throwing and writes nothing', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: 'NaN', [LEGACY_DOCKHEIGHT]: 'abc', [LEGACY_OUTPUT]: '-5' });
    expect(() => migrateDesignerStackLayout(st)).not.toThrow();
    expect(st.getItem(DESIGNER_STACK_STORAGE_KEY)).toBeNull();
  });

  it('a malformed config value does not poison a valid output value', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: 'oops', [LEGACY_OUTPUT]: '180' });
    migrateDesignerStackLayout(st);
    const stored = JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!);
    expect(stored.shares.configDock).toBe(300);                        // default, not NaN
    expect(stored.shares.outputDock).toBeCloseTo(250.435, 3);          // from the 180
  });

  it('does not delete the legacy keys (downgrade must still work)', () => {
    const st = memStorage({ [LEGACY_SPLITPANE]: '260', [LEGACY_DOCKHEIGHT]: '400', [LEGACY_OUTPUT]: '180' });
    migrateDesignerStackLayout(st);
    expect(st.getItem(LEGACY_SPLITPANE)).toBe('260');
    expect(st.getItem(LEGACY_DOCKHEIGHT)).toBe('400');
    expect(st.getItem(LEGACY_OUTPUT)).toBe('180');
  });

  it('swallows a throwing storage', () => {
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => migrateDesignerStackLayout(boom)).not.toThrow();
    expect(() => writeOutputDockCollapsed(boom, true)).not.toThrow();
  });
});

describe('writeOutputDockCollapsed', () => {
  it('flips only the outputDock flag and preserves shares', () => {
    const raw = JSON.stringify({ v: 1, shares: { canvas: 5, configDock: 6, outputDock: 7 }, collapsed: { configDock: true, outputDock: false } });
    const st = memStorage({ [DESIGNER_STACK_STORAGE_KEY]: raw });
    writeOutputDockCollapsed(st, true);
    const after = JSON.parse(st.getItem(DESIGNER_STACK_STORAGE_KEY)!);
    expect(after.collapsed).toEqual({ configDock: true, outputDock: true });
    expect(after.shares).toEqual({ canvas: 5, configDock: 6, outputDock: 7 });
  });

  it('leaves a corrupt stored value alone (StackedSplit falls back to defaults)', () => {
    const st = memStorage({ [DESIGNER_STACK_STORAGE_KEY]: '{not json' });
    writeOutputDockCollapsed(st, false);
    expect(st.getItem(DESIGNER_STACK_STORAGE_KEY)).toBe('{not json');
  });
});

describe('DataPipelineEditor designer StackedSplit', () => {
  beforeEach(() => {
    window.localStorage.clear();
    installFetchMock({
      '/api/loom/workspaces': () => ({ ok: true, workspaces: [{ id: 'ws-1', name: 'workspace-fixture' }] }),
      '/api/items/data-pipeline': () => ({
        ok: true,
        workspaceId: 'ws-1',
        pipelines: [{ id: 'p-1', displayName: 'pipeline-fixture', adfPipelineName: 'p-1' }],
      }),
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

  const pane = (id: string) => document.querySelector(`section[data-pane-id="${id}"]`) as HTMLElement | null;

  async function mounted() {
    // 'fabric' runtime = the editor's own designer (adf/synapse delegate to the
    // core editors, out of scope here). Selecting the workspace auto-binds the
    // first pipeline, which is what un-gates the output pane.
    render(<DataPipelineEditor item={makeItem('data-pipeline', 'Data pipeline')} id="new" runtimePreset="fabric" />);
    const select = (await screen.findByDisplayValue('Select a workspace')) as HTMLSelectElement;
    await selectOptionValue(select, 'ws-1');
    // The output pane only exists once a pipeline is bound (pipelineId gate).
    await waitFor(() => expect(pane('outputDock')).not.toBeNull());
  }

  it('renders canvas, config dock and output dock as three panes of one stack', async () => {
    await mounted();
    expect(pane('canvas')).not.toBeNull();
    expect(pane('configDock')).not.toBeNull();
    expect(pane('canvas')!.parentElement).toBe(pane('configDock')!.parentElement);
    expect(pane('canvas')!.parentElement).toBe(pane('outputDock')!.parentElement);
    expect(screen.getByTestId('pipeline-canvas-stub')).toBeInTheDocument();
    expect(screen.getByTestId('properties-stub')).toBeInTheDocument();
  });

  it('starts with the output dock collapsed and the ribbon offering "Show"', async () => {
    await mounted();
    expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByTestId('output-pane-stub')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show output dock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand Output panel' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('ribbon toggle expands then collapses the pane, and the label tracks it', async () => {
    await mounted();
    fireEvent.click(screen.getByRole('button', { name: 'Show output dock' }));
    await waitFor(() => expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('false'));
    expect(screen.getByTestId('output-pane-stub')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse Output panel' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Hide output dock' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide output dock' }));
    await waitFor(() => expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Show output dock' })).toBeInTheDocument();
  });

  it('collapsing via the pane chevron flips the ribbon state (no desync)', async () => {
    await mounted();
    fireEvent.click(screen.getByRole('button', { name: 'Show output dock' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Output panel' })).toBeInTheDocument());

    // Chevron, NOT the ribbon: the ribbon label must follow.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Output panel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show output dock' })).toBeInTheDocument());
    expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Expand Output panel' }).getAttribute('aria-expanded')).toBe('false');

    // And expanding via the chevron flips it back to "Hide".
    fireEvent.click(screen.getByRole('button', { name: 'Expand Output panel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide output dock' })).toBeInTheDocument());
    expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('false');

    // The ribbon then collapses it again after a chevron-driven open.
    fireEvent.click(screen.getByRole('button', { name: 'Hide output dock' }));
    await waitFor(() => expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true'));
  });

  it('the canvas pane has no collapse chevron; both docks do', async () => {
    await mounted();
    expect(screen.queryByRole('button', { name: /Collapse Pipeline canvas panel|Expand Pipeline canvas panel/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse Activity configuration panel' })).toBeInTheDocument();
  });

  it('seeds the stack from legacy keys at mount and starts the output dock closed', async () => {
    window.localStorage.setItem(LEGACY_SPLITPANE, '260');
    window.localStorage.setItem(LEGACY_OUTPUT, '180');
    await mounted();
    const stored = JSON.parse(window.localStorage.getItem(DESIGNER_STACK_STORAGE_KEY)!);
    expect(stored.shares.configDock).toBe(260);
    expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true');
    expect(window.localStorage.getItem(LEGACY_SPLITPANE)).toBe('260');
  });

  it('a previous session that left the output dock OPEN is reconciled to closed, shares kept', async () => {
    window.localStorage.setItem(DESIGNER_STACK_STORAGE_KEY, JSON.stringify({
      v: 1, shares: { canvas: 11, configDock: 22, outputDock: 33 }, collapsed: { outputDock: false },
    }));
    await mounted();
    // If the editor did not reconcile, the pane would mount expanded while the
    // ribbon (outputDockOpen=false) offered "Show" — the desync this test pins.
    expect(pane('outputDock')!.getAttribute('data-collapsed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Show output dock' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(DESIGNER_STACK_STORAGE_KEY)!).shares)
      .toEqual({ canvas: 11, configDock: 22, outputDock: 33 });
  });
});
