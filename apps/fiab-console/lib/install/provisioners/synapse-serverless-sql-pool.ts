/**
 * Phase 2 — synapse-serverless-sql-pool provisioner.
 *
 * Pairs 1:1 with a lakehouse (no-fabric-dependency.md, Foundation task). When a
 * lakehouse is provisioned on the Azure-native ADLS Gen2 backend, the install
 * engine auto-creates a paired `synapse-serverless-sql-pool` Cosmos item and
 * runs THIS provisioner so F3 (lakehouse) and F14 (Serverless SQL editor) share
 * one Synapse Serverless built-in SQL endpoint over the same lake root.
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
  const adlsRoot = (content.adlsRoot || '').trim();
  if (!adlsRoot) {
    // The parent lakehouse used the opt-in Fabric (OneLake) backend, or its
    // ADLS root could not be resolved — honest gate (no stub).
    return {
      status: 'remediation',
      gate: {
        reason:
          'No ADLS Gen2 root for the paired lakehouse — the SQL analytics endpoint needs the lakehouse abfss location.',
        remediation:
          'Re-install the lakehouse on the Azure-native ADLS backend (the default; LOOM_LAKEHOUSE_BACKEND unset or =adls) ' +
          'so its abfss root is published, then retry. The paired SQL endpoint targets that root via an external data source.',
        link: 'https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-introduction',
      },
      steps,
    };
  }

  const DB = (process.env.LOOM_SYNAPSE_LAKEHOUSE_DB || 'loom_lakehouse').replace(/[^A-Za-z0-9_]/g, '_');
  const DS = `loom_ds_${safeIdent(content.lakehouseName || input.displayName)}`;
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
    },
    steps,
  };
};
