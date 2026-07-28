import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the native-backed ADLS client BEFORE importing the reader so vitest
// never loads the azure SDK chain.
// vi.hoisted: vi.mock is hoisted above const declarations, so the mock fns must be
// declared in a hoisted block or the factory hits "Cannot access before initialization".
const { listPaths, downloadFile } = vi.hoisted(() => ({ listPaths: vi.fn(), downloadFile: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ listPaths, downloadFile }));

import { readDeadLetter, toRelativePrefix } from '../dead-letter';

describe('toRelativePrefix', () => {
  it('passes a container-relative prefix through', () => {
    expect(toRelativePrefix('mirrors/ws1/c1')).toBe('mirrors/ws1/c1');
  });
  it('reduces an https folder URL to the container-relative path', () => {
    expect(toRelativePrefix('https://acct.dfs.core.windows.net/bronze/mirrors/ws1/c1/')).toBe('mirrors/ws1/c1');
  });
  it('strips a trailing _rejected segment', () => {
    expect(toRelativePrefix('mirrors/ws1/c1/_rejected')).toBe('mirrors/ws1/c1');
  });
  it('is empty for an empty input', () => {
    expect(toRelativePrefix('')).toBe('');
  });
});

describe('readDeadLetter', () => {
  beforeEach(() => { listPaths.mockReset(); downloadFile.mockReset(); });

  it('returns an honest empty report when no _rejected tree exists', async () => {
    listPaths.mockResolvedValueOnce([]);
    const rep = await readDeadLetter('mirrors/ws1/c1');
    expect(rep.present).toBe(false);
    expect(rep.totalFiles).toBe(0);
    expect(rep.note).toMatch(/No quarantined rows/);
  });

  it('aggregates per-dataset counts and samples real quarantined rows', async () => {
    // 1) dataset dirs under _rejected
    listPaths.mockResolvedValueOnce([
      { name: 'mirrors/ws1/c1/_rejected/public.orders', isDirectory: true, size: 0 },
    ]);
    // 2) files under the dataset dir
    listPaths.mockResolvedValueOnce([
      { name: 'mirrors/ws1/c1/_rejected/public.orders/rejected-1.jsonl', isDirectory: false, size: 120, lastModified: '2026-07-24T10:00:00Z' },
    ]);
    downloadFile.mockResolvedValueOnce({
      body: Buffer.from(JSON.stringify({ _rejectedAt: '2026-07-24T10:00:00Z', _contractId: 'c', _contractVersion: '1', _violations: [{ rule: 'not-null' }], row: { id: 1 } }) + '\n'),
      size: 120,
    });
    const rep = await readDeadLetter('mirrors/ws1/c1');
    expect(rep.present).toBe(true);
    expect(rep.totalFiles).toBe(1);
    expect(rep.datasets[0]).toMatchObject({ dataset: 'public.orders', files: 1 });
    expect(rep.sample[0]).toMatchObject({ dataset: 'public.orders', contractId: 'c', row: { id: 1 } });
  });

  it('fails open (honest note) when Bronze is unreachable', async () => {
    listPaths.mockRejectedValueOnce(new Error('no ADLS'));
    const rep = await readDeadLetter('mirrors/ws1/c1');
    expect(rep.present).toBe(false);
    expect(rep.note).toMatch(/not reachable/i);
  });
});
