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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
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

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new VmssError('Failed to acquire ARM token', 401);
  return t.token;
}

function basePath(c: VmssConfig): string {
  return `/subscriptions/${c.subscriptionId}/resourceGroups/${c.resourceGroup}/providers/Microsoft.Compute/virtualMachineScaleSets/${encodeURIComponent(c.name)}`;
}

async function armFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${ARM}${path}`, {
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
