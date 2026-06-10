/**
 * OneLake Iceberg V2 interoperability for a Lakehouse — Azure-native.
 *
 * GET  /api/lakehouse/iceberg?container=<c>[&table=<name>]
 *   Report the "expose as Iceberg" status for the lakehouse container:
 *     - the persisted toggle + per-table list (from the Loom settings doc)
 *     - the ADLS Gen2 abfss/https root path of the lakehouse Tables/ folder
 *     - the Iceberg catalog (REST) URL that Iceberg readers point at
 *     - per-table metadata-file path probe (does <table>/metadata/*.metadata.json
 *       exist yet on ADLS?), so the UI shows whether conversion has produced
 *       Iceberg V2 metadata.
 *
 * POST /api/lakehouse/iceberg
 *   body: { container, enabled, tables?: string[] }
 *   Persist the toggle and, when enabling, run the REAL Delta UniForm enable on
 *   each named Delta table via a Databricks SQL Warehouse:
 *     ALTER TABLE delta.`abfss://…/Tables/<t>`
 *       SET TBLPROPERTIES (
 *         'delta.enableIcebergCompatV2' = 'true',
 *         'delta.universalFormat.enabledFormats' = 'iceberg'
 *       );
 *   Delta UniForm writes Apache Iceberg V2 metadata alongside the Delta log on
 *   the SAME ADLS files (no copy), so Iceberg readers (Snowflake, Trino, Spark,
 *   Athena) read the Delta tables directly. This is the 1:1 Azure-native parity
 *   for Fabric OneLake's "Delta read by Iceberg readers" virtualization
 *   (https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables) — no
 *   real Fabric / OneLake / Power BI dependency.
 *
 *   When disabling, persists enabled=false and (best-effort) runs
 *     ALTER TABLE … UNSET TBLPROPERTIES ('delta.universalFormat.enabledFormats')
 *   so the table stops emitting Iceberg metadata.
 *
 * Honest infra-gate: enabling needs a Databricks SQL Warehouse
 * (LOOM_DATABRICKS_HOSTNAME + token/UAMI; optional LOOM_DATABRICKS_SQL_WAREHOUSE_ID).
 * If it's missing, the toggle + table list still persist and the response names
 * the exact env var to set — the conversion applies on the next save.
 *
 * Auth: session-required, tenant-scoped (settings doc partitioned by tenantId).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  getAccountName,
  getServiceClient,
  pathToHttpsUrl,
} from '@/lib/azure/adls-client';
import {
  databricksConfigGate,
  listWarehouses,
  executeStatement,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IcebergSettings {
  enabled: boolean;
  tables: string[]; // bare Delta table names under Tables/ (no leading slash)
  catalogUrl?: string;
  updatedAt?: string;
  updatedBy?: string;
}

interface LakehouseSettingsDoc {
  id: string;
  tenantId: string;
  container: string;
  iceberg?: IcebergSettings;
  // (other settings keys are preserved on read-modify-write)
  [k: string]: unknown;
}

function docId(container: string) {
  return `lakehouse-${container}`;
}

/** Strip leading slash + a leading `Tables/` so callers can pass either form. */
function bareTableName(t: string): string {
  return String(t || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/^Tables\//i, '')
    .replace(/\/+$/, '');
}

/**
 * The Iceberg REST Catalog URL Iceberg readers point at. The Azure-native
 * parity for Fabric's `https://onelake.table.fabric.microsoft.com/iceberg` is
 * Databricks Unity Catalog's Iceberg REST endpoint when Databricks is wired up;
 * otherwise readers use the path-based metadata.json directly on ADLS (no
 * catalog server), which we surface as the metadata root.
 */
function icebergCatalogUrl(): string | undefined {
  const host = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (host) return `https://${host}/api/2.1/unity-catalog/iceberg`;
  return undefined;
}

/** abfss + https roots for the lakehouse Tables/ folder on the primary account. */
function tablesRoots(container: string): { abfss: string; https: string; account: string } {
  const account = getAccountName();
  const abfss = `abfss://${container}@${account}.dfs.core.windows.net/Tables`;
  const https = pathToHttpsUrl(container, 'Tables');
  return { abfss, https, account };
}

/**
 * Probe whether a Delta table has produced an Iceberg metadata folder yet
 * (Tables/<t>/metadata/*.metadata.json). Returns the latest metadata file path
 * (relative to the account) when present, or null. Never throws — a missing
 * folder or an auth error reads as "not converted yet".
 */
async function probeIcebergMetadata(
  container: string,
  table: string,
): Promise<{ converted: boolean; latestMetadata?: string }> {
  try {
    const svc = getServiceClient();
    const fs = svc.getFileSystemClient(container);
    const dir = `Tables/${table}/metadata`;
    const dc = fs.getDirectoryClient(dir);
    if (!(await dc.exists())) return { converted: false };
    let latest: string | undefined;
    let latestVersion = -1;
    for await (const p of fs.listPaths({ path: dir, recursive: false })) {
      const name = p.name || '';
      if (!/\.metadata\.json$/i.test(name)) continue;
      // metadata files look like `00001-<uuid>.metadata.json` or `<n>.metadata.json`
      const leaf = name.substring(name.lastIndexOf('/') + 1);
      const numMatch = leaf.match(/^(\d+)/);
      const version = numMatch ? parseInt(numMatch[1], 10) : 0;
      if (version >= latestVersion) {
        latestVersion = version;
        latest = name;
      }
    }
    return latest
      ? { converted: true, latestMetadata: `${container}/${latest}` }
      : { converted: false };
  } catch {
    return { converted: false };
  }
}

async function readDoc(container: string, tenantId: string): Promise<LakehouseSettingsDoc | undefined> {
  const c = await tenantSettingsContainer();
  try {
    const r = await c.item(docId(container), tenantId).read<LakehouseSettingsDoc>();
    return r.resource;
  } catch (e: any) {
    if (e?.code === 404) return undefined;
    throw e;
  }
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const container = req.nextUrl.searchParams.get('container');
  if (!container) {
    return NextResponse.json({ ok: false, error: 'container query param required' }, { status: 400 });
  }
  const tenantId = session.claims.oid;

  // Honest infra-gate: the lakehouse Tables root lives on the primary ADLS
  // account. If no account is configured, name the env var rather than throw.
  let roots: { abfss: string; https: string; account: string } | null = null;
  let storageGate: string | undefined;
  try {
    roots = tablesRoots(container);
  } catch {
    storageGate =
      'No lakehouse storage account configured. Set LOOM_PRIMARY_STORAGE_ACCOUNT ' +
      '(or LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL, deployed by the DLZ Bicep) and grant ' +
      'the Console UAMI Storage Blob Data Reader on the container.';
  }

  try {
    const doc = await readDoc(container, tenantId);
    const ice: IcebergSettings = doc?.iceberg || { enabled: false, tables: [] };

    // Probe conversion status for each tracked table (only when storage exists).
    let tableStatus: { table: string; converted: boolean; latestMetadata?: string }[] = [];
    if (roots && ice.tables.length > 0) {
      tableStatus = await Promise.all(
        ice.tables.map(async (t) => ({ table: t, ...(await probeIcebergMetadata(container, t)) })),
      );
    }

    return NextResponse.json({
      ok: true,
      container,
      enabled: !!ice.enabled,
      tables: ice.tables,
      tableStatus,
      adlsTablesRoot: roots?.https,
      adlsAbfssRoot: roots?.abfss,
      account: roots?.account,
      catalogUrl: icebergCatalogUrl() || ice.catalogUrl,
      icebergVersion: 'v2',
      databricksConfigured: !databricksConfigGate(),
      storageGate,
      updatedAt: ice.updatedAt,
      updatedBy: ice.updatedBy,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const container: string = body?.container;
  if (!container) return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
  const enabled = !!body?.enabled;
  const tables: string[] = Array.isArray(body?.tables)
    ? Array.from(new Set(body.tables.map(bareTableName).filter((t: string) => t.length > 0)))
    : [];
  if (enabled && tables.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Select at least one Delta table to expose as Iceberg.' },
      { status: 400 },
    );
  }
  const tenantId = session.claims.oid;

  // Read-modify-write so we never clobber the lakehouse's other settings keys.
  let doc: LakehouseSettingsDoc;
  try {
    const existing = await readDoc(container, tenantId);
    doc = existing || { id: docId(container), tenantId, container };
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  const catalogUrl = icebergCatalogUrl();
  doc.iceberg = {
    enabled,
    tables,
    catalogUrl,
    updatedAt: new Date().toISOString(),
    updatedBy: session.claims.upn,
  };

  // Persist first so the preference survives even if the conversion is gated.
  try {
    const c = await tenantSettingsContainer();
    await c.items.upsert<LakehouseSettingsDoc>(doc);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Apply the REAL Delta UniForm property on each table via Databricks.
  const results: {
    table: string;
    applied: boolean;
    sql?: string;
    error?: string;
  }[] = [];
  let gate: string | undefined;

  const dbxGate = databricksConfigGate();
  if (dbxGate) {
    gate =
      `Exposing Delta tables as Iceberg runs a real ALTER TABLE … SET TBLPROPERTIES ` +
      `(delta.universalFormat.enabledFormats='iceberg') via a Databricks SQL Warehouse. ` +
      `Set ${dbxGate.missing} (and optionally LOOM_DATABRICKS_SQL_WAREHOUSE_ID) in the admin-plane ` +
      `env vars to enable conversion. Your selection is saved and will apply on the next save once ` +
      `the warehouse is configured.`;
  } else {
    let account: string;
    try {
      account = getAccountName();
    } catch {
      account = '';
    }
    if (!account) {
      gate =
        'No lakehouse storage account configured. Set LOOM_PRIMARY_STORAGE_ACCOUNT ' +
        '(or LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL) so the ALTER TABLE can target the abfss table path.';
    } else {
      let warehouseId: string | undefined;
      try {
        const whs = await listWarehouses();
        const preferred = process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
        const wh =
          (preferred && whs.find((w) => w.id === preferred)) ||
          whs.find((w) => w.state === 'RUNNING') ||
          whs[0];
        warehouseId = wh?.id;
      } catch (e: any) {
        gate = `Could not list Databricks SQL Warehouses: ${e?.message || String(e)}`;
      }
      if (!warehouseId && !gate) {
        gate =
          'No Databricks SQL Warehouse exists in the workspace. Create one ' +
          '(Databricks navigator → SQL Warehouses) to run ALTER TABLE … SET TBLPROPERTIES.';
      }
      if (warehouseId) {
        for (const t of tables) {
          const abfss = `abfss://${container}@${account}.dfs.core.windows.net/Tables/${t}`;
          const sql = enabled
            ? `ALTER TABLE delta.\`${abfss}\` SET TBLPROPERTIES (` +
              `'delta.enableIcebergCompatV2' = 'true', ` +
              `'delta.universalFormat.enabledFormats' = 'iceberg')`
            : `ALTER TABLE delta.\`${abfss}\` UNSET TBLPROPERTIES IF EXISTS (` +
              `'delta.universalFormat.enabledFormats')`;
          try {
            await executeStatement(warehouseId, sql);
            results.push({ table: t, applied: true, sql });
          } catch (e: any) {
            const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            results.push({ table: t, applied: false, sql, error: raw.slice(0, 300) });
          }
        }
      }
    }
  }

  const appliedCount = results.filter((r) => r.applied).length;
  return NextResponse.json({
    ok: true,
    container,
    enabled,
    tables,
    appliedCount,
    results,
    gate,
    catalogUrl,
    adlsAbfssRoot: (() => {
      try {
        return tablesRoots(container).abfss;
      } catch {
        return undefined;
      }
    })(),
    adlsTablesRoot: (() => {
      try {
        return tablesRoots(container).https;
      } catch {
        return undefined;
      }
    })(),
    icebergVersion: 'v2',
    updatedBy: session.claims.upn,
  });
}
