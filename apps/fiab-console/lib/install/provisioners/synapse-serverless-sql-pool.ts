/**
 * Phase 2 — synapse-serverless-sql-pool provisioner.
 *
 * Pairs 1:1 with a lakehouse (no-fabric-dependency.md, Foundation task) AND with
 * a mirrored-database. When a lakehouse / mirror is provisioned on its
 * Azure-native ADLS Gen2 backend, the install engine auto-creates a paired
 * `synapse-serverless-sql-pool` Cosmos item and runs THIS provisioner so the
 * lake/Bronze data is queryable as T-SQL over one Synapse Serverless built-in
 * endpoint. The lakehouse shares [loom_lakehouse]; each mirror gets its own
 * [loom_mirror_<name>] database with one OPENROWSET view per mirrored table.
 *
 * What it does (all real TDS via synapse-sql-client — no mock branch):
 *   1. Ensures a dedicated Serverless USER database ([loom_lakehouse] by
 *      default, overridable via LOOM_SYNAPSE_LAKEHOUSE_DB). CREATE EXTERNAL …
 *      and CREATE DATABASE SCOPED CREDENTIAL are NOT allowed in `master` on
 *      Serverless, so the user DB is created in the master context first.
 *   2. Creates a DATABASE SCOPED CREDENTIAL using the workspace system MSI
 *      (`IDENTITY = 'Managed Identity'`). The workspace MSI already holds
 *      Storage Blob Data Contributor on the DLZ ADLS account (granted by
 *      landing-zone/synapse-storage-rbac.bicep), so this is the documented
 *      Managed-Identity passthrough path for Serverless → ADLS Gen2.
 *   3. Creates an EXTERNAL DATA SOURCE whose LOCATION is the lakehouse's abfss
 *      root (passed in via content.adlsRoot from the lakehouse provisioner).
 *      On Serverless the native form (LOCATION + CREDENTIAL, no TYPE=HADOOP) is
 *      used. Idempotent: DROP-if-exists then CREATE.
 *   4. Runs `SELECT 1` on the endpoint as a live connectivity + auth proof; the
 *      returned row is surfaced in the receipt.
 *
 * Grounded in Microsoft Learn:
 *   - Managed Identity storage access for Serverless:
 *     https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity
 *   - External tables / data sources on Serverless (native form, no HADOOP):
 *     https://learn.microsoft.com/azure/synapse-analytics/sql/develop-tables-external-tables
 *
 * no-fabric-dependency.md: the Azure-native lakehouse path always yields an
 * abfss adlsRoot, so this works with LOOM_DEFAULT_FABRIC_WORKSPACE unset. When
 * the lakehouse used the opt-in Fabric (OneLake) backend, adlsRoot is absent and
 * this provisioner returns an honest remediation rather than a stub.
 */
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';
import {
  executeQuery as synapseExec,
  serverlessTarget,
  getSynapseSqlSuffix,
} from '@/lib/azure/synapse-sql-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/** Content shape the install engine's pairing rule stamps onto the item. */
interface SynapseServerlessSqlPoolContent {
  /** abfss://<container>@<dfsHost>/lakehouses/<name> — the lakehouse ADLS root. */
  adlsRoot?: string | null;
  /** Cosmos item id of the parent lakehouse (provenance). */
  lakehouseItemId?: string;
  /** Parent lakehouse display name (used to name the data source). */
  lakehouseName?: string;
  // ── Mirror-paired fields (set by ITEM_PAIRING_RULES['mirrored-database']) ──
  /** Cosmos item id of the parent mirrored-database (presence ⇒ mirror branch). */
  mirrorItemId?: string;
  /** Parent mirror display name (used to name the per-mirror DB + data source). */
  mirrorName?: string;
  /** Per-mirror Serverless user database name (e.g. loom_mirror_<name>). */
  database?: string;
  /** Mirrored tables — one OPENROWSET CSV view is created per entry. */
  tables?: Array<{ schema: string; table: string }>;

