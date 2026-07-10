/**
 * SplitPane (R1) — render + interaction tests.
 *
 * The shared resizable split container gives every editor Fabric's draggable
 * pane divider. These jsdom tests exercise the REAL component and assert:
 *   1. both panes render in each direction, with a correctly-oriented divider;
 *   2. dragging the divider (pointer events) resizes the primary pane;
 *   3. the chosen size persists to localStorage and restores on mount;
 *   4. keyboard resize (Arrow / Home) moves the divider;
 *   5. double-click resets to the default size;
 *   6. an external `collapsed` hides the divider (caller's minimize keeps working).
 *
 * jsdom 25 ships no PointerEvent / setPointerCapture; we stub the minimum so
 * fireEvent.pointer* dispatch a MouseEvent-backed event carrying clientX.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { SplitPane } from '../split-pane';

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    // @ts-expect-error — MouseEvent carries clientX; enough for drag tests.
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

const A = <div>pane-a</div>;
const B = <div>pane-b</div>;

describe('SplitPane', () => {
  it('renders both panes and a vertical-oriented divider for a horizontal split', () => {
    wrap(<SplitPane direction="horizontal" defaultSize={200}>{[A, B]}</SplitPane>);
    expect(screen.getByText('pane-a')).toBeInTheDocument();
    expect(screen.getByText('pane-b')).toBeInTheDocument();
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-valuenow', '200');
  });

  it('renders a horizontal-oriented divider for a vertical split', () => {
    wrap(<SplitPane direction="vertical" defaultSize={150}>{[A, B]}</SplitPane>);
    expect(screen.getByText('pane-a')).toBeInTheDocument();
    expect(screen.getByText('pane-b')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
  });

  it('resizes the primary pane when the divider is dragged', () => {
    wrap(<SplitPane direction="horizontal" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>);
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-valuenow', '200');
    fireEvent.pointerDown(sep, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 360, pointerId: 1 }); // +60 → primary grows
    fireEvent.pointerUp(sep, { clientX: 360, pointerId: 1 });
    expect(sep).toHaveAttribute('aria-valuenow', '260');
  });

  it('drags from the trailing edge when primary is "second"', () => {
    wrap(<SplitPane direction="horizontal" primary="second" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 240, pointerId: 1 }); // move left → second pane grows
    fireEvent.pointerUp(sep, { clientX: 240, pointerId: 1 });
    expect(sep).toHaveAttribute('aria-valuenow', '260');
  });

  it('persists the dragged size to localStorage and restores it on mount', () => {
    const { unmount } = wrap(
      <SplitPane direction="horizontal" storageKey="test.persist" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>,
    );
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 150, pointerId: 1 });
    expect(sep).toHaveAttribute('aria-valuenow', '250');
    expect(window.localStorage.getItem('loom.splitpane.test.persist')).toBe('250');

    unmount();
    wrap(<SplitPane direction="horizontal" storageKey="test.persist" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '250');
  });

  it('resizes with the keyboard (Arrow steps, Home to min)', () => {
    wrap(<SplitPane direction="horizontal" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>);
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '224');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(sep).toHaveAttribute('aria-valuenow', '200');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(sep).toHaveAttribute('aria-valuenow', '120');
  });

  it('resets to the default size on double-click', () => {
    wrap(<SplitPane direction="horizontal" defaultSize={200} minSize={120}>{[A, B]}</SplitPane>);
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '224');
    fireEvent.doubleClick(sep);
    expect(sep).toHaveAttribute('aria-valuenow', '200');
  });

  it('hides the divider when externally collapsed but still renders both panes', () => {
    const { container } = wrap(
      <SplitPane direction="horizontal" collapsed defaultSize={200}>{[A, B]}</SplitPane>,
    );
    expect(within(container).queryByRole('separator')).toBeNull();
    expect(screen.getByText('pane-a')).toBeInTheDocument();
    expect(screen.getByText('pane-b')).toBeInTheDocument();
  });
});
