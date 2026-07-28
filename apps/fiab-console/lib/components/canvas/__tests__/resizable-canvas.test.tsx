/**
 * ResizableCanvasRegion — the canvas HEIGHT-resize variant (canvas-resize sweep).
 *
 * The width-resize primitive is SplitPane (see shared/__tests__/split-pane.test);
 * this is its height sibling — the shared drag/keyboard-resizable canvas-height
 * container every canvas editor wraps so the operator can adjust the canvas's
 * height (ADF/Fabric-grade grip). These jsdom tests exercise the REAL component
 * and assert:
 *   1. it renders its child canvas plus a correctly-oriented resize separator;
 *   2. keyboard resize (Arrow / PageDown / Home / End) moves the height and
 *      updates aria-valuenow within the [min, max] bounds;
 *   3. the chosen height persists to localStorage and restores on remount;
 *   4. a below-floor persisted value is clamped up to minPx on restore.
 *
 * jsdom reports offsetHeight === 0, so the pointer-drag path (which reads the
 * live offsetHeight) is not meaningfully exercisable here; the keyboard path
 * drives the same commit()/clamp/persist logic and is asserted instead.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  ResizableCanvasRegion, clampMaxToContainer, findClipAncestor, measureContainerCeiling,
} from '../resizable-canvas';

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    // @ts-expect-error — MouseEvent is enough for the handlers under test.
    window.PointerEvent = class extends MouseEvent {};
  }
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const CANVAS = <div>canvas-child</div>;

describe('ResizableCanvasRegion', () => {
  it('renders the child canvas and a horizontal resize separator', () => {
    wrap(
      <ResizableCanvasRegion storageKey="t-render" defaultPx={480}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    expect(screen.getByText('canvas-child')).toBeInTheDocument();
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
    expect(sep).toHaveAttribute('aria-valuenow', '480');
    expect(sep).toHaveAttribute('aria-valuemin', '240');
  });

  it('grows on ArrowDown and shrinks on ArrowUp (aria-valuenow tracks height)', () => {
    wrap(
      <ResizableCanvasRegion storageKey="t-arrows" defaultPx={480} minPx={320} maxPx={900}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowDown' }); // +24
    expect(sep).toHaveAttribute('aria-valuenow', '504');
    fireEvent.keyDown(sep, { key: 'ArrowUp' });   // -24
    expect(sep).toHaveAttribute('aria-valuenow', '480');
  });

  it('clamps to minPx on Home and to maxPx on End', () => {
    wrap(
      <ResizableCanvasRegion storageKey="t-bounds" defaultPx={480} minPx={320} maxPx={720}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(sep).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(sep).toHaveAttribute('aria-valuenow', '720');
    // Never exceeds the ceiling even with a further grow.
    fireEvent.keyDown(sep, { key: 'PageDown' });
    expect(sep).toHaveAttribute('aria-valuenow', '720');
  });

  it('persists the chosen height to localStorage and restores it on remount', () => {
    const { unmount } = wrap(
      <ResizableCanvasRegion storageKey="t-persist" defaultPx={480} minPx={320} maxPx={900}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'PageDown' }); // +96 → 576
    expect(window.localStorage.getItem('loom.canvasHeight.t-persist')).toBe('576');
    unmount();

    wrap(
      <ResizableCanvasRegion storageKey="t-persist" defaultPx={480} minPx={320} maxPx={900}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '576');
  });

  it('clamps a below-floor persisted value up to minPx on restore', () => {
    window.localStorage.setItem('loom.canvasHeight.t-floor', '100');
    wrap(
      <ResizableCanvasRegion storageKey="t-floor" defaultPx={480} minPx={320} maxPx={900}>
        {CANVAS}
      </ResizableCanvasRegion>,
    );
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '320');
  });
});

/**
 * A5 — container-aware max clamp. The 80vh window ceiling alone let a height
 * persisted on a tall monitor strand the resize grip inside a non-scrolling
 * `overflow: hidden` ancestor on a shorter window (the operator's "pipeline
 * canvas cannot be resized at all" report, research/canvas-resize.md §2.3).
 * The hook now caps its ceiling to the space actually AVAILABLE inside the
 * nearest clipping ancestor.
 */
