/**
 * Backend contract tests for the lakehouse Settings "Expose as Iceberg"
 * capability — /api/lakehouse/settings (GET/PUT).
 *
 * Parity target: Fabric OneLake "Iceberg V2 endpoint" (Delta ↔ Iceberg
 * virtualization). Azure-native, NO Fabric dependency: the endpoint is produced
 * by Delta Lake UniForm via a real ALTER TABLE … SET TBLPROPERTIES run on a
 * Databricks SQL Warehouse. The ADLS abfss:// path + Iceberg metadata-folder
 * URLs are always computed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

const upsert = vi.fn();
const itemRead = vi.fn();
const itemFn = vi.fn(() => ({ read: itemRead }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  tenantSettingsContainer: vi.fn(async () => ({
    item: itemFn,
    items: { upsert },
  })),
}));

vi.mock('@/lib/azure/adls-client', () => ({
  getAccountName: vi.fn(() => 'loomacct'),
}));

const databricksConfigGate = vi.fn();
const listWarehouses = vi.fn();
const executeStatement = vi.fn();
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: (...a: any[]) => databricksConfigGate(...a),
  listWarehouses: (...a: any[]) => listWarehouses(...a),
  executeStatement: (...a: any[]) => executeStatement(...a),
}));

import { GET, PUT } from '../settings/route';
import { getSession } from '@/lib/auth/session';

const sess = { claims: { oid: 'tenant-1', upn: 'u@x' } };
function getReq(qs: string) { return { nextUrl: new URL(`http://x/api/lakehouse/settings?${qs}`) } as any; }
function putReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue(sess);
  // upsert echoes the doc back as the persisted resource
  upsert.mockImplementation(async (doc: any) => ({ resource: doc }));
  itemRead.mockRejectedValue({ code: 404 });
});

describe('PUT /api/lakehouse/settings — Expose as Iceberg', () => {
  it('runs the real UniForm ALTER TABLE and returns the iceberg endpoint when enabled', async () => {
    databricksConfigGate.mockReturnValue(null);
    listWarehouses.mockResolvedValue([{ id: 'wh-1', state: 'RUNNING' }]);
    executeStatement.mockResolvedValue({ rows: [] });

    const res = await PUT(putReq({
      container: 'gold',
      icebergExpose: { enabled: true, tableName: 'bronze_player_profile' },
    }));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(true);
    expect(j.icebergSql).toContain("delta.universalFormat.enabledFormats");
    expect(j.icebergSql).toContain("delta.enableIcebergCompatV2");
    expect(j.icebergSql).toContain(
      'abfss://gold@loomacct.dfs.core.windows.net/Tables/bronze_player_profile',
    );
    expect(executeStatement).toHaveBeenCalledWith('wh-1', expect.stringContaining('SET TBLPROPERTIES'));
    expect(j.icebergEndpoint).toMatchObject({
      abfss: 'abfss://gold@loomacct.dfs.core.windows.net/Tables/bronze_player_profile',
      httpsMetadataFolder:
        'https://loomacct.dfs.core.windows.net/gold/Tables/bronze_player_profile/metadata',
      azureMetadataFolder:
        'azure://loomacct.dfs.core.windows.net/gold/Tables/bronze_player_profile/metadata',
      format: 'iceberg-v2',
      via: 'delta-uniform',
    });
    // selection persisted regardless
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ icebergExpose: { enabled: true, tableName: 'bronze_player_profile', schemaName: undefined } }),
    );
  });

  it('honestly gates (no Fabric error) when Databricks is not configured, still persists + shows path', async () => {
    databricksConfigGate.mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });

    const res = await PUT(putReq({
      container: 'gold',
      icebergExpose: { enabled: true, tableName: 'sales' },
    }));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergGate).toContain('LOOM_DATABRICKS_HOSTNAME');
    expect(executeStatement).not.toHaveBeenCalled();
    // endpoint path is still returned so the UI can show where readers point
    expect(j.icebergEndpoint.abfss).toContain('Tables/sales');
  });

  it('honors schema-enabled path placement under Tables/<schema>/', async () => {
    databricksConfigGate.mockReturnValue(null);
    listWarehouses.mockResolvedValue([{ id: 'wh-1', state: 'RUNNING' }]);
    executeStatement.mockResolvedValue({ rows: [] });

    const res = await PUT(putReq({
      container: 'gold',
      icebergExpose: { enabled: true, tableName: 'orders', schemaName: 'dbo' },
    }));
    const j = await res.json();

    expect(j.icebergEndpoint.abfss).toBe(
      'abfss://gold@loomacct.dfs.core.windows.net/Tables/dbo/orders',
    );
    expect(j.icebergSql).toContain('Tables/dbo/orders');
  });

  it('runs UNSET when disabling iceberg expose', async () => {
    databricksConfigGate.mockReturnValue(null);
    listWarehouses.mockResolvedValue([{ id: 'wh-1', state: 'RUNNING' }]);
    executeStatement.mockResolvedValue({ rows: [] });

    const res = await PUT(putReq({
      container: 'gold',
      icebergExpose: { enabled: false, tableName: 'orders' },
    }));
    const j = await res.json();

    expect(res.status).toBe(200);
    expect(j.icebergSql).toContain('UNSET TBLPROPERTIES');
    expect(executeStatement).toHaveBeenCalledWith('wh-1', expect.stringContaining('UNSET TBLPROPERTIES'));
  });

  it('does nothing iceberg-related when no icebergExpose is provided', async () => {
    const res = await PUT(putReq({ container: 'gold' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergEndpoint).toBeUndefined();
    expect(executeStatement).not.toHaveBeenCalled();
  });
});

describe('GET /api/lakehouse/settings — Iceberg endpoint surfaced on load', () => {
  it('computes the iceberg endpoint from a persisted icebergExpose selection', async () => {
    itemRead.mockResolvedValue({
      resource: {
        id: 'lakehouse-gold',
        tenantId: 'tenant-1',
        container: 'gold',
        icebergExpose: { enabled: true, tableName: 'sales' },
      },
    });
    const res = await GET(getReq('container=gold'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergEndpoint.httpsMetadataFolder).toBe(
      'https://loomacct.dfs.core.windows.net/gold/Tables/sales/metadata',
    );
  });

  it('returns no icebergEndpoint when none persisted', async () => {
    const res = await GET(getReq('container=gold'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergEndpoint).toBeUndefined();
  });
});
