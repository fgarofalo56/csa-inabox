/**
 * Backend contract tests for /api/lakehouse/settings (GET/PUT), including the
 * "Expose as Iceberg" and liquid-clustering statements.
 *
 * Parity target: Fabric OneLake "Iceberg V2 endpoint" (Delta ↔ Iceberg
 * virtualization). Azure-native, NO Fabric dependency: the endpoint is produced
 * by Delta Lake UniForm via a real ALTER TABLE … SET TBLPROPERTIES run on a
 * Databricks SQL Warehouse. The table abfss:// path + Iceberg metadata-folder
 * URLs are always computed.
 *
 * Item scope: every call names the lakehouse item. The container, root and
 * storage host come from the item's binding, so every statement targets
 * `<root>/Tables/...` of THAT item; a PUT needs edit rights. Table, schema and
 * column names are checked against LAKEHOUSE_IDENT_RE and quoted.
 *
 * Refusals read the CALL ROW SET of `executeStatement` / Cosmos `upsert`, and
 * each is paired with a positive arm on the same fixture.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const upsert = vi.fn();
const itemRead = vi.fn();
const itemFn = vi.fn((id: string, _pk: string) => ({ read: () => itemRead(id) }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: vi.fn(async () => ({
    item: itemFn,
    items: { upsert },
  })),
}));

const databricksConfigGate = vi.fn();
const listWarehouses = vi.fn();
const executeStatement = vi.fn();
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: (...a: any[]) => databricksConfigGate(...a),
  listWarehouses: (...a: any[]) => listWarehouses(...a),
  executeStatement: (...a: any[]) => executeStatement(...a),
}));
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
vi.mock('@/lib/auth/item-access', () => ({ resolveItemAccessByOid: vi.fn() }));

import { GET, PUT } from '../settings/route';
import { LAKEHOUSE_IDENT_RE } from '../_lib/identifiers';
import { getSession } from '@/lib/auth/session';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';

const sess = { claims: { oid: 'tenant-1', upn: 'u@x' } };
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/settings?${qs}`) } as any; }
function putReq(body: any) { return { json: async () => body } as any; }

const LH = 'lh-s';
const CONTAINER = 'gold';
const ROOT = 'lakehouses/Sales--lh-s';
const HOST = 'loomacct.dfs.core.windows.net';
const ITEM_ABFSS = `abfss://${CONTAINER}@${HOST}/${ROOT}`;
const tableAbfss = (rel: string) => `${ITEM_ABFSS}/Tables/${rel}`;

function access(canWrite = true) {
  return { item: { id: LH, workspaceId: 'ws-1', itemType: 'lakehouse' }, role: canWrite ? 'Member' : 'Viewer', via: 'workspace', canWrite };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  (resolveItemAccessByOid as any).mockResolvedValue(access(true));
  (resolveLakehouseAbfss as any).mockResolvedValue({ abfss: ITEM_ABFSS, container: CONTAINER, root: ROOT });
  // upsert echoes the doc back as the persisted resource
  upsert.mockImplementation(async (doc: any) => ({ resource: doc }));
  itemRead.mockRejectedValue({ code: 404 });
  databricksConfigGate.mockReturnValue(null);
  listWarehouses.mockResolvedValue([{ id: 'wh-1', state: 'RUNNING' }]);
  executeStatement.mockResolvedValue({ rows: [] });
});

describe('PUT /api/lakehouse/settings — Expose as Iceberg', () => {
  it('runs the real UniForm ALTER TABLE on the table under the item root and returns the iceberg endpoint', async () => {
    const res = await PUT(putReq({
      lakehouseId: LH,
      icebergExpose: { enabled: true, tableName: 'bronze_player_profile' },
    }));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.icebergApplied).toBe(true);
    // Exact statement: breaks if the table leaves <root>/Tables/, or the path
    // stops being quoted as a Databricks identifier.
    expect(j.icebergSql).toBe(
      `ALTER TABLE delta.\`${tableAbfss('bronze_player_profile')}\` SET TBLPROPERTIES(`
      + `'delta.enableIcebergCompatV2' = 'true', 'delta.universalFormat.enabledFormats' = 'iceberg')`,
    );
    expect(executeStatement.mock.calls).toEqual([['wh-1', j.icebergSql]]);
    expect(j.icebergEndpoint).toEqual({
      abfss: tableAbfss('bronze_player_profile'),
      httpsTablePath: `https://${HOST}/${CONTAINER}/${ROOT}/Tables/bronze_player_profile`,
      httpsMetadataFolder: `https://${HOST}/${CONTAINER}/${ROOT}/Tables/bronze_player_profile/metadata`,
      azureMetadataFolder: `azure://${HOST}/${CONTAINER}/${ROOT}/Tables/bronze_player_profile/metadata`,
      format: 'iceberg-v2',
      via: 'delta-uniform',
    });
    // One doc per item, holding the item's own container.
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: `lakehouse-item-${LH}`,
      lakehouseId: LH,
      container: CONTAINER,
      icebergExpose: { enabled: true, tableName: 'bronze_player_profile', schemaName: undefined },
    }));
  });

  it('ignores a container in the body: the statement targets the item binding', async () => {
    const res = await PUT(putReq({
      lakehouseId: LH,
      container: 'bronze',
      icebergExpose: { enabled: true, tableName: 'orders' },
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    // Breaks if the route builds the path from body.container ('bronze').
    expect(j.icebergEndpoint.abfss).toBe(tableAbfss('orders'));
    expect(upsert.mock.calls[0][0].container).toBe(CONTAINER);
  });

  it('takes the storage host from the item binding (sovereign suffix kept)', async () => {
    const govHost = 'loomgov.dfs.core.usgovcloudapi.net';
    (resolveLakehouseAbfss as any).mockResolvedValue({
      abfss: `abfss://${CONTAINER}@${govHost}/${ROOT}`, container: CONTAINER, root: ROOT,
    });
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'orders' } }));
    const j = await res.json();
    // Breaks if the host is hard-coded to the Commercial suffix.
    expect(j.icebergEndpoint.httpsMetadataFolder).toBe(`https://${govHost}/${CONTAINER}/${ROOT}/Tables/orders/metadata`);
  });

  it('honestly gates when Databricks is not configured, still persists + shows path', async () => {
    databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'sales' } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergGate).toContain('LOOM_DATABRICKS_HOSTNAME');
    expect(executeStatement).not.toHaveBeenCalled();
    expect(j.icebergEndpoint.abfss).toBe(tableAbfss('sales'));
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('honors schema-enabled path placement under Tables/<schema>/', async () => {
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'orders', schemaName: 'dbo' } }));
    const j = await res.json();
    expect(j.icebergEndpoint.abfss).toBe(tableAbfss('dbo/orders'));
    expect(j.icebergSql).toContain(`\`${tableAbfss('dbo/orders')}\``);
  });

  it('accepts a table name sent as Tables/<name>', async () => {
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: '/Tables/orders' } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.icebergEndpoint.abfss).toBe(tableAbfss('orders'));
  });

  it('runs UNSET when disabling iceberg expose', async () => {
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: false, tableName: 'orders' } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.icebergSql).toBe(
      `ALTER TABLE delta.\`${tableAbfss('orders')}\` UNSET TBLPROPERTIES IF EXISTS ('delta.universalFormat.enabledFormats')`,
    );
    expect(executeStatement.mock.calls).toEqual([['wh-1', j.icebergSql]]);
  });

  it('does nothing iceberg-related when no icebergExpose is provided', async () => {
    const res = await PUT(putReq({ lakehouseId: LH }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergEndpoint).toBeUndefined();
    expect(executeStatement).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/lakehouse/settings — liquid clustering', () => {
  it('quotes each clustering column and targets the table under the item root', async () => {
    const res = await PUT(putReq({
      lakehouseId: LH,
      liquidClustering: { tableName: 'events', columns: ['player_id', ' filing_ts '] },
    }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.clusteringApplied).toBe(true);
    expect(j.clusteringSql).toBe(
      `ALTER TABLE delta.\`${tableAbfss('events')}\` CLUSTER BY (\`player_id\`, \`filing_ts\`)`,
    );
    expect(executeStatement.mock.calls).toEqual([['wh-1', j.clusteringSql]]);
  });
});

describe('/api/lakehouse/settings — item scope', () => {
  it('PUT requires lakehouseId (400; nothing saved or run)', async () => {
    const res = await PUT(putReq({ container: CONTAINER, icebergExpose: { enabled: true, tableName: 'orders' } }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
    expect(resolveItemAccessByOid).not.toHaveBeenCalled();
  });

  it('GET requires lakehouseId (400; nothing read)', async () => {
    const res = await GET(getReq(`container=${CONTAINER}`));
    expect(res.status).toBe(400);
    expect(itemFn).not.toHaveBeenCalled();
  });

  it('requires access to the lakehouse item (404; nothing saved or run)', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(null);
    const put = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'orders' } }));
    const get = await GET(getReq(`lakehouseId=${LH}`));
    expect(put.status).toBe(404);
    expect(get.status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
    expect(itemFn).not.toHaveBeenCalled();
  });

  it('PUT requires edit rights (403 for a read-only role); GET still reads', async () => {
    (resolveItemAccessByOid as any).mockResolvedValue(access(false));
    const put = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'orders' } }));
    expect(put.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
    // Positive arm: the same read-only role can read the settings.
    const get = await GET(getReq(`lakehouseId=${LH}`));
    expect(get.status).toBe(200);
  });

  it('409 when the item has no storage binding; nothing saved', async () => {
    (resolveLakehouseAbfss as any).mockResolvedValue(null);
    const res = await PUT(putReq({ lakehouseId: LH }));
    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('/api/lakehouse/settings — identifier validation', () => {
  const badNames = ['orders`', 'a/../b', 'orders; DROP TABLE x', 'Tables/dbo/orders', '9lives', 'or ders', ''.padEnd(129, 'a')];

  it('the bad-name fixtures really fail the rule, and the good ones pass it', () => {
    // Lifted from the source, so a fixture cannot disagree with the rule.
    for (const n of badNames) expect(LAKEHOUSE_IDENT_RE.test(n.replace(/^Tables\//i, ''))).toBe(false);
    for (const n of ['orders', '_t1', 'dbo', 'player_id', ''.padEnd(128, 'a')]) expect(LAKEHOUSE_IDENT_RE.test(n)).toBe(true);
  });

  it.each(badNames)('400 for icebergExpose.tableName %j; nothing saved or run', async (name) => {
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: name } }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it.each(['dbo`', 'a/b', 'x;y'])('400 for icebergExpose.schemaName %j', async (schemaName) => {
    const res = await PUT(putReq({ lakehouseId: LH, icebergExpose: { enabled: true, tableName: 'orders', schemaName } }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each(badNames)('400 for liquidClustering.tableName %j', async (name) => {
    const res = await PUT(putReq({ lakehouseId: LH, liquidClustering: { tableName: name, columns: ['a'] } }));
    expect(res.status).toBe(400);
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it.each(['a`', 'a) DROP', 'a.b', '1a'])('400 for a clustering column %j', async (col) => {
    const res = await PUT(putReq({ lakehouseId: LH, liquidClustering: { tableName: 'events', columns: ['ok_col', col] } }));
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(executeStatement).not.toHaveBeenCalled();
  });
});

describe('GET /api/lakehouse/settings — Iceberg endpoint surfaced on load', () => {
  it('computes the iceberg endpoint from the item doc', async () => {
    itemRead.mockImplementation(async (id: string) => {
      if (id === `lakehouse-item-${LH}`) {
        return { resource: { id, tenantId: 'tenant-1', container: CONTAINER, icebergExpose: { enabled: true, tableName: 'sales' } } };
      }
      throw { code: 404 };
    });
    const res = await GET(getReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergEndpoint.httpsMetadataFolder).toBe(`https://${HOST}/${CONTAINER}/${ROOT}/Tables/sales/metadata`);
  });

  it('falls back to the earlier per-container doc, and prefers the item doc when both exist', async () => {
    const legacy = { id: `lakehouse-${CONTAINER}`, tenantId: 'tenant-1', container: CONTAINER, displayName: 'legacy' };
    itemRead.mockImplementation(async (id: string) => {
      if (id === `lakehouse-${CONTAINER}`) return { resource: legacy };
      throw { code: 404 };
    });
    const fromLegacy = await (await GET(getReq(`lakehouseId=${LH}`))).json();
    expect(fromLegacy.settings.displayName).toBe('legacy');
    expect(fromLegacy.settings.id).toBe(`lakehouse-item-${LH}`);

    itemRead.mockImplementation(async (id: string) => {
      if (id === `lakehouse-item-${LH}`) return { resource: { id, tenantId: 'tenant-1', container: CONTAINER, displayName: 'item' } };
      if (id === `lakehouse-${CONTAINER}`) return { resource: legacy };
      throw { code: 404 };
    });
    const fromItem = await (await GET(getReq(`lakehouseId=${LH}`))).json();
    // Breaks if the read order is swapped.
    expect(fromItem.settings.displayName).toBe('item');
  });

  it('returns no icebergEndpoint when the persisted table name is not a valid identifier', async () => {
    itemRead.mockImplementation(async (id: string) => {
      if (id === `lakehouse-item-${LH}`) return { resource: { id, tenantId: 'tenant-1', container: CONTAINER, icebergExpose: { enabled: true, tableName: 'a/../b' } } };
      throw { code: 404 };
    });
    const res = await GET(getReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.icebergEndpoint).toBeUndefined();
  });

  it('returns no icebergEndpoint when none persisted', async () => {
    const res = await GET(getReq(`lakehouseId=${LH}`));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergEndpoint).toBeUndefined();
  });
});
