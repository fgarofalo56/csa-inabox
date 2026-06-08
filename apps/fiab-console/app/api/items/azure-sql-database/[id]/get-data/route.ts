/**
 * POST /api/items/azure-sql-database/[id]/get-data
 *
 * Backs the editor ribbon's "Get data ▾" menu (Copy data / New pipeline /
 * New dataflow). It opens the REAL Azure Data Factory Studio ingestion
 * surfaces with THIS database pre-wired as the copy SINK — no toasts, real
 * navigation.
 *
 *   body { action: 'copy-data' | 'new-pipeline' | 'new-dataflow',
 *          family, server, serverFqdn?, database }
 *   → { ok, url, factoryName, privateNetworkGate?, factoryMiPrincipalHint?,
 *       pipelineName?, dataflowName?, linkedServiceName?, datasetName? }
 *
 * Per-action behaviour
 * --------------------
 *   copy-data    : no ADF artifact created — returns the Copy Data Tool
 *                  deep-link (the stepped wizard creates source + sink from
 *                  scratch; the DB linked service is available as a connection).
 *   new-pipeline : idempotently upserts an AzureSqlDatabase linked service
 *                  (SystemAssignedManagedIdentity auth) + an AzureSqlTable
 *                  dataset bound to it + a one-Copy-activity pipeline whose
 *                  sink is that dataset, then returns the pipeline authoring
 *                  deep-link. The user drags a source onto the canvas and runs.
 *   new-dataflow : same linked service + dataset, plus a MappingDataFlow with
 *                  a single sink stream targeting the dataset; returns the
 *                  dataflow authoring deep-link.
 *
 * Azure-native, no Microsoft Fabric. The factory is the env-pinned default
 * (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME) — when unset we 503 with
 * the exact missing var so the UI shows an honest infra-gate MessageBar.
 * The ADF factory MI must be a SQL Entra user with db_datareader/db_datawriter
 * on the target DB for the copy to write — surfaced as a hint, never a mock.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  adfConfigGate, factoryResourceId, defaultFactoryName, getDefaultFactory,
  upsertLinkedService, upsertDataset, upsertPipeline, upsertDataFlow,
} from '@/lib/azure/adf-client';
import { adfStudioBase, getSqlSuffix } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Action = 'copy-data' | 'new-pipeline' | 'new-dataflow';
type Family = 'azure-sql' | 'managed-instance' | 'postgres';
const ACTIONS = new Set<Action>(['copy-data', 'new-pipeline', 'new-dataflow']);

/** ARM artifact names allow letters, digits, _ (≤260). Sanitise user input. */
function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
}

/** Resolve the SQL server FQDN (use the provided one or build it per cloud). */
function resolveFqdn(server: string, serverFqdn?: string): string {
  if (serverFqdn && serverFqdn.includes('.')) return serverFqdn;
  return server.includes('.') ? server : `${server}.${getSqlSuffix()}`;
}

