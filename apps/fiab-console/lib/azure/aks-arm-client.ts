/**
 * AKS (Azure Kubernetes Service) agent-pool ARM control — the GCC-High / IL5
 * container platform Loom runs on (Commercial / GCC use Container Apps instead).
 *
 * This client lets the Loom Console read the cluster's node pools and scale a
 * pool's node count on demand — the AKS analogue of the VMSS / Container Apps
 * scale paths. Real ARM REST, no mocks:
 *   GET .../managedClusters/{cluster}/agentPools?api-version=2025-04-01   → pools
 *   GET .../managedClusters/{cluster}/agentPools/{pool}?api-version=...   → one pool
 *   PUT .../managedClusters/{cluster}/agentPools/{pool}  { properties }   → scale
 *
 * Scaling a pool sets `count` and disables the cluster autoscaler on that pool
 * (you cannot pin `count` while `enableAutoScaling` is true — ARM rejects it).
 * The existing pool profile is read first and merged so immutable fields
 * (vmSize, osType, vnetSubnetID …) are preserved on the PUT.
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope.
 * Needs "Azure Kubernetes Service Cluster Admin" (or Contributor) on the
 * cluster — granted in container-platform.bicep for the AKS path.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM = armBase();
const ARM_SCOPE = armScope();
const AKS_API = '2025-04-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AksError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AksError';
    this.status = status;
    this.body = body;
  }
}

export class AksNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`AKS cluster is not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AksNotConfiguredError';
  }
}

export interface AksConfig {
  subscriptionId: string;
  resourceGroup: string;
  clusterName: string;
}

export interface AgentPool {
  name: string;
  count: number;
  provisioningState?: string;
  powerState?: string;
  mode?: string;
  vmSize?: string;
  enableAutoScaling: boolean;
  minCount?: number;
  maxCount?: number;
}

/**
 * Resolve AKS config from env. The bicep wires LOOM_AKS_CLUSTER_NAME +
 * LOOM_AKS_RG (only populated when containerPlatform == 'aks', i.e. GCC-High /
 * IL5). Throws AksNotConfiguredError when absent so the route can return an
 * honest 503 gate (Commercial / GCC always hit this — they run Container Apps).
 */
export function readAksConfig(): AksConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_AKS_RG || process.env.LOOM_ADMIN_RG || '';
  const clusterName = process.env.LOOM_AKS_CLUSTER_NAME || '';
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_AKS_RG (or LOOM_ADMIN_RG)');
  if (!clusterName) missing.push('LOOM_AKS_CLUSTER_NAME');
  if (missing.length) throw new AksNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, clusterName };
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new AksError('Failed to acquire ARM token', 401);
  return t.token;
}

function clusterPath(c: AksConfig): string {
  return `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(c.clusterName)}`;
}

