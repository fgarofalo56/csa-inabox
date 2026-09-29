/**
 * Render test for CostTagNotice: each tagLoadState outcome must reach the DOM
 * as its own message. The pure state function is pinned in
 * `cost-tag-state.test.ts`; this file exists because a component that renders
 * the wrong branch for a correct state would pass that file untouched.
 *
 * What breaks each test is stated at its site.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { CostTagNotice, shortSub } from '@/lib/components/monitor/cost-tag-notice';

const SUB = 'aaaaaaaa-0000-0000-0000-000000000001';
const ERR = { subscription: SUB, error: 'Too many requests for test' };

const textOf = (summary: Parameters<typeof CostTagNotice>[0]['summary']) =>
  render(<FluentProvider theme={webLightTheme}><CostTagNotice summary={summary} /></FluentProvider>).container.textContent || '';

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
    expect(t).not.toContain('No cost-allocation tags found');
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
    expect(t).toContain('No cost-allocation tags found for tag key CostCenter');
  });
});

describe('shortSub', () => {
  it('shortens a subscription id and leaves a short value alone', () => {
    // Breaks if the slice bounds change: 8 leading + ellipsis + 4 trailing.
    expect(shortSub(SUB)).toBe('aaaaaaaa…0001');
    expect(shortSub('sub-a')).toBe('sub-a');
  });
});
