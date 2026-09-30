/**
 * Contract tests for /api/lakehouse/schemas (GET/POST/DELETE/PATCH).
 *
 * Item scope: every verb names the lakehouse item. GET needs read access;
 * POST, DELETE and PATCH need edit rights.
 *
 * Spark namespace: every database the route creates, drops or moves between is
 * derived from the authorized item id (`sparkDatabaseFor`). The expected names
 * below are computed by that same exported function rather than transcribed,
 * and the "no bare identifier" assertions read every SQL string the route ran:
 * a statement naming `hr`, `finance` or `dbo` directly breaks them.
 *
 * The registry mock is stateful (a Map keyed like the Cosmos ids), so a POST
 * followed by a DELETE or PATCH exercises what the route itself wrote.
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
vi.mock('../_lib/legacy-container-key', () => ({ legacyContainerKeyFor: vi.fn() }));

import { GET, POST, DELETE, PATCH } from '../schemas/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { runSparkSqlAndWait } from '@/lib/azure/synapse-dev-client';
import {
  listSchemas, createSchemaDoc, getSchemaDoc, updateSchemaStatus, deleteSchemaDoc,
} from '@/lib/azure/lakehouse-schemas';
import { legacyContainerKeyFor } from '../_lib/legacy-container-key';
import { itemSparkPrefix, sparkDatabaseFor } from '../_lib/spark-namespace';

const LH = 'lh-a';
const OTHER = 'lh-b';
const LEGACY = 'bronze';
const sess = { claims: { oid: 'o1', upn: 'u@x' } };
const getReq = (qs: string) => ({ nextUrl: new URL(`http://x/api/lakehouse/schemas?${qs}`) } as any);
const delReq = getReq;
const bodyReq = (body: any) => ({ nextUrl: new URL('http://x/api/lakehouse/schemas'), json: async () => body } as any);

let canWrite = true;
let registry: Map<string, any>;

const dboRow = (lh: string) => ({ id: `${lh}::dbo`, lakehouseId: lh, name: 'dbo', isDefault: true, status: 'active' });
function seed(lh: string, name: string, extra: Record<string, unknown> = {}) {
  registry.set(`${lh}::${name}`, { id: `${lh}::${name}`, lakehouseId: lh, name, isDefault: false, status: 'active', ...extra });
}
/** A row the route itself would write for this item. */
const seedOwn = (name: string) => seed(LH, name, { sparkDatabase: sparkDatabaseFor(LH, name) });

let savedWs: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  canWrite = true;
  registry = new Map();
  savedWs = process.env.LOOM_SYNAPSE_WORKSPACE;
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-ws';
  (getSession as any).mockReturnValue(sess);
  // The caller reaches lh-a only; lh-b answers as unreachable.
  (resolveItemAccessByOid as any).mockImplementation(async (_s: any, id: string) =>
    id === LH
      ? { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite }
      : null,
  );
  (listSchemas as any).mockImplementation(async (lh: string) => [
    dboRow(lh),
    ...[...registry.values()].filter((r) => r.lakehouseId === lh),
  ]);
  (getSchemaDoc as any).mockImplementation(async (lh: string, name: string) =>
    name === 'dbo' ? dboRow(lh) : registry.get(`${lh}::${name}`) ?? null,
  );
  (createSchemaDoc as any).mockImplementation(async (d: any) => {
    seed(d.lakehouseId, d.name, d.sparkDatabase ? { sparkDatabase: d.sparkDatabase } : {});
    return registry.get(`${d.lakehouseId}::${d.name}`);
  });
  (updateSchemaStatus as any).mockResolvedValue(null);
  (deleteSchemaDoc as any).mockImplementation(async (lh: string, name: string) => {
    registry.delete(`${lh}::${name}`);
    return { ok: true };
  });
  (legacyContainerKeyFor as any).mockResolvedValue(null);
  (runSparkSqlAndWait as any).mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.LOOM_SYNAPSE_WORKSPACE;
  else process.env.LOOM_SYNAPSE_WORKSPACE = savedWs;
});

