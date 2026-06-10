/**
 * Backend contract tests for the Iceberg V2 endpoint (Delta UniForm) branch of
 * /api/lakehouse/settings PUT. Azure-native, NO Fabric: a real
 * ALTER TABLE … SET TBLPROPERTIES is run via a Databricks SQL Warehouse so the
 * Delta table is readable by Apache Iceberg readers — the 1:1 of OneLake's
 * Delta→Iceberg virtualization.
 *
 *   - enable → SET TBLPROPERTIES with delta.universalFormat.enabledFormats=iceberg
 *   - disable → UNSET those properties
 *   - schemas-enabled → abfss path includes Tables/<schema>/<table>
 *   - honest gate when Databricks isn't configured (selection still persisted)
 *   - ADLS path + metadata path + IRC catalog URL returned for readers
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/adls-client', () => ({ getAccountName: vi.fn(() => 'loomacct') }));
vi.mock('@/lib/azure/cosmos-client', () => ({ tenantSettingsContainer: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({
  databricksConfigGate: vi.fn(() => null),
  listWarehouses: vi.fn(),
  executeStatement: vi.fn(),
}));

import { PUT } from '../settings/route';
import { getSession } from '@/lib/auth/session';
import { getAccountName } from '@/lib/azure/adls-client';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  databricksConfigGate, listWarehouses, executeStatement,
} from '@/lib/azure/databricks-client';

function putReq(body: any) { return { json: async () => body } as any; }
const sess = { claims: { oid: 'oid-1', upn: 'u@x', tid: 't1' } };

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(sess);
  (getAccountName as any).mockReturnValue('loomacct');
  (databricksConfigGate as any).mockReturnValue(null);
  (tenantSettingsContainer as any).mockResolvedValue({
    items: { upsert: vi.fn(async (d: any) => ({ resource: d })) },
  });
  (listWarehouses as any).mockResolvedValue([{ id: 'wh1', state: 'RUNNING' }]);
  (executeStatement as any).mockResolvedValue({});
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-123.4.azuredatabricks.net';
});

describe('PUT /api/lakehouse/settings — Iceberg V2 endpoint', () => {
  it('runs a real SET TBLPROPERTIES (UniForm) when enabling', async () => {
    const res = await PUT(putReq({
      container: 'bronze',
      icebergEndpoint: { enabled: true, tableName: 'players' },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(true);
    expect(j.icebergEnabled).toBe(true);
    expect(executeStatement).toHaveBeenCalledTimes(1);
    const sql: string = (executeStatement as any).mock.calls[0][1];
    expect(sql).toContain('SET TBLPROPERTIES');
    expect(sql).toContain("'delta.universalFormat.enabledFormats' = 'iceberg'");
    expect(sql).toContain("'delta.enableIcebergCompatV2' = 'true'");
    expect(sql).toContain('abfss://bronze@loomacct.dfs.core.windows.net/Tables/players');
    // reader-facing paths
    expect(j.icebergAdlsPath).toBe('https://loomacct.dfs.core.windows.net/bronze/Tables/players');
    expect(j.icebergMetadataPath).toBe('https://loomacct.dfs.core.windows.net/bronze/Tables/players/metadata');
    expect(j.icebergCatalogUrl).toContain('/api/2.1/unity-catalog/iceberg');
  });

  it('runs UNSET TBLPROPERTIES when disabling', async () => {
    const res = await PUT(putReq({
      container: 'bronze',
      icebergEndpoint: { enabled: false, tableName: 'players' },
    }));
    const j = await res.json();
    expect(j.icebergApplied).toBe(true);
    expect(j.icebergEnabled).toBe(false);
    const sql: string = (executeStatement as any).mock.calls[0][1];
    expect(sql).toContain('UNSET TBLPROPERTIES');
    expect(sql).toContain("'delta.universalFormat.enabledFormats'");
  });

  it('includes the schema in the abfss path for schemas-enabled lakehouses', async () => {
    const res = await PUT(putReq({
      container: 'bronze',
      schemasEnabled: true,
      icebergEndpoint: { enabled: true, tableName: 'players', schema: 'sales' },
    }));
    await res.json();
    const sql: string = (executeStatement as any).mock.calls[0][1];
    expect(sql).toContain('Tables/sales/players');
  });

  it('honest gate (no DDL run) when Databricks is not configured; selection still persisted', async () => {
    (databricksConfigGate as any).mockReturnValue({ missing: 'LOOM_DATABRICKS_HOSTNAME' });
    const res = await PUT(putReq({
      container: 'bronze',
      icebergEndpoint: { enabled: true, tableName: 'players' },
    }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergGate).toContain('LOOM_DATABRICKS_HOSTNAME');
    expect(executeStatement).not.toHaveBeenCalled();
    // persisted regardless so it applies on the next save
    expect(j.settings.icebergEndpoint).toEqual({ enabled: true, tableName: 'players', schema: undefined });
  });

  it('honest gate when no SQL warehouse exists', async () => {
    (listWarehouses as any).mockResolvedValue([]);
    const res = await PUT(putReq({
      container: 'bronze',
      icebergEndpoint: { enabled: true, tableName: 'players' },
    }));
    const j = await res.json();
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergGate).toContain('No Databricks SQL Warehouse');
    expect(executeStatement).not.toHaveBeenCalled();
  });

  it('does nothing Iceberg-related when no icebergEndpoint provided', async () => {
    const res = await PUT(putReq({ container: 'bronze' }));
    const j = await res.json();
    expect(j.icebergApplied).toBe(false);
    expect(j.icebergSql).toBeUndefined();
    expect(executeStatement).not.toHaveBeenCalled();
  });
});
