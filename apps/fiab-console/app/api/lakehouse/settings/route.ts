/**
 * GET /api/lakehouse/settings?container=<c>
 *     — return the persisted Loom-side lakehouse settings doc for the
 *       container (Spark defaults, time-travel retention, Delta defaults,
 *       display name override). Real ADLS state (e.g. soft-delete) is
 *       merged in from Microsoft.Storage when available.
 * PUT /api/lakehouse/settings
 *     body: { container, displayName?, defaultSparkPool?, sparkConfig?,
 *             timeTravelDays?, deltaDefaults?, description?,
 *             icebergExpose?: { enabled, tableName, schemaName? } }
 *     — upsert the Loom-side settings doc in the `tenant-settings`
 *       Cosmos container, partitioned by tenantId. When icebergExpose.enabled,
 *       runs a real Delta UniForm ALTER TABLE so the Delta table is readable by
 *       Iceberg V2 readers (OneLake "Iceberg endpoint" parity, Azure-native).
 *
 * Storage account-level features (lifecycle/version policy) require the
 * caller to hold Storage Account Contributor; settings persisted here are
 * Loom-side defaults that other editors (Lakehouse Notebook, Lakehouse
 * Preview) consume.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import { getAccountName } from '@/lib/azure/adls-client';
import {
  databricksConfigGate,
  listWarehouses,
  executeStatement,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LiquidClustering {
  tableName: string;           // e.g. "bronze_player_profile" (under /Tables/)
  columns: string[];           // e.g. ["player_id", "filing_timestamp"]
}

interface IcebergExpose {
  // 1:1 with Fabric OneLake's "Iceberg V2 endpoint" / Delta-as-Iceberg
  // virtualization — built on the Azure-native path with Delta Lake UniForm
  // (Universal Format). When enabled, Loom runs a REAL ALTER TABLE … SET
  // TBLPROPERTIES('delta.enableIcebergCompatV2'='true',
  // 'delta.universalFormat.enabledFormats'='iceberg') on the named Delta table
  // via a Databricks SQL Warehouse. Delta then asynchronously generates Iceberg
  // V2 metadata (the `metadata/*.metadata.json` files) alongside the Delta log,
  // so any Iceberg reader (Snowflake, Trino, Spark, Athena via the metadata
  // path) can read the table — no Fabric capacity / OneLake required. Exactly
  // like OneLake, there is NO separate "Iceberg endpoint" toggle to flip:
  // exposing the Delta table to Iceberg readers *is* the Iceberg endpoint.
  enabled: boolean;
  tableName: string;           // Delta table under /Tables/ (or /Tables/<schema>/) to expose
  schemaName?: string;         // when the lakehouse is schema-enabled (e.g. "dbo")
}

interface FabricToggles {
  // Persisted preferences. Each is effective ONLY on a Fabric Spark runtime
  // (opt-in). On the Azure-native default path (Synapse Spark / Databricks)
  // the key is silently ignored — the UI discloses this with a warning
  // MessageBar; we never claim the optimization is active on Azure.
  vorder: boolean;             // spark.sql.parquet.vorder.default — Fabric Spark only
  autotune: boolean;           // spark.ms.autotune.enabled — Fabric Runtime 1.2 only
  nativeExecution: boolean;    // Velox/Gluten — Fabric Runtime 1.3/2.0 only
}

interface LakehouseSettingsDoc {
  id: string;                  // `lakehouse-<container>`
  tenantId: string;            // partition key
  container: string;
  displayName?: string;
  description?: string;
  defaultSparkPool?: string;
  sparkConfig?: Record<string, string>;
  timeTravelDays?: number;     // Delta vacuum retention (default 7)
  deltaDefaults?: { autoOptimize?: boolean; tableProperties?: Record<string, string> };
  schemasEnabled?: boolean;    // multi-schema namespace (workspace.lakehouse.schema.table)
  liquidClustering?: LiquidClustering;
  icebergExpose?: IcebergExpose;
  fabricToggles?: FabricToggles;
  updatedAt?: string;
  updatedBy?: string;
}

function docId(container: string) { return `lakehouse-${container}`; }

/**
 * Coarse cloud-boundary detection from the Entra authority host so the UI can
 * render honest per-cloud disclosures for the Fabric-only acceleration gates
 * (e.g. GCC has no Fabric F-SKU capacities). No network call — just env.
 */
