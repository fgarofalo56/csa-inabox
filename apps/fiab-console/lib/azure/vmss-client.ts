/**
 * VM Scale Set control for the scaled self-hosted Integration Runtime (SHIR).
 *
 * The SHIR runs on a VMSS deployed at capacity 0 (scale-to-0). This client lets
 * the Loom Console read the current node count + scale it 0↔N on demand — the
 * engine behind both the Manage-hub IR metrics tile and the pipeline start/stop
 * automation. Real ARM REST, no mocks:
 *   GET   .../virtualMachineScaleSets/{name}?api-version=2024-07-01   → sku.capacity
 *   GET   .../virtualMachineScaleSets/{name}/virtualMachines?...      → live nodes
 *   PATCH .../virtualMachineScaleSets/{name}  { sku: { capacity } }   → scale
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope.
 * Needs Virtual Machine Contributor on the VMSS (granted in shir.bicep).
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5). Single
// source of truth is lib/azure/cloud-endpoints.ts.
const ARM = armBase();
const ARM_SCOPE = armScope();
const VMSS_API = '2024-07-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class VmssError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'VmssError';
    this.status = status;
  }
}

export interface VmssConfig {
  subscriptionId: string;
  resourceGroup: string;
  name: string;
}

export interface VmssStatus {
  name: string;
  /** Target node count from sku.capacity (0 = scaled to zero). */
  capacity: number;
  /** Top-level provisioning state of the scale set. */
  provisioningState?: string;
  /** Per-node states (name + power/provisioning state) from the instance list. */
  nodes: { name: string; provisioningState?: string }[];
}

/**
 * Resolve the SHIR VMSS config from env. The bicep wires LOOM_SHIR_VMSS_NAME +
 * reuses LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID. Returns null when not configured so
 * callers can surface an honest gate (no SHIR deployed) instead of throwing.
 */
export function shirVmssConfig(): VmssConfig | null {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  const resourceGroup = process.env.LOOM_DLZ_RG;
  const name = process.env.LOOM_SHIR_VMSS_NAME;
  if (!subscriptionId || !resourceGroup || !name) return null;
  return { subscriptionId, resourceGroup, name };
}

/**
 * Resolve the SHARED admin-zone Purview SHIR VMSS config from env. The bicep
 * wires LOOM_PURVIEW_SHIR_VMSS_NAME and the VMSS lives in the ADMIN RG
 * (LOOM_ADMIN_RG) — a Purview SHIR cannot share a machine with the DLZ ADF SHIR
 * (Microsoft constraint), so it is a separate VMSS in a different RG. Returns
 * null when not configured so callers surface an honest gate instead of
 * throwing (e.g. Purview not deployed, or no Purview IR auth key supplied).
 */
export function purviewShirVmssConfig(): VmssConfig | null {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  const resourceGroup = process.env.LOOM_ADMIN_RG;
  const name = process.env.LOOM_PURVIEW_SHIR_VMSS_NAME;
  if (!subscriptionId || !resourceGroup || !name) return null;
  return { subscriptionId, resourceGroup, name };
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new VmssError('Failed to acquire ARM token', 401);
  return t.token;
}

function basePath(c: VmssConfig): string {
  return `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.Compute/virtualMachineScaleSets/${encodeURIComponent(c.name)}`;
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
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || (typeof json === 'string' ? json : `ARM ${path} failed ${res.status}`);
    throw new VmssError(msg, res.status);
  }
  return json;
}

/** Read the SHIR VMSS capacity + live node states. */
export async function getVmssStatus(c: VmssConfig): Promise<VmssStatus> {
  const vmss = await armFetch(`${basePath(c)}?api-version=${VMSS_API}`);
  let nodes: { name: string; provisioningState?: string }[] = [];
  try {
    const list = await armFetch(`${basePath(c)}/virtualMachines?api-version=${VMSS_API}`);
    nodes = (list?.value || []).map((vm: any) => ({
      name: vm?.name || vm?.instanceId || 'node',
      provisioningState: vm?.properties?.provisioningState,
    }));
  } catch {
    // Node listing can lag scale operations; fall back to capacity only.
  }
  return {
    name: c.name,
    capacity: typeof vmss?.sku?.capacity === 'number' ? vmss.sku.capacity : 0,
    provisioningState: vmss?.properties?.provisioningState,
    nodes,
  };
}

