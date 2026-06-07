/**
 * GET /api/lakehouse/settings?container=<c>
 *     — return the persisted Loom-side lakehouse settings doc for the
 *       container (Spark defaults, time-travel retention, Delta defaults,
 *       display name override). Real ADLS state (e.g. soft-delete) is
 *       merged in from Microsoft.Storage when available.
 * PUT /api/lakehouse/settings
 *     body: { container, displayName?, defaultSparkPool?, sparkConfig?,
 *             timeTravelDays?, deltaDefaults?, description? }
 *     — upsert the Loom-side settings doc in the `tenant-settings`
 *       Cosmos container, partitioned by tenantId.
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
    return NextResponse.json({
      ok: true,
      container,
      cloud: cloudEnv(),
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

    return NextResponse.json({
      ok: true,
      cloud: cloudEnv(),
      settings: resource,
      clusteringApplied,
      clusteringSql,
      clusteringGate,
      clusteringError,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
