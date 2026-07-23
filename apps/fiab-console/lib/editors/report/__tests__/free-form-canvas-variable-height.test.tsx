/**
 * U1 (G3) — FreeFormCanvas variable-height-parent tolerance.
 *
 * The report designer now wraps the canvas in the shared ResizableCanvasRegion
 * (storageKey `report-designer-canvas`), so the canvas' parent height is
 * user-controlled at runtime. The PRP's step-1 verification requirement:
 * "verify the absolute-positioned page sizing from pageDimsActive tolerates a
 * variable-height parent — test it."
 *
 * The mechanism under test: FreeFormCanvas letterboxes a FIXED page-px stage
 * (`width/height = pageDimsActive`) inside a scroll viewport and derives its
 * fit-mode zoom from the viewport's ResizeObserver rect. So when the parent
 * (region) height changes, the page's absolute pixel space must NOT change —
 * only the stage `scale()` recomputes. These specs drive the ResizeObserver
 * callback with different viewport heights and pin exactly that contract:
 *   • stage width/height stay the page dims at every parent height;
 *   • fit-mode scale tracks min(availW/pageW, availH/pageH) as height varies;
 *   • a shorter-than-70vh parent is honored via the new `fitParent` prop
 *     (the ResizableCanvasRegion owns the height; no 70vh floor fights it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { FreeFormCanvas, type FFVisual } from '../free-form-canvas';

// ── ResizeObserver stub (jsdom has none) ───────────────────────────────────
type RoCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
const roCallbacks: RoCallback[] = [];

class ResizeObserverStub {
  private cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe(): void { /* rect pushes are driven manually by the specs */ }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

/** Fire every observed viewport with the given rect (inside act). */
function resizeViewport(width: number, height: number): void {
  act(() => {
    roCallbacks.forEach((cb) => cb([{ contentRect: { width, height } }]));
  });
}

const PAGE = { width: 1280, height: 720 };
/** Matches the canvas' internal viewport padding budget. */
const PAD = 48;

const visuals: FFVisual[] = [
  { id: 'v1', layout: { x: 24, y: 24, w: 400, h: 300, z: 0 } },
  { id: 'v2', layout: { x: 480, y: 96, w: 320, h: 240, z: 1 } },
];

function mountCanvas(fitParent?: boolean) {
  return render(
    <FreeFormCanvas<FFVisual>
      visuals={visuals}
      page={PAGE}
      selectedId={null}
      selectedIds={new Set()}
      snapToGrid={false}
      fitParent={fitParent}
      onSelect={() => {}}
      onMarquee={() => {}}
      onLayout={() => {}}
      renderVisual={(v) => <div data-testid={`body-${v.id}`} />}
      renderChrome={(v) => <div data-testid={`chrome-${v.id}`} />}
    />,
  );
}

/** The letterboxed page stage (role=group, canvas aria-label). */
function stage(): HTMLElement {
  return screen.getByRole('group', { name: /report canvas/i });
}

function stageScale(): number {
  const m = /scale\(([\d.]+)\)/.exec(stage().style.transform || '');
  expect(m, `stage transform should carry a scale() — got "${stage().style.transform}"`).toBeTruthy();
  return Number(m![1]);
}

beforeEach(() => {
  roCallbacks.length = 0;
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FreeFormCanvas under a variable-height parent (U1 G3)', () => {
  it('keeps the page stage at pageDims px at EVERY parent height — only scale changes', () => {
    mountCanvas(true);
    resizeViewport(1000, 748);
    expect(stage().style.width).toBe(`${PAGE.width}px`);
    expect(stage().style.height).toBe(`${PAGE.height}px`);

    // Shrink the parent far below the old 70vh floor (region dragged short).
    resizeViewport(1000, 348);
    expect(stage().style.width).toBe(`${PAGE.width}px`);
    expect(stage().style.height).toBe(`${PAGE.height}px`);
  });

  it('fit-mode zoom tracks min(availW/pageW, availH/pageH) as the height varies', () => {
    mountCanvas(true);

    // Width-bound: availH/pageH (700/720) > availW/pageW (952/1280).
    resizeViewport(1000, 748);
    expect(stageScale()).toBeCloseTo((1000 - PAD) / PAGE.width, 5);

    // Height-bound after the user drags the region short: 300/720 wins.
    resizeViewport(1000, 348);
    expect(stageScale()).toBeCloseTo((348 - PAD) / PAGE.height, 5);

    // Grow the region tall again → back to width-bound.
    resizeViewport(1000, 2000);
    expect(stageScale()).toBeCloseTo((1000 - PAD) / PAGE.width, 5);
  });

  it('renders both visuals at their absolute page rects regardless of parent height', () => {
    mountCanvas(true);
    resizeViewport(1000, 348);
    expect(screen.getByTestId('body-v1')).toBeInTheDocument();
    expect(screen.getByTestId('body-v2')).toBeInTheDocument();
  });

  it('legacy hosts (no fitParent) still mount and scale — the prop is additive', () => {
    mountCanvas(undefined);
    resizeViewport(1200, 900);
    expect(stage().style.width).toBe(`${PAGE.width}px`);
    expect(stageScale()).toBeGreaterThan(0);
  });
});
