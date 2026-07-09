/**
 * BFF tests for the DBX-11 table-format (Iceberg / UniForm) DDL create path on
 * the UC tables route (mode:'ddl'). Auth, config gate, warehouse requirement,
 * format validation, and happy-path delegation to createUcTableWithFormat.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(),
  listUcTables: vi.fn(),
  listUcVolumes: vi.fn(),
  listUcFunctions: vi.fn(),
  getUcTable: vi.fn(),
  createUcTable: vi.fn(),
  createUcTableFromFile: vi.fn(),
  deleteUcTable: vi.fn(),
  patchUcTable: vi.fn(),
}));
vi.mock('@/lib/azure/unity-catalog-client', () => ({
  createUcTableWithFormat: vi.fn(),
}));

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { createUcTableWithFormat } from '@/lib/azure/unity-catalog-client';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1' }, exp: 9_999_999_999 };
function postReq(body: any) { return { json: async () => body } as any; }
const COLS = [{ name: 'id', type_name: 'BIGINT', nullable: false }];

beforeEach(() => {
  vi.resetAllMocks();
  (databricksConfigGate as any).mockReturnValue(null);
});

it('401 without session', async () => {
  (getSession as any).mockReturnValue(null);
  const res = await POST(postReq({ mode: 'ddl', name: 't', catalog_name: 'c', schema_name: 's', table_format: 'ICEBERG', warehouse_id: 'w', columns: COLS }));
  expect(res.status).toBe(401);
});

it('503 when Databricks not configured', async () => {
  (getSession as any).mockReturnValue(SESSION);
  (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
  const res = await POST(postReq({ mode: 'ddl', name: 't', catalog_name: 'c', schema_name: 's', table_format: 'ICEBERG', warehouse_id: 'w', columns: COLS }));
  expect(res.status).toBe(503);
});

it('400 when warehouse_id is missing (DDL needs a warehouse)', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ mode: 'ddl', name: 't', catalog_name: 'c', schema_name: 's', table_format: 'DELTA_UNIFORM', columns: COLS }));
  const j = await res.json();
  expect(res.status).toBe(400);
  expect(j.error).toMatch(/warehouse/i);
});

it('400 on an unknown table_format', async () => {
  (getSession as any).mockReturnValue(SESSION);
  const res = await POST(postReq({ mode: 'ddl', name: 't', catalog_name: 'c', schema_name: 's', table_format: 'PARQUET', warehouse_id: 'w', columns: COLS }));
  expect(res.status).toBe(400);
});

it('creates a UniForm table via the DDL client on the happy path', async () => {
  (getSession as any).mockReturnValue(SESSION);
  (createUcTableWithFormat as any).mockResolvedValue({ sql: 'CREATE TABLE …', executionMs: 20 });
  const res = await POST(postReq({
    mode: 'ddl', name: 'orders', catalog_name: 'main', schema_name: 'sales',
    table_format: 'DELTA_UNIFORM', deletion_vectors: true, warehouse_id: 'wh-1', columns: COLS,
  }));
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.sql).toContain('CREATE TABLE');
  expect(createUcTableWithFormat).toHaveBeenCalledWith('wh-1', expect.objectContaining({
    catalog: 'main', schema: 'sales', name: 'orders', format: 'DELTA_UNIFORM', deletionVectors: true,
  }), false);
});
