/**
 * PR #4776 — the DQ routes map a classified SQL-warehouse resolution failure
 * to its own status + body (403 permission / 503 network), never a generic 500.
 *
 * The REAL `data-quality-client` and `dq-monitor-client` run the Delta /
 * Databricks paths: only `resolveWarehouseIdOrThrow` is replaced, so the
 * WarehouseResolutionError travels the production path
 * (runDqRules -> resolveWarehouseIdOrThrow; dropDeltaConstraint -> warehouse()).
 *
 * What breaks these tests: deleting the `instanceof WarehouseResolutionError`
 * branch from dq/run's catch or from dq/monitors' `failed()` helper (both
 * fall to `apiServerError` -> 500 with no `entitlement`), or reverting the GET
 * constraints `.catch` to `{ error: message }` (drops `kind` + `entitlement`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolve: vi.fn(),
  executeStatement: vi.fn(),
  rulesRead: vi.fn(),
  appendDqRun: vi.fn(),
  getMonitor: vi.fn(),
  listRefreshes: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => m.getSession() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: async () => ({ item: () => ({ read: () => m.rulesRead() }) }),
}));
vi.mock('@/lib/azure/dq-run-store', () => ({
  appendDqRun: (...a: unknown[]) => m.appendDqRun(...a),
}));
vi.mock('@/lib/azure/databricks-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/databricks-client');
  return {
    ...actual,
    databricksConfigGate: () =>
      process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' },
    executeStatement: (...a: unknown[]) => m.executeStatement(...a),
  };
});
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-sql-warehouse')>(
    '@/lib/azure/databricks-sql-warehouse',
  );
  return { ...actual, resolveWarehouseIdOrThrow: (...a: unknown[]) => m.resolve(...a) };
});
// Only the Lakehouse-Monitoring REST half of the monitor client is replaced;
// the Delta-constraint functions (the warehouse path) stay real.
vi.mock('@/lib/azure/dq-monitor-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/azure/dq-monitor-client');
  return {
    ...actual,
    getMonitor: (...a: unknown[]) => m.getMonitor(...a),
    listRefreshes: (...a: unknown[]) => m.listRefreshes(...a),
  };
});

import { WarehouseResolutionError } from '@/lib/azure/databricks-sql-warehouse';
import { POST as runPOST } from '../run/route';
import { GET as monitorsGET, POST as monitorsPOST } from '../monitors/route';

function permissionError() {
  return new WarehouseResolutionError({
    kind: 'permission', step: 'list',
    message: 'The Console identity is not allowed to list SQL warehouses (HTTP 403).',
    remediation: 'A workspace admin grants the databricks-sql-access entitlement.',
    entitlement: 'databricks-sql-access',
  });
}
function networkError() {
  return new WarehouseResolutionError({
    kind: 'network', step: 'list',
    message: 'The Console could not reach the Databricks workspace.',
    remediation: 'Check the private endpoint.',
  });
}

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv('LOOM_DATABRICKS_HOSTNAME', 'adb-1.azuredatabricks.net');
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockReturnValue({ claims: { oid: 'oid-1', upn: 'u@x' } });
  m.rulesRead.mockResolvedValue({ resource: { items: [] } });
  m.getMonitor.mockResolvedValue(null);
  m.listRefreshes.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('DQ routes — classified warehouse failure is NOT a generic 500', () => {
  it('dq/run (databricks): permission -> 403 with kind + entitlement; nothing persisted', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await runPOST(post('/api/dq/run', { backend: 'databricks' }));
    const j = await res.json();
    // A 500 here = the WRE branch is gone from the dq/run catch.
    expect(res.status).toBe(403);
    expect(j.kind).toBe('permission');
    expect(j.code).toBe('warehouse_permission');
    expect(j.entitlement).toBe('databricks-sql-access');
    expect(m.resolve).toHaveBeenCalledTimes(1);
    expect(m.appendDqRun).not.toHaveBeenCalled();
  });

  it('dq/run (databricks): network -> 503, no entitlement', async () => {
    m.resolve.mockRejectedValue(networkError());
    const res = await runPOST(post('/api/dq/run', { backend: 'databricks' }));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.kind).toBe('network');
    expect(j.entitlement).toBeUndefined();
  });

  it('dq/monitors POST drop-constraint: permission -> 403 with the entitlement', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await monitorsPOST(post('/api/dq/monitors', { action: 'drop-constraint', table: 'cat.sch.t', name: 'c1' }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.kind).toBe('permission');
    expect(j.entitlement).toBe('databricks-sql-access');
    expect(m.executeStatement).not.toHaveBeenCalled();
  });

  it('dq/monitors GET: constraints half carries kind + entitlement, monitor half still answers', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await monitorsGET(new NextRequest('http://localhost/api/dq/monitors?table=cat.sch.t'));
    const j = await res.json();
    expect(res.status).toBe(200);
    // Reverting the `.catch` to `{ error: message }` leaves kind/entitlement undefined.
    expect(j.constraints.kind).toBe('permission');
    expect(j.constraints.entitlement).toBe('databricks-sql-access');
    expect(j.constraints.error).toMatch(/not allowed to list/);
    expect(m.getMonitor).toHaveBeenCalledWith('cat.sch.t');
  });

  it('no session -> 401 on run + monitors, before the warehouse is resolved', async () => {
    // The routes moved onto withSession (route-toolkit boy-scout rule). Breaks
    // if the prologue is lost: the handler would reach the resolver.
    m.getSession.mockReturnValue(null);
    expect((await runPOST(post('/api/dq/run', { backend: 'databricks' }))).status).toBe(401);
    expect((await monitorsPOST(post('/api/dq/monitors', { action: 'drop-constraint', table: 't', name: 'c1' }))).status).toBe(401);
    expect((await monitorsGET(new NextRequest('http://localhost/api/dq/monitors?table=t'))).status).toBe(401);
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it('control: a NON-warehouse failure on drop-constraint is still a 500', async () => {
    // Pins that the mapping is keyed on the error CLASS: a plain SQL error from
    // the statement keeps the generic 500.
    m.resolve.mockResolvedValue('wh-1');
    m.executeStatement.mockRejectedValue(new Error('DELTA_CONSTRAINT_DOES_NOT_EXIST'));
    const res = await monitorsPOST(post('/api/dq/monitors', { action: 'drop-constraint', table: 'cat.sch.t', name: 'c1' }));
    expect(res.status).toBe(500);
    expect(m.executeStatement).toHaveBeenCalledTimes(1);
  });
});
