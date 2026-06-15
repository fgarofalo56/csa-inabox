/**
 * pipeline-tools.ts — handlers for the CSA Loom Pipeline Copilot persona.
 *
 * Pure backend tool functions (no React, no UI). Each is registered in
 * copilot-personas.ts and called by the cross-item orchestrator loop. Every
 * handler hits a REAL Azure backend — ADF ARM REST (adf-client) or the Synapse
 * dev endpoint (synapse-dev-client) — per no-vaporware.md. No placeholder
 * pipeline JSON: generation is an Azure OpenAI call grounded in the factory's
 * real linked services, and apply persists via the real upsert REST.
 *
 * Azure-native by default (no Microsoft Fabric / Power BI dependency, per
 * no-fabric-dependency.md): the backend is ADF or Synapse, selected by the
 * pipeline item's slug, never a Fabric workspace.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { cogScope } from '../azure/cloud-endpoints';
import type { AoaiTarget } from '../azure/copilot-orchestrator';
import type { PipelineSpec } from '../components/pipeline/types';
import * as adf from '../azure/adf-client';
import * as synapseDev from '../azure/synapse-dev-client';

export type PipelineBackend = 'adf' | 'synapse';

// ---------- Credential (same chain as the rest of the Loom Azure clients) ----------
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------- Source/sink capability classification ----------
// Mapping a linked-service connector type → whether it can be a Copy source
// and/or sink. Drives the `/` completion picker (source vs dest) without an
// extra Azure round-trip beyond the linked-service list itself.
const SOURCE_CAPABLE_TYPES = new Set([
  'AzureBlobFS', 'AzureDataLakeStoreGen2', 'AzureDataLakeStore', 'AzureBlobStorage', 'AzureBlob',
  'AmazonS3', 'GoogleCloudStorage', 'HttpServer', 'FileServer', 'Sftp',
  'AzureSqlDatabase', 'AzureSqlMI', 'SqlServer', 'AzureSynapseAnalytics', 'AzureSqlDW',
  'AzurePostgreSql', 'AzureMySql', 'MySql', 'PostgreSql', 'Oracle', 'Db2',
  'AzureCosmosDb', 'AzureCosmosDbMongoDbApi', 'AzureDataExplorer', 'RestService', 'OData',
]);
const SINK_CAPABLE_TYPES = new Set([
  'AzureBlobFS', 'AzureDataLakeStoreGen2', 'AzureDataLakeStore', 'AzureBlobStorage', 'AzureBlob',
  'FileServer', 'Sftp',
  'AzureSqlDatabase', 'AzureSqlMI', 'SqlServer', 'AzureSynapseAnalytics', 'AzureSqlDW',
  'AzurePostgreSql', 'AzureMySql',
  'AzureCosmosDb', 'AzureCosmosDbMongoDbApi', 'AzureDataExplorer',
]);

export interface PipelineConnection {
  name: string;
  type: string;
  capable: Array<'source' | 'sink'>;
}

function classifyConnection(name: string, type: string): PipelineConnection {
  const capable: Array<'source' | 'sink'> = [];
  if (SOURCE_CAPABLE_TYPES.has(type)) capable.push('source');
  if (SINK_CAPABLE_TYPES.has(type)) capable.push('sink');
  return { name, type, capable };
}

// ============================================================
// 1. List connections (linked services) — `/` source/dest completion
// ============================================================
export async function handlePipelineListConnections(
  args: { backend: PipelineBackend },
): Promise<PipelineConnection[]> {
  if (args.backend === 'adf') {
    const ls = await adf.listLinkedServices();
    return ls.map((l) => classifyConnection(l.name, l.properties?.type || 'unknown'));
  }
  const ls = await synapseDev.listLinkedServices();
  return ls.map((l) => classifyConnection(l.name, l.properties?.type || 'unknown'));
}

// ============================================================
// 2. List datasets — connection-bind completion
// ============================================================
export interface PipelineDatasetInfo { name: string; type: string; linkedService?: string }

export async function handlePipelineListDatasets(
  args: { backend: PipelineBackend },
): Promise<PipelineDatasetInfo[]> {
  if (args.backend === 'adf') {
    const ds = await adf.listDatasets();
    return ds.map((d) => ({
      name: d.name,
      type: d.properties?.type || 'unknown',
      linkedService: d.properties?.linkedServiceName?.referenceName,
    }));
  }
  const ds = await synapseDev.listDatasets();
  return ds.map((d) => ({
    name: d.name,
    type: d.properties?.type || 'unknown',
    linkedService: d.properties?.linkedServiceName?.referenceName,
  }));
}

// ============================================================
// 3. Generate a complete pipeline JSON from NL (sub-AOAI call)
// ============================================================
const PIPELINE_GEN_SYSTEM = (connList: string) => `
You are an Azure Data Factory / Synapse pipeline JSON generator.
Available linked services (connections) — reference ONLY these real names, never invent any:
${connList || '  (none discovered — only emit activities that need no linked service, e.g. Wait/SetVariable)'}

Emit a single VALID pipeline JSON object (no markdown fences, no prose). Schema:
{ "name": string, "properties": { "description": string, "activities": [ ... ] } }

For a Copy activity (the common "copy from X to Y" request):
  "type": "Copy",
  "typeProperties": {
    "source": { "type": "<AzureBlobFSSource|AzureSqlSource|DelimitedTextSource|ParquetSource|BlobSource>", ... },
    "sink":   { "type": "<AzureBlobFSSink|AzureSqlSink|SqlSink|DelimitedTextSink|ParquetSink>", "writeBehavior": "insert" },
    "enableStaging": false
  },
  "inputs":  [{ "referenceName": "<DatasetName>", "type": "DatasetReference" }],
  "outputs": [{ "referenceName": "<DatasetName>", "type": "DatasetReference" }]
Map ADLS/Blob folder sources to AzureBlobFSSource with wildcardFolderPath/wildcardFileName.
Map SQL table sinks to AzureSqlSink with a tableName (schema.table).
Always set each activity a unique "name" and "dependsOn": [] (or proper dependencies for a chain).
Return ONLY the JSON object.
`.trim();

function stripFences(raw: string): string {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : t).trim();
}

export async function handlePipelineGenerate(
  args: {
    description: string;
    name: string;
    backend: PipelineBackend;
    connections?: Array<{ name: string; type: string }>;
  },
  aoaiTarget: AoaiTarget,
): Promise<{ spec: PipelineSpec; summary: string }> {
  const description = String(args.description || '').trim();
  const name = String(args.name || '').trim() || 'generated_pipeline';
  if (!description) throw new Error('A pipeline description is required.');

  const connList = (args.connections || [])
    .map((c) => `  - "${c.name}" (${c.type})`)
    .join('\n');

  const tok = await credential.getToken(cogScope());
  if (!tok?.token) throw new Error('Failed to acquire Azure OpenAI token for pipeline generation.');

  const url = `${aoaiTarget.endpoint}/openai/deployments/${encodeURIComponent(
    aoaiTarget.deployment,
  )}/chat/completions?api-version=${aoaiTarget.apiVersion}`;

  const messages = [
    { role: 'system', content: PIPELINE_GEN_SYSTEM(connList) },
    { role: 'user', content: `Pipeline name: ${name}\nDescription: ${description}` },
  ];

  // Try with temperature:0 + json_object response_format; fall back without
  // sampling params for reasoning models that reject temperature (o1/o3/gpt-5).
  const send = (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        response_format: { type: 'json_object' },
        ...(withTemperature ? { temperature: 0 } : {}),
      }),
    });

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (/unsupported_value|does not support|Only the default \(1\) value is supported/i.test(t) &&
        /temperature|top_p/i.test(t)) {
      res = await send(false);
    } else {
      throw new Error(`Pipeline generation failed 400: ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    throw new Error(`Pipeline generation failed ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content || '{}';

  let spec: PipelineSpec;
  try {
    spec = JSON.parse(raw) as PipelineSpec;
  } catch {
    try {
      spec = JSON.parse(stripFences(raw)) as PipelineSpec;
    } catch {
      throw new Error(`Azure OpenAI returned non-JSON pipeline: ${String(raw).slice(0, 200)}`);
    }
  }
  if (!spec || typeof spec !== 'object' || !spec.properties || !Array.isArray(spec.properties.activities)) {
    throw new Error('Generated pipeline is missing properties.activities.');
  }
  if (!spec.name) spec.name = name;

  const acts = spec.properties.activities;
  const summary =
    `Generated "${spec.name}" with ${acts.length} activit${acts.length === 1 ? 'y' : 'ies'}: ` +
    acts.map((a: any) => `${a.name} (${a.type})`).join(', ');
  return { spec, summary };
}

// ============================================================
// 4. Run the bound pipeline → real runId
// ============================================================
export async function handlePipelineRun(
  args: { pipelineName: string; backend: PipelineBackend; params?: Record<string, unknown> },
): Promise<{ runId: string; pipelineName: string }> {
  const { pipelineName, backend, params } = args;
  if (!pipelineName) throw new Error('pipelineName is required to run.');
  const res = backend === 'adf'
    ? await adf.runPipeline(pipelineName, params || {})
    : await synapseDev.runPipeline(pipelineName, params || {});
  return { runId: res.runId, pipelineName };
}

// ============================================================
// 5. Run status (poll a runId)
// ============================================================
export async function handlePipelineGetRunStatus(
  args: { runId: string; backend: PipelineBackend; pipelineName?: string },
): Promise<{ runId: string; status: string; message?: string; durationMs?: number }> {
  const { runId, backend, pipelineName } = args;
  if (!runId) throw new Error('runId is required.');
  if (backend === 'synapse') {
    const run = await synapseDev.getPipelineRun(runId);
    return { runId, status: run.status || 'Unknown', message: run.message, durationMs: run.durationInMs };
  }
  // ADF: find the run in the recent window for the pipeline.
  const runs = await adf.listPipelineRuns(pipelineName, 1);
  const found = runs.find((r) => r.runId === runId);
  if (found) {
    return { runId, status: found.status || 'Unknown', message: found.message, durationMs: found.durationInMs };
  }
  // Fall back to activity-run rollup when the run isn't in the pipeline window.
  const acts = await adf.listActivityRuns(runId);
  const anyFailed = acts.some((a) => a.status === 'Failed');
  const allDone = acts.length > 0 && acts.every((a) => ['Succeeded', 'Failed', 'Cancelled', 'Skipped'].includes(a.status || ''));
  const status = acts.length === 0 ? 'Unknown' : anyFailed ? 'Failed' : allDone ? 'Succeeded' : 'InProgress';
  return { runId, status };
}

// ============================================================
// 6. Summarize an existing pipeline
// ============================================================
export async function handlePipelineSummarize(
  args: { pipelineName: string; backend: PipelineBackend },
): Promise<{ name: string; description?: string; activityCount: number; activities: Array<{ name: string; type: string; dependsOn: string[] }> }> {
  const { pipelineName, backend } = args;
  if (!pipelineName) throw new Error('pipelineName is required.');
  const pl = backend === 'adf'
    ? await adf.getPipeline(pipelineName)
    : await synapseDev.getPipeline(pipelineName);
  const activities = (pl.properties?.activities || []) as Array<any>;
  return {
    name: pl.name,
    description: pl.properties?.description,
    activityCount: activities.length,
    activities: activities.map((a) => ({
      name: a?.name,
      type: a?.type,
      dependsOn: Array.isArray(a?.dependsOn)
        ? a.dependsOn.map((d: any) => (typeof d === 'string' ? d : d?.activity)).filter(Boolean)
        : [],
    })),
  };
}

// ============================================================
// 7. Error assistant — read the REAL failed-run errors
// ============================================================
export interface FailedActivityInfo {
  name: string;
  type: string;
  errorCode?: string;
  message?: string;
  failureType?: string;
}

export async function handlePipelineExplainError(
  args: { runId: string; backend: PipelineBackend; pipelineName?: string },
): Promise<{ runId: string; status?: string; failedActivities: FailedActivityInfo[]; runMessage?: string }> {
  const { runId, backend, pipelineName } = args;
  if (!runId) throw new Error('runId is required to explain an error.');

  if (backend === 'adf') {
    const acts = await adf.listActivityRuns(runId);
    const failed = acts.filter((a) => a.status === 'Failed').map((a) => ({
      name: a.activityName,
      type: a.activityType,
      errorCode: a.error?.errorCode,
      message: a.error?.message,
      failureType: a.error?.failureType,
    }));
    // Pipeline-level message for the run as a fallback / extra context.
    const runs = await adf.listPipelineRuns(pipelineName, 2).catch(() => []);
    const run = runs.find((r) => r.runId === runId);
    return { runId, status: run?.status, failedActivities: failed, runMessage: run?.message };
  }

  // Synapse: per-activity query (added to synapse-dev-client) + run-level message.
  const acts = await synapseDev.listActivityRuns(runId).catch(() => [] as synapseDev.SynapseActivityRun[]);
  const failed = acts.filter((a) => a.status === 'Failed').map((a) => ({
    name: a.activityName,
    type: a.activityType,
    errorCode: a.error?.errorCode,
    message: a.error?.message,
    failureType: a.error?.failureType,
  }));
  const run = await synapseDev.getPipelineRun(runId).catch(() => null);
  return { runId, status: run?.status, failedActivities: failed, runMessage: run?.message };
}
