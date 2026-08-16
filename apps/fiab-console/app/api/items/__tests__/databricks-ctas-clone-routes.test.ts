/**
 * BFF gate + contract tests for the Save-as-table (CTAS) / clone / SELECT INTO
 * routes:
 *   - POST /api/items/databricks-sql-warehouse/[id]/ctas
 *   - POST /api/items/databricks-sql-warehouse/[id]/clone
 *   - POST /api/items/synapse-dedicated-sql-pool/[id]/clone   (SELECT INTO)
 *
 * Asserts the auth gate (401), config gate (503), input validation (400),
 * lifecycle pre-check (409), and that the happy path delegates to the real
 * data-plane helpers with the right SQL and shapes the result. The clients are
 * stubbed; their own REST/TDS contracts are covered elsewhere.
 *
 * UPDATED for GHSA-v2g8-gp3r-rg4r round 3. `ctas` and the Synapse `clone` now
 * take an AUTHORIZED ITEM rather than an id: their handlers accept `ctx` and run
 * `guardSynapseItemRequest` first. This file therefore supplies a route `ctx`
 * and stubs the workspace ladder + Cosmos so the ADMITTED path is still what is
 * being contract-tested here. The DENIED path is not re-tested in this file —
 * it has its own suite (`app/api/items/[type]/[id]/__tests__/
 * ghsa-shared-backend-dispatchers.test.ts`), which is where the authorization
 * assertions and their mutation receipts live.
 *
 * `databricks-sql-warehouse/[id]/clone` is UNCHANGED by that pass and is still
 * called without a ctx, deliberately: it is one of the routes left on the
 * ledger, and a test that quietly started passing a ctx would read as coverage
 * it does not have.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));

const ITEMS = [
  { id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', state: {} },
  { id: 'dp-1', itemType: 'synapse-dedicated-sql-pool', workspaceId: 'ws-1', state: {} },
];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const t = spec?.parameters?.find((p: any) => p.name === '@t')?.value;
          return { resources: ITEMS.filter((i) => !t || i.itemType === t) };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  executeStatement: vi.fn(),
  getWarehouse: vi.fn(),
  databricksConfigGate: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: vi.fn(),
  dedicatedTarget: vi.fn(() => ({ server: 'ws.sql.azuresynapse.net', database: 'pool', cacheKey: 'k' })),
}));
vi.mock('@/lib/azure/synapse-pool-arm', () => ({ getPoolState: vi.fn() }));

import { POST as ctasPOST } from '../databricks-sql-warehouse/[id]/ctas/route';
import { POST as dbxClonePOST } from '../databricks-sql-warehouse/[id]/clone/route';
import { POST as synClonePOST } from '../synapse-dedicated-sql-pool/[id]/clone/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

function bodyReq(body: any) {
  return { url: 'http://x/', nextUrl: new URL('http://x/'), json: async () => body } as any;
}
const swCtx = { params: Promise.resolve({ id: 'sw-1' }) } as any;
const dpCtx = { params: Promise.resolve({ id: 'dp-1' }) } as any;
const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };

beforeEach(() => {
  vi.resetAllMocks();
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (databricksConfigGate as any).mockReturnValue(null);
  (getWarehouse as any).mockResolvedValue({ state: 'RUNNING' });
  (getPoolState as any).mockResolvedValue({ state: 'Online', sku: 'DW100c' });
});

describe('POST /databricks-sql-warehouse/[id]/ctas', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'c', schema: 's', tableName: 't', sql: 'SELECT 1' }), swCtx);
    expect(res.status).toBe(401);
  });

  it('503 when Databricks not configured', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'c', schema: 's', tableName: 't', sql: 'SELECT 1' }), swCtx);
    expect(res.status).toBe(503);
  });

  it('400 when tableName missing', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'c', schema: 's', sql: 'SELECT 1' }), swCtx);
    expect(res.status).toBe(400);
  });

  it('400 when sql is not a SELECT', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'c', schema: 's', tableName: 't', sql: 'DROP TABLE x' }), swCtx);
    expect(res.status).toBe(400);
  });

  it('409 when warehouse is not RUNNING', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (getWarehouse as any).mockResolvedValue({ state: 'STOPPED' });
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'c', schema: 's', tableName: 't', sql: 'SELECT 1' }), swCtx);
    expect(res.status).toBe(409);
  });

  it('200 emits CREATE TABLE … USING DELTA AS SELECT and returns the FQN', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (executeStatement as any).mockResolvedValue({ columns: [], rows: [], rowCount: 0, executionMs: 42, truncated: false });
    const res = await ctasPOST(bodyReq({ warehouseId: 'w', catalog: 'main', schema: 'dev', tableName: 'orders_t', sql: 'SELECT * FROM main.sales.orders' }), swCtx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.table).toBe('main.dev.orders_t');
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toContain('CREATE TABLE `main`.`dev`.`orders_t` USING DELTA');
    expect(sql).toContain('AS\nSELECT * FROM main.sales.orders');
  });
});

describe('POST /databricks-sql-warehouse/[id]/clone', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await dbxClonePOST(bodyReq({ warehouseId: 'w', source: 'a', target: 'b' }));
    expect(res.status).toBe(401);
  });

  it('400 when source/target missing', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await dbxClonePOST(bodyReq({ warehouseId: 'w', source: 'a' }));
    expect(res.status).toBe(400);
  });

  it('SHALLOW clone emits SHALLOW CLONE and reports zero copied files', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (executeStatement as any).mockResolvedValue({
      columns: ['source_table_size', 'source_num_of_files', 'num_copied_files'],
      rows: [[1024, 7, 0]], rowCount: 1, executionMs: 30, truncated: false,
    });
    const res = await dbxClonePOST(bodyReq({ warehouseId: 'w', source: 'main.s.o', target: 'main.d.o', cloneType: 'SHALLOW' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.cloneType).toBe('SHALLOW');
    expect(j.numCopiedFiles).toBe(0);
    expect(j.sourceNumFiles).toBe(7);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toBe('CREATE TABLE IF NOT EXISTS main.d.o SHALLOW CLONE main.s.o');
  });

  it('DEEP clone with replace emits CREATE OR REPLACE … DEEP CLONE and reports copied files', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (executeStatement as any).mockResolvedValue({
      columns: ['source_num_of_files', 'num_copied_files'],
      rows: [[7, 7]], rowCount: 1, executionMs: 99, truncated: false,
    });
    const res = await dbxClonePOST(bodyReq({ warehouseId: 'w', source: 'main.s.o', target: 'main.d.o', cloneType: 'DEEP', replace: true }));
    const j = await res.json();
    expect(j.cloneType).toBe('DEEP');
    expect(j.numCopiedFiles).toBe(7);
    const sql = (executeStatement as any).mock.calls[0][1] as string;
    expect(sql).toBe('CREATE OR REPLACE TABLE main.d.o DEEP CLONE main.s.o');
  });
});

describe('POST /synapse-dedicated-sql-pool/[id]/clone (SELECT INTO)', () => {
  it('401 without session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await synClonePOST(bodyReq({ sourceTable: 'a', targetTable: 'b' }), dpCtx);
    expect(res.status).toBe(401);
  });

  it('400 when target table missing', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const res = await synClonePOST(bodyReq({ sourceTable: 'a' }), dpCtx);
    expect(res.status).toBe(400);
  });

  it('409 when pool is not Online', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (getPoolState as any).mockResolvedValue({ state: 'Paused', sku: 'DW100c' });
    const res = await synClonePOST(bodyReq({ sourceTable: 'a', targetTable: 'b' }), dpCtx);
    expect(res.status).toBe(409);
  });

  it('200 emits SELECT * INTO … FROM … and returns the honest zero-copy note', async () => {
    (getSession as any).mockReturnValue(SESSION);
    (executeQuery as any).mockResolvedValue({
      columns: [], rows: [], rowCount: 0, executionMs: 55, truncated: false, messages: [], recordsAffected: 1234,
    });
    const res = await synClonePOST(bodyReq({ sourceSchema: 'dbo', sourceTable: 'orders', targetSchema: 'stage', targetTable: 'orders_copy' }), dpCtx);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.target).toBe('stage.orders_copy');
    expect(j.recordsAffected).toBe(1234);
    expect(j.note).toMatch(/no zero-copy clone/i);
    const sql = (executeQuery as any).mock.calls[0][1] as string;
    expect(sql).toContain('SELECT *');
    expect(sql).toContain('INTO   [stage].[orders_copy]');
    expect(sql).toContain('FROM   [dbo].[orders]');
  });
});
