/**
 * PR #4776 — the MDM routes map a classified SQL-warehouse resolution failure
 * to its own status + body (403 permission / 503 network), never a generic 500.
 *
 * The REAL `lib/azure/mdm-match-merge` runs: only `resolveWarehouseIdOrThrow`
 * is replaced, so the WarehouseResolutionError travels the same path it does in
 * production (runMatch / runMerge / listGoldenRecords -> warehouse() -> throw).
 *
 * What breaks these tests: deleting the `instanceof WarehouseResolutionError`
 * branch from any of the three route catches. match + merge then fall to
 * `apiServerError` (500, no `entitlement`), and golden-records falls to the
 * 500 carrying the "Run a merge first" hint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolve: vi.fn(),
  executeStatement: vi.fn(),
  getModel: vi.fn(),
  appendMdmRun: vi.fn(),
  listCrosswalk: vi.fn(),
  listMdmRuns: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: () => m.getSession() }));
vi.mock('@/lib/azure/mdm-store', () => ({
  getModel: (...a: unknown[]) => m.getModel(...a),
  appendMdmRun: (...a: unknown[]) => m.appendMdmRun(...a),
  listCrosswalk: (...a: unknown[]) => m.listCrosswalk(...a),
  listMdmRuns: (...a: unknown[]) => m.listMdmRuns(...a),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: () =>
    process.env.LOOM_DATABRICKS_HOSTNAME ? null : { missing: 'LOOM_DATABRICKS_HOSTNAME' },
  executeStatement: (...a: unknown[]) => m.executeStatement(...a),
}));
vi.mock('@/lib/azure/databricks-sql-warehouse', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-sql-warehouse')>(
    '@/lib/azure/databricks-sql-warehouse',
  );
  return { ...actual, resolveWarehouseIdOrThrow: (...a: unknown[]) => m.resolve(...a) };
});

import { WarehouseResolutionError } from '@/lib/azure/databricks-sql-warehouse';
import { POST as matchPOST } from '../match/route';
import { POST as mergePOST } from '../merge/route';
import { GET as goldenGET } from '../golden-records/route';

const MODEL = {
  id: 'm1', name: 'Customers', entity: 'customer', sourceTable: 'customers',
  recordIdColumn: 'id', sourceSystemColumn: 'src', timestampColumn: 'updated_at',
  matchAttributes: [{ column: 'email', matchType: 'exact' }],
  survivorship: [{ column: 'email', strategy: 'most-recent' }],
  goldenTable: 'customers_golden',
};

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
  m.getModel.mockResolvedValue(MODEL);
  m.listCrosswalk.mockResolvedValue([]);
  m.appendMdmRun.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('MDM routes — classified warehouse failure is NOT a generic 500', () => {
  it('match: permission -> 403 with kind + entitlement; no SQL executed', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await matchPOST(post('/api/mdm/match', { modelId: 'm1' }));
    const j = await res.json();
    // A 500 here = the WRE branch is gone from the match catch.
    expect(res.status).toBe(403);
    expect(j.ok).toBe(false);
    expect(j.kind).toBe('permission');
    expect(j.code).toBe('warehouse_permission');
    expect(j.entitlement).toBe('databricks-sql-access');
    expect(m.executeStatement).not.toHaveBeenCalled();
    expect(m.resolve).toHaveBeenCalledTimes(1);
  });

  it('merge: network -> 503 with kind network and NO entitlement', async () => {
    m.resolve.mockRejectedValue(networkError());
    const res = await mergePOST(post('/api/mdm/merge', { modelId: 'm1' }));
    const j = await res.json();
    expect(res.status).toBe(503);
    expect(j.kind).toBe('network');
    expect(j.code).toBe('warehouse_network');
    expect(j.entitlement).toBeUndefined();
    expect(j.remediation).toMatch(/private endpoint/);
    expect(m.appendMdmRun).not.toHaveBeenCalled();
  });

  it('merge: permission -> 403 with the entitlement', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await mergePOST(post('/api/mdm/merge', { modelId: 'm1' }));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.entitlement).toBe('databricks-sql-access');
  });

  it('golden-records: permission -> 403 and NOT the "Run a merge first" hint', async () => {
    m.resolve.mockRejectedValue(permissionError());
    const res = await goldenGET(new NextRequest('http://localhost/api/mdm/golden-records?modelId=m1'));
    const j = await res.json();
    expect(res.status).toBe(403);
    expect(j.kind).toBe('permission');
    expect(j.entitlement).toBe('databricks-sql-access');
    // Paired with the positive assertions above: without the WRE branch the
    // body is the 500 { error, hint } shape and `hint` is present.
    expect(j.hint).toBeUndefined();
  });

  it('no session -> 401 on all three, before the warehouse is resolved', async () => {
    // The routes moved onto withSession (route-toolkit boy-scout rule). Breaks
    // if the prologue is lost: the handler would reach the resolver.
    m.getSession.mockReturnValue(null);
    expect((await matchPOST(post('/api/mdm/match', { modelId: 'm1' }))).status).toBe(401);
    expect((await mergePOST(post('/api/mdm/merge', { modelId: 'm1' }))).status).toBe(401);
    expect((await goldenGET(new NextRequest('http://localhost/api/mdm/golden-records?modelId=m1'))).status).toBe(401);
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.getModel).not.toHaveBeenCalled();
  });

  it('control: a NON-warehouse failure still reaches the existing 500 paths', async () => {
    // Pins that the mapping is keyed on the error CLASS, not applied to
    // everything: a plain Error from the SQL statement keeps its 500s.
    m.resolve.mockResolvedValue('wh-1');
    m.executeStatement.mockRejectedValue(new Error('TABLE_OR_VIEW_NOT_FOUND'));
    const match = await matchPOST(post('/api/mdm/match', { modelId: 'm1' }));
    expect(match.status).toBe(500);
    const golden = await goldenGET(new NextRequest('http://localhost/api/mdm/golden-records?modelId=m1'));
    expect(golden.status).toBe(500);
    const gj = await golden.json();
    expect(gj.hint).toMatch(/Run a merge first/);
    expect(m.executeStatement).toHaveBeenCalled();
  });
});
