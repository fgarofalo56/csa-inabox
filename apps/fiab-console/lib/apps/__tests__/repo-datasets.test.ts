/**
 * repo-datasets path-safety + read tests.
 *
 * The bundle author controls the `repoDataset` string, so the resolver MUST
 * confine reads to samples/app-data/** and reject any traversal / absolute /
 * escaping path. These tests prove the guard + a real read of a shipped sample.
 */
import { describe, it, expect } from 'vitest';
import { normalizeRepoDatasetPath, readRepoDataset, REPO_DATASET_PREFIX } from '@/lib/apps/repo-datasets';

describe('normalizeRepoDatasetPath', () => {
  it('canonicalises a bare relative path under the prefix', () => {
    expect(normalizeRepoDatasetPath('lakehouse-inspector/x.csv')).toBe(`${REPO_DATASET_PREFIX}/lakehouse-inspector/x.csv`);
  });
  it('accepts an already-prefixed path', () => {
    expect(normalizeRepoDatasetPath(`${REPO_DATASET_PREFIX}/a/b.csv`)).toBe(`${REPO_DATASET_PREFIX}/a/b.csv`);
  });
  it('normalises backslashes + leading ./', () => {
    expect(normalizeRepoDatasetPath('.\\app\\c.csv')).toBe(`${REPO_DATASET_PREFIX}/app/c.csv`);
  });
  it('rejects absolute paths', () => {
    expect(normalizeRepoDatasetPath('/etc/passwd')).toBeNull();
    expect(normalizeRepoDatasetPath('C:/Windows/system32/x')).toBeNull();
  });
  it('rejects traversal that escapes the prefix', () => {
    expect(normalizeRepoDatasetPath('../../etc/passwd')).toBeNull();
    expect(normalizeRepoDatasetPath(`${REPO_DATASET_PREFIX}/../../secret`)).toBeNull();
    expect(normalizeRepoDatasetPath('a/../../../etc')).toBeNull();
  });
  it('rejects the bare prefix (a directory, not a file)', () => {
    expect(normalizeRepoDatasetPath(REPO_DATASET_PREFIX)).toBeNull();
  });
  it('rejects empty / non-string', () => {
    expect(normalizeRepoDatasetPath('')).toBeNull();
    // @ts-expect-error intentional bad input
    expect(normalizeRepoDatasetPath(null)).toBeNull();
  });
});

describe('readRepoDataset', () => {
  it('reads a shipped sample dataset', () => {
    const ds = readRepoDataset('lakehouse-inspector/retail-orders-public.csv');
    expect(ds).not.toBeNull();
    expect(ds!.fileName).toBe('retail-orders-public.csv');
    expect(ds!.contentType).toBe('text/csv');
    expect(ds!.bytes.length).toBeGreaterThan(1000);
    // First line is the header we generated.
    expect(ds!.bytes.toString('utf-8').split('\n')[0]).toContain('order_id,order_date');
  });
  it('returns null for an unsafe path (no throw)', () => {
    expect(readRepoDataset('../../package.json')).toBeNull();
  });
  it('returns null for a missing file under the prefix', () => {
    expect(readRepoDataset('does-not-exist/nope.csv')).toBeNull();
  });
});
