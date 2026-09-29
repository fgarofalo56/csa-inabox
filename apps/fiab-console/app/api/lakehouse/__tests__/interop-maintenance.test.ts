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
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
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
});

describe('GET /api/lakehouse/interop', () => {
  it('reads the item doc and reports the binding account (read access is enough)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.container).toBe(CONTAINER);
    expect(j.account).toBe('loomacct');
    // Breaks if the state doc goes back to a per-container key.
    expect(interopRead.mock.calls).toEqual([[`interop:item:${LH}`]]);
  });

  it('requires lakehouseId (400)', async () => {
    const res = await INTEROP_GET(getReq(`container=${CONTAINER}`), {} as any);
    expect(res.status).toBe(400);
    expect(interopRead).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await INTEROP_GET(getReq(`lakehouseId=${LH}`), {} as any);
    expect(res.status).toBe(404);
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

  it('requires edit rights (403 for a read-only role; no Spark session, nothing saved)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await flip(true);
    expect(res.status).toBe(403);
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
    expect(res.status).toBe(400);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });

  it('requires edit rights (403 for a read-only role; no Spark session)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const res = await run();
    expect(res.status).toBe(403);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
    expect(jobsUpsert).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const res = await run();
    expect(res.status).toBe(404);
    expect(createLivySessionAsync).not.toHaveBeenCalled();
  });
});