const sparkSql = (): string[] => (runSparkSqlAndWait as any).mock.calls.map((c: any[]) => c[1]);
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Every backtick identifier in a statement. */
const idents = (sql: string) => [...sql.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
/** Database identifiers (every identifier except a trailing `.table`) that are not in this item's namespace. */
function foreignDatabases(sqls: string[]): string[] {
  const out: string[] = [];
  for (const sql of sqls) {
    const dbs = sql.startsWith('ALTER TABLE') ? idents(sql).filter((_, i) => i % 2 === 0) : idents(sql);
    for (const db of dbs) if (!db.startsWith(itemSparkPrefix(LH))) out.push(db);
  }
  return out;
}

describe('the item namespace', () => {
  it('is derived from the item id and differs between items (breaks if the prefix ignores the id)', () => {
    expect(sparkDatabaseFor(LH, 'hr')).toMatch(/^lh_[0-9a-f]{12}_hr$/);
    expect(sparkDatabaseFor(LH, 'hr')).not.toBe(sparkDatabaseFor(OTHER, 'hr'));
    // Spark database names are case-insensitive: 'HR' and 'hr' share one.
    expect(sparkDatabaseFor(LH, 'HR')).toBe(sparkDatabaseFor(LH, 'hr'));
  });
});

describe('GET /api/lakehouse/schemas', () => {
  it('lists the schemas of an item the caller can read (read-only role is enough)', async () => {
    canWrite = false;
    seedOwn('sales');
    const res = await GET(getReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.schemas.map((s: any) => s.name)).toEqual(['dbo', 'sales']);
    expect(j.schemas[0].sparkDatabase).toBe(sparkDatabaseFor(LH, 'dbo'));
  });

  it('adds rows from the earlier container key only when that key is attributed to this item', async () => {
    seedOwn('sales');
    seed(LEGACY, 'old_mart');
    seed(LEGACY, 'sales'); // same name as an item row: the item row wins
    let j = await (await GET(getReq(`lakehouseId=${LH}`))).json();
    expect(j.schemas.map((s: any) => s.name)).toEqual(['dbo', 'sales']);

    (legacyContainerKeyFor as any).mockResolvedValue(LEGACY);
    j = await (await GET(getReq(`lakehouseId=${LH}`))).json();
    expect(j.schemas.map((s: any) => [s.name, !!s.legacy])).toEqual([['dbo', false], ['sales', false], ['old_mart', true]]);
  });

  it('requires access to the lakehouse item (404 with code and remediation; registry not read)', async () => {
    const res = await GET(getReq(`lakehouseId=${OTHER}`));
    const j = await res.json();
    expect(res.status).toBe(404);
    expect(j.code).toBe('item_not_found');
    expect(typeof j.remediation).toBe('string');
    expect(listSchemas).not.toHaveBeenCalled();
  });
});

describe('POST /api/lakehouse/schemas', () => {
  it('registers the schema with its item database and creates only that database (positive arm)', async () => {
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'finance' }));
    expect(res.status).toBe(200);
    await flush();
    const db = sparkDatabaseFor(LH, 'finance');
    expect((createSchemaDoc as any).mock.calls[0][0]).toMatchObject({ lakehouseId: LH, name: 'finance', sparkDatabase: db });
    // Breaks on `CREATE SCHEMA IF NOT EXISTS \`finance\``.
    expect(sparkSql()).toEqual([`CREATE SCHEMA IF NOT EXISTS \`${db}\``]);
  });

  it('refuses dbo in any letter case (it maps to the default database)', async () => {
    for (const name of ['dbo', 'DBO']) {
      const res = await POST(bodyReq({ lakehouseId: LH, name }));
      const j = await res.json();
      expect([res.status, j.code]).toEqual([400, 'reserved_schema']);
      expect(typeof j.remediation).toBe('string');
    }
    expect(createSchemaDoc).not.toHaveBeenCalled();
  });

  it('refuses a name that differs from an existing schema only in case (409; nothing registered)', async () => {
    seedOwn('Sales');
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'sales' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([409, 'schema_exists']);
    expect(createSchemaDoc).not.toHaveBeenCalled();
    // Positive arm: the same exact name upserts (retry after an error).
    const again = await POST(bodyReq({ lakehouseId: LH, name: 'Sales' }));
    expect(again.status).toBe(200);
  });

  it('refuses a name longer than the item namespace allows (113 chars) and accepts 112', async () => {
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'a'.repeat(113) }));
    expect([(res.status), (await res.json()).code]).toEqual([400, 'bad_name']);
    const ok = await POST(bodyReq({ lakehouseId: LH, name: 'a'.repeat(112) }));
    expect(ok.status).toBe(200);
  });

  it('requires edit rights (403 read_only with remediation; nothing registered or run)', async () => {
    canWrite = false;
    const res = await POST(bodyReq({ lakehouseId: LH, name: 'finance' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([403, 'read_only']);
    expect(typeof j.remediation).toBe('string');
    await flush();
    expect(createSchemaDoc).not.toHaveBeenCalled();
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing registered)', async () => {
    const res = await POST(bodyReq({ lakehouseId: OTHER, name: 'finance' }));
    expect(res.status).toBe(404);
    expect(createSchemaDoc).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/lakehouse/schemas', () => {
  it('POST hr then DELETE hr touches only the item database, never `hr` itself', async () => {
    expect((await POST(bodyReq({ lakehouseId: LH, name: 'hr' }))).status).toBe(200);
    await flush();
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=hr`));
    const j = await res.json();
    expect(res.status).toBe(200);
    const db = sparkDatabaseFor(LH, 'hr');
    // Breaks on `DROP SCHEMA IF EXISTS \`hr\` CASCADE`.
    expect(sparkSql()).toEqual([`CREATE SCHEMA IF NOT EXISTS \`${db}\``, `DROP SCHEMA IF EXISTS \`${db}\` CASCADE`]);
    expect(foreignDatabases(sparkSql())).toEqual([]);
    expect(j.data).toEqual({ name: 'hr', sparkSchemaKept: false, sparkDatabase: db });
    expect(registry.has(`${LH}::hr`)).toBe(false);
  });

  it('removes a row without an item database and drops nothing (sparkSchemaKept, note)', async () => {
    seed(LH, 'sales'); // no sparkDatabase
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(sparkSql()).toEqual([]);
    expect(j.data.sparkSchemaKept).toBe(true);
    expect(typeof j.note).toBe('string');
    expect((deleteSchemaDoc as any).mock.calls).toEqual([[LH, 'sales']]);
  });

  it('removes a row recorded with a database name other than its own and drops nothing', async () => {
    seed(LH, 'sales', { sparkDatabase: 'sales' });
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    expect(res.status).toBe(200);
    // Breaks if the route trusted the row's recorded name: a DROP of `sales` appears.
    expect(sparkSql()).toEqual([]);
  });

  it('deletes a row found under the attributed earlier key, dropping nothing', async () => {
    seed(LEGACY, 'old_mart');
    let res = await DELETE(delReq(`lakehouseId=${LH}&name=old_mart`));
    expect(res.status).toBe(404);
    (legacyContainerKeyFor as any).mockResolvedValue(LEGACY);
    res = await DELETE(delReq(`lakehouseId=${LH}&name=old_mart`));
    expect(res.status).toBe(200);
    expect((deleteSchemaDoc as any).mock.calls).toEqual([[LEGACY, 'old_mart']]);
    expect(sparkSql()).toEqual([]);
  });

  it('requires edit rights (403 for a read-only role; nothing dropped or deleted)', async () => {
    seedOwn('sales');
    canWrite = false;
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=sales`));
    expect(res.status).toBe(403);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
    expect(deleteSchemaDoc).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing dropped or deleted)', async () => {
    seed(OTHER, 'sales', { sparkDatabase: sparkDatabaseFor(OTHER, 'sales') });
    const res = await DELETE(delReq(`lakehouseId=${OTHER}&name=sales`));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
    expect(deleteSchemaDoc).not.toHaveBeenCalled();
  });

  it('404 unknown_schema for a name this item does not register; nothing run', async () => {
    const res = await DELETE(delReq(`lakehouseId=${LH}&name=notmine`));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([404, 'unknown_schema']);
    expect(sparkSql()).toEqual([]);
  });
});

describe('PATCH /api/lakehouse/schemas (move table)', () => {
  it('moves between two of this item\'s schemas using the item databases, even when another item registers the same name', async () => {
    seed(OTHER, 'finance');
    expect((await POST(bodyReq({ lakehouseId: LH, name: 'finance' }))).status).toBe(200);
    expect((await POST(bodyReq({ lakehouseId: LH, name: 'mine' }))).status).toBe(200);
    await flush();
    (runSparkSqlAndWait as any).mockClear();
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'finance', toSchema: 'mine' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    const from = sparkDatabaseFor(LH, 'finance');
    const to = sparkDatabaseFor(LH, 'mine');
    // Breaks on `ALTER TABLE \`finance\`.\`orders\` RENAME TO \`mine\`.\`orders\``.
    expect(sparkSql()).toEqual([`ALTER TABLE \`${from}\`.\`orders\` RENAME TO \`${to}\`.\`orders\``]);
    expect(foreignDatabases(sparkSql())).toEqual([]);
    expect(j.data.sparkTable).toBe(`${to}.orders`);
  });

  it('refuses dbo as the source or the target (400 reserved_schema; nothing run)', async () => {
    seedOwn('mine');
    for (const [fromSchema, toSchema] of [['dbo', 'mine'], ['mine', 'dbo'], ['DBO', 'mine']]) {
      const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema, toSchema }));
      const j = await res.json();
      expect([res.status, j.code]).toEqual([400, 'reserved_schema']);
      expect(typeof j.remediation).toBe('string');
    }
    // An omitted source defaults to dbo and is refused the same way.
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', toSchema: 'mine' }));
    expect(res.status).toBe(400);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('refuses a schema row without an item database (409 legacy_schema; nothing run)', async () => {
    seedOwn('mine');
    seed(LH, 'finance');
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'finance', toSchema: 'mine' }));
    const j = await res.json();
    expect([res.status, j.code]).toEqual([409, 'legacy_schema']);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('404 when the target schema is not registered on this item; nothing run', async () => {
    seedOwn('finance');
    seed(OTHER, 'notmine', { sparkDatabase: sparkDatabaseFor(OTHER, 'notmine') });
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'finance', toSchema: 'notmine' }));
    expect([res.status, (await res.json()).code]).toEqual([404, 'unknown_schema']);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('404 when the source schema is not registered on this item; nothing run', async () => {
    seedOwn('mine');
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'notmine', toSchema: 'mine' }));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing run)', async () => {
    seed(OTHER, 'finance', { sparkDatabase: sparkDatabaseFor(OTHER, 'finance') });
    seed(OTHER, 'mine', { sparkDatabase: sparkDatabaseFor(OTHER, 'mine') });
    const res = await PATCH(bodyReq({ lakehouseId: OTHER, tableName: 'orders', fromSchema: 'finance', toSchema: 'mine' }));
    expect(res.status).toBe(404);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });

  it('requires edit rights (403 for a read-only role; nothing run)', async () => {
    seedOwn('finance');
    seedOwn('mine');
    canWrite = false;
    const res = await PATCH(bodyReq({ lakehouseId: LH, tableName: 'orders', fromSchema: 'finance', toSchema: 'mine' }));
    expect(res.status).toBe(403);
    expect(runSparkSqlAndWait).not.toHaveBeenCalled();
  });
});