  // ── Databricks-UC-mirror fields (set by ITEM_PAIRING_RULES['mirrored-databricks']) ──
  /**
   * Cosmos item id of the parent mirrored-databricks. Presence ⇒ the
   * Databricks-UC branch: instead of relative CSV folders under one adlsRoot,
   * each UC table is an EXTERNAL Delta table at its own absolute abfss
   * `storageLocation`, so we register one external data source per distinct
   * storage-account root and one OPENROWSET(...FORMAT='delta') view per table.
   * This is the Azure-native "shortcut" that makes the mounted UC catalog
   * queryable in Loom — no Microsoft Fabric / OneLake.
   */
  databricksMirrorItemId?: string;
  /** Parent mirror display name (used to name the per-mirror DB + data sources). */
  databricksMirrorName?: string;
  /** Unity Catalog name being mirrored (provenance + receipt). */
  ucCatalogName?: string;
  /**
   * UC tables to expose as Delta OPENROWSET views. `storageLocation` is the
   * absolute abfss:// Delta root (the table's `_delta_log` parent) returned by
   * the UC tables API for EXTERNAL/MANAGED Delta tables.
   */
  ucTables?: Array<{ schema: string; table: string; storageLocation: string; format?: string }>;
}

/** Parse an abfss:// (or https dfs) Delta storage location into a
 * { root, relative } pair: `root` is the container@account.dfs.core root
 * usable as an EXTERNAL DATA SOURCE LOCATION; `relative` is the path within
 * it (the Delta folder). Returns null when the URI can't be parsed (caller
 * then falls back to using the absolute location directly). */
export function splitAbfss(loc: string): { root: string; relative: string } | null {
  const m = /^abfss:\/\/([^@/]+)@([^/]+)(\/.*)?$/i.exec(loc.trim());
  if (m) {
    const [, container, host, path] = m;
    return { root: `abfss://${container}@${host}/`, relative: (path || '/').replace(/^\/+/, '') };
  }
  // https://<account>.dfs.core.windows.net/<container>/<path>
  const h = /^https?:\/\/([^/]+)\/([^/]+)(\/.*)?$/i.exec(loc.trim());
  if (h) {
    const [, host, container, path] = h;
    return { root: `abfss://${container}@${host}/`, relative: (path || '/').replace(/^\/+/, '') };
  }
  return null;
}

