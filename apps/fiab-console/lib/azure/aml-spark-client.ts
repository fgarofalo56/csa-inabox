/**
 * Azure Machine Learning — Serverless Spark standalone-job client.
 *
 * This backs the %%pyspark cell-routing path in Commercial / GCC. AML
 * Serverless Spark has NO interactive Livy-style REST surface; the public,
 * documented way to run arbitrary PySpark against the managed serverless Spark
 * compute is a **standalone Spark job** (`jobType: 'Spark'`) submitted through
 * ARM. So one %%pyspark cell run == one short-lived Spark job:
 *
 *   1. resolve the workspace default blob datastore (account + container) —
 *      ARM GET .../datastores/workspaceblobstore
 *   2. upload a generated runner `run.py` (the user cell wrapped so stdout is
 *      captured + written to an output folder) to that blob container
 *   3. register a versioned **code asset** pointing at the uploaded folder
 *   4. submit the Spark job referencing that codeId, with a `uri_folder`
 *      output the runner writes `result.json` into
 *   5. poll the job to a terminal state, then read `result.json` back from blob
 *
 * Auth: ARM control plane uses the sovereign-cloud ARM `.default` scope; the
 * blob data plane uses the storage `.default` scope. Both minted from the
 * Console UAMI via ChainedTokenCredential — identical to mlflow-client /
 * synapse-livy-client. No mocks: every call hits the real AML / Storage REST
 * surface and surfaces errors verbatim.
 *
 * Gov note: AML Serverless Spark is not offered in Azure Government, so the
 * caller (execute-spark route) forces the Synapse-Livy backend at GCC-High /
 * IL5 and never reaches this client. The endpoints here are nonetheless
 * cloud-aware via cloud-endpoints so the code is portable.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/machine-learning/how-to-submit-spark-jobs
 *   https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces/jobs
 *   https://learn.microsoft.com/azure/machine-learning/how-to-deploy-with-rest (datastore + blob upload)
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope, getBlobSuffix } from './cloud-endpoints';
import { buildRunnerPy } from './aml-spark-runner';

export { buildRunnerPy };

const AML_API_VERSION = '2024-10-01';
const STORAGE_SCOPE = 'https://storage.azure.com/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Raised when the AML workspace needed for Serverless Spark isn't configured. */
export class AmlSparkNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  constructor(missing: string[]) {
    super('Azure ML Serverless Spark is not configured in this deployment');
    this.name = 'AmlSparkNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
      `then grant the Console UAMI the "AzureML Data Scientist" + "Storage Blob Data ` +
      `Contributor" roles on it. LOOM_AML_SPARK names the workspace; ` +
      `LOOM_AML_RG / LOOM_AML_REGION fall back to the Foundry hub env.`;
  }
}

export interface AmlSparkConfig {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  region: string;
  instanceType: string;
  runtimeVersion: string;
}

/**
 * Resolve the AML Serverless Spark config from env. `LOOM_AML_SPARK` is the
 * opt-in toggle (the workspace name). RG / region fall back to the Foundry hub
 * vars so an already-configured Loom needs only the one new var.
 */
export function amlSparkConfig(): AmlSparkConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');

  const workspace = process.env.LOOM_AML_SPARK || process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_SPARK');

  const region =
    process.env.LOOM_AML_REGION || process.env.LOOM_FOUNDRY_REGION;
  if (!region) missing.push('LOOM_AML_REGION');

  if (missing.length) throw new AmlSparkNotConfiguredError(missing);

  const resourceGroup =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  return {
    subscriptionId: subscriptionId!,
    resourceGroup,
    workspace: workspace!,
    region: region!,
    instanceType: process.env.LOOM_AML_SPARK_INSTANCE_TYPE || 'Standard_E4S_V3',
    runtimeVersion: process.env.LOOM_AML_SPARK_RUNTIME || '3.4',
  };
}

/** True when the AML Serverless Spark backend is configured + selected. */
export function isAmlSparkConfigured(): boolean {
  if (!process.env.LOOM_AML_SPARK) return false;
  try { amlSparkConfig(); return true; } catch { return false; }
}

function blobSuffix(): string {
  return getBlobSuffix();
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire ARM token for AML Serverless Spark');
  return t.token;
}

async function storageToken(): Promise<string> {
  const t = await credential.getToken(STORAGE_SCOPE);
  if (!t?.token) throw new Error('Failed to acquire Storage token for AML Serverless Spark');
  return t.token;
}

