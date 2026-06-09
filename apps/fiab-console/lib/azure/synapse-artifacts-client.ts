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
  return fetch(`${devBase()}${path}`, {
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
