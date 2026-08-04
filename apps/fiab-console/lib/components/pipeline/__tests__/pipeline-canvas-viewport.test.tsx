/**
 * Pipeline canvas viewport — the layout regression this file exists to prevent.
 *
 * THE BUG (fixed by PR "fix(ui): the pipeline canvas was invisible, not small"):
 * `pipeline-designer.tsx`'s bottom dock was `flexShrink: 0` with NO height, so it
 * took its CONTENT height. With nothing selected that content was an `EmptyState`
 * whose `minHeight: 320px` is a hard floor under `box-sizing: border-box`. Inside
 * the 560px `ResizableCanvasRegion` the column came to
 *     552 − 32 gaps − 50 nav − 36 errors − 320 dock − 18 status ≈ 96px of canvas,
 * and because `canvas.tsx`'s React Flow shell carried `minHeight: 400px`, React
 * Flow measured 400px inside that 96px `overflow: hidden` wrap: `fitView` centred
 * the nodes at y≈200 and the CanvasRightRail / MiniMap anchored to a bottom edge
 * that was clipped away. The canvas was not small — it was off-screen.
 *
 * These specs drive the REAL PipelineDesigner and the REAL SplitPane (only the
 * React Flow canvas child is stubbed — see the mock note below) and assert the
 * two properties that make the bug impossible:
 *
 *   1. the dock is the SIZED pane of a vertical split, so it is BOUNDED and can
 *      never be starved-out by its own content height; and
 *   2. at its default the dock takes strictly LESS THAN HALF the split, so the
 *      canvas always holds the dominant share — at the region's 560px floor and
 *      on a tall window alike.
 *
 * Plus the two Fabric-parity behaviours that removed the 320px floor in the first
 * place: the no-selection dock shows pipeline-level settings (Learn:
 * fabric/data-factory/pipeline-canvas-experience — "When no activity is selected,
 * the configuration pane at the bottom of the canvas shows pipeline-level
 * settings"), and that branch is collapsible.
 *
 * MUTATION-PROVEN: reverting the dock to `flexShrink: 0` + no split makes the
 * five layout/parity specs fail and leaves the control spec green.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import React from 'react';

// The React Flow engine (@xyflow/react + ELK) OOMs the jsdom fork on import —
// the same carve-out lib/editors/__tests__/data-pipeline.test.tsx takes. It is a
// transform/heap limit of that import chain, not a product issue. Everything
// under test here is the designer's own layout, which the stub does not touch.
vi.mock('../canvas', () => ({
  PipelineCanvas: React.forwardRef((_props: any, _ref: any) =>
    React.createElement('div', { 'data-testid': 'pipeline-canvas-stub' }, 'canvas')),
}));

import { PipelineDesigner, DOCK_MIN_PX, DOCK_SIZING_KEY } from '../pipeline-designer';

/** Divider label the designer gives its canvas↔dock split. */
const DOCK_DIVIDER = 'Resize activity configuration panel';
/** SplitPane always reserves this much for the FLEXING pane (its OPPOSITE_MIN). */
const OPPOSITE_MIN = 80;

/**
 * Height every element reports while a spec runs. SplitPane resolves a `%`
 * default against `containerExtent()` → `el.clientHeight`, which jsdom reports
 * as 0 unless stubbed.
 */
let containerPx = 468;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return containerPx; },
  });
  if (typeof window.PointerEvent === 'undefined') {
    // @ts-expect-error — MouseEvent carries clientY; enough for divider drags.
    window.PointerEvent = class extends MouseEvent {};
  }
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  containerPx = 468;
  try { window.localStorage.clear(); } catch { /* storage disabled */ }
  // PropertiesPanel's useCopyResources() fetches factory datasets on mount.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ ok: true, datasets: [], linkedServices: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDesigner(props: Partial<React.ComponentProps<typeof PipelineDesigner>> = {}) {
  return render(
    <FluentProvider theme={webLightTheme}>
      <PipelineDesigner
        activities={[]}
        onActivitiesChange={() => { /* controlled by the host */ }}
        parameters={[{ name: 'runDate', type: 'string', defaultValue: '2026-01-01' }]}
        variables={[{ name: 'rowCount', type: 'String' }]}
        {...props}
      />
    </FluentProvider>,
  );
}