/** Encoded `factory=` deep-link query param for ADF Studio. */
function factoryParam(): string {
  return `factory=${encodeURIComponent(factoryResourceId())}`;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest config gate — names the exact missing env var.
  const g = adfConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured',
        error: `Azure Data Factory not configured for this deployment: set ${g.missing}. ` +
          'The factory is deployed by platform/fiab/bicep/modules/landing-zone/adf.bicep.',
        missing: g.missing,
      },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '') as Action;
  const family = String(body?.family || 'azure-sql') as Family;
  const server = String(body?.server || '').trim();
  const serverFqdn = String(body?.serverFqdn || '').trim();
  const database = String(body?.database || '').trim();

  if (!ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: 'action must be copy-data | new-pipeline | new-dataflow' }, { status: 400 });
  }
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });

  const factoryName = defaultFactoryName();

  // Detect whether the factory's management plane is private (publicNetworkAccess
  // Disabled) so the UI can warn the user they need corporate VPN / Bastion to
  // reach ADF Studio. A read failure here is non-fatal — default to "private"
  // because adf.bicep deploys it Disabled.
  let privateNetworkGate = true;
  try {
    const f = await getDefaultFactory();
    privateNetworkGate = (f.properties?.publicNetworkAccess || 'Disabled') !== 'Enabled';
  } catch {
    privateNetworkGate = true;
  }

  const factoryMiPrincipalHint =
    `Grant the ADF factory's managed identity db_datareader + db_datawriter on [${database}] ` +
    `(Microsoft Entra): CREATE USER [${factoryName}] FROM EXTERNAL PROVIDER; ` +
    `ALTER ROLE db_datareader ADD MEMBER [${factoryName}]; ALTER ROLE db_datawriter ADD MEMBER [${factoryName}];`;

  try {
    // ── Copy Data Tool — no artifact; the wizard builds source + sink. ──
    if (action === 'copy-data') {
      const url = `${adfStudioBase()}/copyDataTool?${factoryParam()}`;
      return NextResponse.json({
        ok: true, action, url, factoryName, privateNetworkGate, factoryMiPrincipalHint,
      });
    }

    // New pipeline / dataflow create real sink artifacts. Wired for the SQL
    // family today (AzureSqlDatabase linked service + AzureSqlTable dataset).
    if (family !== 'azure-sql') {
      return NextResponse.json(
        {
          ok: false,
          error: `New ${action === 'new-pipeline' ? 'pipeline' : 'dataflow'} sink is wired for Azure SQL today. ` +
            `Use "Copy data" for ${family} — the Copy Data Tool builds the ${family} sink connection in the wizard.`,
        },
        { status: 400 },
      );
    }

    const fqdn = resolveFqdn(server, serverFqdn);
    const lsName = safeName(`loom_sqldb_${server}_${database}`);
    const dsName = safeName(`loom_ds_${server}_${database}`);

    // 1) AzureSqlDatabase linked service — SystemAssignedManagedIdentity auth
    //    (no secret on disk; the factory MI authenticates to the DB).
    await upsertLinkedService(lsName, {
      name: lsName,
      properties: {
        type: 'AzureSqlDatabase',
        description: `Loom Get-data sink for ${fqdn} / ${database}`,
        annotations: ['loom', 'get-data-sink'],
        typeProperties: {
          connectionString:
            `Integrated Security=False;Encrypt=True;Connection Timeout=30;` +
            `Data Source=tcp:${fqdn},1433;Initial Catalog=${database}`,
          authenticationType: 'SystemAssignedManagedIdentity',
        },
      },
    });

    // 2) AzureSqlTable dataset bound to that linked service. The target table
    //    is selected in the designer (real ADF flow), so it carries an
    //    optional `tableName` parameter rather than a hard-coded table.
    await upsertDataset(dsName, {
      name: dsName,
      properties: {
        type: 'AzureSqlTable',
        description: `Loom Get-data sink table on ${database}`,
        annotations: ['loom', 'get-data-sink'],
        linkedServiceName: { referenceName: lsName, type: 'LinkedServiceReference' },
        parameters: { tableName: { type: 'string', defaultValue: '' } },
        typeProperties: { tableName: { value: "@dataset().tableName", type: 'Expression' } },
      },
    });

    const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);

    if (action === 'new-pipeline') {
      const pipelineName = safeName(`loom_ingest_${database}_${ts}`);
      // One Copy activity: sink = our AzureSqlTable dataset (AzureSqlSink). The
      // SOURCE is left for the user to drop on the canvas — this matches the
      // real ADF "blank pipeline with a Copy activity" starting point.
      await upsertPipeline(pipelineName, {
        name: pipelineName,
        properties: {
          description: `Loom Get-data ingestion into ${database} (sink pre-wired). Add a source on the canvas, then Debug/Run.`,
          annotations: ['loom', 'get-data-sink'],
          activities: [
            {
              name: 'CopyToDatabase',
              type: 'Copy',
              dependsOn: [],
              policy: { timeout: '0.12:00:00', retry: 0, secureOutput: false, secureInput: false },
              typeProperties: {
                sink: { type: 'AzureSqlSink', writeBehavior: 'insert', disableMetricsCollection: false },
              },
              // Sink dataset reference (parameterised table — picked in designer).
              outputs: [
                { referenceName: dsName, type: 'DatasetReference', parameters: { tableName: '' } },
              ],
            },
          ],
        },
      });
      const url = `${adfStudioBase()}/authoring/pipeline/${encodeURIComponent(pipelineName)}?${factoryParam()}`;
      return NextResponse.json({
        ok: true, action, url, factoryName, privateNetworkGate, factoryMiPrincipalHint,
        pipelineName, linkedServiceName: lsName, datasetName: dsName,
      });
    }

    // action === 'new-dataflow'
    const dataflowName = safeName(`loom_df_${database}_${ts}`);
    await upsertDataFlow(dataflowName, {
      name: dataflowName,
      properties: {
        type: 'MappingDataFlow',
        description: `Loom Get-data Mapping Data Flow — sink into ${database}.`,
        annotations: ['loom', 'get-data-sink'],
        typeProperties: {
          sources: [],
          sinks: [
            { name: 'sinkToSqlDb', dataset: { referenceName: dsName, type: 'DatasetReference' } },
          ],
          transformations: [],
          scriptLines: [
            'sink(allowSchemaDrift: true,',
            '  validateSchema: false,',
            '  deletable:false,',
            '  insertable:true,',
            '  updateable:false,',
            '  upsertable:false,',
            '  skipDuplicateMapInputs: true,',
            '  skipDuplicateMapOutputs: true) ~> sinkToSqlDb',
          ],
        },
      },
    });
    const url = `${adfStudioBase()}/authoring/dataflow/${encodeURIComponent(dataflowName)}?${factoryParam()}`;
    return NextResponse.json({
      ok: true, action, url, factoryName, privateNetworkGate, factoryMiPrincipalHint,
      dataflowName, linkedServiceName: lsName, datasetName: dsName,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
