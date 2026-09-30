/**
 * Contract tests for /api/lakehouse/interop (GET/PUT) and
 * POST /api/lakehouse/maintenance.
 *
 * Item scope: both name the lakehouse item. Reads need read access, while the
 * interop flip and maintenance need edit rights. The container, root and account
 * come from the item binding, so the Spark statement targets
 * `<root>/Tables/<table>`. The interop catalog step changes an entry only when
 * it is absent or already points under this item's table.
 *
 * Refusals read the CALL ROW SET of `createLivySessionAsync` and of the catalog
 * register/drop, each paired with a positive arm.
 *
 * Namespace and earlier state: the default namespace is the item's own
 * `lh_<12 hex>`, a namespace recorded for the table is reused, and the rows of
 * the container-keyed doc are listed only when the container is attributed to
 * this item alone (`listLakehouseRootFacts` decides that here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));
vi.mock('@/lib/azure/lakehouse-abfss', async () => {
  const actual: any = await vi.importActual('@/lib/azure/lakehouse-abfss');
  const resolveLakehouseAbfss = vi.fn();
  return {
    lakehouseStorageWithheldMessage: actual.lakehouseStorageWithheldMessage,
    listLakehouseRootFacts: vi.fn(async () => []),
    resolveLakehouseAbfss,
    resolveLakehouseStorage: async (...a: any[]) => {
      const b: any = await resolveLakehouseAbfss(...a);
      if (b && typeof b === 'object' && 'withheld' in b) return { ok: false, reason: b.withheld };
      return b ? { ok: true, bound: b } : { ok: false, reason: 'no-storage' };
    },
  };
});
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'fallbackacct') }));
vi.mock('@/lib/azure/synapse-dev-client', () => ({
  createLivySessionAsync: vi.fn(),
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
}));
vi.mock('@/lib/azure/synapse-livy-client', () => ({ defaultSparkPool: () => 'loompool' }));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: () => {} }));

const interopRead = vi.fn();
const interopUpsert = vi.fn();
const jobsUpsert = vi.fn();
vi.mock('@/lib/azure/cosmos-client', () => ({
  lakehouseInteropContainer: async () => ({ item: (id: string) => ({ read: () => interopRead(id) }), items: { upsert: interopUpsert } }),
  maintenanceJobsContainer: async () => ({ items: { upsert: jobsUpsert, query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  auditLogContainer: async () => ({ items: { create: async (d: any) => ({ resource: d }) } }),
}));
vi.mock('@/lib/azure/iceberg-catalog-client', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    icebergCatalogConfigGate: vi.fn(() => null),
    loadTable: vi.fn(),
    registerTable: vi.fn(),
    dropTableRegistration: vi.fn(),
    logIcebergAccess: vi.fn(async () => {}),
  };
});

import { GET as INTEROP_GET, PUT as INTEROP_PUT } from '../interop/route';
import { POST as MAINT_POST } from '../maintenance/route';
import { getSession } from '@/lib/auth/session';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { listLakehouseRootFacts, resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { itemNamespaceBase } from '../_lib/interop-namespace';
import { createLivySessionAsync } from '@/lib/azure/synapse-dev-client';
import {
  IcebergCatalogError, loadTable, registerTable, dropTableRegistration,
} from '@/lib/azure/iceberg-catalog-client';

const LH = 'lh-io';
const CONTAINER = 'gold';
const ROOT = 'lakehouses/Sales--lh-io';
const HOST = 'loomacct.dfs.core.windows.net';
const TABLE_ROOT = `abfss://${CONTAINER}@${HOST}/${ROOT}/Tables/orders`;

const getReq = (qs: string) => ({
  nextUrl: new URL(`https://loom.test/api/lakehouse/interop?${qs}`),
  headers: new Headers({ host: 'loom.test' }),
  url: `https://loom.test/api/lakehouse/interop?${qs}`,
} as any);
const bodyReq = (body: any) => ({
  json: async () => body,
  headers: new Headers({ host: 'loom.test' }),
  url: 'https://loom.test/api/lakehouse/x',
  nextUrl: new URL('https://loom.test/api/lakehouse/x'),
} as any);
function access(canWrite = true) {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}
const notFound = () => new IcebergCatalogError('not found', 404);

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'o1', upn: 'u@x', tid: 't1' } });
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: `abfss://${CONTAINER}@${HOST}/${ROOT}`, container: CONTAINER, root: ROOT });
  (createLivySessionAsync as any).mockResolvedValue({ id: 5, state: 'starting' });
  interopRead.mockRejectedValue({ code: 404 });
  interopUpsert.mockResolvedValue({});
  jobsUpsert.mockResolvedValue({});
  (loadTable as any).mockRejectedValue(notFound());
  (registerTable as any).mockResolvedValue({});
  (dropTableRegistration as any).mockResolvedValue({});
  (listLakehouseRootFacts as any).mockResolvedValue([]);
});

/** Serve `docs[id]` from the interop container, 404 for anything else. */
function docs(byId: Record<string, unknown>) {
  interopRead.mockImplementation(async (id: string) => {
    if (id in byId) return { resource: byId[id] };
    throw { code: 404 };
  });
}
const row = (table: string, namespace: string, extra: Record<string, unknown> = {}) => ({
  table, namespace, delta: true, iceberg: true, via: 'delta-uniform', updatedAt: 't', updatedBy: 'u', ...extra,
});
const ITEM_DOC = `interop:item:${LH}`;
const LEGACY_DOC = `interop:${CONTAINER}`;
/** Another lakehouse item recording the same container. */
const SHARED = [{ id: 'lh-other', adlsContainer: CONTAINER }];

