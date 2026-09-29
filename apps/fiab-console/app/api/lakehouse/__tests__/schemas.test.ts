/**
 * Contract tests for /api/lakehouse/schemas (GET/POST/DELETE/PATCH).
 *
 * Item scope: every verb names the lakehouse item. GET needs read access;
 * POST, DELETE and PATCH need edit rights. The Spark metastore is shared by
 * every lakehouse, so DELETE runs `DROP SCHEMA` only when no other item
 * registers the same name, and PATCH moves a table only between schemas this
 * item registers.
 *
 * Refusals read the CALL ROW SET of `runSparkSqlAndWait` and the registry
 * writes, and each is paired with a positive arm on the same fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({ runSparkSqlAndWait: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-schemas', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-schemas');
  return {
    SCHEMA_NAME_RE: actual.SCHEMA_NAME_RE,
    DEFAULT_SCHEMA: actual.DEFAULT_SCHEMA,
    listSchemas: vi.fn(),
    createSchemaDoc: vi.fn(),
    getSchemaDoc: vi.fn(),
    updateSchemaStatus: vi.fn(),
    deleteSchemaDoc: vi.fn(),
  };
});
vi.mock('../_lib/schema-owners', () => ({ otherSchemaOwners: vi.fn() }));

import { GET, POST, DELETE, PATCH } from '../schemas/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { runSparkSqlAndWait } from '@/lib/azure/synapse-dev-client';
import {
  listSchemas, createSchemaDoc, getSchemaDoc, updateSchemaStatus, deleteSchemaDoc,
} from '@/lib/azure/lakehouse-schemas';
import { otherSchemaOwners } from '../_lib/schema-owners';

const LH = 'lh-sc';
const sess = { claims: { oid: 'o1', upn: 'u@x' } };
const getReq = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/schemas?${qs}`) } as any);
const delReq = getReq;
const bodyReq = (body: any) => ({ nextUrl: new URL('http://x/api/lakehouse/schemas'), json: async () => body } as any);

function access(canWrite = true) {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}
const row = (name: string) => ({ id: `${LH}::${name}`, lakehouseId: LH, name, status: 'active' });

let savedWs: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  savedWs = process.env.LOOM_SYNAPSE_WORKSPACE;
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  (getSession as any).mockReturnValue(sess);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (listSchemas as any).mockResolvedValue([row('dbo'), row('sales')]);
  (createSchemaDoc as any).mockImplementation(async (d: any) => row(d.name));
  (getSchemaDoc as any).mockImplementation(async (_lh: string, name: string) => (name === 'dbo' || name === 'sales' ? row(name) : null));
  (updateSchemaStatus as any).mockResolvedValue(null);
  (deleteSchemaDoc as any).mockResolvedValue({ ok: true });
  (otherSchemaOwners as any).mockResolvedValue([]);
  (runSparkSqlAndWait as any).mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.LOOM_SYNAPSE_WORKSPACE;
  else process.env.LOOM_SYNAPSE_WORKSPACE = savedWs;
});

const sparkSql = () => (runSparkSqlAndWait as any).mock.calls.map((c: any[]) => c[1]);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('GET /api/lakehouse/schemas', () => {
  it('lists the schemas of an item the caller can read (read-only role is enough)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await GET(getReq(`lakehouseId=${LH}`));
    expect(res.status).toBe(200);
    expect((listSchemas as any).mock.calls).toEqual([[LH]]);
  });

  it('requires access to the lakehouse item (404; registry not read)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await GET(getReq(`lakehouseId=${LH}`));
    expect(res.status).toBe(404);
    expect(listSchemas).not.toHaveBeenCalled();
  });
});

describe('POST /api/lakehouse/schemas', () => {
  it('registers the schema and runs a quoted CREATE SCHEMA (positive arm)', async () => {
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'finance' }));
    expect(res.status).toBe(200);
    await flush();
    expect((createSchemaDoc as any).mock.calls[0][0]).toMatchObject({ lakehouseId: LH, name: 'finance' });
    expect(sparkSql()).toEqual(['CREATE SCHEMA IF NOT EXISTS `finance`']);
  });

  it('requires edit rights (403 for a read-only role; nothing registered or run)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'finance' }));
    expect(res.status).toBe(403);
    await flush();
    expect(createSchemaDoc).not.toHaveBeenCalled();
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing registered)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'finance' }));
    expect(res.status).toBe(404);
    expect(createSchemaDoc).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/lakehouse/schemas', () => {
  it('drops the Spark schema when no other item registers the name (positive arm)', async () => {
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.data).toEqual({ name: 'sales', sparkSchemaKept: false });
    expect(sparkSql()).toEqual(['DROP SCHEMA IF EXISTS `sales` CASCADE']);
    expect((otherSchemaOwners as any).mock.calls).toEqual([[LH, 'sales']]);
    expect((deleteSchemaDoc as any).mock.calls).toEqual([[LH, 'sales']]);
  });

  it('keeps the Spark schema when another item registers the same name; removes only this row', async () => {
    (otherSchemaOwners as any).mockResolvedValue(['lh-other']);
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    const j = await res.json();
    expect(res.status).toBe(200);
    // Breaks if the owner check is skipped (a DROP row appears).
    expect(sparkSql()).toEqual([]);
    expect(j.data.sparkSchemaKept).toBe(true);
    expect((deleteSchemaDoc as any).mock.calls).toEqual([[LH, 'sales']]);
  });

  it('requires edit rights (403 for a read-only role; nothing dropped or deleted)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    expect(res.status).toBe(403);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
    expect(deleteSchemaDoc).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing dropped or deleted)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
    expect(deleteSchemaDoc).not.toHaveBeenCalled();
  });

  it('runs no DROP for a name this item does not register', async () => {
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=notmine`));
    expect(res.status).toBe(200);
    expect(sparkSql()).toEqual([]);
  });
});

describe('PATCH /api/lakehouse/schemas (move table)', () => {
  it('moves a table between two schemas this item registers, with quoted identifiers (positive arm)', async () => {
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'dbo', toSchema: 'sales' }));
    expect(res.status).toBe(200);
    expect(sparkSql()).toEqual(['ALTER TABLE `dbo`.`orders` RENAME TO `sales`.`orders`']);
  });

  it('404 when the target schema is not registered on this item; nothing run', async () => {
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'dbo', toSchema: 'notmine' }));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('404 when the source schema is not registered on this item; nothing run', async () => {
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'notmine', toSchema: 'sales' }));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('requires edit rights (403 for a read-only role; nothing run)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'dbo', toSchema: 'sales' }));
    expect(res.status).toBe(403);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });
});
