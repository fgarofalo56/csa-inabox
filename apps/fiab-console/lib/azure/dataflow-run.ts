/**
 * Dataflow Gen2 — Azure-native run dispatcher.
 *
 * Compiles an authored Power Query (M) mashup into an ADF `WranglingDataFlow`
 * and runs it via an `ExecuteWranglingDataflow` activity on ADF Spark. The
 * authored output query is written to the chosen destination (ADLS Gen2
 * Parquet/CSV or an Azure SQL table) by materialising the matching ADF
 * dataset + linked service, then wiring it as the dataflow sink.
 *
 * This is the DEFAULT, no-Fabric backend (LOOM_DATAFLOW_BACKEND unset or
 * 'adf'). The Fabric path is strictly opt-in (LOOM_DATAFLOW_BACKEND=fabric +
 * a bound LOOM_DEFAULT_FABRIC_WORKSPACE) and gated honestly when not present.
 *
 * No mocks — every step is a real ARM call against the DLZ Data Factory.
 */

import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  adfConfigGate,
  upsertLinkedService,
  upsertDataset,
  upsertWranglingDataFlow,
  runWranglingDataFlow,
  type WranglingSink,
} from '@/lib/azure/adf-client';
import { parseSharedQueries, type DataflowSink } from '@/lib/components/pipeline/dataflow/m-script';
import type { WorkspaceItem } from '@/lib/types/workspace';

export type RunResult =
  | { ok: true; backend: 'adf'; runId: string; pipelineName: string; dataFlowName: string; outputQuery: string }
  | { ok: false; status: number; error: string; hint?: string };

function fromB64(b: string): string {
  try { return Buffer.from(b, 'base64').toString('utf-8'); } catch { return ''; }
}

/** Extract the Power Query M script from a Cosmos dataflow item's definition. */
function extractM(item: WorkspaceItem): string | null {
  const def = (item.state as any)?.definition;
  const parts: Array<{ path?: string; payload?: string }> = def?.parts || [];
  const main =
    parts.find((p) => /mashup\.(pq|m)$/i.test(p.path || '')) ||
    parts.find((p) => /\.(pq|m)$/i.test(p.path || '')) ||
    parts[0];
  if (main?.payload) return fromB64(main.payload);
  return null;
}

