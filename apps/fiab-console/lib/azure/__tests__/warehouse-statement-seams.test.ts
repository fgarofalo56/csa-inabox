/**
 * #4776 (round 4, A-3) — SEAMS: the navigator's Databricks introspection and the
 * report connection executor run their statements through the resolver's
 * self-healing `withResolvedWarehouse`, so a warehouse deleted out-of-band is
 * invalidated and re-resolved once instead of failing for up to 5 minutes.
 *
 * The retry logic itself is pinned in databricks-sql-warehouse.test.ts; these
 * pin the CALL SITES (a mutation inside the resolver proves nothing about them).
 * The wrapper spy hands the statement 'wh-healed' — an id DIFFERENT from what
 * the up-front `resolveWarehouseIdOrThrow` returns ('wh-first') — so a site
 * that goes back to `executeStatement(<id resolved once>, …)` sends 'wh-first'
 * and these go RED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  executeStatement: vi.fn(),
  withResolved: vi.fn(),
  loadConnection: vi.fn(),
}));

vi.mock('@/lib/azure/databricks-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/databricks-client');
  return { ...actual, databricksConfigGate: () => null, executeStatement: (...a: unknown[]) => m.executeStatement(...a) };
});
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/databricks-sql-warehouse');
  return {
    ...actual,
    resolveWarehouseIdOrThrow: async () => 'wh-first',
    withResolvedWarehouse: (fn: (id: string) => Promise<unknown>) => m.withResolved(fn),
  };
});
vi.mock('@/lib/azure/connections-store', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/connections-store');
  return { ...actual, loadConnection: (...a: unknown[]) => m.loadConnection(...a) };
});

import { introspectDatabricks } from '@/lib/report/navigator/introspect';
import { buildConnectionExecutor } from '@/lib/azure/report-model-resolver';

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.withResolved.mockImplementation(async (fn: (id: string) => Promise<unknown>) => fn('wh-healed'));
});

describe('statement sites route through withResolvedWarehouse (#4776)', () => {
  it('navigator introspection: SHOW CATALOGS runs on the wrapper-supplied id', async () => {
    m.executeStatement.mockResolvedValue({ columns: ['catalog'], rows: [['main']] });
    const out = await introspectDatabricks({ id: 'c1', type: 'databricks-sql', database: '' } as any, 'catalog', undefined, undefined);
    expect(m.withResolved).toHaveBeenCalledTimes(1);
    expect(m.executeStatement.mock.calls.map((c) => c[0])).toEqual(['wh-healed']);
    // Positive half: the real result still flows back as navigator nodes.
    expect(out).toEqual([{ name: 'main', kind: 'catalog', hasChildren: true, selectable: false }]);
  });

  it('report connection executor: the databricks-sql runner uses the wrapper-supplied id', async () => {
    m.loadConnection.mockResolvedValue({ id: 'c1', type: 'databricks-sql', database: 'cat.sch', auth: { kind: 'entra-mi' } });
    m.executeStatement.mockResolvedValue({ columns: ['COLUMN_NAME', 'DATA_TYPE'], rows: [['id', 'int']] });
    const res = await buildConnectionExecutor(
      { kind: 'connection', connectionId: 'c1', connType: 'databricks-sql', objectRef: { mode: 'table', schema: 'sch', table: 't' } } as any,
      'tenant-1',
    );
    expect(res.backend).toBe('connection');
    await (res as any).executor.introspectFields();
    expect(m.withResolved).toHaveBeenCalled();
    const ids = m.executeStatement.mock.calls.map((c) => c[0]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(['wh-healed']));
  });
});
