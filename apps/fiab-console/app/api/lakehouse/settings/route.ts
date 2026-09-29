/**
 * GET /api/lakehouse/settings?lakehouseId=<id>
 *     — return the persisted Loom-side settings doc for the lakehouse item
 *       (Spark defaults, time-travel retention, Delta defaults, display name
 *       override). Read access to the item is required.
 * PUT /api/lakehouse/settings
 *     body: { lakehouseId, displayName?, defaultSparkPool?, sparkConfig?,
 *             timeTravelDays?, deltaDefaults?, description?,
 *             liquidClustering?: { tableName, columns[] },
 *             icebergExpose?: { enabled, tableName, schemaName? } }
 *     — upsert the Loom-side settings doc in the `tenant-settings` Cosmos
 *       container, partitioned by the caller's oid. Edit access to the item is
 *       required. When icebergExpose.enabled, runs a real Delta UniForm ALTER
 *       TABLE so the Delta table is readable by Iceberg V2 readers (OneLake
 *       "Iceberg endpoint" parity, Azure-native).
 *
 * Item scope: the storage container and root come from the item's own binding
 * (`authorizeAndBind`), and every table these statements name sits under
 * `<root>/Tables/`. Table, schema and column names must match
 * `LAKEHOUSE_IDENT_RE` (400 otherwise) and are quoted with
 * `quoteIdent(..., 'databricks-sql')` where they enter SQL.
 *
 * Storage account-level features (lifecycle/version policy) require the
 * caller to hold Storage Account Contributor; settings persisted here are
 * Loom-side defaults that other editors (Lakehouse Notebook, Lakehouse
 * Preview) consume.
 */

import { NextRequest, NextResponse } from 'next/server';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  databricksConfigGate,
  listWarehouses,
  executeStatement,
} from '@/lib/azure/databricks-client';
import { withSession } from '@/lib/api/route-toolkit';
import { apiBadRequest } from '@/lib/api/respond';
import { quoteIdent } from '@/lib/sql/quoting';
import { hostHasSuffix } from '@/lib/util/host-match';
import { abfssHost, authorizeAndBind } from '../_lib/item-binding';
import { IDENT_RULE_TEXT, isLakehouseIdent, lakehouseTableName } from '../_lib/identifiers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LiquidClustering {
  tableName: string;           // e.g. "bronze_player_profile" (under <root>/Tables/)
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
  tableName: string;           // Delta table under <root>/Tables/ (or <root>/Tables/<schema>/)
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
  id: string;                  // `lakehouse-item-<lakehouseId>`
  tenantId: string;            // partition key
  lakehouseId?: string;
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

/** One settings doc per lakehouse item (several items can share a container). */
function docId(lakehouseId: string) { return `lakehouse-item-${lakehouseId}`; }
/** The earlier per-container doc id, read as a fallback so saved settings carry over. */
function legacyDocId(container: string) { return `lakehouse-${container}`; }

type IcebergEndpoint = {
  abfss: string;
  httpsTablePath: string;
  httpsMetadataFolder: string;
  azureMetadataFolder: string;
  format: 'iceberg-v2';
  via: 'delta-uniform';
};

/** Where a lakehouse item's storage lives, as the item's binding records it. */
interface ItemLocation {
  abfss: string;               // abfss://<container>@<host>/<root>
  container: string;
  root: string;
  host: string | null;
}

/**
 * Coarse cloud-boundary detection from the Entra authority host so the UI can
 * render honest per-cloud disclosures for the Fabric-only acceleration gates
 * (e.g. GCC has no Fabric F-SKU capacities). No network call — just env.
 */
