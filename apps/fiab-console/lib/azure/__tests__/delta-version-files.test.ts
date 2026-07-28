import { describe, it, expect } from 'vitest';
import { replayActiveFiles, maxVersion, cleanTablePath, type CommitFileActions } from '../delta-version-files';

const commits: CommitFileActions[] = [
  { version: 0, added: ['part-0.parquet', 'part-1.parquet'], removed: [] },
  { version: 1, added: ['part-2.parquet'], removed: ['part-1.parquet'] },
  { version: 2, added: ['part-3.parquet'], removed: ['part-0.parquet'] },
];

describe('replayActiveFiles', () => {
  it('reconstructs the file-set at version 0', () => {
    expect(replayActiveFiles(commits, 0).sort()).toEqual(['part-0.parquet', 'part-1.parquet']);
  });

  it('reconstructs the file-set at version 1 (add + remove)', () => {
    expect(replayActiveFiles(commits, 1).sort()).toEqual(['part-0.parquet', 'part-2.parquet']);
  });

  it('reconstructs the file-set at the latest version', () => {
    expect(replayActiveFiles(commits, 2).sort()).toEqual(['part-2.parquet', 'part-3.parquet']);
  });

  it('ignores commits after the target version (time-travel to the past)', () => {
    expect(replayActiveFiles(commits, 0)).not.toContain('part-2.parquet');
  });

  it('handles a remove-then-readd correctly (present)', () => {
    const c: CommitFileActions[] = [
      { version: 0, added: ['x.parquet'], removed: [] },
      { version: 1, added: [], removed: ['x.parquet'] },
      { version: 2, added: ['x.parquet'], removed: [] },
    ];
    expect(replayActiveFiles(c, 2)).toEqual(['x.parquet']);
    expect(replayActiveFiles(c, 1)).toEqual([]);
  });

  it('is order-independent (sorts by version)', () => {
    const shuffled = [commits[2], commits[0], commits[1]];
    expect(replayActiveFiles(shuffled, 1).sort()).toEqual(['part-0.parquet', 'part-2.parquet']);
  });
});

describe('maxVersion', () => {
  it('returns the highest committed version', () => {
    expect(maxVersion(commits)).toBe(2);
    expect(maxVersion([])).toBe(-1);
  });
});

describe('cleanTablePath', () => {
  it('trims slashes and rejects traversal', () => {
    expect(cleanTablePath('/sales/orders/')).toBe('sales/orders');
    expect(cleanTablePath('../etc')).toBe(null);
    expect(cleanTablePath('   ')).toBe(null);
  });
});