describe('A5 — container-aware max clamp', () => {
  describe('clampMaxToContainer (pure)', () => {
    it('caps the base ceiling to the available container height', () => {
      // The headline case: a height persisted at 800 on a tall monitor must
      // clamp to <= 500 when only 500px is available.
      expect(clampMaxToContainer(900, 500, 240)).toBe(500);
      expect(Math.min(800, clampMaxToContainer(900, 500, 240))).toBeLessThanOrEqual(500);
    });

    it('keeps the base ceiling when no container measurement exists', () => {
      expect(clampMaxToContainer(900, null, 240)).toBe(900);
      expect(clampMaxToContainer(900, undefined, 240)).toBe(900);
      expect(clampMaxToContainer(900, Number.NaN, 240)).toBe(900);
      expect(clampMaxToContainer(900, 0, 240)).toBe(900);
      expect(clampMaxToContainer(900, -50, 240)).toBe(900);
    });

    it('never drops the ceiling below minPx (region stays usable)', () => {
      expect(clampMaxToContainer(900, 100, 240)).toBe(240);
    });

    it('does not raise a ceiling already below the container availability', () => {
      expect(clampMaxToContainer(400, 700, 240)).toBe(400);
    });
  });

  describe('findClipAncestor (pure, jsdom)', () => {
    afterEach(() => { document.body.innerHTML = ''; });

    const chain = (styles: string[]): HTMLElement => {
      // Builds nested divs outermost-first and returns the INNERMOST element.
      let parent: HTMLElement = document.body;
      let leaf: HTMLElement = document.body;
      for (const overflowY of styles) {
        const el = document.createElement('div');
        if (overflowY) el.style.overflowY = overflowY;
        parent.appendChild(el);
        parent = el;
        leaf = el;
      }
      return leaf;
    };

    it('finds the nearest overflow-hidden ancestor', () => {
      const leaf = chain(['hidden', '', '']);
      const hidden = document.body.firstElementChild as HTMLElement;
      expect(findClipAncestor(leaf)).toBe(hidden);
    });

    it('stops (null) at a scrollable ancestor — the grip can be scrolled to', () => {
      // hidden > auto > leaf: the scrollable rescue wins over the outer clip.
      const leaf = chain(['hidden', 'auto', '']);
      expect(findClipAncestor(leaf)).toBeNull();
    });

    it('returns null when nothing clips', () => {
      const leaf = chain(['', '', '']);
      expect(findClipAncestor(leaf)).toBeNull();
    });
  });

  describe('measureContainerCeiling (jsdom, mocked geometry)', () => {
    it('returns null when the clip ancestor is content-sized (nothing clipped)', () => {
      const clip = document.createElement('div');
      const region = document.createElement('div');
      clip.appendChild(region);
      // jsdom defaults: scrollHeight === clientHeight === 0 → nothing clipped.
      expect(measureContainerCeiling(clip, region)).toBeNull();
    });

    it('measures the px from the region top to the clip ancestor visible bottom', () => {
      const clip = document.createElement('div');
      const region = document.createElement('div');
      clip.appendChild(region);
      Object.defineProperty(clip, 'clientHeight', { value: 500, configurable: true });
      Object.defineProperty(clip, 'scrollHeight', { value: 810, configurable: true });
      clip.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
      region.getBoundingClientRect = () => ({ top: 140 } as DOMRect);
      // visible bottom 100 + 500 = 600; region top 140 → 460 available.
      expect(measureContainerCeiling(clip, region)).toBe(460);
    });
  });

  it('a persisted 800 clamps to <=500 once a 500-available clipping container is measured (grip never strands)', () => {
    window.localStorage.setItem('loom.canvasHeight.t-container', '800');
    const { container } = wrap(
      <div data-testid="clip" style={{ overflowY: 'hidden' }}>
        <ResizableCanvasRegion storageKey="t-container" defaultPx={460} minPx={300} maxPx={900}>
          {CANVAS}
        </ResizableCanvasRegion>
      </div>,
    );
    const sep = screen.getByRole('separator');
    // jsdom reports zero geometry at mount → no container clamp yet: the
    // persisted 800 applies within the explicit 900 ceiling.
    expect(sep).toHaveAttribute('aria-valuenow', '800');

    // The window shrank (RDP): the clipping ancestor now has 500px visible and
    // its content overflows. Re-measure fires on window resize.
    const clip = container.querySelector('[data-testid="clip"]') as HTMLElement;
    Object.defineProperty(clip, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(clip, 'scrollHeight', { value: 810, configurable: true });
    fireEvent(window, new Event('resize'));

    expect(Number(sep.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(500);
    expect(sep).toHaveAttribute('aria-valuemax', '500');
    // The tall-monitor preference is NOT destroyed — only the live height is
    // clamped; storage keeps the user's chosen 800 for when space returns.
    expect(window.localStorage.getItem('loom.canvasHeight.t-container')).toBe('800');
  });
});

/**
 * U3 — auto-until-first-resize (`autoPx`). Notebook cells feed their measured
 * Monaco content height as `autoPx`: the region FOLLOWS content (auto-fit,
 * nothing persisted) until the user's first real resize gesture, which commits
 * + persists and permanently switches that key to user-sized.
 */
describe('ResizableCanvasRegion — autoPx (auto-until-first-resize)', () => {
  const auto = (autoPx: number, storageKey = 't-auto') => (
    <ResizableCanvasRegion storageKey={storageKey} defaultPx={240} minPx={120} maxPx={720} autoPx={autoPx}>
      {CANVAS}
    </ResizableCanvasRegion>
  );

  it('follows the content-driven autoPx (clamped to bounds) and persists nothing', () => {
    const { rerender } = wrap(auto(150));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '150');
    // Content grew → the region follows.
    rerender(<FluentProvider theme={webLightTheme}>{auto(300)}</FluentProvider>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '300');
    // Above the ceiling → clamped.
    rerender(<FluentProvider theme={webLightTheme}>{auto(9000)}</FluentProvider>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '720');
    // Auto mode never writes storage — keys exist only after a user resize.
    expect(window.localStorage.getItem('loom.canvasHeight.t-auto')).toBeNull();
  });

  it('a keyboard resize steps from the DISPLAYED auto height, persists, and stops following content', () => {
    const { rerender } = wrap(auto(300, 't-auto-kb'));
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowDown' }); // +24 from the displayed 300
    expect(sep).toHaveAttribute('aria-valuenow', '324');
    expect(window.localStorage.getItem('loom.canvasHeight.t-auto-kb')).toBe('324');
    // Content changes no longer move a user-sized region.
    rerender(<FluentProvider theme={webLightTheme}>{auto(500, 't-auto-kb')}</FluentProvider>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '324');
  });

  it('a previously persisted height wins over autoPx from the start (per-key, siblings unaffected)', () => {
    window.localStorage.setItem('loom.canvasHeight.t-auto-persist', '400');
    wrap(auto(150, 't-auto-persist'));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '400');
    cleanup();
    // A sibling key with no persisted height still auto-fits.
    wrap(auto(150, 't-auto-sibling'));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '150');
  });
});