function cloudEnv(): 'commercial' | 'gcc' | 'gcch' | 'il5' {
  // AZURE_AUTHORITY_HOST is a bare host (login.microsoftonline.us /
  // login.microsoftonline.com), so match the TLD as a DNS label.
  // `host.includes('.us')` also matched any host with `.us` anywhere in it —
  // `login.contoso.com.usercontent.net`, `login.microsoftonline.com/.usX` —
  // and would have reported a Commercial deployment as Gov, hiding the Fabric
  // capacity disclosures this function exists to render.
  const host = (process.env.AZURE_AUTHORITY_HOST || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (hostHasSuffix(host, 'us')) {
    if (process.env.LOOM_IL5 === 'true') return 'il5';
    if (process.env.LOOM_GCCH === 'true') return 'gcch';
    return 'gcc';
  }
  return 'commercial';
}

type Parsed<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function parseLiquidClustering(v: any): Parsed<LiquidClustering> {
  if (!v || typeof v !== 'object' || typeof v.tableName !== 'string' || !v.tableName.trim()) {
    return { ok: true, value: undefined };
  }
  const tableName = lakehouseTableName(v.tableName);
  if (!tableName) return { ok: false, error: `liquidClustering.tableName must be ${IDENT_RULE_TEXT}.` };
  const columns = Array.isArray(v.columns)
    ? v.columns.map((c: any) => String(c).trim()).filter((c: string) => c.length > 0)
    : [];
  const bad = columns.find((c: string) => !isLakehouseIdent(c));
  if (bad !== undefined) {
    return { ok: false, error: `liquidClustering column ${JSON.stringify(bad)} is not valid: a column name is ${IDENT_RULE_TEXT}.` };
  }
  return { ok: true, value: { tableName, columns } };
}

function parseIcebergExpose(v: any): Parsed<IcebergExpose> {
  if (!v || typeof v !== 'object' || typeof v.tableName !== 'string' || !v.tableName.trim()) {
    return { ok: true, value: undefined };
  }
  const tableName = lakehouseTableName(v.tableName);
  if (!tableName) return { ok: false, error: `icebergExpose.tableName must be ${IDENT_RULE_TEXT}.` };
  const rawSchema = typeof v.schemaName === 'string' ? v.schemaName.trim() : '';
  if (rawSchema && !isLakehouseIdent(rawSchema)) {
    return { ok: false, error: `icebergExpose.schemaName must be ${IDENT_RULE_TEXT}.` };
  }
  return { ok: true, value: { enabled: !!v.enabled, tableName, schemaName: rawSchema || undefined } };
}

/**
 * The item-root location of a Delta table, plus the Iceberg metadata-folder
 * URLs readers point at. Pure string construction from the item binding and
 * validated names — no network call — so the UI always has the paths to show.
 */
function tableLocation(loc: ItemLocation, tableName: string, schemaName?: string) {
  const tablesRel = `Tables/${schemaName ? `${schemaName}/` : ''}${tableName}`;
  const abfss = `${loc.abfss}/${tablesRel}`;
  const httpsBase = loc.host ? `https://${loc.host}/${loc.container}/${loc.root}/${tablesRel}` : '';
  return {
    abfss,
    httpsTablePath: httpsBase,
    httpsMetadataFolder: httpsBase ? `${httpsBase}/metadata` : '',
    // Snowflake EXTERNAL VOLUME wants the azure:// scheme; the metadata folder
    // is the discovery root for Iceberg readers.
    azureMetadataFolder: loc.host ? `azure://${loc.host}/${loc.container}/${loc.root}/${tablesRel}/metadata` : '',
  };
}

function icebergEndpointFor(loc: ItemLocation, ie: IcebergExpose): IcebergEndpoint {
  const p = tableLocation(loc, ie.tableName, ie.schemaName);
  return { ...p, format: 'iceberg-v2', via: 'delta-uniform' };
}

/** `delta.\`<abfss>\`` with the path quoted as a Databricks identifier. */
function deltaTableRef(abfss: string): string {
  return `delta.${quoteIdent(abfss, 'databricks-sql')}`;
}

function parseFabricToggles(v: any): FabricToggles | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return {
    vorder: !!v.vorder,
    autotune: !!v.autotune,
    nativeExecution: !!v.nativeExecution,
  };
}

