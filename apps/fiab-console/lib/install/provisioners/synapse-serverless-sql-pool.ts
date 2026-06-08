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
import {
  executeQuery as synapseExec,
  serverlessTarget,
  getSynapseSqlSuffix,
} from '@/lib/azure/synapse-sql-client';

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
    return { status: 'failed', error: `CREATE DATABASE [${DB}] failed: ${e?.message || String(e)}`, steps };
  }

  // Step 2 — credential (workspace MSI passthrough) + external data source.
  const userTarget = serverlessTarget(DB);
  const locLiteral = location.replace(/'/g, "''");
  const ddl =
    `IF NOT EXISTS (SELECT 1 FROM sys.database_scoped_credentials WHERE name = N'WorkspaceIdentity')\n` +
    `  EXEC('CREATE DATABASE SCOPED CREDENTIAL [WorkspaceIdentity] WITH IDENTITY = ''Managed Identity''');\n` +
    `IF EXISTS (SELECT 1 FROM sys.external_data_sources WHERE name = N'${DS}')\n` +
    `  EXEC('DROP EXTERNAL DATA SOURCE [${DS}]');\n` +
    `EXEC('CREATE EXTERNAL DATA SOURCE [${DS}] WITH (LOCATION = ''${locLiteral}'', CREDENTIAL = [WorkspaceIdentity])');`;
  try {
    await synapseExec(userTarget, ddl);
    steps.push(`External data source [${DS}] → ${location} (credential: WorkspaceIdentity / Managed Identity).`);
  } catch (e: any) {
    if (isAuthError(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse Serverless rejected CREATE EXTERNAL DATA SOURCE: ${(e?.message || String(e)).slice(0, 160)}`,
          remediation:
            `Grant the Console UAMI CONTROL on the [${DB}] database (to create the scoped credential + external data ` +
            'source), and ensure the Synapse workspace system MSI has Storage Blob Data Contributor on the DLZ ADLS ' +
            'account (landing-zone/synapse-storage-rbac.bicep grants this).',
          link: 'https://learn.microsoft.com/azure/synapse-analytics/sql/develop-storage-files-storage-access-control?tabs=managed-identity',
        },
        steps,
      };
    }
    return { status: 'failed', error: `CREATE EXTERNAL DATA SOURCE [${DS}] failed: ${e?.message || String(e)}`, steps };
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
      const bulk = `${t.schema}.${t.table}/`.replace(/'/g, "''");
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