describe('GET /api/lakehouse/interop', () => {
  it('reads the item doc and reports the binding account (read access is enough)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.container).toBe(CONTAINER);
    expect(j.account).toBe('loomacct');
    // Breaks if the state doc goes back to a per-container key. The container
    // doc is read second because no other item records this container.
    expect(interopRead.mock.calls).toEqual([[ITEM_DOC], [LEGACY_DOC]]);
    // Breaks if the default namespace goes back to the container name.
    expect(j.defaultNamespace).toBe(itemNamespaceBase(LH));
    expect(j.defaultNamespace).toMatch(/^lh_[0-9a-f]{12}$/);
  });

  it('lists earlier container rows, marked legacy, after the item rows', async () => {
    docs({
      [ITEM_DOC]: { tables: [row('orders', 'lh_x')] },
      [LEGACY_DOC]: { tables: [row('orders', CONTAINER), row('customers', CONTAINER)] },
    });
    const j = await (await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any)).json();
    // Breaks if the earlier doc is not read (customers missing), if its row
    // shadows the item row for orders, or if the marker is dropped.
    expect(j.tables.map((t: any) => [t.table, t.namespace, !!t.legacy])).toEqual([
      ['orders', 'lh_x', false],
      ['customers', CONTAINER, true],
    ]);
  });

  it('does not read the container doc when another item records the same container', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue(SHARED);
    docs({ [ITEM_DOC]: { tables: [] }, [LEGACY_DOC]: { tables: [row('customers', CONTAINER)] } });
    const j = await (await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any)).json();
    expect(interopRead.mock.calls).toEqual([[ITEM_DOC]]);
    expect(j.tables).toEqual([]);
  });

  it('requires lakehouseId (400 bad_request)', async () => {
    const res = await INTEROP_GET(getReq(`container=${CONTAINER}`), {} as any);
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(interopRead).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404 item_not_found)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any);
    const j = await res.json();
    expect([res.status, j.code]).toEqual([404, 'item_not_found']);
    expect(interopRead).not.toHaveBeenCalled();
  });
});