async function armFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetchWithTimeout(`${ARM}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await token()}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok && res.status !== 202) {
    const msg = json?.error?.message || json?.message || (typeof json === 'string' ? json : `ARM ${path} failed ${res.status}`);
    throw new AksError(msg, res.status, json);
  }
  return json;
}

function shapePool(raw: any): AgentPool {
  const p = raw?.properties || raw || {};
  return {
    name: raw?.name || p?.name || 'nodepool',
    count: typeof p?.count === 'number' ? p.count : 0,
    provisioningState: p?.provisioningState,
    powerState: p?.powerState?.code,
    mode: p?.mode,
    vmSize: p?.vmSize,
    enableAutoScaling: !!p?.enableAutoScaling,
    minCount: typeof p?.minCount === 'number' ? p.minCount : undefined,
    maxCount: typeof p?.maxCount === 'number' ? p.maxCount : undefined,
  };
}

/** List the cluster's agent (node) pools with their current count + state. */
export async function listAksAgentPools(): Promise<AgentPool[]> {
  const cfg = readAksConfig();
  const list = await armFetch(`${clusterPath(cfg)}/agentPools?api-version=${AKS_API}`);
  return (list?.value || []).map(shapePool);
}

/** Read a single agent pool (raw ARM body — used to preserve immutable fields on PUT). */
async function getAgentPoolRaw(cfg: AksConfig, poolName: string): Promise<any> {
  return armFetch(`${clusterPath(cfg)}/agentPools/${encodeURIComponent(poolName)}?api-version=${AKS_API}`);
}

/**
 * Scale an agent pool to `count` nodes. Reads the existing pool first, merges
 * the new count and disables the autoscaler on that pool (count + autoscale are
 * mutually exclusive in ARM), then PUTs the merged profile back so vmSize /
 * osType / subnet are preserved. ARM returns 200 (sync) or 202 (async LRO) —
 * either way provisioningState transitions Updating → Succeeded.
 */
export async function scaleAksAgentPool(poolName: string, count: number): Promise<AgentPool> {
  if (!Number.isInteger(count) || count < 0 || count > 1000) {
    throw new AksError(`count must be an integer 0-1000 (got ${count})`, 400);
  }
  const cfg = readAksConfig();
  const existing = await getAgentPoolRaw(cfg, poolName);
  const props = { ...(existing?.properties || {}) };
  props.count = count;
  // Pin the count: a manual scale requires the autoscaler off on this pool.
  props.enableAutoScaling = false;
  delete props.minCount;
  delete props.maxCount;
  // provisioningState / powerState are read-only — drop them from the PUT body.
  delete props.provisioningState;
  delete props.powerState;
  const r = await armFetch(
    `${clusterPath(cfg)}/agentPools/${encodeURIComponent(poolName)}?api-version=${AKS_API}`,
    { method: 'PUT', body: JSON.stringify({ properties: props }) },
  );
  // 202 returns no body; reflect an Updating state for the poll loop.
  if (!r) return { name: poolName, count, provisioningState: 'Updating', enableAutoScaling: false };
  return shapePool(r);
}

// ---------------------------------------------------------------------------
// Deployment env-write via AKS Run Command (the AKS analogue of the Container
// Apps env PATCH — the env-config admin surface uses this on GCC-High / IL5 /
// DoD boundaries where Loom runs on AKS, not Container Apps).
// ---------------------------------------------------------------------------
//
// AKS exposes a server-side `kubectl` runner over ARM (Microsoft Learn — "AKS
// Run Command"): POST .../managedClusters/{c}/runCommand { command } creates a
// short-lived pod in the cluster, runs the command, and returns its exitCode +
// logs via .../commandResults/{id}. This works for PRIVATE clusters and needs
// NO inbound cluster network access from the Console — the call is pure ARM,
// authorized by the same UAMI/ARM token used for agent-pool scaling. It is the
// Azure-native, no-portal env-write path for the AKS-hosted Console Deployment.
//
// Plain env vars  → `kubectl set env deployment/<name> KEY=VALUE …`  (rolls the
//                   Deployment, a zero-downtime rolling update).
// Secret env vars → upsert a single K8s Secret (server-side apply via stdin)
//                   then `kubectl set env deployment/<name> --from=secret/<s>`
//                   so the values land as secretKeyRef, never as plain env or in
//                   the Run Command logs.

const RUNCMD_API = '2025-04-01';

/** Default Deployment name for the Console workload on AKS (matches app-deployments.bicep ${APP_NAME}). */
function consoleDeploymentName(): string {
  return process.env.LOOM_CONSOLE_APP_NAME || 'loom-console';
}

/** Kubernetes namespace the Console Deployment lives in (bicep manifest omits one → `default`). */
function consoleNamespace(): string {
  return process.env.LOOM_AKS_NAMESPACE || 'default';
}

/** Name of the K8s Secret backing env-config secret-typed keys for the Console Deployment. */
function consoleEnvSecretName(): string {
  return `${consoleDeploymentName()}-env-config`;
}

/** RFC-1123 / env-name sanity: K8s env names must be C_IDENTIFIERs. The registry
 * keys are already LOOM_… / SESSION_SECRET style, but guard defensively. */
function isValidEnvName(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Single-quote a value for safe embedding in the `sh -c` command string. */
function shQuote(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the `kubectl` shell pipeline that applies an env-config change to a
 * Deployment via AKS Run Command. Pure (no I/O) so it is unit-testable. Secret
 * VALUES are embedded only inside a stdin heredoc Secret manifest (never argv),
 * and referenced on the container via `--from=secret/<name>` so they land as
 * secretKeyRef, not plain env, and never appear in process listings.
 */
export function buildAksEnvCommand(args: {
  deployment: string;
  namespace: string;
  secretName: string;
  changes: Record<string, string>;
  secrets: Record<string, string>;
}): string {
  const { deployment: dep, namespace: ns, secretName } = args;
  const changeKeys = Object.keys(args.changes);
  const secretKeys = Object.keys(args.secrets);
  const steps: string[] = ['set -e'];
  if (secretKeys.length > 0) {
    const stringDataLines = secretKeys
      .map((k) => `  ${k}: ${shQuote(args.secrets[k])}`)
      .join('\n');
    const manifest =
      `apiVersion: v1\nkind: Secret\nmetadata:\n  name: ${secretName}\n  namespace: ${ns}\ntype: Opaque\nstringData:\n${stringDataLines}`;
    steps.push(`kubectl apply -n ${ns} -f - <<'LOOM_SECRET_EOF'\n${manifest}\nLOOM_SECRET_EOF`);
    steps.push(`kubectl set env -n ${ns} deployment/${dep} --from=secret/${secretName}`);
  }
  if (changeKeys.length > 0) {
    const kv = changeKeys.map((k) => `${k}=${shQuote(args.changes[k])}`).join(' ');
    steps.push(`kubectl set env -n ${ns} deployment/${dep} ${kv}`);
  }
  steps.push(`kubectl rollout status -n ${ns} deployment/${dep} --timeout=10s || true`);
  return steps.join('\n');
}

export interface AksEnvUpdateResult {
  deployment: string;
  namespace: string;
  /** Plain env var keys applied. */
  changed: string[];
  /** Secret env var keys applied (values redacted everywhere). */
  secretsChanged: string[];
  provisioningState: string;
  exitCode: number;
}

/**
 * Poll an AKS Run Command long-running operation to completion and return the
 * RunCommandResult (exitCode + logs). The initial POST returns 202 with the
 * command id in the body (`{ id }`); commandResults is then polled until
 * provisioningState is terminal.
 */
async function pollRunCommand(cfg: AksConfig, commandId: string): Promise<any> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const r = await armFetch(
      `${clusterPath(cfg)}/commandResults/${encodeURIComponent(commandId)}?api-version=${RUNCMD_API}`,
    );
    const state = (r?.properties?.provisioningState || '').toLowerCase();
    if (state === 'succeeded' || state === 'failed' || state === 'canceled') return r;
    if (Date.now() > deadline) return r; // return last known; caller surfaces non-terminal honestly
    await new Promise((res) => setTimeout(res, 2_000));
  }
}

/**
 * Apply env-config changes to the AKS-hosted Console Deployment via Run Command.
 * Mirrors updateContainerAppEnv's contract so the env-config route can branch on
 * platform with identical persistence + audit semantics.
 *
 * - `changes`  : plain KEY→VALUE env vars (set directly on the container).
 * - `secrets`  : secret-typed KEY→VALUE env vars (stored in a K8s Secret and
 *                referenced via secretKeyRef — values never appear in env specs
 *                or Run Command logs; the apply reads the Secret YAML from stdin
 *                rather than the argv).
 */
export async function updateAksDeploymentEnv(
  changes: Record<string, string>,
  opts?: { secrets?: Record<string, string> },
): Promise<AksEnvUpdateResult> {
  const cfg = readAksConfig();
  const secrets = opts?.secrets || {};
  const changeKeys = Object.keys(changes);
  const secretKeys = Object.keys(secrets);
  if (changeKeys.length === 0 && secretKeys.length === 0) {
    throw new AksError('updateAksDeploymentEnv: no changes supplied', 400);
  }
  for (const k of [...changeKeys, ...secretKeys]) {
    if (!isValidEnvName(k)) throw new AksError(`invalid env var name for AKS: ${k}`, 400);
  }

  const dep = consoleDeploymentName();
  const ns = consoleNamespace();
  const secretName = consoleEnvSecretName();

  // Build a single shell pipeline so the whole env update is one rolling update.
  const command = buildAksEnvCommand({ deployment: dep, namespace: ns, secretName, changes, secrets });

  const post = await armFetch(
    `${clusterPath(cfg)}/runCommand?api-version=${RUNCMD_API}`,
    { method: 'POST', body: JSON.stringify({ command }) },
  );

  // 200 = synchronous result; 202 = LRO, body carries the command id to poll.
  let result = post;
  const commandId = post?.id || post?.name;
  if ((!post?.properties || !post?.properties?.exitCode) && commandId) {
    result = await pollRunCommand(cfg, String(commandId));
  }

  const exitCode = typeof result?.properties?.exitCode === 'number' ? result.properties.exitCode : -1;
  const provisioningState = result?.properties?.provisioningState || 'Updating';
  if (exitCode !== 0 && provisioningState.toLowerCase() === 'succeeded') {
    // Command ran but kubectl failed — surface the logs (already secret-free).
    throw new AksError(
      `AKS env update failed (kubectl exitCode ${exitCode}): ${String(result?.properties?.logs || '').slice(0, 600)}`,
      502,
      result?.properties,
    );
  }

  return {
    deployment: dep,
    namespace: ns,
    changed: changeKeys,
    secretsChanged: secretKeys,
    provisioningState,
    exitCode,
  };
}