/** SQL-safe identifier fragment (letters/digits/underscore only). */
function safeIdent(s: string): string {
  return String(s || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'lakehouse';
}

/** True when a TDS error looks like an authn/authz failure (→ remediation). */
function isAuthError(e: any): boolean {
  const msg = (e?.message || String(e)).toLowerCase();
  return (
    e?.number === 18456 || // Login failed
    /\b(401|403)\b/.test(msg) ||
    /login failed|permission denied|not authorized|unauthorized|forbidden|does not have permission|cannot find the credential/.test(
      msg,
    )
  );
}

export const synapseSqlPoolProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = process.env.LOOM_SYNAPSE_WORKSPACE;

  // Honest Azure-side infra gate — name the exact env var + bicep output.
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason:
          'No Synapse Serverless workspace configured — cannot create the lakehouse SQL analytics endpoint.',
        remediation:
          'Set LOOM_SYNAPSE_WORKSPACE to the Synapse workspace name (the `synapseServerlessSqlEndpoint` output of ' +
          'platform/fiab/bicep/modules/landing-zone/synapse.bicep) and grant the Console UAMI Synapse SQL admin on it. ' +
          'No Microsoft Fabric required.',
        link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/on-demand-workspace-overview',
      },
      steps,
    };
  }

  const content = (input.content || {}) as SynapseServerlessSqlPoolContent;

  // ── Databricks-UC-mirror branch ───────────────────────────────────────────
  // Each UC table is an EXTERNAL Delta table whose `storageLocation` already
  // lives in ADLS Gen2. We make the mounted catalog queryable in Loom by
  // registering, per distinct storage-account root, one EXTERNAL DATA SOURCE +
  // WorkspaceIdentity (workspace MSI) credential, then one
  // OPENROWSET(... FORMAT='delta') view per table. This is the Azure-native
  // shortcut — Synapse Serverless reads the same Delta files the UC governs, no
  // Microsoft Fabric / OneLake. Grounded in Microsoft Learn:
  //   https://learn.microsoft.com/azure/synapse-analytics/sql/query-delta-lake-format
  if (content.databricksMirrorItemId) {
    return provisionDatabricksMirror(input, content, ws, steps);
  }

  const isMirror = !!content.mirrorItemId;
  const sourceLabel = isMirror ? 'mirror' : 'lakehouse';
  const adlsRoot = (content.adlsRoot || '').trim();
  if (!adlsRoot) {
    // The parent lakehouse used the opt-in Fabric (OneLake) backend, or its
    // ADLS root could not be resolved — honest gate (no stub).
    return {
      status: 'remediation',
      gate: {
        reason:
          `No ADLS Gen2 root for the paired ${sourceLabel} — the SQL analytics endpoint needs the ${sourceLabel} abfss location.`,
        remediation: isMirror
          ? 'Re-install the mirror on the Azure-native ADF-CDC backend (the default; LOOM_MIRROR_BACKEND unset or =adf-cdc) ' +
            'and set LOOM_BRONZE_URL (DLZ Bicep output) so the mirror Bronze root is published, then retry. The paired SQL ' +
            'endpoint targets that root via an external data source.'
          : 'Re-install the lakehouse on the Azure-native ADLS backend (the default; LOOM_LAKEHOUSE_BACKEND unset or =adls) ' +
            'so its abfss root is published, then retry. The paired SQL endpoint targets that root via an external data source.',
        link: 'https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction',
      },
      steps,
    };
  }

  // Mirror gets a dedicated per-mirror user database (loom_mirror_<name>, passed
  // in via content.database) and its own external data source so its OPENROWSET
  // views don't collide with the shared lakehouse database. Lakehouse keeps the
  // shared [loom_lakehouse] DB.
  const DB = isMirror
    ? (content.database || `loom_mirror_${safeIdent(content.mirrorName || input.displayName)}`)
        .replace(/[^A-Za-z0-9_]/g, '_')
        .slice(0, 128)
    : (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
  const DS = isMirror
    ? `loom_ds_mirror_${safeIdent(content.mirrorName || input.displayName)}`
    : `loom_ds_${safeIdent(content.lakehouseName || input.displayName)}`;
  const location = adlsRoot.endsWith('/') ? adlsRoot : `${adlsRoot}/`;
  const endpoint = `${ws}-ondemand.${getSynapseSqlSuffix()}`;

  // Step 1 — ensure the dedicated Serverless USER database (CREATE DATABASE
  // cannot run from inside the not-yet-existing target DB, so run in master).
  try {
    await synapseExec(
      serverlessTarget('master'),
      `IF DB_ID(N'${DB}') IS NULL EXEC('CREATE DATABASE [${DB}]');`,
    );
    steps.push(`Serverless user database [${DB}] ready on ${endpoint}.`);
  } catch (e: any) {
    if (isAuthError(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse Serverless rejected CREATE DATABASE: ${(e?.message || String(e)).slice(0, 160)}`,
          remediation:
            'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Synapse SQL Administrator role on the workspace ' +
            '(it must be the workspace AAD admin or hold CONTROL SERVER on the Serverless endpoint to create databases).',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, `Confirm the Synapse Serverless endpoint ${endpoint} is reachable and grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Synapse SQL Administrator role on the workspace (the ARM AAD admin alone does not create a serverless login for an MI — see the Serverless-SQL AAD login fix).`, { errorPrefix: `CREATE DATABASE [${DB}] failed: `, link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control', steps });
  }

  // Step 2 — credential (workspace MSI passthrough) + external data source.
  //
  // Run as DISCRETE, individually-diagnosed statements rather than one batch.
  // Serverless can fail CREATE EXTERNAL DATA SOURCE with SQL 15151 ("the
  // specified credential cannot be found or the user does not have permission")
  // when the scoped credential silently wasn't created — so we (a) ensure a
  // database master key exists (idempotent; some serverless credential paths
  // require it), (b) create the Managed-Identity credential and VERIFY the row
  // actually lands before referencing it, then (c) (re)create the external data
  // source. On any failure we surface the FULL error + which sub-step broke, so
  // the receipt is actionable instead of a misleading "grant CONTROL" hint (the
  // UAMI is typically already the workspace AAD admin).
  const userTarget = serverlessTarget(DB);
  const locLiteral = escapeSqlLiteral(location);
  const errText = (e: any) => (e?.message || String(e)).replace(/\s+/g, ' ').trim();
  let stage = 'master key';
  try {
    await synapseExec(
      userTarget,
      `IF NOT EXISTS (SELECT 1 FROM sys.symmetric_keys WHERE name = '##MS_DatabaseMasterKey##')\n` +
        `  EXEC('CREATE MASTER KEY');`,
    );

    stage = 'scoped credential';
    await synapseExec(
      userTarget,
      `IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = N'WorkspaceIdentity')\n` +
        `  EXEC('CREATE DATABASE SCOPED CREDENTIAL [WorkspaceIdentity] WITH IDENTITY = ''Managed Identity''');`,
    );
    // Verify the credential actually exists — a silent no-op here is exactly
    // what produces the downstream 15151 on CREATE EXTERNAL DATA SOURCE.
    const check = await synapseExec(
      userTarget,
      `SELECT COUNT(*) AS n FROM sys.database_scoped_credentials WHERE name = N'WorkspaceIdentity';`,
    );
    const credRows = Number(check?.rows?.[0]?.[0] ?? 0);
    if (credRows < 1) {
      return {
        status: 'failed',
        error:
          `Scoped credential [WorkspaceIdentity] did not materialise in [${DB}] after CREATE (sys.database_scoped_credentials ` +
          `count=${credRows}). The external data source cannot be created without it.`,
        steps,
      };
    }
    steps.push(`Scoped credential [WorkspaceIdentity] present in [${DB}] (Managed Identity).`);

    stage = 'external data source';
    await synapseExec(
      userTarget,
      `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'${DS}')\n` +
        `  EXEC('DROP EXTERNAL DATA SOURCE [${DS}]');\n` +
        `EXEC('CREATE EXTERNAL DATA SOURCE [${DS}] WITH (LOCATION = ''${locLiteral}'', CREDENTIAL = [WorkspaceIdentity])');`,
    );
    steps.push(`External data source [${DS}] → ${location} (credential: WorkspaceIdentity / Managed Identity).`);
  } catch (e: any) {
    const msg = errText(e);
    if (isAuthError(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse Serverless rejected the ${stage} step: ${msg.slice(0, 220)}`,
          remediation:
            `The Console UAMI must be the Synapse workspace Entra (AAD) admin — or hold CONTROL on [${DB}] — AND the ` +
            `Synapse workspace SYSTEM-assigned MSI must have Storage Blob Data Contributor on the DLZ ADLS account ` +
            `(landing-zone/synapse-storage-rbac.bicep). If both are already in place, this is the serverless ` +
            `Managed-Identity credential / master-key path; full error: ${msg.slice(0, 400)}`,
          link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity',
        },
        steps,
      };
    }
    return resolveInfraResidual(msg, `The Console UAMI must be the Synapse workspace Entra (AAD) admin (or hold CONTROL on [${DB}]) and the Synapse workspace system MSI must have Storage Blob Data Contributor on the DLZ ADLS account (landing-zone/synapse-storage-rbac.bicep).`, { reason: `Synapse Serverless rejected the ${stage} step.`, errorPrefix: `Serverless ${stage} step failed: `, link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity', steps });
  }

  // Step 2.5 (mirror only) — EXTERNAL FILE FORMAT (CSV, skip-header) + one
  // OPENROWSET view per mirrored table. The mirror engine lands each table as
  // CSV at <mirrorRoot>/<schema>.<table>/snapshot.csv (+ delta-<ts>.csv); the
  // external data source LOCATION is <mirrorRoot>, so each view's BULK path is
  // the relative '<schema>.<table>/' folder (trailing slash reads the snapshot
  // and every delta together as one logical table). Views (not native external
  // tables) because CSV external tables require explicit column definitions that
  // aren't known at provision time; an OPENROWSET view infers the schema at query
  // time from HEADER_ROW. Grounded in Microsoft Learn:
  //   https://learn.microsoft.com/azure/synapse-analytics/sql/query-single-csv-file
  if (isMirror) {
    const tables = content.tables || [];
    const FMT = `CsvWithHeader_${safeIdent(content.mirrorName || input.displayName)}`;
    const fmtDdl =
      `IF NOT EXISTS (SELECT 1 FROM sys.external_file_formats WHERE name = N'${FMT}')\n` +
      `  EXEC('CREATE EXTERNAL FILE FORMAT [${FMT}] WITH (FORMAT_TYPE = DELIMITEDTEXT, ` +
      `FORMAT_OPTIONS ( FIELD_TERMINATOR = '','', FIRST_ROW = 2 ))');`;
    try {
      await synapseExec(userTarget, fmtDdl);
      steps.push(`External file format [${FMT}] (CSV / skip header) ready.`);
    } catch (e: any) {
      steps.push(`File format [${FMT}] note: ${(e?.message || String(e)).slice(0, 100)}.`);
    }

    let viewsMade = 0;
    for (const t of tables) {
      const viewName = `${safeIdent(t.schema)}_${safeIdent(t.table)}`;
      const bulk = escapeSqlLiteral(`${t.schema}.${t.table}/`);
      const viewDdl =
        `CREATE OR ALTER VIEW [dbo].[${viewName}] AS\n` +
        `SELECT * FROM OPENROWSET(\n` +
        `  BULK '${bulk}', DATA_SOURCE = '${DS}',\n` +
        `  FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE\n` +
        `) AS rows;`;
      try {
        await synapseExec(userTarget, viewDdl);
        viewsMade += 1;
        steps.push(`View [dbo].[${viewName}] → ${t.schema}.${t.table}/ ready.`);
      } catch (e: any) {
        steps.push(`View [dbo].[${viewName}] note: ${(e?.message || String(e)).slice(0, 100)}.`);
      }
    }
    if (!tables.length) {
      steps.push(
        'No mirrored tables listed on the mirror — the per-table views are created once the mirror config lists ' +
          'explicit tables. The endpoint, database, and data source are ready for ad-hoc OPENROWSET queries now.',
      );
    }

    // Real-table receipt — SELECT TOP 10 over the first view (non-fatal). A
    // zero-row result is honest: the mirror's Start hasn't populated Bronze yet.
    const first = tables[0];
    if (first) {
      const viewName = `${safeIdent(first.schema)}_${safeIdent(first.table)}`;
      try {
        const probe = await synapseExec(userTarget, `SELECT TOP 10 * FROM [dbo].[${viewName}];`);
        steps.push(
          `SELECT TOP 10 [dbo].[${viewName}] → ${probe.rowCount} row(s), ${probe.columns.length} col(s) ` +
            `(${probe.executionMs}ms).` +
            (probe.rowCount === 0
              ? ' Mirror not yet populated — Start the mirror to land Bronze CSV, then rows appear.'
              : ' Live rows confirmed (receipt).'),
        );
      } catch (e: any) {
        steps.push(
          `Real-table probe [dbo].[${viewName}] note: ${(e?.message || String(e)).slice(0, 140)}. ` +
            'Start the mirror to populate Bronze; the view then returns rows.',
        );
      }
    }
    steps.push(`Mirror SQL endpoint: [${DB}] on ${endpoint} with ${viewsMade} table view(s) over ${location}.`);
  }

  // Step 3 — SELECT 1 live connectivity + auth proof. The returned row is the
  // receipt evidence the endpoint is reachable. Non-fatal: a cold pool can be
  // slow on the very first hit, but the data source above is already created.
  try {
    const probe = await synapseExec(userTarget, `SELECT 1 AS smoke, SUSER_NAME() AS upn, DB_NAME() AS db;`);
    const row = probe.rows?.[0];
    steps.push(
      `SELECT 1 → live row ${row ? JSON.stringify(row) : '[]'} (cols: ${probe.columns.join(', ')}; ${probe.executionMs}ms). ` +
        'Endpoint reachable.',
    );
  } catch (e: any) {
    steps.push(
      `SELECT 1 warm-up note: ${(e?.message || String(e)).slice(0, 160)} — pool may be cold on first hit; ` +
        'the external data source is created and the endpoint is queryable from F14.',
    );
  }

  return {
    status: 'created',
    resourceId: endpoint,
    secondaryIds: {
      backend: 'synapse-serverless',
      endpoint,
      database: DB,
      dataSource: DS,
      adlsRoot: location,
      ...(content.lakehouseItemId ? { lakehouseItemId: content.lakehouseItemId } : {}),
      ...(content.mirrorItemId ? { mirrorItemId: content.mirrorItemId } : {}),
    },
    steps,
  };
};