/**
 * Scale the SHIR VMSS to `capacity` nodes (0 = stop/scale-to-zero). PATCH on the
 * sku is the lightweight scale operation; ARM returns 200/202 and the nodes
 * spin up (running the IR install+register extension) or drain.
 */
export async function scaleVmss(c: VmssConfig, capacity: number): Promise<void> {
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 8) {
    throw new VmssError(`capacity must be an integer 0-8 (got ${capacity})`, 400);
  }
  await armFetch(`${basePath(c)}?api-version=${VMSS_API}`, {
    method: 'PATCH',
    body: JSON.stringify({ sku: { capacity } }),
  });
}

export interface EnsureUpResult {
  /** True when the VMSS was at 0 and a scale-up was issued by this call. */
  scaledUp: boolean;
  /** Target capacity requested (0 when already running / no-op). */
  capacity: number;
  /** Running (Succeeded) node count observed at return. */
  runningNodes: number;
  /** Set when the scale-up could not be issued/confirmed (fail-open — never blocks the run). */
  warning?: string;
}

/**
 * Ensure the SHIR VMSS has at least one node running before a run that depends
 * on it (pipeline copy-on-SHIR, or a Purview scan that uses the self-hosted IR).
 *
 * Behavior:
 *   - If current capacity > 0 → no-op (already up); returns scaledUp:false.
 *   - If current capacity === 0 → scale to `target` (clamped 1..8), then poll
 *     getVmssStatus until at least one node reports provisioningState
 *     'Succeeded' OR the timeout elapses. The run can begin as soon as ARM has
 *     accepted the scale + nodes are coming online; the SHIR registers with the
 *     IR as each node boots (the CustomScript bootstrap).
 *
 * FAIL-OPEN: any error (e.g. the UAMI lacks Virtual Machine Contributor on the
 * VMSS) is swallowed into `warning` — a scale-up failure must NEVER block the
 * run. The caller surfaces the warning in the receipt.
 */
export async function ensureShirUp(
  c: VmssConfig,
  target = 4,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<EnsureUpResult> {
  const want = Math.min(8, Math.max(1, Math.trunc(target) || 1));
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const pollMs = opts?.pollMs ?? 5_000;
  try {
    const cur = await getVmssStatus(c);
    const runningNow = cur.nodes.filter((n) => n.provisioningState === 'Succeeded').length;
    if (cur.capacity > 0) {
      return { scaledUp: false, capacity: cur.capacity, runningNodes: runningNow };
    }
    await scaleVmss(c, want);
    // Poll until at least one node is up (or timeout). The run does not need to
    // wait for ALL nodes — one online SHIR node accepts the activity/scan.
    const deadline = Date.now() + timeoutMs;
    let running = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        const st = await getVmssStatus(c);
        running = st.nodes.filter((n) => n.provisioningState === 'Succeeded').length;
        if (running >= 1) break;
      } catch {
        // transient — keep polling until the deadline
      }
    }
    return {
      scaledUp: true,
      capacity: want,
      runningNodes: running,
      ...(running < 1
        ? { warning: `Scaled ${c.name} to ${want} node(s); no node reported running within ${Math.round(timeoutMs / 1000)}s — the run will start while nodes finish coming online.` }
        : {}),
    };
  } catch (e: any) {
    const status = e instanceof VmssError ? e.status : 0;
    const hint = status === 401 || status === 403
      ? 'The Console UAMI needs Virtual Machine Contributor on the SHIR VMSS.'
      : '';
    return {
      scaledUp: false,
      capacity: 0,
      runningNodes: 0,
      warning: `Could not auto-scale ${c.name} up before the run (${e?.message || String(e)}). ${hint} The run will proceed; start the SHIR manually if it is at 0.`.trim(),
    };
  }
}