/** The dock's current px, read off the REAL split divider the designer renders. */
function dockPx(): number {
  const divider = screen.getByLabelText(DOCK_DIVIDER);
  return Number(divider.getAttribute('aria-valuenow'));
}

describe('pipeline designer — canvas viewport', () => {
  it('docks the properties panel inside a BOUNDED vertical split (not an unbounded flexShrink:0 block)', () => {
    renderDesigner();
    const divider = screen.getByLabelText(DOCK_DIVIDER);
    // A vertical split's separator is horizontally oriented — this is the
    // canvas↔dock divider, and its existence is what bounds the dock at all.
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
    expect(divider).toHaveAttribute('role', 'separator');
    // Bounded below by the config form's usability floor…
    expect(dockPx()).toBeGreaterThanOrEqual(DOCK_MIN_PX);
    // …and above, so the dock can never consume the whole column the way an
    // unbounded content-height dock did.
    expect(dockPx()).toBeLessThanOrEqual(containerPx - OPPOSITE_MIN);
  });

  it('leaves the canvas the DOMINANT share at the region floor (the 96px case)', () => {
    // 468px is what the split actually gets inside the region's 560px floor
    // (552 usable − 50 nav − 18 status − 16 gaps). The old layout gave the
    // canvas ~96px of it; the dock must now take less than half.
    containerPx = 468;
    renderDesigner();
    expect(dockPx() * 2).toBeLessThan(containerPx);
    // Concretely: strictly more canvas than the ~96px the bug produced.
    expect(containerPx - dockPx()).toBeGreaterThan(96);
  });

  it('keeps the canvas dominant on a tall window too (the share does not go fixed)', () => {
    containerPx = 900;
    renderDesigner();
    expect(dockPx() * 2).toBeLessThan(containerPx);
    expect(containerPx - dockPx()).toBeGreaterThan(468 - DOCK_MIN_PX);
  });

  it('clamps the dock even when dragged to its maximum — the canvas always survives', () => {
    renderDesigner();
    const divider = screen.getByLabelText(DOCK_DIVIDER);
    // End = "as large as this pane may go".
    fireEvent.keyDown(divider, { key: 'End' });
    expect(dockPx()).toBeLessThanOrEqual(containerPx - OPPOSITE_MIN);
    expect(window.localStorage.getItem(`loom.splitpane.${DOCK_SIZING_KEY}`)).not.toBeNull();
  });
});

describe('pipeline designer — no-selection dock (Fabric parity)', () => {
  it('shows pipeline-level settings instead of the 320px "No activity selected" card', () => {
    renderDesigner();
    // Fabric's four pipeline-level areas. Parameters/Variables carry live counts
    // from the pipeline actually being edited (1 param, 1 variable above).
    expect(screen.getByRole('tab', { name: /Parameters \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Variables \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Activities \(0\)/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Settings$/ })).toBeInTheDocument();
    // The EmptyState that imposed the 320px floor is gone.
    expect(screen.queryByText('No activity selected')).not.toBeInTheDocument();
    // …and the open tab shows the REAL parameter, not a placeholder.
    const paramsPane = document.querySelector('[data-pipeline-level="parameters"]');
    expect(paramsPane).not.toBeNull();
    expect(within(paramsPane as HTMLElement).getByText('runDate')).toBeInTheDocument();
  });

  it('makes the no-selection dock collapsible (the chevron used to be absent entirely)', () => {
    renderDesigner();
    const toggle = screen.getByRole('button', { name: /Collapse properties panel/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Expand properties panel/i }))
      .toHaveAttribute('aria-expanded', 'false');
  });
});

describe('pipeline designer — control', () => {
  // Deliberately independent of the dock layout: this spec passes both before
  // and after the fix, so a red run above is the layout regression and not the
  // designer failing to mount at all.
  it('renders the activities palette and the canvas', () => {
    renderDesigner();
    expect(screen.getAllByText('Activities').length).toBeGreaterThan(0);
    expect(screen.getByTestId('pipeline-canvas-stub')).toBeInTheDocument();
  });
});