/** Resolve the DLZ ADLS Gen2 account + dfs endpoint base from env. */
function resolveAdls(): { account: string; dfsBase: string } | null {
  for (const env of ['LOOM_BRONZE_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL', 'LOOM_LANDING_URL']) {
    const url = process.env[env];
    const m = url?.match(/^(https:\/\/([^/]+))\//i);
    if (m) return { account: m[2].split('.')[0], dfsBase: m[1] };
  }
  const acct = process.env.LOOM_ADLS_ACCOUNT;
  if (acct) {
    const suffix = process.env.AZURE_CLOUD === 'AzureUSGovernment' ? 'core.usgovcloudapi.net' : 'core.windows.net';
    return { account: acct, dfsBase: `https://${acct}.dfs.${suffix}` };
  }
  return null;
}

/**
 * Materialise the ADF dataset + linked service for the configured sink and
 * return the WranglingSink binding. Returns a structured gate when the
 * required Azure infra env is missing.
 */
async function buildSink(
  itemId: string,
  outputQuery: string,
  sink: DataflowSink,
): Promise<{ sink: WranglingSink } | { gate: { status: number; error: string; hint: string } }> {
  const datasetName = `loom-pqsink-${itemId.slice(0, 8)}`;
  if (sink.type === 'adls') {
    const adls = resolveAdls();
    if (!adls) {
      return {
        gate: {
          status: 503,
          error: 'ADLS Gen2 destination is not configured in this deployment.',
          hint: 'Set LOOM_BRONZE_URL (or LOOM_ADLS_ACCOUNT) on the Console app — deployed by platform/fiab/bicep/modules/landing-zone/storage.bicep.',
        },
      };
    }
    const lsName = 'loom-adls-mi';
    await upsertLinkedService(lsName, {
      name: lsName,
      properties: {
        type: 'AzureBlobFS',
        description: 'Loom ADLS Gen2 (factory managed identity auth).',
        // No credential field → ADF authenticates with the factory's
        // system-assigned MI (granted Storage Blob Data Contributor in bicep).
        typeProperties: { url: adls.dfsBase },
      },
    });
    const container = sink.container || 'silver';
    const folderPath = (sink.path || `dataflows/${itemId}`).replace(/^\/+|\/+$/g, '');
    const format = sink.format || 'parquet';
    await upsertDataset(datasetName, {
      name: datasetName,
      properties: {
        type: format === 'csv' ? 'DelimitedText' : 'Parquet',
        linkedServiceName: { referenceName: lsName, type: 'LinkedServiceReference' },
        typeProperties: {
          location: { type: 'AzureBlobFSLocation', fileSystem: container, folderPath },
          ...(format === 'csv' ? { columnDelimiter: ',', firstRowAsHeader: true, quoteChar: '"' } : {}),
        },
      },
    });
    return { sink: { queryName: outputQuery, sinkName: 'AdlsSink', datasetName } };
  }
  // Azure SQL
  if (!sink.linkedService || !sink.table) {
    return {
      gate: {
        status: 400,
        error: 'Azure SQL destination requires a linked service and a table.',
        hint: 'Pick a SQL linked service and enter schema.table on the Output tab, then Run.',
      },
    };
  }
  await upsertDataset(datasetName, {
    name: datasetName,
    properties: {
      type: 'AzureSqlTable',
      linkedServiceName: { referenceName: sink.linkedService, type: 'LinkedServiceReference' },
      typeProperties: { schema: sink.schema || 'dbo', table: sink.table },
    },
  });
  return { sink: { queryName: outputQuery, sinkName: 'SqlSink', datasetName } };
}

/**
 * Run a Cosmos-backed Dataflow Gen2 item on the Azure-native ADF backend.
 * The caller has already verified the session.
 */
export async function runDataflowAdf(itemId: string, workspaceId: string): Promise<RunResult> {
  const gate = adfConfigGate();
  if (gate) {
    return {
      ok: false, status: 503,
      error: `ADF not configured — missing ${gate.missing}.`,
      hint: 'Set LOOM_SUBSCRIPTION_ID, LOOM_DLZ_RG and LOOM_ADF_NAME on the Console app (deployed by platform/fiab/bicep/modules/landing-zone/adf.bicep).',
    };
  }
  const items = await itemsContainer();
  const { resource } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
  if (!resource || resource.itemType !== 'dataflow') {
    return { ok: false, status: 404, error: 'dataflow not found' };
  }
  const m = extractM(resource);
  if (!m) {
    return { ok: false, status: 400, error: 'Dataflow has no Power Query (M) script to run. Author a query and Save first.' };
  }
  const queries = parseSharedQueries(m);
  if (queries.length === 0) {
    return { ok: false, status: 400, error: 'No queries found in the Power Query script. Add at least one query.' };
  }
  const sink = (resource.state as any)?.sink as DataflowSink | undefined;
  if (!sink) {
    return {
      ok: false, status: 400,
      error: 'No destination set. Choose an ADLS or Azure SQL destination on the Output tab before running.',
    };
  }
  const outputQuery = (sink.query && queries.some((q) => q.name === sink.query) ? sink.query : queries[queries.length - 1].name);
  const built = await buildSink(itemId, outputQuery, sink);
  if ('gate' in built) {
    return { ok: false, status: built.gate.status, error: built.gate.error, hint: built.gate.hint };
  }
  const dataFlowName = `loom-pq-${itemId.slice(0, 8)}`;
  await upsertWranglingDataFlow(dataFlowName, m);
  const run = await runWranglingDataFlow(dataFlowName, [built.sink]);
  // Best-effort: persist the last run id for the editor's status pane.
  try {
    const next: WorkspaceItem = {
      ...resource,
      state: { ...(resource.state || {}), lastRunId: run.runId, lastRunAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    };
    await items.item(resource.id, workspaceId).replace(next);
  } catch { /* non-fatal — the run is already dispatched */ }
  return {
    ok: true, backend: 'adf', runId: run.runId, pipelineName: run.pipelineName, dataFlowName, outputQuery,
  };
}
