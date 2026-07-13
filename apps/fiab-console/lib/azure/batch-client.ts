/**
 * Azure Batch client (SVC-5) — pools over the ARM management plane and
 * jobs/tasks over the account DATA plane, for the deployment-pinned Batch
 * account (LOOM_BATCH_ACCOUNT). Real REST only, no mocks.
 *
 * Two planes, two audiences:
 *   - Pools:        Microsoft.Batch/batchAccounts/{account}/pools over ARM
 *                   (management.azure.com), armScope() token. The Console UAMI
 *                   must hold "Contributor" on the Batch account (granted in
 *                   platform/fiab/bicep/modules/deploy-planner/batch.bicep).
 *   - Jobs/Tasks:   https://{accountEndpoint}/jobs, /jobs/{id}/tasks over the
 *                   Batch DATA plane, batchScope() token (cloud-aware audience).
 *                   Requires the account to allow Microsoft Entra ID
 *                   authentication (allowedAuthenticationModes includes AAD).
 *
 * Honest gate: batchConfigGate() returns the exact missing env var so each BFF
 * route 503s with a precise MessageBar instead of a generic 500. Azure-native —
 * no Microsoft Fabric dependency anywhere on this path.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/rest/api/batchmanagement/pool
 *   https://learn.microsoft.com/rest/api/batchservice/
 *   https://learn.microsoft.com/azure/batch/batch-aad-auth
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope, batchScope } from './cloud-endpoints';

const ARM_SCOPE = armScope();
/** Management-plane (ARM) api-version — Microsoft.Batch pools. */
const BATCH_MGMT_API = '2024-07-01';
/** Data-plane api-version — jobs/tasks over the account endpoint. */
const BATCH_DATA_API = '2024-07-01.20.0';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class BatchError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Azure Batch call failed (${status})`);
    this.name = 'BatchError';
    this.status = status;
    this.body = body;
  }
}

export interface BatchConfig {
  subscriptionId: string;
  resourceGroup: string;
  account: string;
}

/**
 * Honest config gate. Returns the exact missing env var so a BFF route can 503
 * with a precise MessageBar (`code: 'not_configured'`). Returns null when the
 * account + subscription + RG are all resolvable. Mirrors eventhubsConfigGate.
 */
export function batchConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_BATCH_ACCOUNT) return { missing: 'LOOM_BATCH_ACCOUNT' };
  if (!(process.env.LOOM_BATCH_SUB || process.env.LOOM_SUBSCRIPTION_ID)) {
    return { missing: 'LOOM_BATCH_SUB (or LOOM_SUBSCRIPTION_ID)' };
  }
  if (!(process.env.LOOM_BATCH_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG)) {
    return { missing: 'LOOM_BATCH_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)' };
  }
  return null;
}

export function readBatchConfig(): BatchConfig {
  const subscriptionId = process.env.LOOM_BATCH_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup =
    process.env.LOOM_BATCH_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG || '';
  const account = process.env.LOOM_BATCH_ACCOUNT || '';
  if (!subscriptionId || !resourceGroup || !account) {
    throw new BatchError(503, undefined, 'Azure Batch account not configured');
  }
  return { subscriptionId, resourceGroup, account };
}

function accountUrl(cfg: BatchConfig): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(cfg.resourceGroup)}/providers/Microsoft.Batch/batchAccounts/${encodeURIComponent(cfg.account)}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new BatchError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

async function callData(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(batchScope());
  if (!t?.token) throw new BatchError(401, undefined, 'Failed to acquire Batch data-plane token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json; odata=minimalmetadata',
      accept: 'application/json',
    },
  });
}

// ---------------------------------------------------------------------------
// Account (management plane)
// ---------------------------------------------------------------------------

export interface BatchAccount {
  name: string;
  location?: string;
  /** Host (no scheme), e.g. `myacct.eastus.batch.azure.com`. */
  accountEndpoint?: string;
  poolAllocationMode?: string;
  provisioningState?: string;
  dedicatedCoreQuota?: number;
  lowPriorityCoreQuota?: number;
  poolQuota?: number;
  activeJobAndJobScheduleQuota?: number;
}

function shapeAccount(raw: any): BatchAccount {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    location: raw?.location,
    accountEndpoint: p.accountEndpoint,
    poolAllocationMode: p.poolAllocationMode,
    provisioningState: p.provisioningState,
    dedicatedCoreQuota: p.dedicatedCoreQuota,
    lowPriorityCoreQuota: p.lowPriorityCoreQuota,
    poolQuota: p.poolQuota,
    activeJobAndJobScheduleQuota: p.activeJobAndJobScheduleQuota,
  };
}

export async function getBatchAccount(cfg?: BatchConfig): Promise<BatchAccount> {
  const c = cfg || readBatchConfig();
  const r = await callArm(`${accountUrl(c)}?api-version=${BATCH_MGMT_API}`);
  if (!r.ok) throw new BatchError(r.status, await r.text(), `getBatchAccount failed ${r.status}`);
  return shapeAccount(await r.json());
}

/** Resolve `https://{accountEndpoint}` for the data plane, throwing if absent. */
async function dataBase(cfg: BatchConfig): Promise<string> {
  const acct = await getBatchAccount(cfg);
  if (!acct.accountEndpoint) {
    throw new BatchError(502, acct, 'Batch account has no accountEndpoint (provisioning incomplete)');
  }
  return `https://${acct.accountEndpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// Pools (management plane — ARM)
// ---------------------------------------------------------------------------

export interface BatchPool {
  name: string;
  vmSize?: string;
  state?: string;
  allocationState?: string;
  provisioningState?: string;
  currentDedicatedNodes?: number;
  currentLowPriorityNodes?: number;
  targetDedicatedNodes?: number;
  targetLowPriorityNodes?: number;
  enableAutoScale?: boolean;
  autoScaleFormula?: string;
}

function shapePool(raw: any): BatchPool {
  const p = raw?.properties || {};
  const sc = p.scaleSettings || {};
  const fixed = sc.fixedScale || {};
  const auto = sc.autoScale || {};
  return {
    name: raw?.name,
    vmSize: p.vmSize,
    state: p.currentState || p.state,
    allocationState: p.allocationState,
    provisioningState: p.provisioningState,
    currentDedicatedNodes: p.currentDedicatedNodes,
    currentLowPriorityNodes: p.currentLowPriorityNodes,
    targetDedicatedNodes: fixed.targetDedicatedNodes,
    targetLowPriorityNodes: fixed.targetLowPriorityNodes,
    enableAutoScale: !!sc.autoScale,
    autoScaleFormula: auto.formula,
  };
}

export async function listPools(cfg?: BatchConfig): Promise<BatchPool[]> {
  const c = cfg || readBatchConfig();
  const r = await callArm(`${accountUrl(c)}/pools?api-version=${BATCH_MGMT_API}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new BatchError(r.status, await r.text(), `listPools failed ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.value || []).map(shapePool);
}

/**
 * Typed pool creation spec — no freeform JSON. `nodeAgentSku` + `imageReference`
 * default to Ubuntu 22.04, the current Batch-supported marketplace image.
 */
export interface CreatePoolSpec {
  name: string;
  vmSize: string;
  /** Fixed-scale dedicated node count (ignored when enableAutoScale). */
  targetDedicatedNodes?: number;
  /** Fixed-scale low-priority (Spot) node count (ignored when enableAutoScale). */
  targetLowPriorityNodes?: number;
  enableAutoScale?: boolean;
  autoScaleFormula?: string;
  autoScaleEvaluationInterval?: string;
  nodeAgentSku?: string;
  imagePublisher?: string;
  imageOffer?: string;
  imageSku?: string;
}

/** Build the ARM PUT body (pure — unit-tested). */
export function buildPoolBody(spec: CreatePoolSpec): Record<string, any> {
  const props: Record<string, any> = {
    vmSize: spec.vmSize,
    deploymentConfiguration: {
      virtualMachineConfiguration: {
        imageReference: {
          publisher: spec.imagePublisher || 'canonical',
          offer: spec.imageOffer || '0001-com-ubuntu-server-jammy',
          sku: spec.imageSku || '22_04-lts',
          version: 'latest',
        },
        nodeAgentSkuId: spec.nodeAgentSku || 'batch.node.ubuntu 22.04',
      },
    },
  };
  if (spec.enableAutoScale && spec.autoScaleFormula) {
    props.scaleSettings = {
      autoScale: {
        formula: spec.autoScaleFormula,
        evaluationInterval: spec.autoScaleEvaluationInterval || 'PT5M',
      },
    };
  } else {
    props.scaleSettings = {
      fixedScale: {
        targetDedicatedNodes: spec.targetDedicatedNodes ?? 1,
        targetLowPriorityNodes: spec.targetLowPriorityNodes ?? 0,
        resizeTimeout: 'PT15M',
      },
    };
  }
  return { properties: props };
}

export async function createPool(spec: CreatePoolSpec, cfg?: BatchConfig): Promise<BatchPool> {
  const c = cfg || readBatchConfig();
  if (!spec?.name) throw new BatchError(400, spec, 'createPool requires a name');
  if (!spec?.vmSize) throw new BatchError(400, spec, 'createPool requires a vmSize');
  const r = await callArm(
    `${accountUrl(c)}/pools/${encodeURIComponent(spec.name)}?api-version=${BATCH_MGMT_API}`,
    { method: 'PUT', body: JSON.stringify(buildPoolBody(spec)) },
  );
  if (!r.ok && r.status !== 201 && r.status !== 200) {
    throw new BatchError(r.status, await r.text(), `createPool failed ${r.status}`);
  }
  return shapePool(await r.json().catch(() => ({ name: spec.name, properties: {} })));
}

export async function deletePool(name: string, cfg?: BatchConfig): Promise<void> {
  const c = cfg || readBatchConfig();
  const r = await callArm(
    `${accountUrl(c)}/pools/${encodeURIComponent(name)}?api-version=${BATCH_MGMT_API}`,
    { method: 'DELETE' },
  );
  if (r.status === 404 || r.status === 204 || r.status === 202 || r.ok) return;
  throw new BatchError(r.status, await r.text(), `deletePool failed ${r.status}`);
}

// ---------------------------------------------------------------------------
// Jobs (data plane)
// ---------------------------------------------------------------------------

export interface BatchJob {
  id: string;
  displayName?: string;
  state?: string;
  poolId?: string;
  priority?: number;
  creationTime?: string;
}

function shapeJob(raw: any): BatchJob {
  return {
    id: raw?.id,
    displayName: raw?.displayName,
    state: raw?.state,
    poolId: raw?.poolInfo?.poolId,
    priority: raw?.priority,
    creationTime: raw?.creationTime,
  };
}

export async function listJobs(cfg?: BatchConfig): Promise<BatchJob[]> {
  const c = cfg || readBatchConfig();
  const base = await dataBase(c);
  const r = await callData(`${base}/jobs?api-version=${BATCH_DATA_API}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new BatchError(r.status, await r.text(), `listJobs failed ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.value || []).map(shapeJob);
}

export interface CreateJobSpec {
  id: string;
  poolId: string;
  displayName?: string;
  priority?: number;
}

/** Build the data-plane job body (pure — unit-tested). */
export function buildJobBody(spec: CreateJobSpec): Record<string, any> {
  const body: Record<string, any> = {
    id: spec.id,
    poolInfo: { poolId: spec.poolId },
  };
  if (spec.displayName) body.displayName = spec.displayName;
  if (typeof spec.priority === 'number') body.priority = spec.priority;
  return body;
}

export async function createJob(spec: CreateJobSpec, cfg?: BatchConfig): Promise<{ id: string }> {
  const c = cfg || readBatchConfig();
  if (!spec?.id) throw new BatchError(400, spec, 'createJob requires an id');
  if (!spec?.poolId) throw new BatchError(400, spec, 'createJob requires a poolId');
  const base = await dataBase(c);
  const r = await callData(`${base}/jobs?api-version=${BATCH_DATA_API}`, {
    method: 'POST',
    body: JSON.stringify(buildJobBody(spec)),
  });
  if (!r.ok && r.status !== 201) throw new BatchError(r.status, await r.text(), `createJob failed ${r.status}`);
  return { id: spec.id };
}

export async function deleteJob(id: string, cfg?: BatchConfig): Promise<void> {
  const c = cfg || readBatchConfig();
  const base = await dataBase(c);
  const r = await callData(`${base}/jobs/${encodeURIComponent(id)}?api-version=${BATCH_DATA_API}`, {
    method: 'DELETE',
  });
  if (r.status === 404 || r.status === 202 || r.status === 204 || r.ok) return;
  throw new BatchError(r.status, await r.text(), `deleteJob failed ${r.status}`);
}

// ---------------------------------------------------------------------------
// Tasks (data plane)
// ---------------------------------------------------------------------------

export interface BatchTask {
  id: string;
  displayName?: string;
  state?: string;
  commandLine?: string;
  exitCode?: number;
  creationTime?: string;
}

function shapeTask(raw: any): BatchTask {
  return {
    id: raw?.id,
    displayName: raw?.displayName,
    state: raw?.state,
    commandLine: raw?.commandLine,
    exitCode: raw?.executionInfo?.exitCode,
    creationTime: raw?.creationTime,
  };
}

export async function listTasks(jobId: string, cfg?: BatchConfig): Promise<BatchTask[]> {
  const c = cfg || readBatchConfig();
  if (!jobId) throw new BatchError(400, undefined, 'listTasks requires a jobId');
  const base = await dataBase(c);
  const r = await callData(`${base}/jobs/${encodeURIComponent(jobId)}/tasks?api-version=${BATCH_DATA_API}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new BatchError(r.status, await r.text(), `listTasks failed ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return (j?.value || []).map(shapeTask);
}

export interface CreateTaskSpec {
  jobId: string;
  id: string;
  commandLine: string;
  displayName?: string;
}

/** Build the data-plane task body (pure — unit-tested). */
export function buildTaskBody(spec: CreateTaskSpec): Record<string, any> {
  const body: Record<string, any> = {
    id: spec.id,
    commandLine: spec.commandLine,
  };
  if (spec.displayName) body.displayName = spec.displayName;
  return body;
}

export async function createTask(spec: CreateTaskSpec, cfg?: BatchConfig): Promise<{ id: string }> {
  const c = cfg || readBatchConfig();
  if (!spec?.jobId) throw new BatchError(400, spec, 'createTask requires a jobId');
  if (!spec?.id) throw new BatchError(400, spec, 'createTask requires an id');
  if (!spec?.commandLine) throw new BatchError(400, spec, 'createTask requires a commandLine');
  const base = await dataBase(c);
  const r = await callData(
    `${base}/jobs/${encodeURIComponent(spec.jobId)}/tasks?api-version=${BATCH_DATA_API}`,
    { method: 'POST', body: JSON.stringify(buildTaskBody(spec)) },
  );
  if (!r.ok && r.status !== 201) throw new BatchError(r.status, await r.text(), `createTask failed ${r.status}`);
  return { id: spec.id };
}

export async function deleteTask(jobId: string, taskId: string, cfg?: BatchConfig): Promise<void> {
  const c = cfg || readBatchConfig();
  const base = await dataBase(c);
  const r = await callData(
    `${base}/jobs/${encodeURIComponent(jobId)}/tasks/${encodeURIComponent(taskId)}?api-version=${BATCH_DATA_API}`,
    { method: 'DELETE' },
  );
  if (r.status === 404 || r.status === 202 || r.status === 204 || r.ok) return;
  throw new BatchError(r.status, await r.text(), `deleteTask failed ${r.status}`);
}

// ---------------------------------------------------------------------------
// Client-safe presets + pure gate helpers live in ./batch-presets (no @azure/identity
// so the batch-pool editor can import them without pulling a credential into the
// browser bundle). Re-exported here for server-side callers.
// ---------------------------------------------------------------------------
export {
  VM_SIZE_PRESETS,
  AUTOSCALE_PRESETS,
  autoScaleFormulaFor,
  classifyBatchGate,
} from './batch-presets';
export type { BatchGateInfo } from './batch-presets';
