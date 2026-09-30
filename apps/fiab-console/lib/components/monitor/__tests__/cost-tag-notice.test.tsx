/**
 * Render test for CostTagNotice: each tagLoadState outcome must reach the DOM
 * as its own message. The pure state function is pinned in
 * `cost-tag-state.test.ts`; this file exists because a component that renders
 * the wrong branch for a correct state would pass that file untouched.
 *
 * What breaks each test is stated at its site.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import {
  CostTagNotice, ERROR_TEXT_MAX, ERRORS_SHOWN, PartialBreakdownNotice, breakdownEmptyText, listErrors, shortSub,
} from '@/lib/components/monitor/cost-tag-notice';

const SUB = 'aaaaaaaa-0000-0000-0000-000000000001';
const ERR = { subscription: SUB, error: 'Too many requests for test' };
const NONE_TEXT = 'No cost-allocation tags found';

type Props = Parameters<typeof CostTagNotice>[0];
const mount = (props: Props) => render(<FluentProvider theme={webLightTheme}><CostTagNotice {...props} /></FluentProvider>);
const textOf = (summary: Props['summary']) => mount({ summary }).container.textContent || '';

describe('CostTagNotice', () => {
  it('renders nothing when rows are present and every query answered', () => {
    // Breaks if the ok branch renders any notice (e.g. falls through to "none").
    expect(textOf({ byTag: [{ key: 'commercial', cost: 50 }], tagQueryErrors: [], tagKey: 'Environment' })).toBe('');
  });

  it('failed: says the breakdown could not be loaded, never "no tags found"', () => {
    const t = textOf({ byTag: [], tagQueryErrors: [ERR], tagKey: 'Environment' });
    // Breaks if a failed query renders the "none" message (the original defect).
    expect(t).toContain('tag breakdown could not be loaded');
    expect(t).toContain(`${shortSub(SUB)}: Too many requests for test`);
    expect(t).not.toContain(NONE_TEXT);
  });

  it('partial: names the omitted subscription count and error', () => {
    const t = textOf({ byTag: [{ key: 'commercial', cost: 50 }], tagQueryErrors: [ERR, { ...ERR, subscription: 'bbbbbbbb-0000-0000-0000-000000000002' }], tagKey: 'Environment' });
    // Breaks if partial renders nothing (reads as ok) or reuses the failed text.
    expect(t).toContain('Partial: the Environment breakdown below omits spend from 2 subscriptions');
    expect(t).not.toContain('could not be loaded');
  });

  it('none: the only state that may say no tags were found', () => {
    const t = textOf({ byTag: [], tagQueryErrors: [], tagKey: 'CostCenter' });
    // Breaks if the none branch is dropped, or the configured key is not shown.
    expect(t).toContain(`${NONE_TEXT} for tag key CostCenter`);
  });

  it('unknown while loading: a skeleton, no claim at all (#4771 R7, B-1)', () => {
    const { container, getByLabelText } = mount({ summary: null, loading: true });
    // Breaks if the loading branch is dropped: the neutral text would render.
    expect(getByLabelText('Loading the tag breakdown')).toBeTruthy();
    // Breaks if a null summary reaches the none branch (the R7 defect).
    expect(container.textContent || '').not.toContain(NONE_TEXT);
  });

  it('unknown after a failed read: a neutral notice that names nothing as found', () => {
    const t = textOf(null);
    // Breaks if unknown renders null (a silent pane) or the none text.
    expect(t).toContain('Tag breakdown unavailable');
    expect(t).toContain('The cost summary was not read');
    expect(t).not.toContain(NONE_TEXT);
  });

  it('every state that is not a final answer offers Retry, and Retry calls back', () => {
    for (const summary of [null, { byTag: [], tagQueryErrors: [ERR] }, { byTag: [{ key: 'x', cost: 1 }], tagQueryErrors: [ERR] }]) {
      const onRetry = vi.fn();
      const { getByRole, unmount } = mount({ summary, onRetry });
      fireEvent.click(getByRole('button', { name: 'Retry' }));
      // Breaks if the Retry action is missing on this state (getByRole throws)
      // or is not wired to onRetry (called 0 times).
      expect(onRetry).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('none offers no Retry: re-reading will not change a genuine answer', () => {
    const { queryByRole, container } = mount({ summary: { byTag: [], tagQueryErrors: [] }, onRetry: vi.fn() });
    // Positive half first, so the absence below is not satisfied by an empty render.
    expect(container.textContent).toContain(NONE_TEXT);
    // Breaks if Retry is rendered on every state, including the final one.
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('each notice carries a MessageBarTitle', () => {
    const { container } = mount({ summary: { byTag: [], tagQueryErrors: [ERR] } });
    // Breaks if the title is dropped: the failed notice would have no heading text.
    expect(container.textContent).toContain('Tag breakdown could not be loaded');
  });
});

describe('listErrors', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ subscription: `sub-${i}`, error: `err-${i}` }));

  it(`lists at most ${ERRORS_SHOWN} errors and counts the rest`, () => {
    const t = listErrors(many);
    // Breaks if truncation is removed (sub-3 and sub-4 would appear) or the
    // remainder count is wrong (5 - 3 = 2).
    expect(t).toBe('sub-0: err-0 · sub-1: err-1 · sub-2: err-2 · and 2 more');
  });

  it('adds no "and N more" suffix at or under the limit', () => {
    // Breaks if the suffix is emitted for a remainder of zero ("and 0 more").
    expect(listErrors(many.slice(0, ERRORS_SHOWN))).toBe('sub-0: err-0 · sub-1: err-1 · sub-2: err-2');
  });

  it(`cuts each raw Azure message at ${ERROR_TEXT_MAX} characters (#4771 R8)`, () => {
    // Breaks if the cut is removed (the 301st character survives), moved, or
    // loses its ellipsis marker.
    expect(listErrors([{ subscription: 'sub-0', error: 'x'.repeat(ERROR_TEXT_MAX + 100) }]))
      .toBe(`sub-0: ${'x'.repeat(ERROR_TEXT_MAX)}…`);
    // Boundary: exactly ERROR_TEXT_MAX is left whole. Breaks if `>` becomes `>=`.
    expect(listErrors([{ subscription: 'sub-0', error: 'y'.repeat(ERROR_TEXT_MAX) }]))
      .toBe(`sub-0: ${'y'.repeat(ERROR_TEXT_MAX)}`);
    // Breaks if the limit constant drifts from what the review asked for.
    expect(ERROR_TEXT_MAX).toBe(300);
  });
});

describe('PartialBreakdownNotice (#4771 R8, B-1 and A-4)', () => {
  const mountP = (props: Parameters<typeof PartialBreakdownNotice>[0]) =>
    render(<FluentProvider theme={webLightTheme}><PartialBreakdownNotice {...props} /></FluentProvider>);

  it('renders nothing for an empty or absent error list', () => {
    // Breaks if the notice renders unconditionally.
    expect(mountP({ errors: [], dimension: 'service' }).container.textContent).toBe('');
    expect(mountP({ errors: undefined, dimension: 'service' }).container.textContent).toBe('');
  });

  it('names the dimension, the omitted count and the errors, under a title', () => {
    const t = mountP({ errors: [ERR, { ...ERR, subscription: 'bbbbbbbb-0000-0000-0000-000000000002' }], dimension: 'resource group' }).container.textContent || '';
    // Breaks if the title, the dimension, the plural or the count is dropped.
    expect(t).toContain('Partial breakdown');
    expect(t).toContain('the resource group breakdown omits spend from 2 subscriptions whose cost read failed');
    // Breaks if the error list is dropped.
    expect(t).toContain(`${shortSub(SUB)}: Too many requests for test`);
  });

  it('offers Retry, and Retry calls back', () => {
    const onRetry = vi.fn();
    const { getByRole } = mountP({ errors: [ERR], dimension: 'service', onRetry });
    fireEvent.click(getByRole('button', { name: 'Retry' }));
    // Breaks if Retry is missing (getByRole throws) or not wired (0 calls).
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('breakdownEmptyText (#4771 R8, B-2)', () => {
  it('claims "No cost recorded." only for a complete, successful read', () => {
    // Breaks if any branch is dropped or reordered: each row's expected text is distinct.
    expect(breakdownEmptyText({ gated: false, failed: false, partial: false })).toBe('No cost recorded.');
    expect(breakdownEmptyText({ gated: false, failed: true, partial: false })).toMatch(/^The cost read did not complete/);
    expect(breakdownEmptyText({ gated: false, failed: false, partial: true })).toMatch(/^No cost recorded in the subscriptions that answered/);
    expect(breakdownEmptyText({ gated: true, failed: false, partial: false })).toMatch(/^Grant Cost Management Reader/);
    // Precedence: a gate outranks a failure, which outranks a partial read.
    expect(breakdownEmptyText({ gated: true, failed: true, partial: true })).toMatch(/^Grant/);
    expect(breakdownEmptyText({ gated: false, failed: true, partial: true })).toMatch(/^The cost read did not complete/);
  });
});

describe('CostTagNotice under a gate (#4771 R8)', () => {
  it('withholds Retry and points at the gate bar', () => {
    const onRetry = vi.fn();
    const { queryByRole, container } = mount({ summary: null, gated: true, onRetry });
    // Positive half: the neutral notice rendered, and names the gate as the fix.
    expect(container.textContent).toContain('Tag breakdown unavailable');
    expect(container.textContent).toContain('the notice above names what is missing and how to fix it');
    // Breaks if `gated` is ignored: a Retry that can only hit the same gate renders.
    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('shortSub', () => {
  it('shortens a subscription id and leaves a short value alone', () => {
    // Breaks if the slice bounds change: 8 leading + ellipsis + 4 trailing.
    expect(shortSub(SUB)).toBe('aaaaaaaa…0001');
    expect(shortSub('sub-a')).toBe('sub-a');
  });
});
