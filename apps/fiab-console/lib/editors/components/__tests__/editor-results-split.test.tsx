/**
 * EditorResultsSplit (U6) — render + interaction tests.
 *
 * The shared query↔results divider every Monaco query editor adopts. These
 * jsdom tests exercise the REAL component (SplitPane + ResizableCanvasRegion
 * underneath; only the FLAG0 client hook is mocked) and assert:
 *   1. inactive (`active=false`) → plain flow layout, no separators (clean
 *      first-open before the first Run);
 *   2. active + flag ON → workspace grip + divider render, both panes mount,
 *      and the results pane provides EditorSplitContext (SplitFillBox fills);
 *   3. divider drag commits and persists under
 *      `loom.splitpane.<editorKey>.results-split`;
 *   4. flag OFF → flow layout even when active (the no-roll revert path);
 *   5. SplitFillBox outside a split keeps its flow styling.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';

// FLAG0 client hook → controllable without a react-query provider.
const flagState = { value: true };
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({
  useRuntimeFlag: () => flagState.value,
}));

import { EditorResultsSplit, SplitFillBox } from '../editor-results-split';

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    // @ts-expect-error — MouseEvent carries clientY; enough for drag tests.
    window.PointerEvent = class extends MouseEvent {};
  }
  if (!HTMLElement.prototype.setPointerCapture) HTMLElement.prototype.setPointerCapture = () => {};
  if (!HTMLElement.prototype.releasePointerCapture) HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
  flagState.value = true;
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

function wrap(ui: React.ReactElement) {
  return render(<FluentProvider theme={webLightTheme}>{ui}</FluentProvider>);
}

const QUERY = <div>query-pane-content</div>;
const RESULTS = <SplitFillBox className="grid-box"><div>results-grid</div></SplitFillBox>;

const DIVIDER_LABEL = 'Resize query / results split';

describe('EditorResultsSplit', () => {
  it('renders plain flow with no separators while inactive (clean first-open)', () => {
    const { container } = wrap(
      <EditorResultsSplit editorKey="test-ed" active={false} query={QUERY} results={RESULTS} />,
    );
    expect(screen.getByText('query-pane-content')).toBeInTheDocument();
    expect(screen.getByText('results-grid')).toBeInTheDocument();
    expect(within(container).queryAllByRole('separator')).toHaveLength(0);
  });

  it('mounts the workspace grip + divider when active', () => {
    wrap(<EditorResultsSplit editorKey="test-ed" active query={QUERY} results={RESULTS} />);
    expect(screen.getByText('query-pane-content')).toBeInTheDocument();
    expect(screen.getByText('results-grid')).toBeInTheDocument();
    // The SplitPane divider between the panes…
    const divider = screen.getByRole('separator', { name: DIVIDER_LABEL });
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
    // …and the ResizableCanvasRegion workspace grip.
    expect(
      screen.getByRole('separator', { name: /Resize query workspace height/ }),
    ).toBeInTheDocument();
  });

  it('provides EditorSplitContext to the results pane (SplitFillBox flex-fills)', () => {
    wrap(<EditorResultsSplit editorKey="test-ed" active query={QUERY} results={RESULTS} />);
    const box = screen.getByText('results-grid').parentElement as HTMLElement;
    expect(box.className).toContain('grid-box');
    expect(box.style.flexGrow).toBe('1');
    expect(box.style.maxHeight).toBe('none');
    expect(box.style.minHeight).toBe('0');
  });

  it('drags the divider and persists under loom.splitpane.<key>.results-split', () => {
    wrap(<EditorResultsSplit editorKey="test-ed" active query={QUERY} results={RESULTS} defaultQuerySize={200} />);
    const divider = screen.getByRole('separator', { name: DIVIDER_LABEL });
    fireEvent.pointerDown(divider, { clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientY: 360, pointerId: 1 }); // +60 → query pane grows
    fireEvent.pointerUp(divider, { clientY: 360, pointerId: 1 });
    expect(divider).toHaveAttribute('aria-valuenow', '260');
    expect(window.localStorage.getItem('loom.splitpane.test-ed.results-split')).toBe('260');
  });

  it('restores the persisted split position on remount', () => {
    window.localStorage.setItem('loom.splitpane.test-ed.results-split', '333');
    wrap(<EditorResultsSplit editorKey="test-ed" active query={QUERY} results={RESULTS} defaultQuerySize={200} />);
    expect(screen.getByRole('separator', { name: DIVIDER_LABEL })).toHaveAttribute('aria-valuenow', '333');
  });

  it('falls back to flow layout when the FLAG0 kill-switch is OFF', () => {
    flagState.value = false;
    const { container } = wrap(
      <EditorResultsSplit editorKey="test-ed" active query={QUERY} results={RESULTS} />,
    );
    expect(screen.getByText('query-pane-content')).toBeInTheDocument();
    expect(screen.getByText('results-grid')).toBeInTheDocument();
    expect(within(container).queryAllByRole('separator')).toHaveLength(0);
    // Outside an active split the fill box keeps its flow styling (no flex override).
    const box = screen.getByText('results-grid').parentElement as HTMLElement;
    expect(box.style.flexGrow).toBe('');
  });
});