/**
 * Pair a Synapse Serverless SQL endpoint over a Databricks Unity Catalog
 * mirror. Creates a per-mirror user database, then for every distinct ADLS
 * storage-account root a credential-backed EXTERNAL DATA SOURCE, then one
 * OPENROWSET(... FORMAT='delta') view per UC table at its relative Delta path.
 * The result is that `mirrored-databricks` mounts a catalog that is queryable
 * as T-SQL in Loom — the missing "pair an endpoint / create a shortcut" half of
 * the item (audit H8). Real TDS only; honest gates on missing data / auth.
 */
async function provisionDatabricksMirror(
  input: { displayName: string; cosmosItemId?: string },
  content: SynapseServerlessSqlPoolContent,
  ws: string,
  steps: string[],
): Promise<ProvisionResult> {
  const name = content.databricksMirrorName || input.displayName;
  const ucTables = (content.ucTables || []).filter((t) => t && t.storageLocation && t.table);
  if (ucTables.length === 0) {
    return {
      status: 'remediation',
      gate: {
        reason:
          `No queryable Unity Catalog Delta tables found for catalog "${content.ucCatalogName || name}" — ` +
          'nothing to mount as a SQL endpoint.',
        remediation:
          'The mounted UC catalog must contain at least one Delta table with a resolvable storage location ' +
          '(EXTERNAL tables, or MANAGED tables whose storage_location the UC API returns). MANAGED tables on a ' +
          'metastore-managed storage root the Synapse MSI cannot read are skipped; expose the data as an EXTERNAL ' +
          'Delta table on an ADLS Gen2 location the Synapse workspace MSI can read (Storage Blob Data Reader).',
        link: 'https://learn.microsoft.com/azure/databricks/connect/unity-catalog/external-locations',
      },
      steps,
    };
  }

  const DB = `loom_dbxmirror_${safeIdent(name)}`.slice(0, 128);
  const endpoint = `${ws}-ondemand.${getSynapseSqlSuffix()}`;
  const userTarget = serverlessTarget(DB);

  // Step 1 — per-mirror user database (CREATE DATABASE runs from master).
  try {
    await synapseExec(
      serverlessTarget('master'),
      `IF DB_ID(N'${DB}') IS NULL EXEC('CREATE DATABASE [${DB}]');`,
    );
    steps.push(`Serverless user database [${DB}] ready on ${endpoint}.`);
  } catch (e: any) {
    if (isAuthError(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse Serverless rejected CREATE DATABASE: ${(e?.message || String(e)).slice(0, 160)}`,
          remediation:
            'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Synapse SQL Administrator role on the workspace ' +
            '(it must be the workspace AAD admin or hold CONTROL SERVER on the Serverless endpoint to create databases).',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, `Confirm the Synapse Serverless endpoint ${endpoint} is reachable and grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Synapse SQL Administrator role on the workspace (the ARM AAD admin alone does not create a serverless login for an MI — see the Serverless-SQL AAD login fix).`, { errorPrefix: `CREATE DATABASE [${DB}] failed: `, link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control', steps });
  }

  // Step 2 — WorkspaceIdentity credential (workspace MSI passthrough). The same
  // credential serves every external data source below.
  try {
    await synapseExec(
      userTarget,
      `IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = N'WorkspaceIdentity')\n` +
        `  EXEC('CREATE DATABASE SCOPED CREDENTIAL [WorkspaceIdentity] WITH IDENTITY = ''Managed Identity''');`,
    );
    steps.push('Database scoped credential [WorkspaceIdentity] (workspace MSI) ready.');
  } catch (e: any) {
    if (isAuthError(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse Serverless rejected CREATE DATABASE SCOPED CREDENTIAL: ${(e?.message || String(e)).slice(0, 160)}`,
          remediation:
            `Grant the Console UAMI CONTROL on the [${DB}] database, and ensure the Synapse workspace system MSI has ` +
            'Storage Blob Data Reader on the ADLS account(s) backing the Databricks Unity Catalog external locations.',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, `Grant the Console UAMI CONTROL on the [${DB}] database, and ensure the Synapse workspace system MSI has Storage Blob Data Reader on the ADLS account(s) backing the Databricks Unity Catalog external locations.`, { errorPrefix: 'CREATE DATABASE SCOPED CREDENTIAL failed: ', link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity', steps });
  }

  // Step 3 — one EXTERNAL DATA SOURCE per distinct storage-account root, then
  // one OPENROWSET(...FORMAT='delta') view per UC table.
  const dsByRoot = new Map<string, string>(); // root → data source name
  let dsMade = 0;
  let viewsMade = 0;
  let firstView: string | null = null;
  for (const t of ucTables) {
    const split = splitAbfss(t.storageLocation);
    // Resolve a data source for this table's root (create once per root).
    let ds: string | undefined;
    let relative: string | null = null;
    if (split) {
      relative = split.relative;
      ds = dsByRoot.get(split.root);
      if (!ds) {
        ds = `loom_ds_dbx_${dsMade}_${safeIdent(name)}`.slice(0, 120);
        const locLiteral = escapeSqlLiteral(split.root);
        const dsDdl =
          `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'${ds}')\n` +
          `  EXEC('DROP EXTERNAL DATA SOURCE [${ds}]');\n` +
          `EXEC('CREATE EXTERNAL DATA SOURCE [${ds}] WITH (LOCATION = ''${locLiteral}'', CREDENTIAL = [WorkspaceIdentity])');`;
        try {
          await synapseExec(userTarget, dsDdl);
          dsByRoot.set(split.root, ds);
          dsMade += 1;
          steps.push(`External data source [${ds}] → ${split.root} (credential: WorkspaceIdentity).`);
        } catch (e: any) {
          steps.push(`Data source for ${split.root} note: ${(e?.message || String(e)).slice(0, 120)}.`);
          ds = undefined;
        }
      }
    }

    const viewName = `${safeIdent(t.schema)}_${safeIdent(t.table)}`;
    // With a data source: relative Delta path. Without one (unparseable URI):
    // fall back to the absolute location directly in BULK (no DATA_SOURCE).
    const viewDdl =
      ds && relative !== null
        ? `CREATE OR ALTER VIEW [dbo].[${viewName}] AS\n` +
          `SELECT * FROM OPENROWSET(\n` +
          `  BULK '${escapeSqlLiteral(relative)}', DATA_SOURCE = '${ds}', FORMAT = 'delta'\n` +
          `) AS rows;`
        : `CREATE OR ALTER VIEW [dbo].[${viewName}] AS\n` +
          `SELECT * FROM OPENROWSET(\n` +
          `  BULK '${escapeSqlLiteral(t.storageLocation)}', FORMAT = 'delta'\n` +
          `) AS rows;`;
    try {
      await synapseExec(userTarget, viewDdl);
      viewsMade += 1;
      if (!firstView) firstView = viewName;
      steps.push(`View [dbo].[${viewName}] → ${t.schema}.${t.table} (Delta).`);
    } catch (e: any) {
      steps.push(`View [dbo].[${viewName}] note: ${(e?.message || String(e)).slice(0, 120)}.`);
    }
  }

  // Step 4 — real-row receipt over the first view (non-fatal).
  if (firstView) {
    try {
      const probe = await synapseExec(userTarget, `SELECT TOP 10 * FROM [dbo].[${firstView}];`);
      steps.push(
        `SELECT TOP 10 [dbo].[${firstView}] → ${probe.rowCount} row(s), ${probe.columns.length} col(s) ` +
          `(${probe.executionMs}ms).` +
          (probe.rowCount > 0 ? ' Live Delta rows confirmed (receipt).' : ' View resolves; table currently empty.'),
      );
    } catch (e: any) {
      steps.push(`Real-table probe [dbo].[${firstView}] note: ${(e?.message || String(e)).slice(0, 140)}.`);
    }
  }

  steps.push(
    `Databricks UC mirror SQL endpoint: [${DB}] on ${endpoint} with ${viewsMade} Delta view(s) ` +
      `over ${dsMade} storage root(s) (catalog ${content.ucCatalogName || name}).`,
  );

  return {
    status: 'created',
    resourceId: endpoint,
    secondaryIds: {
      backend: 'synapse-serverless',
      endpoint,
      database: DB,
      viewCount: String(viewsMade),
      ...(content.databricksMirrorItemId ? { databricksMirrorItemId: content.databricksMirrorItemId } : {}),
    },
    steps,
  };
}
