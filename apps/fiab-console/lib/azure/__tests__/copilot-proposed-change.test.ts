/**
 * extractProposedChange — sentinel-stripping for approval-gated tool results.
 *
 * Verifies the contract the orchestrator relies on:
 *  - the __proposedChange__ sentinel is REMOVED from the result the model sees
 *    (the model must never be told the edit is applied — it isn't, until Keep)
 *  - a valid payload is parsed into a normalized proposed_change shape
 *  - non-proposing results pass through untouched
 */
import { describe, it, expect } from 'vitest';
import { extractProposedChange, PROPOSED_CHANGE_KEY } from '@/lib/copilot/proposed-change';

describe('extractProposedChange', () => {
  it('passes plain results through with no proposed change', () => {
    const r = { ok: true, rows: [1, 2, 3] };
    const { publicResult, proposed } = extractProposedChange(r);
    expect(proposed).toBeNull();
    expect(publicResult).toBe(r);
  });

  it('strips the sentinel from the model-facing result and parses the payload', () => {
    const result = {
      ok: true,
      rationale: 'Vectorized',
      [PROPOSED_CHANGE_KEY]: {
        target: 'notebook-cell:c1',
        before: 'for i in range(n): pass',
        after: 'df.cache()',
        lang: 'pyspark',
        summary: 'Vectorized',
      },
    };
    const { publicResult, proposed } = extractProposedChange(result);

    // Sentinel must NOT survive into what the model sees.
    expect(PROPOSED_CHANGE_KEY in (publicResult as any)).toBe(false);
    expect((publicResult as any).ok).toBe(true);
    expect((publicResult as any).rationale).toBe('Vectorized');

    expect(proposed).toEqual({
      target: 'notebook-cell:c1',
      before: 'for i in range(n): pass',
      after: 'df.cache()',
      lang: 'pyspark',
      summary: 'Vectorized',
    });
  });

  it('still strips the sentinel even when the payload is malformed (no target)', () => {
    const result = { ok: true, [PROPOSED_CHANGE_KEY]: { before: 'x' } };
    const { publicResult, proposed } = extractProposedChange(result);
    expect(proposed).toBeNull();
    expect(PROPOSED_CHANGE_KEY in (publicResult as any)).toBe(false);
  });

  it('coerces missing before/after to empty strings', () => {
    const result = { [PROPOSED_CHANGE_KEY]: { target: 'query-editor:q1', after: 'SELECT 1' } };
    const { proposed } = extractProposedChange(result);
    expect(proposed).toEqual({
      target: 'query-editor:q1',
      before: '',
      after: 'SELECT 1',
      lang: undefined,
      summary: undefined,
    });
  });
});
