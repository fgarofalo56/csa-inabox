/**
 * Synapse Analytics **artifacts** REST client — the Synapse Studio workspace
 * data-plane (`https://<workspace>.dev.azuresynapse.net`, api-version
 * 2020-12-01).
 *
 * This backs the Synapse "Workspace Resources" navigator (the Synapse
 * equivalent of the ADF Factory Resources pane). It list/create/deletes the
 * workspace artifact collections:
 *
 *   pipelines | datasets | dataflows | linkedservices | triggers |
 *   notebooks | sqlScripts
 *
 * via real REST:
 *   GET    https://<ws>.dev.azuresynapse.net/<collection>?api-version=2020-12-01
 *   GET    https://<ws>.dev.azuresynapse.net/<collection>/<name>?api-version=…
 *   PUT    https://<ws>.dev.azuresynapse.net/<collection>/<name>?api-version=…
 *   DELETE https://<ws>.dev.azuresynapse.net/<collection>/<name>?api-version=…
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential), requesting the Synapse data-plane scope
 * `https://dev.azuresynapse.net/.default`. The Loom UAMI needs the
 * **Synapse Artifact Publisher** (write/delete) or **Synapse Administrator**
 * Synapse-RBAC role on the workspace. Workspace name comes from
 * `LOOM_SYNAPSE_WORKSPACE`.
 *
 * Spark Big Data pools + Dedicated SQL pools are read from ARM
 * (Microsoft.Synapse/workspaces/{ws}/bigDataPools | sqlPools) via the existing
 * `synapse-dev-client` helpers (`listSparkPools`, `listDedicatedSqlPools`).
 *
 * No mocks. Every call hits the real API and surfaces errors verbatim. When
 * `LOOM_SYNAPSE_WORKSPACE` is unset the BFF gates with an honest 503.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { detectLoomCloud } from './cloud-endpoints';

// The Synapse Studio data-plane host + token scope are sovereign-cloud aware.
// Commercial / GCC run on `dev.azuresynapse.net`; GCC-High / IL5 / DoD run on
// the Azure Government host `dev.azuresynapse.usgovcloudapi.net`. Without this
// split the dev-plane calls hit the wrong audience and 401 in Government.
function synapseDfsSuffix(): string {
  const cloud = detectLoomCloud();
  return cloud === 'GCC-High' || cloud === 'DoD'
    ? 'dev.azuresynapse.usgovcloudapi.net'
    : 'dev.azuresynapse.net';
}

const DEV_SCOPE = (() => {
  const cloud = detectLoomCloud();
  return cloud === 'GCC-High' || cloud === 'DoD'
    ? 'https://dev.azuresynapse.usgovcloudapi.net/.default'
    : 'https://dev.azuresynapse.net/.default';
})();
const DEV_API = '2020-12-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function ws(): string { return required('LOOM_SYNAPSE_WORKSPACE'); }

export function devBase(): string {
  return `https://${ws()}.${synapseDfsSuffix()}`;
}

/**
 * Honest config gate for the workspace-level artifact routes. Returns the exact
 * missing env var so the BFF can 503 with a precise MessageBar instead of a
 * generic 500. Returns null when configured.
 */
export function synapseConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) return { missing: 'LOOM_SYNAPSE_WORKSPACE' };
  return null;
}

