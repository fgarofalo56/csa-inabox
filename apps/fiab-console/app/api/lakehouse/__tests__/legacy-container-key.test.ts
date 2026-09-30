/**
 * `legacyContainerKeyFor` attributes a container-keyed row to a lakehouse item
 * only when that item is the one lakehouse bound to the container. Each case
 * below names the input that turns the answer from the container to null (or
 * back), and the helper's own recorded-container parser is pinned beside it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/azure/lakehouse-abfss', () => ({
  resolveLakehouseStorage: vi.fn(),
  listLakehouseRootFacts: vi.fn(),
}));

import { legacyContainerKeyFor, recordedContainerOf } from '../_lib/legacy-container-key';
import { listLakehouseRootFacts, resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';

const LH = 'lh-1';
const WS = 'ws-1';
const bound = (container: string) => ({ ok: true, bound: { abfss: `abfss://${container}@acct.dfs.core.windows.net/r`, container, root: 'r' } });

beforeEach(() => {
  vi.clearAllMocks();
  (resolveLakehouseStorage as any).mockResolvedValue(bound('gold'));
  (listLakehouseRootFacts as any).mockResolvedValue([{ id: LH, adlsContainer: 'gold' }, { id: 'lh-2', adlsContainer: 'silver' }]);
});

describe('legacyContainerKeyFor', () => {
  it('returns the container when no other item records it', async () => {
    expect(await legacyContainerKeyFor(LH, WS)).toBe('gold');
    // The item's own workspace is what resolves the binding.
    expect((resolveLakehouseStorage as any).mock.calls).toEqual([[LH, WS]]);
  });

  it('returns null when another item records the same container', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue([{ id: LH, adlsContainer: 'gold' }, { id: 'lh-2', provContainer: 'gold' }]);
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
  });

  it('returns null when another item records the container only in its abfss root', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue([{ id: 'lh-2', provAdlsRoot: 'abfss://gold@acct.dfs.core.windows.net/x' }]);
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
  });

  it('returns null when another item records no container at all', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue([{ id: 'lh-2' }]);
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
  });

  it('ignores the item itself in the list', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue([{ id: LH }]);
    // Breaks if the item's own row counts as another item.
    expect(await legacyContainerKeyFor(LH, WS)).toBe('gold');
  });

  it('returns null when the item storage does not resolve', async () => {
    (resolveLakehouseStorage as any).mockResolvedValue({ ok: false, reason: 'no-storage' });
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
    (resolveLakehouseStorage as any).mockRejectedValue(new Error('down'));
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
  });

  it('returns null when the lakehouse list cannot be read', async () => {
    (listLakehouseRootFacts as any).mockRejectedValue(new Error('down'));
    expect(await legacyContainerKeyFor(LH, WS)).toBeNull();
  });
});

describe('recordedContainerOf', () => {
  it('reads adlsContainer, then provContainer, then the abfss root', () => {
    expect([
      recordedContainerOf({ adlsContainer: ' gold ', provContainer: 'silver' }),
      recordedContainerOf({ provContainer: 'silver', provAdlsRoot: 'abfss://bronze@a/x' }),
      recordedContainerOf({ provAdlsRoot: 'abfss://bronze@a/x' }),
      recordedContainerOf({ provAdlsRoot: 'https://a/bronze' }),
      recordedContainerOf({}),
    ]).toEqual(['gold', 'silver', 'bronze', '', '']);
  });
});
