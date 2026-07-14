import { describe, it, expect } from 'vitest';
import {
  jaccard, tokens, outranks, planDedupe, detectContradictions, promoteTopics,
} from '../memory-consolidate-core';
import type { MemoryRecord } from '../memory-types';

function mem(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, scopeKey: 'user:o', scope: 'user', content, category: 'fact', confidence: 0.8,
    tags: [], createdAt: '2026-07-14T00:00:00.000Z', source: 'auto', ...over,
  };
}

describe('jaccard', () => {
  it('is 1 for identical token sets and 0 for disjoint', () => {
    expect(jaccard(tokens('the quick brown fox'), tokens('the quick brown fox'))).toBe(1);
    expect(jaccard(tokens('alpha beta'), tokens('gamma delta'))).toBe(0);
  });
});

describe('outranks', () => {
  it('prefers higher confidence, then recall count, then recency', () => {
    expect(outranks(mem('a', 'x', { confidence: 0.9 }), mem('b', 'x', { confidence: 0.5 }))).toBe(true);
    expect(outranks(mem('a', 'x', { confidence: 0.8, recallCount: 5 }), mem('b', 'x', { confidence: 0.8, recallCount: 1 }))).toBe(true);
  });
});

describe('planDedupe', () => {
  it('drops the lower-salience side of a near-duplicate pair', () => {
    const keep = mem('keep', 'user prefers metric units for reporting', { confidence: 0.95 });
    const drop = mem('drop', 'user prefers metric units for reporting', { confidence: 0.6 });
    const plan = planDedupe([keep, drop], 0.6);
    expect(plan.drop).toContain('drop');
    expect(plan.drop).not.toContain('keep');
    expect(plan.merges[0]).toMatchObject({ keep: 'keep', drop: 'drop' });
  });

  it('does NOT merge unrelated memories', () => {
    const plan = planDedupe([mem('a', 'prefers dark mode'), mem('b', 'fiscal year starts in April')], 0.6);
    expect(plan.drop).toHaveLength(0);
  });

  it('does NOT merge a memory with its negation (that is a contradiction, not a dup)', () => {
    const plan = planDedupe([
      mem('a', 'the project uses Databricks for compute'),
      mem('b', 'the project does not use Databricks for compute'),
    ], 0.5);
    expect(plan.drop).toHaveLength(0);
  });
});

describe('detectContradictions', () => {
  it('flags high-overlap opposite-polarity pairs', () => {
    const c = detectContradictions([
      mem('a', 'the fiscal year starts in April'),
      mem('b', 'the fiscal year does not start in April'),
    ], 0.5);
    expect(c.length).toBe(1);
    expect(c[0]).toMatchObject({ a: 'a', b: 'b' });
  });

  it('does not flag unrelated memories', () => {
    expect(detectContradictions([mem('a', 'likes coffee'), mem('b', 'fiscal year starts in April')], 0.5)).toHaveLength(0);
  });
});

describe('promoteTopics', () => {
  it('promotes tags that recur at or above the threshold', () => {
    const records = [
      mem('a', 'one', { tags: ['governance', 'purview'] }),
      mem('b', 'two', { tags: ['governance'] }),
      mem('c', 'three', { tags: ['governance', 'other'] }),
    ];
    const topics = promoteTopics(records, 3);
    expect(topics.map((t) => t.tag)).toContain('governance');
    expect(topics.find((t) => t.tag === 'governance')?.count).toBe(3);
    expect(topics.map((t) => t.tag)).not.toContain('purview');
  });
});
