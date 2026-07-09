/**
 * Unit tests for the PREDICT run-history model (FGC-18 "run history persisted"):
 * upsert + prune, prefix-aware terminal-status application, and sort order.
 */
import { describe, it, expect } from 'vitest';
import {
  upsertPredictHistory,
  applyHistoryStatus,
  matchHistoryKey,
  sortHistory,
  pruneHistory,
  MAX_PREDICT_HISTORY,
  type PredictHistoryEntry,
  type PredictHistoryMap,
} from '@/lib/azure/predict-history';

function entry(runId: string, startedAt: string, over: Partial<PredictHistoryEntry> = {}): PredictHistoryEntry {
  return {
    runId, backend: 'synapse', version: '1', inputRef: 'in', outputRef: 'out',
    featureCount: 2, startedAt, status: 'submitted', ...over,
  };
}

describe('upsertPredictHistory', () => {
  it('inserts a new entry (immutably)', () => {
    const before: PredictHistoryMap = {};
    const after = upsertPredictHistory(before, entry('r1', '2026-07-08T00:00:00Z'));
    expect(after.r1).toBeTruthy();
    expect(before).toEqual({}); // input untouched
  });

  it('replaces an existing entry by runId', () => {
    const map = upsertPredictHistory({}, entry('r1', '2026-07-08T00:00:00Z', { version: '1' }));
    const next = upsertPredictHistory(map, entry('r1', '2026-07-08T00:00:00Z', { version: '2' }));
    expect(next.r1.version).toBe('2');
    expect(Object.keys(next)).toHaveLength(1);
  });

  it('prunes to the newest MAX_PREDICT_HISTORY entries', () => {
    let map: PredictHistoryMap = {};
    for (let i = 0; i < MAX_PREDICT_HISTORY + 5; i++) {
      const iso = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      map = upsertPredictHistory(map, entry(`r${i}`, iso));
    }
    expect(Object.keys(map)).toHaveLength(MAX_PREDICT_HISTORY);
    // The oldest (r0) should have been pruned; the newest kept.
    expect(map.r0).toBeUndefined();
    expect(map[`r${MAX_PREDICT_HISTORY + 4}`]).toBeTruthy();
  });
});

describe('matchHistoryKey', () => {
  const map: PredictHistoryMap = {
    'synapse-spark:pool:12': entry('synapse-spark:pool:12', '2026-07-08T00:00:00Z'),
    'aml:job-1': entry('aml:job-1', '2026-07-08T00:00:00Z', { backend: 'aml' }),
  };

  it('matches an exact runId', () => {
    expect(matchHistoryKey(map, 'aml:job-1')).toBe('aml:job-1');
  });

  it('matches a Synapse base key from a statement-scoped runId', () => {
    expect(matchHistoryKey(map, 'synapse-spark:pool:12:99')).toBe('synapse-spark:pool:12');
  });

  it('returns null when nothing matches', () => {
    expect(matchHistoryKey(map, 'synapse-spark:other:1')).toBeNull();
  });
});

describe('applyHistoryStatus', () => {
  it('stamps a terminal status on the matching entry (prefix-aware)', () => {
    const map = upsertPredictHistory({}, entry('synapse-spark:p:5', '2026-07-08T00:00:00Z'));
    const next = applyHistoryStatus(map, 'synapse-spark:p:5:77', { status: 'succeeded', rows: 100 });
    expect(next['synapse-spark:p:5'].status).toBe('succeeded');
    expect(next['synapse-spark:p:5'].rows).toBe(100);
  });

  it('is a no-op returning the same reference when nothing matches', () => {
    const map = upsertPredictHistory({}, entry('r1', '2026-07-08T00:00:00Z'));
    const next = applyHistoryStatus(map, 'nope', { status: 'failed' });
    expect(next).toBe(map);
  });
});

describe('sortHistory', () => {
  it('orders newest submission first', () => {
    const map: PredictHistoryMap = {
      a: entry('a', '2026-07-01T00:00:00Z'),
      b: entry('b', '2026-07-08T00:00:00Z'),
      c: entry('c', '2026-07-05T00:00:00Z'),
    };
    expect(sortHistory(map).map((e) => e.runId)).toEqual(['b', 'c', 'a']);
  });

  it('handles undefined', () => {
    expect(sortHistory(undefined)).toEqual([]);
  });
});

describe('pruneHistory', () => {
  it('returns the input untouched when under the cap', () => {
    const map = upsertPredictHistory({}, entry('r1', '2026-07-08T00:00:00Z'));
    expect(pruneHistory(map)).toBe(map);
  });
});