async function pickWarehouse(usePreferredId: boolean) {
  const whs = await listWarehouses();
  const preferred = process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
  return (
    (usePreferredId && preferred && whs.find((w) => w.id === preferred)) ||
    whs.find((w) => w.state === 'RUNNING') ||
    whs[0]
  );
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const lakehouseId = (req.nextUrl.searchParams.get('lakehouseId') || '').trim();
  if (!lakehouseId) return apiBadRequest('lakehouseId is required: settings belong to a lakehouse item.');
  const tenantId = session.claims.oid;

  try {
    const scope = await authorizeAndBind(session, lakehouseId);
    if (scope instanceof NextResponse) return scope;
    const loc: ItemLocation = { ...scope.bound, root: scope.rootSegments.join('/'), host: abfssHost(scope.bound.abfss) };
    const container = loc.container;

    const c = await tenantSettingsContainer();
    const readDoc = async (id: string): Promise<LakehouseSettingsDoc | undefined> => {
      try {
        const r = await c.item(id, tenantId).read<LakehouseSettingsDoc>();
        return r.resource;
      } catch (e: any) {
        if (e?.code !== 404) throw e;
        return undefined;
      }
    };
    const resource = (await readDoc(docId(lakehouseId))) || (await readDoc(legacyDocId(container)));

    // If the persisted doc has an Iceberg-expose selection whose names are
    // valid, surface the table path + Iceberg metadata-folder URLs so the
    // editor can render them on load (the "endpoint" is just the metadata
    // path readers point at).
    let icebergEndpoint: IcebergEndpoint | undefined;
    const ie = parseIcebergExpose(resource?.icebergExpose);
    if (ie.ok && ie.value) icebergEndpoint = icebergEndpointFor(loc, ie.value);

    return NextResponse.json({
      ok: true,
      container,
      cloud: cloudEnv(),
      icebergEndpoint,
      settings: resource
        ? { ...resource, id: docId(lakehouseId), lakehouseId, container }
        : {
            id: docId(lakehouseId),
            tenantId,
            lakehouseId,
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
});

export const PUT = withSession(async (req: NextRequest, { session }) => {
  const body = await req.json().catch(() => ({}));
  const lakehouseId = typeof body?.lakehouseId === 'string' ? body.lakehouseId.trim() : '';
  if (!lakehouseId) return apiBadRequest('lakehouseId is required: settings belong to a lakehouse item.');
  const tenantId = session.claims.oid;

  const lcParsed = parseLiquidClustering(body.liquidClustering);
  if (!lcParsed.ok) return apiBadRequest(lcParsed.error);
  const ieParsed = parseIcebergExpose(body.icebergExpose);
  if (!ieParsed.ok) return apiBadRequest(ieParsed.error);

  try {
    const scope = await authorizeAndBind(session, lakehouseId, {
      write: true,
      readOnlyMessage:
        'Your role on this lakehouse is read-only, so Loom did not save its settings. A workspace '
        + 'Member/Admin, or an item grant that includes Edit, can change them.',
    });
    if (scope instanceof NextResponse) return scope;
    const loc: ItemLocation = { ...scope.bound, root: scope.rootSegments.join('/'), host: abfssHost(scope.bound.abfss) };
    const container = loc.container;

    const doc: LakehouseSettingsDoc = {
      id: docId(lakehouseId),
      tenantId,
      lakehouseId,
      container,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      defaultSparkPool: typeof body.defaultSparkPool === 'string' ? body.defaultSparkPool : undefined,
      sparkConfig: body.sparkConfig && typeof body.sparkConfig === 'object' ? body.sparkConfig : {},
      timeTravelDays: typeof body.timeTravelDays === 'number' && body.timeTravelDays >= 0 ? body.timeTravelDays : 7,
      deltaDefaults: body.deltaDefaults && typeof body.deltaDefaults === 'object' ? body.deltaDefaults : { autoOptimize: true },
      schemasEnabled: typeof body.schemasEnabled === 'boolean' ? body.schemasEnabled : undefined,
      liquidClustering: lcParsed.value,
      icebergExpose: ieParsed.value,
      fabricToggles: parseFabricToggles(body.fabricToggles),
      updatedAt: new Date().toISOString(),
      updatedBy: session.claims.upn,
    };

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
          const { abfss } = tableLocation(loc, lc.tableName);
          const cols = lc.columns.map((col) => quoteIdent(col, 'databricks-sql')).join(', ');
          const sql = `ALTER TABLE ${deltaTableRef(abfss)} CLUSTER BY (${cols})`;
          clusteringSql = sql;

          const wh = await pickWarehouse(true);
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
    // metadata asynchronously; we always return the table path + Iceberg
    // metadata-folder URL so readers (Snowflake/Trino/Spark) can be pointed at
    // it. The selection is persisted regardless so it re-applies on next save.
    let icebergApplied = false;
    let icebergSql: string | undefined;
    let icebergGate: string | undefined;
    let icebergError: string | undefined;
    let icebergEndpoint: IcebergEndpoint | undefined;

    const ie = doc.icebergExpose;
    if (ie?.enabled && ie.tableName) {
      icebergEndpoint = icebergEndpointFor(loc, ie);

      // ALTER TABLE … SET TBLPROPERTIES turns on UniForm Iceberg V2 reads.
      // Use REORG … UPGRADE UNIFORM when deletion vectors / older compat may
      // be present; SET TBLPROPERTIES is the standard enable path and the one
      // OneLake's virtualization mirrors. We use SET TBLPROPERTIES as the
      // primary; the UI documents REORG for tables with deletion vectors.
      const sql =
        `ALTER TABLE ${deltaTableRef(icebergEndpoint.abfss)} SET TBLPROPERTIES(` +
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
          const wh = await pickWarehouse(true);
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
    } else if (ie && !ie.enabled && ie.tableName) {
      // Disable path — turn UniForm Iceberg generation off for the table. This
      // is a real ALTER as well (best-effort; gated identically).
      const { abfss } = tableLocation(loc, ie.tableName, ie.schemaName);
      const sql =
        `ALTER TABLE ${deltaTableRef(abfss)} UNSET TBLPROPERTIES IF EXISTS (` +
        `'delta.universalFormat.enabledFormats')`;
      icebergSql = sql;
      const gate = databricksConfigGate();
      if (!gate) {
        try {
          const wh = await pickWarehouse(false);
          if (wh) {
            await executeStatement(wh.id, sql);
          }
        } catch (e: any) {
          icebergError = e?.message || String(e);
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
});
