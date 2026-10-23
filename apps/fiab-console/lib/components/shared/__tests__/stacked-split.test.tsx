/**
 * StackedSplit component wiring (jsdom has no layout, so sizes are not
 * asserted here — the reflow math is covered in stacked-split-model.test.ts).
 * This pins: collapse via the header chevron persists under ONE key without
 * touching shares, the divider is a separate focusable separator, and a
 * persisted layout is restored by pane id.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { StackedSplit } from '../stacked-split';

const KEY = 'loom.stackedsplit.t';
const panes = [
  { id: 'canvas', role: 'canvas' as const, title: 'Canvas', content: <p>canvas body</p>, defaultFlex: 3 },
  { id: 'val', title: 'Validation', content: <p>val body</p>, defaultFlex: 1.5 },
  { id: 'out', title: 'Output', content: <p>out body</p> },
];

describe('StackedSplit', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it('renders a separator per adjacent expanded pair, each separate from the chevron buttons', () => {
    render(<StackedSplit sizingKey="t" panes={panes} />);
    const seps = screen.getAllByRole('separator');
    expect(seps).toHaveLength(2); // 3 panes -> 2 dividers; breaks if a divider is dropped/duplicated
    expect(seps[0].getAttribute('aria-label')).toBe('Resize Canvas');
    expect(seps[0].tagName).not.toBe('BUTTON');
    // Canvas is not collapsible by default; docks are.
    expect(screen.queryByRole('button', { name: 'Collapse Canvas panel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse Validation panel' })).toBeTruthy();
  });

  it('chevron click collapses, persists collapsed[id]=true under one key, and leaves shares at their defaults', async () => {
    render(<StackedSplit sizingKey="t" panes={panes} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Validation panel' }));
    expect(screen.queryByText('val body')).toBeNull();
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    expect(saved.v).toBe(1);
    expect(saved.collapsed.val).toBe(true);
    expect(saved.shares).toEqual({ canvas: 3, val: 1.5, out: 1 }); // breaks if collapse rewrites shares
    // Expand again: body returns and the stored share is still 1.5.
    fireEvent.click(screen.getByRole('button', { name: 'Expand Validation panel' }));
    expect(screen.getByText('val body')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}').shares.val).toBe(1.5);
  });

  it('restores a persisted layout by pane id after mount, ignoring a stale id', async () => {
    window.localStorage.setItem(KEY, JSON.stringify({
      v: 1, shares: { canvas: 5, val: 2, gone: 9 }, collapsed: { out: true, gone: true },
    }));
    render(<StackedSplit sizingKey="t" panes={panes} />);
    await waitFor(() => expect(screen.queryByText('out body')).toBeNull()); // out restored collapsed
    expect(screen.getByText('val body')).toBeTruthy();
    const sec = document.querySelector('[data-pane-id="canvas"]') as HTMLElement;
    expect(sec.style.flex).toBe('5 1 0px'); // persisted 5, not the defaultFlex 3
  });

  it('Home on a divider re-saves the layout (keyboard path reaches persistence)', () => {
    render(<StackedSplit sizingKey="t" panes={panes} />);
    fireEvent.keyDown(screen.getAllByRole('separator')[1], { key: 'Home' });
    expect(window.localStorage.getItem(KEY)).not.toBeNull(); // breaks if keydown is not wired
  });
});
