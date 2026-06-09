/**
 * CopilotDiff — approval gate (Keep / Undo) for a Copilot-proposed change.
 *
 * Per the approval-diff contract + no-vaporware, this asserts the REAL gating
 * behavior, not just that a dialog renders:
 *  - closed (no dialog) when `change` is null
 *  - the proposed before/after both reach the diff surface
 *  - NOTHING is applied on open — onKeep fires only on the Keep click
 *  - Undo discards via onUndo
 *
 * The Monaco DiffEditor is loaded via next/dynamic; here we stub next/dynamic so
 * the diff surface renders synchronously and we can assert the before/after text
 * actually flows into it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Stub next/dynamic → a synchronous DiffEditor that surfaces original/modified.
vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () =>
    function StubDiffEditor(props: any) {
      return React.createElement(
        'div',
        { 'data-testid': 'diff-editor', 'data-language': props.language },
        React.createElement('div', { 'data-testid': 'diff-before' }, props.original),
        React.createElement('div', { 'data-testid': 'diff-after' }, props.modified),
      );
    },
}));

import { CopilotDiff, type ProposedChange } from '../copilot-diff';

const CHANGE: ProposedChange = {
  target: 'notebook-cell:cell-1',
  before: 'df = spark.read.parquet(path)\nfor i in range(len(df)): pass',
  after: 'df = spark.read.parquet(path).cache()',
  lang: 'pyspark',
  summary: 'Vectorized + cached',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('CopilotDiff approval gate', () => {
  it('renders nothing interactive when change is null', () => {
    render(<CopilotDiff change={null} onKeep={vi.fn()} onUndo={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(screen.queryByTestId('diff-editor')).toBeNull();
  });

  it('shows the real before/after in the diff surface (python language)', () => {
    render(<CopilotDiff change={CHANGE} onKeep={vi.fn()} onUndo={vi.fn()} />);
    const editor = screen.getByTestId('diff-editor');
    expect(editor.getAttribute('data-language')).toBe('python');
    expect(screen.getByTestId('diff-before').textContent).toContain('for i in range');
    expect(screen.getByTestId('diff-after').textContent).toContain('.cache()');
  });

  it('does NOT apply on open — onKeep fires only when Keep is clicked', () => {
    const onKeep = vi.fn();
    render(<CopilotDiff change={CHANGE} onKeep={onKeep} onUndo={vi.fn()} />);
    expect(onKeep).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onKeep).toHaveBeenCalledWith(CHANGE);
  });

  it('discards via Undo without applying', () => {
    const onKeep = vi.fn();
    const onUndo = vi.fn();
    render(<CopilotDiff change={CHANGE} onKeep={onKeep} onUndo={onUndo} />);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
  });
});