function cloudEnv(): 'commercial' | 'gcc' | 'gcch' | 'il5' {
  const host = (process.env.AZURE_AUTHORITY_HOST || '').toLowerCase();
  if (host.includes('.us')) {
    if (process.env.LOOM_IL5 === 'true') return 'il5';
    if (process.env.LOOM_GCCH === 'true') return 'gcch';
    return 'gcc';
  }
  return 'commercial';
}

function parseLiquidClustering(v: any): LiquidClustering | undefined {
  if (!v || typeof v !== 'object' || typeof v.tableName !== 'string' || !v.tableName.trim()) {
    return undefined;
  }
  const columns = Array.isArray(v.columns)
    ? v.columns.map((c: any) => String(c).trim()).filter((c: string) => c.length > 0)
    : [];
  return { tableName: v.tableName.trim(), columns };
}

function parseIcebergExpose(v: any): IcebergExpose | undefined {
  if (!v || typeof v !== 'object' || typeof v.tableName !== 'string' || !v.tableName.trim()) {
    return undefined;
  }
  const schemaName =
    typeof v.schemaName === 'string' && v.schemaName.trim() ? v.schemaName.trim() : undefined;
  return { enabled: !!v.enabled, tableName: v.tableName.trim(), schemaName };
}

/**
 * Build the ADLS abfss:// path and the Iceberg metadata-folder / latest
 * metadata HTTPS URLs for a Delta table exposed via UniForm. Pure string
 * construction — no network call — so the UI always has the paths to show.
 */