async function callDev(path: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  return fetchWithTimeout(`${devBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  const text = await r.text();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch { return {} as T; }
}

// Synapse artifact lists are paged with a `nextLink` continuation; walk it so
// the count is accurate for large workspaces.
async function listAll<T>(collection: string, label: string): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = `/${collection}?api-version=${DEV_API}`;
  let guard = 0;
  while (path && guard++ < 50) {
    const r = await callDev(path);
    const body = await jsonOrThrow<{ value?: T[]; nextLink?: string }>(r, label);
    if (Array.isArray(body.value)) out.push(...body.value);
    if (body.nextLink) {
      // nextLink is an absolute URL on the same dev host; strip the host so
      // callDev (which prefixes devBase) re-targets it correctly.
      try {
        const u = new URL(body.nextLink);
        path = `${u.pathname}${u.search}`;
      } catch { path = null; }
    } else {
      path = null;
    }
  }
  return out;
}

// ============================================================
// Shared artifact shape
// ============================================================

export interface SynapseArtifact {
  id?: string;
  name: string;
  type?: string;
  etag?: string;
  properties?: Record<string, unknown>;
}

// ============================================================
// Datasets  (workspaces/.../datasets)
// ============================================================

export interface SynapseDataset extends SynapseArtifact {
  properties: {
    type: string;
    description?: string;
    linkedServiceName?: { referenceName: string; type: 'LinkedServiceReference'; parameters?: Record<string, unknown> };
    schema?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    folder?: { name: string };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listDatasets(): Promise<SynapseDataset[]> {
  return listAll<SynapseDataset>('datasets', 'listDatasets');
}

export async function upsertDataset(name: string, spec: SynapseDataset): Promise<SynapseDataset> {
  const r = await callDev(`/datasets/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapseDataset>(r, `upsertDataset(${name})`);
}

export async function deleteDataset(name: string): Promise<void> {
  const r = await callDev(`/datasets/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteDataset failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Data flows  (workspaces/.../dataflows)
// ============================================================

export interface SynapseDataFlow extends SynapseArtifact {
  properties: {
    type: 'MappingDataFlow' | 'Flowlet' | string;
    description?: string;
    annotations?: unknown[];
    folder?: { name: string };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listDataFlows(): Promise<SynapseDataFlow[]> {
  return listAll<SynapseDataFlow>('dataflows', 'listDataFlows');
}

export async function upsertDataFlow(name: string, spec: SynapseDataFlow): Promise<SynapseDataFlow> {
  const r = await callDev(`/dataflows/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapseDataFlow>(r, `upsertDataFlow(${name})`);
}

export async function deleteDataFlow(name: string): Promise<void> {
  const r = await callDev(`/dataflows/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteDataFlow failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Linked services  (workspaces/.../linkedservices)
// ============================================================

export interface SynapseLinkedService extends SynapseArtifact {
  properties: {
    type: string;
    description?: string;
    annotations?: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    connectVia?: { referenceName: string; type: 'IntegrationRuntimeReference' };
    typeProperties?: Record<string, unknown>;
  };
}

export async function listLinkedServices(): Promise<SynapseLinkedService[]> {
  return listAll<SynapseLinkedService>('linkedservices', 'listLinkedServices');
}

export async function upsertLinkedService(name: string, spec: SynapseLinkedService): Promise<SynapseLinkedService> {
  const r = await callDev(`/linkedservices/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapseLinkedService>(r, `upsertLinkedService(${name})`);
}

export async function deleteLinkedService(name: string): Promise<void> {
  const r = await callDev(`/linkedservices/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteLinkedService failed ${r.status}: ${await r.text()}`);
  }
}

// ============================================================
// Notebooks  (workspaces/.../notebooks)
//
// A Synapse notebook artifact carries a `nbformat`/`nbformat_minor` and a
// `cells[]` array (standard Jupyter IPYNB shape) plus optional `bigDataPool`
// and `sessionProperties` attachment metadata.
// ============================================================

export interface SynapseNotebook extends SynapseArtifact {
  properties: {
    description?: string;
    bigDataPool?: { referenceName: string; type: 'BigDataPoolReference' };
    sessionProperties?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    nbformat?: number;
    nbformat_minor?: number;
    cells?: unknown[];
    folder?: { name: string };
  };
}

export async function listNotebooks(): Promise<SynapseNotebook[]> {
  return listAll<SynapseNotebook>('notebooks', 'listNotebooks');
}

export async function upsertNotebook(name: string, spec: SynapseNotebook): Promise<SynapseNotebook> {
  const r = await callDev(`/notebooks/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapseNotebook>(r, `upsertNotebook(${name})`);
}

export async function deleteNotebook(name: string): Promise<void> {
  const r = await callDev(`/notebooks/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteNotebook failed ${r.status}: ${await r.text()}`);
  }
}

/** A minimal but valid empty PySpark notebook (Jupyter nbformat 4). */
export function emptyNotebookProperties(): SynapseNotebook['properties'] {
  return {
    nbformat: 4,
    nbformat_minor: 2,
    metadata: {
      language_info: { name: 'python' },
      kernelspec: { name: 'synapse_pyspark', display_name: 'Synapse PySpark' },
    },
    cells: [
      { cell_type: 'code', metadata: {}, source: ['# new Synapse notebook'], outputs: [], execution_count: null },
    ],
  };
}

// ============================================================
// SQL scripts  (workspaces/.../sqlScripts)
//
// A SQL script artifact carries `content.query` (the T-SQL text) plus
// `content.currentConnection` (the pool the script targets). We create an
// empty script targeting the built-in serverless pool.
// ============================================================

export interface SynapseSqlScript extends SynapseArtifact {
  properties: {
    description?: string;
    type?: 'SqlQuery' | string;
    content?: {
      query?: string;
      currentConnection?: { databaseName?: string; poolName?: string; type?: string };
      resultLimit?: number;
      metadata?: { language?: string };
    };
    folder?: { name: string };
  };
}

export async function listSqlScripts(): Promise<SynapseSqlScript[]> {
  return listAll<SynapseSqlScript>('sqlScripts', 'listSqlScripts');
}

export async function upsertSqlScript(name: string, spec: SynapseSqlScript): Promise<SynapseSqlScript> {
  const r = await callDev(`/sqlScripts/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapseSqlScript>(r, `upsertSqlScript(${name})`);
}

export async function deleteSqlScript(name: string): Promise<void> {
  const r = await callDev(`/sqlScripts/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteSqlScript failed ${r.status}: ${await r.text()}`);
  }
}

/** A minimal but valid empty SQL script targeting the built-in serverless pool. */
export function emptySqlScriptProperties(): SynapseSqlScript['properties'] {
  return {
    type: 'SqlQuery',
    content: {
      query: '-- new SQL script\nSELECT 1;',
      currentConnection: { databaseName: 'master', poolName: 'Built-in', type: 'SqlOnDemand' },
      resultLimit: 5000,
      metadata: { language: 'sql' },
    },
  };
}

// ============================================================
// Spark configurations  (workspaces/.../sparkconfigurations)
//
// A Spark configuration is the Synapse equivalent of a "notebook environment":
// a named bag of Spark session settings (spark.* keys) that a notebook can
// attach so its Livy session inherits library packages and config. The Synapse
// Studio notebook header surfaces it as the "Environment / Spark configuration"
// picker next to the Spark-pool attach dropdown.
//
// Dev-plane REST (api-version 2020-12-01):
//   GET https://<ws>.dev.azuresynapse.net/sparkconfigurations?api-version=…
// `properties.configs` is a flat { [key]: value } string map.
//   Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-configuration
// ============================================================

export interface SynapseSparkConfiguration extends SynapseArtifact {
  properties?: {
    description?: string;
    configs?: Record<string, string>;
    annotations?: unknown[];
    notes?: string;
    createdBy?: string;
    configMergeRule?: Record<string, string>;
  };
}

export async function listSparkConfigurations(): Promise<SynapseSparkConfiguration[]> {
  return listAll<SynapseSparkConfiguration>('sparkconfigurations', 'listSparkConfigurations');
}

// ============================================================
// Pipelines  (workspaces/.../pipelines)
//
// A Synapse pipeline is the orchestration unit that invokes a MappingDataFlow
// via an `ExecuteDataFlow` activity (the Synapse equivalent of ADF's pipeline).
// The Loom semantic-model ingest path uses this to run the Parquet→Delta
// MappingDataFlow on the Synapse Spark IR when LOOM_SYNAPSE_WORKSPACE is set
// (the opt-in alternative to the default ADF MappingDataFlow path).
//
// Dev-plane REST (api-version 2020-12-01):
//   PUT  https://<ws>.dev.azuresynapse.net/pipelines/<name>?api-version=…
//   POST https://<ws>.dev.azuresynapse.net/pipelines/<name>/createRun?api-version=…
//   Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/pipeline
// ============================================================

export interface SynapsePipeline extends SynapseArtifact {
  properties: {
    description?: string;
    activities: unknown[];
    parameters?: Record<string, { type: string; defaultValue?: unknown }>;
    variables?: Record<string, { type: string; defaultValue?: unknown }>;
    annotations?: unknown[];
    folder?: { name: string };
    concurrency?: number;
  };
}

export async function listPipelines(): Promise<SynapsePipeline[]> {
  return listAll<SynapsePipeline>('pipelines', 'listPipelines');
}

export async function upsertPipeline(name: string, spec: SynapsePipeline): Promise<SynapsePipeline> {
  const r = await callDev(`/pipelines/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return jsonOrThrow<SynapsePipeline>(r, `upsertPipeline(${name})`);
}

export async function deletePipeline(name: string): Promise<void> {
  const r = await callDev(`/pipelines/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deletePipeline failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * Trigger a pipeline run. POST /pipelines/{name}/createRun returns `{ runId }`.
 * Optional `params` are passed as the request body's pipeline parameters.
 */
export async function runPipeline(
  name: string,
  params?: Record<string, unknown>,
): Promise<{ runId: string }> {
  const r = await callDev(`/pipelines/${encodeURIComponent(name)}/createRun?api-version=${DEV_API}`, {
    method: 'POST',
    body: JSON.stringify(params || {}),
  });
  return jsonOrThrow<{ runId: string }>(r, `runPipeline(${name})`);
}

// ============================================================
// 202 long-running commit helper (local mirror of synapse-dev-client's
// commitArtifact). Spark-job-definition PUTs return 202 + a Location
// (operationResults) header: the artifact only exists once that operation
// reaches Succeeded, and can reach Failed when the definition references a pool
// or file that doesn't resolve. Treating the 202 as success would report
// "created" for a definition that silently failed to commit. We poll to a
// terminal state and throw the real error on failure. On a 200 (synchronous
// commit) it returns immediately. Inlined here (rather than importing from
// synapse-dev-client) to avoid a cross-client import cycle — both modules own a
// private `callDev`/credential pair.
//
// Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-job-definition/create-or-update-spark-job-definition
// ============================================================
async function commitArtifactLocal<T>(r: Response, label: string): Promise<T> {
  if (!r.ok && r.status !== 202) {
    throw new Error(`${label} failed ${r.status}: ${await r.text()}`);
  }
  if (r.status !== 202) {
    const text = await r.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { return {} as T; }
  }
  const loc = r.headers.get('location') || r.headers.get('Location');
  let accepted: T = {} as T;
  try { const t = await r.text(); if (t) accepted = JSON.parse(t) as T; } catch { /* ignore */ }
  if (!loc) return accepted;

  const tok = await credential.getToken(DEV_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Synapse dev token');
  const deadline = Date.now() + 90_000;
  let delay = 1000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 1.5, 5000);
    const op = await fetchWithTimeout(loc, {
      headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    });
    const text = await op.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    // operationResults returns the artifact itself (with no status) on success,
    // or { status: 'Succeeded' | 'Failed' | 'InProgress', error? }.
    const status = body?.status as string | undefined;
    if (!status) {
      // No status field → terminal artifact echo. Treat 200 as done.
      if (op.ok) return (body as T) ?? accepted;
      throw new Error(`${label} operation poll failed ${op.status}: ${text}`);
    }
    if (status === 'Succeeded') return (body as T) ?? accepted;
    if (status === 'Failed' || status === 'Cancelled') {
      const err = body?.error?.message || body?.error?.code || text;
      throw new Error(`${label} did not commit (${status}): ${err}`);
    }
    // InProgress / Running → keep polling.
  }
  throw new Error(`${label} timed out waiting for the commit operation to settle`);
}

// ============================================================
// KQL scripts  (workspaces/.../kqlScripts)
//
// The Synapse Studio Develop hub → KQL scripts surface. A KQL script artifact
// carries `content.query` (the KQL text) + `content.currentConnection`, which
// pins the Synapse Data Explorer (Kusto) pool + database the script runs
// against. The pool is a Synapse-workspace Kusto pool
// (Microsoft.Synapse/workspaces/{ws}/kustoPools) — NOT standalone ADX and NOT
// a Fabric Eventhouse — so the Azure-native default path needs no Fabric.
//
// Dev-plane REST (api-version 2020-12-01):
//   GET    https://<ws>.dev.azuresynapse.net/kqlScripts?api-version=…
//   PUT    https://<ws>.dev.azuresynapse.net/kqlScripts/<name>?api-version=…
//   DELETE https://<ws>.dev.azuresynapse.net/kqlScripts/<name>?api-version=…
//   Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/kql-scripts
// ============================================================

export interface SynapseKqlScript extends SynapseArtifact {
  properties?: {
    content?: {
      query?: string;
      currentConnection?: { poolName?: string; databaseName?: string; type?: string };
      metadata?: { language?: string };
    };
    folder?: { name: string };
  };
}

export async function listKqlScripts(): Promise<SynapseKqlScript[]> {
  return listAll<SynapseKqlScript>('kqlScripts', 'listKqlScripts');
}

export async function getKqlScript(name: string): Promise<SynapseKqlScript | null> {
  const r = await callDev(`/kqlScripts/${encodeURIComponent(name)}?api-version=${DEV_API}`);
  if (r.status === 404) return null;
  return jsonOrThrow<SynapseKqlScript>(r, `getKqlScript(${name})`);
}

export async function upsertKqlScript(name: string, spec: SynapseKqlScript): Promise<SynapseKqlScript> {
  const r = await callDev(`/kqlScripts/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  // KQL-script PUT may be a 202 LRO like the other heavy artifacts.
  return commitArtifactLocal<SynapseKqlScript>(r, `upsertKqlScript(${name})`);
}

export async function deleteKqlScript(name: string): Promise<void> {
  const r = await callDev(`/kqlScripts/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteKqlScript failed ${r.status}: ${await r.text()}`);
  }
}

/**
 * A minimal but valid empty KQL script. Connection (pool/database) is left
 * unset by default — the editor's "Connect to" / "Use database" dropdowns bind
 * it from the workspace's live Kusto pools before the first Run.
 */
export function emptyKqlScriptProperties(poolName?: string, databaseName?: string): SynapseKqlScript['properties'] {
  return {
    content: {
      query: '// new KQL script\n',
      currentConnection: { type: 'KustoPool', poolName, databaseName },
      metadata: { language: 'kql' },
    },
  };
}

// ============================================================
// Spark job definitions  (workspaces/.../sparkJobDefinitions)
//
// The Synapse Studio Develop hub → Spark job definitions surface: a batch
// Spark JAR/.py job definition that runs as a Livy batch against a target Spark
// Big Data pool. `jobProperties` is a Livy-batch-compatible payload (file,
// className, args, sizing). Submitting it creates a real Livy batch.
//
// Dev-plane REST (api-version 2020-12-01) — the PUT is a 202 LRO:
//   GET    https://<ws>.dev.azuresynapse.net/sparkJobDefinitions?api-version=…
//   PUT    https://<ws>.dev.azuresynapse.net/sparkJobDefinitions/<name>?api-version=…
//   DELETE https://<ws>.dev.azuresynapse.net/sparkJobDefinitions/<name>?api-version=…
//   Learn: https://learn.microsoft.com/rest/api/synapse/data-plane/spark-job-definition
// ============================================================

export interface SynapseSparkJobProperties {
  file?: string;
  className?: string;
  args?: string[];
  jars?: string[];
  pyFiles?: string[];
  files?: string[];
  conf?: Record<string, string>;
  driverMemory?: string;
  driverCores?: number;
  executorMemory?: string;
  executorCores?: number;
  numExecutors?: number;
}

export interface SynapseSparkJobDefinition extends SynapseArtifact {
  properties: {
    description?: string;
    targetBigDataPool: { referenceName: string; type: 'BigDataPoolReference' };
    requiredSparkVersion?: string;
    language?: 'PySpark' | 'Spark' | 'SparkR' | string;
    jobProperties: SynapseSparkJobProperties;
    folder?: { name: string };
  };
}

export async function listSparkJobDefinitions(): Promise<SynapseSparkJobDefinition[]> {
  return listAll<SynapseSparkJobDefinition>('sparkJobDefinitions', 'listSparkJobDefinitions');
}

export async function getSparkJobDefinition(name: string): Promise<SynapseSparkJobDefinition | null> {
  const r = await callDev(`/sparkJobDefinitions/${encodeURIComponent(name)}?api-version=${DEV_API}`);
  if (r.status === 404) return null;
  return jsonOrThrow<SynapseSparkJobDefinition>(r, `getSparkJobDefinition(${name})`);
}

export async function upsertSparkJobDefinition(name: string, spec: SynapseSparkJobDefinition): Promise<SynapseSparkJobDefinition> {
  const r = await callDev(`/sparkJobDefinitions/${encodeURIComponent(name)}?api-version=${DEV_API}`, {
    method: 'PUT',
    body: JSON.stringify({ name: spec.name || name, properties: spec.properties }),
  });
  return commitArtifactLocal<SynapseSparkJobDefinition>(r, `upsertSparkJobDefinition(${name})`);
}

export async function deleteSparkJobDefinition(name: string): Promise<void> {
  const r = await callDev(`/sparkJobDefinitions/${encodeURIComponent(name)}?api-version=${DEV_API}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 200 && r.status !== 202 && r.status !== 204) {
    throw new Error(`deleteSparkJobDefinition failed ${r.status}: ${await r.text()}`);
  }
}

/** A minimal Spark job definition targeting the given Spark Big Data pool. */
export function emptySparkJobDefinitionProperties(poolName: string): SynapseSparkJobDefinition['properties'] {
  return {
    targetBigDataPool: { referenceName: poolName, type: 'BigDataPoolReference' },
    language: 'PySpark',
    jobProperties: { file: '' },
  };
}

// ============================================================
// Synapse Kusto pool data-plane query (for the KQL-script Run button)
//
// Synapse Data Explorer (Kusto) pools expose a v1 REST query endpoint at
// `https://<poolName>.<workspace>.kusto.azuresynapse.net` (Azure Government:
// `…kusto.azuresynapse.us`). This is distinct from the standalone ADX cluster
// the `kusto-client` targets — it is the pool that lives INSIDE the Synapse
// workspace, so the KQL-script Run never depends on a separate ADX deployment
// (and never on Fabric). Auth uses the same workspace credential, scoped to the
// pool's `<clusterUri>/.default`.
// ============================================================

function kustoPoolSuffix(): string {
  const cloud = detectLoomCloud();
  return cloud === 'GCC-High' || cloud === 'DoD'
    ? 'kusto.azuresynapse.us'
    : 'kusto.azuresynapse.net';
}

/** The data-plane cluster URI for a Synapse Kusto pool. */
export function synapseKustoPoolUri(poolName: string): string {
  return `https://${poolName}.${ws()}.${kustoPoolSuffix()}`;
}

export interface KqlRunResult {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
}

const KQL_MAX_ROWS = 5000;

/**
 * Run a KQL query against a Synapse Kusto pool's database. Returns the primary
 * results table (Table_0) in a UI-friendly shape. Throws with the real Kusto
 * error message on failure (surfaced verbatim by the Run route).
 */
export async function runKqlOnPool(poolName: string, databaseName: string, query: string): Promise<KqlRunResult> {
  const clusterUri = synapseKustoPoolUri(poolName);
  const tok = await credential.getToken(`${clusterUri}/.default`);
  if (!tok?.token) throw new Error(`Failed to acquire token for Kusto pool ${poolName}`);
  const started = Date.now();
  const res = await fetchWithTimeout(`${clusterUri}/v1/rest/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      'x-ms-client-request-id': `loom-synapse-kql.${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify({ db: databaseName, csl: query }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.['@message'] || json?.error?.message || text || 'Kusto query failed').toString();
    throw new Error(`runKqlOnPool(${poolName}/${databaseName}) ${res.status}: ${msg}`);
  }
  const tables = json?.Tables || [];
  const primary = tables.find((t: any) => t?.TableName === 'Table_0') || tables[0];
  const cols: { ColumnName: string; DataType?: string; ColumnType?: string }[] = primary?.Columns || [];
  const rawRows: unknown[][] = primary?.Rows || [];
  const truncated = rawRows.length > KQL_MAX_ROWS;
  return {
    columns: cols.map((c) => c.ColumnName),
    columnTypes: cols.map((c) => c.DataType || c.ColumnType || ''),
    rows: truncated ? rawRows.slice(0, KQL_MAX_ROWS) : rawRows,
    rowCount: rawRows.length,
    truncated,
    executionMs: Date.now() - started,
  };
}
