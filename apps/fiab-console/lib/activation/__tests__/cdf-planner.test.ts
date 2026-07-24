import { describe, it, expect } from 'vitest';
import {
  parseCommitActions, planCommitCdf, planCdfRange, commitFileName, type CdfRangeDeps,
} from '../cdf-planner';

describe('cdf-planner — commit parsing', () => {
  it('parses newline-delimited actions and skips malformed lines', () => {
    const body = [
      JSON.stringify({ commitInfo: { operation: 'WRITE' } }),
      '  ',
      '{ not json',
      JSON.stringify({ add: { path: 'part-1.parquet', dataChange: true } }),
    ].join('\n');
    const actions = parseCommitActions(body);
    expect(actions).toHaveLength(2);
    expect(actions[1].add).toBeTruthy();
  });
});

describe('cdf-planner — planCommitCdf precedence', () => {
  it('uses cdc files and ignores add/remove when cdc present', () => {
    const actions = [
      { cdc: { path: '_change_data/cdc-1.parquet' } },
      { add: { path: 'part-new.parquet', dataChange: true } },
      { remove: { path: 'part-old.parquet', dataChange: true } },
    ];
    const plan = planCommitCdf(actions, 5);
    expect(plan.files).toEqual([{ path: '_change_data/cdc-1.parquet', isCdc: true, version: 5 }]);
    expect(plan.hasUnrepresentableDeletes).toBe(false);
  });

  it('treats add-with-dataChange as inserts when no cdc files', () => {
    const actions = [
      { add: { path: 'part-a.parquet', dataChange: true } },
      { add: { path: 'part-b.parquet', dataChange: false } }, // compaction — not a change
    ];
    const plan = planCommitCdf(actions, 7);
    expect(plan.files).toEqual([{ path: 'part-a.parquet', isCdc: false, version: 7 }]);
  });

  it('flags a dataChange remove with no cdc files as unrepresentable', () => {
    const plan = planCommitCdf([{ remove: { path: 'part-x.parquet', dataChange: true } }], 9);
    expect(plan.files).toHaveLength(0);
    expect(plan.hasUnrepresentableDeletes).toBe(true);
  });
});

describe('cdf-planner — planCdfRange', () => {
  const commits: Record<number, Record<string, unknown>[]> = {
    3: [{ add: { path: 'v3-a.parquet', dataChange: true } }],
    4: [{ cdc: { path: '_change_data/v4-cdc.parquet' } }],
    5: [{ metaData: { id: 'x' } }], // metadata-only
    6: [{ cdc: { path: '_change_data/v6-cdc.parquet' } }],
  };
  const deps: CdfRangeDeps = {
    listVersions: async () => Object.keys(commits).map((v) => ({ version: Number(v) })),
    downloadCommit: async (_c, _p, v) => commits[v].map((a) => JSON.stringify(a)).join('\n'),
  };

  it('plans only versions in (from, to] and records the new watermark', async () => {
    const plan = await planCdfRange(deps, 'gold', 'segments/vip', 3);
    // versions 4,5,6 in range; 5 is empty.
    expect(plan.toVersion).toBe(6);
    expect(plan.fromVersion).toBe(4);
    expect(plan.files.map((f) => f.path)).toEqual(['_change_data/v4-cdc.parquet', '_change_data/v6-cdc.parquet']);
    expect(plan.emptyVersions).toEqual([5]);
  });

  it('returns an empty plan when already at the watermark', async () => {
    const plan = await planCdfRange(deps, 'gold', 'segments/vip', 6);
    expect(plan.files).toHaveLength(0);
    expect(plan.toVersion).toBe(6);
  });

  it('includes the first commit (add-file inserts) when from = -1', async () => {
    const plan = await planCdfRange(deps, 'gold', 'segments/vip', -1);
    expect(plan.files.some((f) => f.path === 'v3-a.parquet' && !f.isCdc)).toBe(true);
  });
});

describe('cdf-planner — commitFileName', () => {
  it('zero-pads to 20 digits', () => {
    expect(commitFileName(4)).toBe('00000000000000000004.json');
  });
});