function wsArmId(cfg: AmlSparkConfig): string {
  return (
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${cfg.workspace}`
  );
}

async function armFetch(path: string, init?: RequestInit): Promise<Response> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${armBase()}${path}${sep}api-version=${AML_API_VERSION}`;
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${await armToken()}`,
      'content-type': 'application/json',
    },
  });
}

async function armJson<T>(r: Response, label: string): Promise<T> {
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch { /* keep raw */ }
    throw new Error(`${label} failed ${r.status}: ${String(msg).slice(0, 400)}`);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

interface BlobStore { account: string; container: string; }

/** Resolve the workspace default blob datastore's storage account + container. */
async function defaultBlobStore(cfg: AmlSparkConfig): Promise<BlobStore> {
  const r = await armFetch(`${wsArmId(cfg)}/datastores/workspaceblobstore`);
  const j = await armJson<any>(r, 'get workspaceblobstore datastore');
  const account = j?.properties?.accountName;
  const container = j?.properties?.containerName;
  if (!account || !container) {
    throw new Error('workspaceblobstore datastore is missing accountName/containerName');
  }
  return { account, container };
}

/** Upload a UTF-8 text blob (BlockBlob) to the workspace blob container. */
async function putBlob(store: BlobStore, blobPath: string, content: string): Promise<void> {
  const url = `https://${store.account}.${blobSuffix()}/${store.container}/${blobPath}`;
  const r = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await storageToken()}`,
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2021-12-02',
      'content-type': 'text/plain; charset=utf-8',
    },
    body: content,
  });
  if (!r.ok) {
    throw new Error(`blob upload ${blobPath} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

/** Read a text blob back; returns null on 404 (job hasn't written it). */
async function getBlobText(store: BlobStore, blobPath: string): Promise<string | null> {
  const url = `https://${store.account}.${blobSuffix()}/${store.container}/${blobPath}`;
  const r = await fetchWithTimeout(url, {
    headers: {
      authorization: `Bearer ${await storageToken()}`,
      'x-ms-version': '2021-12-02',
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`blob read ${blobPath} failed ${r.status}`);
  return r.text();
}

/**
 * The PySpark runner that wraps a user cell is built by the pure, dependency-
 * free `buildRunnerPy` (re-exported above from ./aml-spark-runner).
 */

export interface AmlSparkSubmit {
  jobName: string;
  resultBlobPath: string;
}

/**
 * Submit one %%pyspark cell as an AML Serverless Spark standalone job.
 * Returns the jobName (used as the poll handle) and the blob path the runner
 * will write its result.json into.
 */
export async function submitAmlSparkCell(cellSource: string, cellId: string): Promise<AmlSparkSubmit> {
  const cfg = amlSparkConfig();
  const store = await defaultBlobStore(cfg);
  const token = `loom-${(cellId || 'cell').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'cell'}-${Date.now()}`;
  const codeFolder = `loom-code/${token}`;
  const outFolder = `loom-spark-out/${token}`;
  const resultBlobPath = `${outFolder}/result.json`;

  // 1. upload runner
  const runnerB64 = Buffer.from(cellSource, 'utf-8').toString('base64');
  await putBlob(store, `${codeFolder}/run.py`, buildRunnerPy(runnerB64));

  // 2. register code asset version pointing at the uploaded folder
  const codeUri = `https://${store.account}.${blobSuffix()}/${store.container}/${codeFolder}`;
  const codeRes = await armFetch(`${wsArmId(cfg)}/codes/${token}/versions/1`, {
    method: 'PUT',
    body: JSON.stringify({ properties: { codeUri, isAnonymous: true, description: 'Loom %%pyspark cell' } }),
  });
  const codeJson = await armJson<any>(codeRes, 'register code asset');
  const codeId: string = codeJson?.id || `${wsArmId(cfg)}/codes/${token}/versions/1`;

  // 3. submit the Spark job
  const outUri = `azureml://datastores/workspaceblobstore/paths/${outFolder}/`;
  const body = {
    properties: {
      jobType: 'Spark',
      codeId,
      entry: { sparkJobEntryType: 'SparkJobPythonEntry', file: 'run.py' },
      args: '--loom-out ${{outputs.loom_out}}',
      resources: { instanceType: cfg.instanceType, runtimeVersion: cfg.runtimeVersion },
      identity: { identityType: 'UserIdentity' },
      conf: {
        'spark.driver.cores': '1',
        'spark.driver.memory': '2g',
        'spark.executor.cores': '2',
        'spark.executor.memory': '2g',
        'spark.executor.instances': '2',
      },
      outputs: {
        loom_out: { jobOutputType: 'uri_folder', uri: outUri, mode: 'Direct' },
      },
    },
  };
  const jobRes = await armFetch(`${wsArmId(cfg)}/jobs/${token}`, { method: 'PUT', body: JSON.stringify(body) });
  await armJson<any>(jobRes, 'submit Spark job');
  return { jobName: token, resultBlobPath };
}

export interface AmlSparkStatus {
  /** Raw AML job status: Queued|Starting|Preparing|Running|Finalizing|Completed|Failed|Canceled */
  status: string;
  terminal: boolean;
  succeeded: boolean;
}

/** Poll an AML Spark job's status. */
export async function getAmlSparkJob(jobName: string): Promise<AmlSparkStatus> {
  const cfg = amlSparkConfig();
  const r = await armFetch(`${wsArmId(cfg)}/jobs/${jobName}`);
  const j = await armJson<any>(r, 'get Spark job');
  const status: string = j?.properties?.status || 'Unknown';
  const terminal = ['Completed', 'Failed', 'Canceled', 'NotResponding'].includes(status);
  return { status, terminal, succeeded: status === 'Completed' };
}

export interface AmlSparkResult {
  status: 'ok' | 'error';
  textPlain?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/**
 * Read the runner's result.json back from blob after the job completes.
 * Returns null when the file isn't there yet (caller keeps polling) — except
 * when the job failed, where we surface the AML failure instead.
 */
export async function readAmlSparkResult(resultBlobPath: string): Promise<AmlSparkResult | null> {
  const cfg = amlSparkConfig();
  const store = await defaultBlobStore(cfg);
  const text = await getBlobText(store, resultBlobPath);
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    return {
      status: j.status === 'error' ? 'error' : 'ok',
      textPlain: typeof j.textPlain === 'string' ? j.textPlain : '',
      ename: j.ename || undefined,
      evalue: j.evalue || undefined,
      traceback: j.traceback ? [String(j.traceback)] : undefined,
    };
  } catch {
    return { status: 'ok', textPlain: text };
  }
}
