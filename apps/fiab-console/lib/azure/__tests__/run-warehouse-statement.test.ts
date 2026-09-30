/**
 * #4776 (A-3) — the SEAM: `runWarehouseStatement` with no explicit warehouse id
 * delegates to the resolver's `withResolvedWarehouse`, which invalidates a
 * cached id whose warehouse is gone and retries once. The retry logic itself is
 * pinned in databricks-sql-warehouse.test.ts; this file pins that the ONE
 * production caller the review named actually reaches it (a mutation inside
 * the resolver proves nothing about the call site).
 *
 * Breaks if runWarehouseStatement goes back to `resolveWarehouseIdOrThrow()` +
 * a single executeStatement: this mock exports no such function, so the call
 * throws, and `withResolvedWarehouse` is called 0 times.
 */
import { describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({ withResolved: vi.fn() }));
vi.mock('@/lib/azure/databricks-sql-warehouse', () => ({
  withResolvedWarehouse: (fn: (id: string) => Promise<unknown>) => m.withResolved(fn),
}));

import { runWarehouseStatement } from '../databricks-client';

describe('runWarehouseStatement → withResolvedWarehouse (seam)', () => {
  it('with no explicit id, the statement runs through the self-healing resolver wrapper', async () => {
    const result = { columns: ['one'], rows: [[1]], rowCount: 1, executionMs: 1, truncated: false };
    m.withResolved.mockResolvedValue(result);
    const out = await runWarehouseStatement('SELECT 1');
    expect(m.withResolved).toHaveBeenCalledTimes(1);
    // The wrapper is handed the statement runner (a function of the warehouse id).
    expect(typeof m.withResolved.mock.calls[0][0]).toBe('function');
    expect(out).toBe(result);
  });
});
