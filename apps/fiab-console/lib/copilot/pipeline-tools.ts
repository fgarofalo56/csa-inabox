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
import {
  deleteFactoryObject,
  factoryOpsGate,
  isFactoryObjectDeletable,
  normalizeFactoryObjectKind,
  backendLabel,
  FACTORY_OBJECT_KINDS,
  FACTORY_OBJECT_KIND_LABELS,
  type FactoryObjectKind,
} from '../azure/adf-resource-ops';

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

// ============================================================
// 8. Delete / remove factory objects (DESTRUCTIVE — confirm-intent guarded)
// ============================================================
//
// The Copilot could always CREATE and EDIT factory objects; it could never
// remove one. These handlers close that gap using the real delete REST shared
// in adf-resource-ops.ts (the same clients the Factory Resources tree's Delete
// buttons call). Because deletes are irreversible, every handler is guarded by
// a confirm-intent flag: on the first call (`confirm !== true`) NOTHING is
// deleted — the tool returns a summary telling the model to confirm with the
// user first, then re-call with `confirm: true`. The transcript renders the
// returned summary markdown so the user always sees exactly what happened.

/**
 * Typed Copilot tool result for a destructive factory op. Shaped as a
 * copilot-result-tagger `SummaryResult` (kind:'summary' → rendered markdown)
 * plus structured fields (deleted / awaitingConfirmation / …) the transcript
 * ignores but tests + telemetry read.
 */
export interface FactoryDeleteResult {
  kind: 'summary';
  title: string;
  markdown: string;
  /** True only when a real backend delete actually executed. */
  deleted: boolean;
  /** True when the tool declined and is asking the user to confirm. */
  awaitingConfirmation: boolean;
  /** True when an honest config/support gate blocked the op. */
  gated: boolean;
  objectKind: FactoryObjectKind;
  name: string;
  backend: PipelineBackend;
}

function deleteResult(partial: Omit<FactoryDeleteResult, 'kind'>): FactoryDeleteResult {
  return { kind: 'summary', ...partial };
}

/**
 * Shared core for both delete tools: honest config gate → backend-support gate
 * → confirm-intent guard → real delete. `boundPipeline` (when the caller is the
 * docked pipeline editor) drives an extra "this is the pipeline you have open"
 * warning in the confirm step.
 */
async function removeFactoryObjectCore(args: {
  kind: FactoryObjectKind;
  name: string;
  backend: PipelineBackend;
  confirm?: boolean;
  boundPipeline?: string;
}): Promise<FactoryDeleteResult> {
  const { kind, backend } = args;
  const name = String(args.name || '').trim();
  const label = FACTORY_OBJECT_KIND_LABELS[kind];
  const be = backendLabel(backend);
  const base = { deleted: false, awaitingConfirmation: false, gated: false, objectKind: kind, name, backend };

  if (!name) throw new Error(`A ${label} name is required to delete.`);

  // 1. Honest config gate — backend not wired in this deployment.
  const gate = factoryOpsGate(backend);
  if (gate) {
    return deleteResult({
      ...base,
      gated: true,
      title: `Delete blocked — ${be} not configured`,
      markdown:
        `Cannot delete the ${label} **${name}**: the ${be} backend is not configured in this deployment ` +
        `(missing \`${gate.missing}\`). No changes were made.`,
    });
  }

  // 2. Backend-support gate — kind not removable on this backend via Loom.
  if (!isFactoryObjectDeletable(backend, kind)) {
    return deleteResult({
      ...base,
      gated: true,
      title: `Delete not supported on ${be}`,
      markdown:
        `Removing a ${label} on the ${be} backend isn't wired in CSA Loom yet — ` +
        `remove **${name}** from Synapse Studio instead. No changes were made.`,
    });
  }

  // 3. Confirm-intent guard — never delete on the first, unconfirmed call.
  if (args.confirm !== true) {
    const boundWarning =
      kind === 'pipeline' && args.boundPipeline && args.boundPipeline === name
        ? ' — note this is the pipeline you currently have open in the editor'
        : '';
    return deleteResult({
      ...base,
      awaitingConfirmation: true,
      title: `Confirm delete of ${label} "${name}"`,
      markdown:
        `⚠️ This will **permanently delete** the ${be} ${label} **${name}**${boundWarning}. ` +
        `This cannot be undone. Confirm with the user, then call this tool again with \`confirm: true\` to proceed.`,
    });
  }

  // 4. Real, irreversible backend delete.
  await deleteFactoryObject(backend, kind, name);
  return deleteResult({
    ...base,
    deleted: true,
    title: `Deleted ${label} "${name}"`,
    markdown: `🗑️ Deleted the ${be} ${label} **${name}**.`,
  });
}

/**
 * Delete a NAMED pipeline in the factory (distinct from the bound one the
 * editor is on). Confirm-intent guarded; warns when the named pipeline is the
 * one currently open.
 */
export async function handlePipelineDeletePipeline(args: {
  name: string;
  backend: PipelineBackend;
  confirm?: boolean;
  boundPipeline?: string;
}): Promise<FactoryDeleteResult> {
  return removeFactoryObjectCore({
    kind: 'pipeline',
    name: args.name,
    backend: args.backend,
    confirm: args.confirm,
    boundPipeline: args.boundPipeline,
  });
}

/**
 * Remove a factory object by type + name (dataset / linked-service / trigger /
 * integration-runtime / data flow / CDC / managed private endpoint). The
 * `objectType` is normalized from free-form aliases; an unknown type throws
 * with the supported list. Confirm-intent guarded.
 */
export async function handlePipelineRemoveFactoryObject(args: {
  objectType: string;
  name: string;
  backend: PipelineBackend;
  confirm?: boolean;
}): Promise<FactoryDeleteResult> {
  const kind = normalizeFactoryObjectKind(args.objectType);
  if (!kind) {
    throw new Error(
      `Unknown factory object type "${args.objectType}". Supported types: ${FACTORY_OBJECT_KINDS.join(', ')}.`,
    );
  }
  return removeFactoryObjectCore({
    kind,
    name: args.name,
    backend: args.backend,
    confirm: args.confirm,
  });
}