describe('PUT /api/lakehouse/interop', () => {
  const flip = (iceberg: boolean, extra: Record<string, unknown> = {}) =>
    INTEROP_PUT(bodyReq({ lakehouseId: LH, tableName: 'orders', iceberg, ...extra }), {} as any);

  it('runs the metadata job on the table under the item root (positive arm)', async () => {
    const res = await flip(true);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.tableRootUri).toBe(TABLE_ROOT);
    expect(j.code).toContain(TABLE_ROOT);
    expect((createLivySessionAsync as any).mock.calls.length).toBe(1);
    expect(jobsUpsert.mock.calls[0][0]).toMatchObject({ lakehouseId: LH, container: CONTAINER });
  });

  it('requires edit rights (403 read_only; no Spark session, nothing saved)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await flip(true);
    const j = await res.json();
    expect([res.status, j.code]).toEqual([403, 'read_only']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
    expect(interopUpsert).not.toHaveBeenCalled();
    expect(registerTable).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await flip(false);
    expect(res.status).toBe(404);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('registers when no catalog entry exists', async () => {
    await flip(true);
    expect((registerTable as any).mock.calls.length).toBe(1);
  });

  it('leaves a catalog entry that points at another table unchanged (enable)', async () => {
    (loadTable as any).mockResolvedValue({ 'metadata-location': `abfss://${CONTAINER}@${HOST}/lakehouses/Other--lh-x/Tables/orders/metadata/v1.json` });
    const res = await flip(true);
    const j = await res.json();
    expect(registerTable).not.toHaveBeenCalled();
    expect(j.catalogNote).toMatch(/different table/);
  });

  it('leaves a catalog entry that points at another table unchanged (disable)', async () => {
    (loadTable as any).mockResolvedValue({ 'metadata-location': `abfss://${CONTAINER}@${HOST}/lakehouses/Other--lh-x/Tables/orders/metadata/v1.json` });
    await flip(false);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('treats a sibling root sharing the prefix as another table', async () => {
    (loadTable as any).mockResolvedValue({ 'metadata-location': `abfss://${CONTAINER}@${HOST}/${ROOT}-archive/Tables/orders/metadata/v1.json` });
    await flip(false);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('treats a sibling table whose name extends this one as another table', async () => {
    // `orders_old` starts with `orders`: breaks a prefix test without the '/' boundary.
    (loadTable as any).mockResolvedValue({ 'metadata-location': `${TABLE_ROOT}_old/metadata/v1.json` });
    await flip(false);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('de-registers an entry that points under this item table (positive arm)', async () => {
    (loadTable as any).mockResolvedValue({ 'metadata-location': `${TABLE_ROOT}/metadata/v3.json` });
    await flip(false);
    expect((dropTableRegistration as any).mock.calls.length).toBe(1);
  });

  it('does not de-register when there is no entry', async () => {
    await flip(false);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('treats an entry whose path differs only in letter case as another table (ADLS paths are case-sensitive)', async () => {
    const upper = `abfss://${CONTAINER}@${HOST}/${ROOT.toUpperCase()}/TABLES/ORDERS`;
    // The fixture really differs in case, and only in case.
    expect(upper).not.toBe(TABLE_ROOT);
    expect(upper.toLowerCase()).toBe(TABLE_ROOT.toLowerCase());
    // Breaks if the path part is compared case-insensitively (the entry would be de-registered).
    (loadTable as any).mockResolvedValue({ 'metadata-location': `${upper}/metadata/v3.json` });
    await flip(false);
    expect(dropTableRegistration).not.toHaveBeenCalled();
  });

  it('matches the account host case-insensitively (positive arm for the case rule)', async () => {
    const hostUpper = `abfss://${CONTAINER}@${HOST.toUpperCase()}/${ROOT}/Tables/orders`;
    expect(hostUpper).not.toBe(TABLE_ROOT);
    // Breaks if the whole URI is compared case-sensitively (host case would make it another table).
    (loadTable as any).mockResolvedValue({ 'metadata-location': `${hostUpper}/metadata/v3.json` });
    await flip(false);
    expect((dropTableRegistration as any).mock.calls.length).toBe(1);
  });
});

describe('PUT /api/lakehouse/interop — namespace', () => {
  const flip = (iceberg: boolean, extra: Record<string, unknown> = {}) =>
    INTEROP_PUT(bodyReq({ lakehouseId: LH, tableName: 'orders', iceberg, ...extra }), {} as any);

  it('registers under the item namespace by default, not the container name', async () => {
    const res = await flip(true);
    const j = await res.json();
    const ns = itemNamespaceBase(LH);
    expect(ns).toMatch(/^lh_[0-9a-f]{12}$/);
    // Breaks if the default goes back to the container ('gold').
    expect(j.namespace).toBe(ns);
    expect((registerTable as any).mock.calls.map((c: any[]) => [c[0], c[1]])).toEqual([[ns, 'orders']]);
  });

  it('adds the table sub-folders to the item namespace', async () => {
    const res = await flip(true, { tableName: 'sales/orders' });
    expect((await res.json()).namespace).toBe(`${itemNamespaceBase(LH)}.sales`);
  });

  it('reuses the namespace recorded in the earlier container state', async () => {
    docs({ [LEGACY_DOC]: { tables: [row('orders', CONTAINER)] } });
    const res = await flip(false);
    const j = await res.json();
    // Breaks if the recorded name is ignored: the existing entry would not be found.
    expect(j.namespace).toBe(CONTAINER);
  });

  it('does not reuse the container state when another item records that container', async () => {
    (listLakehouseRootFacts as any).mockResolvedValue(SHARED);
    docs({ [LEGACY_DOC]: { tables: [row('orders', CONTAINER)] } });
    const j = await (await flip(true)).json();
    expect(j.namespace).toBe(itemNamespaceBase(LH));
  });

  it('a requested namespace wins over the recorded one', async () => {
    docs({ [ITEM_DOC]: { tables: [row('orders', 'lh_x')] } });
    const j = await (await flip(true, { namespace: 'sales.curated' })).json();
    expect(j.namespace).toBe('sales.curated');
  });

  it('refuses a malformed namespace (400 bad_request; no Spark session)', async () => {
    const res = await flip(true, { namespace: 'bad name/..' });
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('refuses a malformed table path with a code (400 bad_request)', async () => {
    const res = await flip(true, { tableName: '../x' });
    const j = await res.json();
    expect([res.status, j.code]).toEqual([400, 'bad_request']);
  });

  it('a taken catalog name returns catalog_name_taken and offers the item namespace', async () => {
    docs({ [LEGACY_DOC]: { tables: [row('orders', CONTAINER)] } });
    (loadTable as any).mockResolvedValue({ 'metadata-location': `abfss://${CONTAINER}@${HOST}/lakehouses/Other--lh-x/Tables/orders/metadata/v1.json` });
    const j = await (await flip(true)).json();
    expect(registerTable).not.toHaveBeenCalled();
    expect(j.catalogCode).toBe('catalog_name_taken');
    // Breaks if no alternative is offered for a name the item does not own.
    expect(j.suggestedNamespace).toBe(itemNamespaceBase(LH));
    expect(j.catalogRemediation).toContain(itemNamespaceBase(LH));
  });

  it('offers no alternative when the name tried is already the item namespace', async () => {
    (loadTable as any).mockResolvedValue({ 'metadata-location': `abfss://${CONTAINER}@${HOST}/lakehouses/Other--lh-x/Tables/orders/metadata/v1.json` });
    const j = await (await flip(true)).json();
    expect(j.catalogCode).toBe('catalog_name_taken');
    expect(j.suggestedNamespace).toBeUndefined();
    expect(j.catalogRemediation).toMatch(/different namespace/);
  });

  it('does not overwrite the item doc when it could not be read', async () => {
    interopRead.mockImplementation(async (id: string) => {
      if (id === ITEM_DOC) throw { code: 503, message: 'unavailable' };
      throw { code: 404 };
    });
    const j = await (await flip(true)).json();
    expect(j.persistError).toBeTruthy();
    // Breaks if the item doc is saved (from the persist step or the catalog step)
    // after a failed read: it would hold this one table only.
    expect(interopUpsert).not.toHaveBeenCalled();
    // Positive arm: the catalog step itself still ran.
    expect((registerTable as any).mock.calls.length).toBe(1);
  });

  it('saves the item doc when it was read (positive arm for the above)', async () => {
    await flip(true);
    expect(interopUpsert.mock.calls.map((c: any[]) => c[0].id)).toEqual([ITEM_DOC, ITEM_DOC]);
  });
});

describe('POST /api/lakehouse/maintenance', () => {
  const run = (extra: Record<string, unknown> = {}) =>
    MAINT_POST(bodyReq({ lakehouseId: LH, tableName: 'orders', pool: 'loompool', compaction: true, vacuumRetentionHours: 168, ...extra }), {} as any);

  it('runs on the table under the item root, in the item container (positive arm)', async () => {
    const res = await run({ container: 'bronze' });
    expect(res.status).toBe(200);
    const doc = jobsUpsert.mock.calls[0][0];
    // Breaks if the body container ('bronze') or the container top level is used.
    expect(doc.container).toBe(CONTAINER);
    expect(doc.lakehouseId).toBe(LH);
    expect(doc.code).toContain(TABLE_ROOT);
    expect(doc.account).toBe('loomacct');
  });

  it('requires lakehouseId (400; no Spark session)', async () => {
    const res = await MAINT_POST(bodyReq({ container: CONTAINER, tableName: 'orders', pool: 'loompool', compaction: true }), {} as any);
    const j = await res.json();
    expect([res.status, j.code, typeof j.remediation]).toEqual([400, 'bad_request', 'string']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires edit rights (403 read_only; no Spark session)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await run();
    expect([res.status, (await res.json()).code]).toEqual([403, 'read_only']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
    expect(jobsUpsert).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404 item_not_found)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await run();
    expect([res.status, (await res.json()).code]).toEqual([404, 'item_not_found']);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });
});