function icebergPaths(account: string, container: string, ie: IcebergExpose) {
  const cleanTable = ie.tableName.replace(/^\/+/, '').replace(/^Tables\//i, '');
  const schemaSeg = ie.schemaName ? `${ie.schemaName.replace(/^\/+|\/+$/g, '')}/` : '';
  const tablesRel = `Tables/${schemaSeg}${cleanTable}`;
  const host = `${account}.dfs.core.windows.net`;
  return {
    cleanTable,
    abfss: `abfss://${container}@${host}/${tablesRel}`,
    httpsTablePath: `https://${host}/${container}/${tablesRel}`,
    httpsMetadataFolder: `https://${host}/${container}/${tablesRel}/metadata`,
    // Snowflake EXTERNAL VOLUME wants the azure:// scheme; the metadata folder
    // is the discovery root for Iceberg readers.
    azureMetadataFolder: `azure://${host}/${container}/${tablesRel}/metadata`,
  };
}

function parseFabricToggles(v: any): FabricToggles | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return {
    vorder: !!v.vorder,
    autotune: !!v.autotune,
    nativeExecution: !!v.nativeExecution,
  };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const container = req.nextUrl.searchParams.get('container');
  if (!container) return NextResponse.json({ ok: false, error: 'container query param required' }, { status: 400 });
  const tenantId = session.claims.oid;

  try {
    const c = await tenantSettingsContainer();
    let resource: LakehouseSettingsDoc | undefined;
    try {
      const r = await c.item(docId(container), tenantId).read<LakehouseSettingsDoc>();
      resource = r.resource;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    // If the persisted doc has an Iceberg-expose selection, surface the ADLS
    // path + Iceberg metadata-folder URLs so the editor can render them on load
    // (the "endpoint" is just the metadata path readers point at).
    let icebergEndpoint:
      | {
          abfss: string;
          httpsTablePath: string;
          httpsMetadataFolder: string;
          azureMetadataFolder: string;
          format: 'iceberg-v2';
          via: 'delta-uniform';
        }
      | undefined;
    const ie = resource?.icebergExpose;
    if (ie?.tableName) {
      try {
        const account = getAccountName();
        const paths = icebergPaths(account, container, ie);
        icebergEndpoint = {
          abfss: paths.abfss,
          httpsTablePath: paths.httpsTablePath,
          httpsMetadataFolder: paths.httpsMetadataFolder,
          azureMetadataFolder: paths.azureMetadataFolder,
          format: 'iceberg-v2',
          via: 'delta-uniform',
        };
      } catch {
        /* storage account not configured — UI shows the honest gate */
      }
    }

    return NextResponse.json({
      ok: true,
      container,
      cloud: cloudEnv(),
      icebergEndpoint,
      settings: resource || {
        id: docId(container),
        tenantId,
        container,
        timeTravelDays: 7,
        sparkConfig: {},
        deltaDefaults: { autoOptimize: true, tableProperties: {} },
        schemasEnabled: false,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const container: string = body?.container;
  if (!container) return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
  const tenantId = session.claims.oid;

  const doc: LakehouseSettingsDoc = {
    id: docId(container),
    tenantId,
    container,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    defaultSparkPool: typeof body.defaultSparkPool === 'string' ? body.defaultSparkPool : undefined,
    sparkConfig: body.sparkConfig && typeof body.sparkConfig === 'object' ? body.sparkConfig : {},
    timeTravelDays: typeof body.timeTravelDays === 'number' && body.timeTravelDays >= 0 ? body.timeTravelDays : 7,
    deltaDefaults: body.deltaDefaults && typeof body.deltaDefaults === 'object' ? body.deltaDefaults : { autoOptimize: true },
    schemasEnabled: typeof body.schemasEnabled === 'boolean' ? body.schemasEnabled : undefined,
    liquidClustering: parseLiquidClustering(body.liquidClustering),
    icebergExpose: parseIcebergExpose(body.icebergExpose),
    fabricToggles: parseFabricToggles(body.fabricToggles),
    updatedAt: new Date().toISOString(),
    updatedBy: session.claims.upn,
  };

  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.items.upsert<LakehouseSettingsDoc>(doc);

    // Liquid clustering — issue a REAL ALTER TABLE … CLUSTER BY against the
    // named Delta table via a Databricks SQL Warehouse (Azure-native path, no
    // Fabric dependency). Honest gate when the warehouse isn't configured; the
    // chosen columns are persisted either way so they apply on the next save.
    let clusteringApplied = false;
    let clusteringSql: string | undefined;
    let clusteringGate: string | undefined;
    let clusteringError: string | undefined;

    const lc = doc.liquidClustering;
    if (lc?.tableName && lc.columns.length > 0) {
      const gate = databricksConfigGate();
      if (gate) {
        clusteringGate =
          `Liquid clustering runs a real ALTER TABLE … CLUSTER BY via a Databricks SQL Warehouse. ` +
          `Set ${gate.missing} (and optionally LOOM_DATABRICKS_SQL_WAREHOUSE_ID) in the admin-plane env vars to enable it. ` +
          `Your clustering columns are saved and will apply on the next save once the warehouse is configured.`;
      } else {
        try {
          const account = getAccountName();
          const cleanTable = lc.tableName.replace(/^\/+/, '').replace(/^Tables\//i, '');
          const abfss = `abfss://${container}@${account}.dfs.core.windows.net/Tables/${cleanTable}`;
          const cols = lc.columns
            .map((col) => '`' + String(col).replace(/`/g, '').trim() + '`')
            .filter((col) => col !== '``')
            .join(', ');
          const sql = `ALTER TABLE delta.\`${abfss}\` CLUSTER BY (${cols})`;
          clusteringSql = sql;

          const whs = await listWarehouses();
          const preferred = process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
          const wh =
            (preferred && whs.find((w) => w.id === preferred)) ||
            whs.find((w) => w.state === 'RUNNING') ||
            whs[0];
          if (!wh) {
            clusteringGate =
              'No Databricks SQL Warehouse exists in the workspace. Create one (Databricks navigator → SQL Warehouses) to run ALTER TABLE … CLUSTER BY.';
          } else {
            await executeStatement(wh.id, sql);
            clusteringApplied = true;
          }
        } catch (e: any) {
          clusteringError = e?.message || String(e);
        }
      }
    }

    // Expose as Iceberg (OneLake "Iceberg V2 endpoint" parity → Delta UniForm).
    // When enabled for a named Delta table, issue a REAL ALTER TABLE … SET
    // TBLPROPERTIES enabling IcebergCompatV2 + UniForm iceberg via a Databricks
    // SQL Warehouse (Azure-native, no Fabric). Delta then generates Iceberg V2
    // metadata asynchronously; we always return the ADLS path + Iceberg
    // metadata-folder URL so readers (Snowflake/Trino/Spark) can be pointed at
    // it. The selection is persisted regardless so it re-applies on next save.
    let icebergApplied = false;
    let icebergSql: string | undefined;
    let icebergGate: string | undefined;
    let icebergError: string | undefined;
    let icebergEndpoint:
      | {
          abfss: string;
          httpsTablePath: string;
          httpsMetadataFolder: string;
          azureMetadataFolder: string;
          format: 'iceberg-v2';
          via: 'delta-uniform';
        }
      | undefined;

    const ie = doc.icebergExpose;
    if (ie?.enabled && ie.tableName) {
      let account: string | undefined;
      try {
        account = getAccountName();
      } catch (e: any) {
        icebergGate =
          'Storage account is not configured (set LOOM_LAKEHOUSE_STORAGE_ACCOUNT / LOOM_ADLS_ACCOUNT). ' +
          'The Iceberg expose selection is saved and will apply once the storage account is set.';
      }

      if (account) {
        const paths = icebergPaths(account, container, ie);
        icebergEndpoint = {
          abfss: paths.abfss,
          httpsTablePath: paths.httpsTablePath,
          httpsMetadataFolder: paths.httpsMetadataFolder,
          azureMetadataFolder: paths.azureMetadataFolder,
          format: 'iceberg-v2',
          via: 'delta-uniform',
        };

        // ALTER TABLE … SET TBLPROPERTIES turns on UniForm Iceberg V2 reads.
        // Use REORG … UPGRADE UNIFORM when deletion vectors / older compat may
        // be present; SET TBLPROPERTIES is the standard enable path and the one
        // OneLake's virtualization mirrors. We use SET TBLPROPERTIES as the
        // primary; the UI documents REORG for tables with deletion vectors.
        const sql =
          `ALTER TABLE delta.\`${paths.abfss}\` SET TBLPROPERTIES(` +
          `'delta.enableIcebergCompatV2' = 'true', ` +
          `'delta.universalFormat.enabledFormats' = 'iceberg')`;
        icebergSql = sql;

        const gate = databricksConfigGate();
        if (gate) {
          icebergGate =
            `Exposing a Delta table to Iceberg readers uses Delta Lake UniForm, which runs a real ` +
            `ALTER TABLE … SET TBLPROPERTIES via a Databricks SQL Warehouse. Set ${gate.missing} ` +
            `(and optionally LOOM_DATABRICKS_SQL_WAREHOUSE_ID) in the admin-plane env vars to enable it. ` +
            `Your selection is saved and the Iceberg metadata path below is already valid; metadata is ` +
            `generated the first time the UniForm enable runs.`;
        } else {
          try {
            const whs = await listWarehouses();
            const preferred = process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
            const wh =
              (preferred && whs.find((w) => w.id === preferred)) ||
              whs.find((w) => w.state === 'RUNNING') ||
              whs[0];
            if (!wh) {
              icebergGate =
                'No Databricks SQL Warehouse exists in the workspace. Create one (Databricks navigator → SQL Warehouses) to run the UniForm ALTER TABLE that generates Iceberg metadata.';
            } else {
              await executeStatement(wh.id, sql);
              icebergApplied = true;
            }
          } catch (e: any) {
            icebergError = e?.message || String(e);
          }
        }
      }
    } else if (ie && !ie.enabled && ie.tableName) {
      // Disable path — turn UniForm Iceberg generation off for the table. This
      // is a real ALTER as well (best-effort; gated identically).
      let account: string | undefined;
      try {
        account = getAccountName();
      } catch {
        /* no-op: nothing to disable if no account */
      }
      if (account) {
        const paths = icebergPaths(account, container, ie);
        const sql =
          `ALTER TABLE delta.\`${paths.abfss}\` UNSET TBLPROPERTIES IF EXISTS (` +
          `'delta.universalFormat.enabledFormats')`;
        icebergSql = sql;
        const gate = databricksConfigGate();
        if (!gate) {
          try {
            const whs = await listWarehouses();
            const wh = whs.find((w) => w.state === 'RUNNING') || whs[0];
            if (wh) {
              await executeStatement(wh.id, sql);
            }
          } catch (e: any) {
            icebergError = e?.message || String(e);
          }
        }
      }
    }

    return NextResponse.json({
      ok: true,
      cloud: cloudEnv(),
      settings: resource,
      clusteringApplied,
      clusteringSql,
      clusteringGate,
      clusteringError,
      icebergApplied,
      icebergSql,
      icebergGate,
      icebergError,
      icebergEndpoint,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
