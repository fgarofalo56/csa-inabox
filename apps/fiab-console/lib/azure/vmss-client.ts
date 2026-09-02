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
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM host + scope (Commercial / GCC-High / IL5). Single
// source of truth is lib/azure/cloud-endpoints.ts.
const ARM = armBase();
const ARM_SCOPE = armScope();
const VMSS_API = '2024-07-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
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
  /**
   * True when `resourceGroup` was NOT emitted by the deploy for THIS scale set and
   * was substituted from a neighbouring deployment's RG. The coordinates are then
   * complete but only the name has known provenance — reads tolerate that (a wrong
   * GET is a wasted request), `scaleVmss` refuses it (a wrong PATCH scales someone
   * else's machine). Absent/false = every coordinate came from this VMSS's own
   * deploy output or was supplied explicitly by a caller.
   */
  resourceGroupAssumed?: boolean;
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

/** Trimmed env read — an all-whitespace value is as absent as an unset one. */
function v(env: NodeJS.ProcessEnv, k: string): string {
  return (env[k] || '').trim();
}

/**
 * ── #4248 — COORDINATES TRAVEL TOGETHER, OR NOT AT ALL ──────────────────────
 *
 * Both resolvers below used to compose a VMSS **name** from one deployment with
 * a **home** (RG + subscription) taken from another's assumptions:
 *
 *     purviewShirVmssConfig  name: LOOM_PURVIEW_SHIR_VMSS_NAME
 *                              rg: LOOM_ADMIN_RG          <- assumed
 *                             sub: LOOM_SUBSCRIPTION_ID   <- assumed, no fallback
 *     shirVmssConfig         name: LOOM_SHIR_VMSS_NAME
 *                             sub: LOOM_SUBSCRIPTION_ID   <- admin sub, always
 *
 * That is the same mismatched-coordinates family that produced the deterministic
 * ARM 404 in the estate-pause manifest (#4243): the id resolved, ARM accepted the
 * request, and the resource it addressed did not exist. Here the blast radius is
 * larger than a wasted read — `scaleVmss` PATCHes `sku.capacity`, so a wrong-home
 * id either 404s the scale verb or, if a same-named VMSS exists in the assumed
 * RG, scales SOMEONE ELSE'S machine.
 *
 * PR #4247 made the deploy emit the authoritative coordinates for exactly this
 * resource. Verified at 71c5bf2426 in
 * `platform/fiab/bicep/modules/admin-plane/main.bicep` (grep the var names — the
 * line numbers drift, the bindings do not):
 *
 *     LOOM_PURVIEW_SHIR_RG = purviewShirDeployed ? resourceGroup().name : ''
 *     LOOM_SHIR_SUB        = purviewShirDeployed ? subscription().subscriptionId : ''
 *
 * — i.e. bound ONLY when the template actually deploys the Purview SHIR;
 * otherwise both are the EMPTY STRING. That is why every chain below falls
 * through an empty value rather than treating "set" as "set to something".
 *
 * The chains are the ones `lib/estate/pause-orchestrator.ts`
 * `resolveDeployManifest()` already established (lines 1268-1276) — deliberately
 * the same convention, not a second one:
 *
 *     Purview SHIR   rg  = LOOM_PURVIEW_SHIR_RG || LOOM_ADMIN_RG
 *                    sub = LOOM_SHIR_SUB || LOOM_SUBSCRIPTION_ID
 *     DLZ ADF SHIR   rg  = LOOM_DLZ_RG
 *                    sub = LOOM_SHIR_SUB || LOOM_DLZ_SUBSCRIPTION_ID
 *                          || LOOM_DLZ_SUB || LOOM_SUBSCRIPTION_ID
 *
 * ONE deliberate narrowing vs. the pause path: it also allows `LOOM_ADMIN_RG` as
 * a last-resort RG for the DLZ ADF SHIR. This module does not, and the #4248 fix
 * sketch says the same ("keeping `LOOM_DLZ_RG`"). The same bicep emits
 * `LOOM_DLZ_RG` UNCONDITIONALLY, from a param whose default is non-empty
 * (`rg-csa-loom-dlz-single-${location}`), so that fallback cannot fire on a
 * Loom-deployed console — and if it ever did it would compose a DLZ VMSS name
 * with the admin RG, which is precisely the shape this comment exists to
 * prevent, on a MUTATING path. Returning null instead yields the caller's honest
 * "not configured" gate, which is a safe outcome; scaling the wrong VMSS is not.
 *
 * The Purview SHIR's `|| LOOM_ADMIN_RG` is the SAME shape and gets the same answer
 * in a different place. It cannot simply be deleted — it is the only RG available
 * when the SHIR was deployed outside this template — so the resolver keeps it,
 * MARKS it (`resourceGroupAssumed`), and `scaleVmss` refuses to PATCH on a marked
 * config. Reads still resolve, so the metrics tile keeps reporting; the mutation
 * says what it assumed and what to set, rather than handing back ARM's own "does
 * not exist" as if the coordinates had been established (R7).
 *
 * KNOWN LIMITATION, inherited deliberately, NOT introduced here (#4248 audit).
 * `LOOM_SHIR_SUB` is bound from the *Purview* SHIR's deployment context, yet it
 * is FIRST in the *DLZ ADF* SHIR's subscription chain — in `resolveDeployManifest`
 * and therefore here. On an estate where the Purview SHIR is deployed (so
 * `LOOM_SHIR_SUB` = the admin sub) AND the DLZ ADF SHIR is deployed AND
 * `LOOM_DLZ_SUBSCRIPTION_ID` names a different sub, `shirVmssConfig()` resolves
 * the DLZ SHIR into the ADMIN sub. Diverging here would give the pause manifest
 * and the scaling surface two different ids for one machine — a worse instance
 * of the very family this fixes — so both paths keep the one convention and the
 * chain is corrected in ONE place when it is. Reported on #4248, not fixed here.
 */

/**
 * Resolve the DLZ ADF SHIR VMSS config from the deploy-emitted env.
 *
 * Returns null when the estate does not name this VMSS, so callers can surface
 * an honest gate (no SHIR deployed) instead of throwing.
 */
export function shirVmssConfig(env: NodeJS.ProcessEnv = process.env): VmssConfig | null {
  const name = v(env, 'LOOM_SHIR_VMSS_NAME');
  const resourceGroup = v(env, 'LOOM_DLZ_RG');
  // The DLZ RG lives in the DLZ subscription on a multi-sub estate; pairing it
  // with the admin sub is the measured `ResourceGroupNotFound` shape that
  // lib/azure/loom-subscriptions.ts exists to prevent. LOOM_DLZ_SUB is the
  // legacy alias some partially-migrated deploys still emit.
  const subscriptionId = v(env, 'LOOM_SHIR_SUB')
    || v(env, 'LOOM_DLZ_SUBSCRIPTION_ID')
    || v(env, 'LOOM_DLZ_SUB')
    || v(env, 'LOOM_SUBSCRIPTION_ID');
  if (!subscriptionId || !resourceGroup || !name) return null;
  return { subscriptionId, resourceGroup, name };
}

/**
 * Resolve the SHARED admin-zone Purview SHIR VMSS config from the deploy-emitted
 * env. A Purview SHIR cannot share a machine with the DLZ ADF SHIR (Microsoft
 * constraint — see purview-shir.bicep), so it is a SEPARATE VMSS with its own
 * home, and it resolves with its own coordinates: LOOM_PURVIEW_SHIR_RG /
 * LOOM_SHIR_SUB, both bound from the purview-shir module's deployment context.
 * LOOM_DLZ_RG must never leak in here.
 *
 * Returns null when not configured so callers surface an honest gate instead of
 * throwing (e.g. Purview not deployed, or no Purview IR auth key supplied).
 */
export function purviewShirVmssConfig(env: NodeJS.ProcessEnv = process.env): VmssConfig | null {
  const name = v(env, 'LOOM_PURVIEW_SHIR_VMSS_NAME');
  // `LOOM_PURVIEW_SHIR_RG` is emitted ONLY when this template deployed the SHIR
  // (admin-plane/main.bicep:4621 — `purviewShirDeployed ? resourceGroup().name : ''`).
  // In the same false branch the NAME falls back to `loomPurviewShirVmssName`, the
  // BROWNFIELD OVERRIDE documented at :1609 as "an EXISTING Purview SHIR VMSS
  // deployed outside this template" — and there is no matching RG override param.
  // So the `|| LOOM_ADMIN_RG` below fires in exactly one shape: the name has
  // EXTERNAL provenance and the home is this template's own RG, assumed. That is
  // a complete config `assertVmssTarget` passes, so it is flagged instead —
  // reads keep working, `scaleVmss` refuses (R7: the guess is disclosed, not
  // laundered into ARM's "does not exist").
  const declaredRg = v(env, 'LOOM_PURVIEW_SHIR_RG');
  const resourceGroup = declaredRg || v(env, 'LOOM_ADMIN_RG');
  const subscriptionId = v(env, 'LOOM_SHIR_SUB') || v(env, 'LOOM_SUBSCRIPTION_ID');
  if (!subscriptionId || !resourceGroup || !name) return null;
  return {
    subscriptionId,
    resourceGroup,
    name,
    ...(declaredRg ? {} : { resourceGroupAssumed: true }),
  };
}

/**
 * Refuse to address a VMSS whose coordinates are incomplete, and NAME what is
 * missing (deploy-integrity R7: the message states only what was established).
 *
 * The resolvers above return null rather than a partial config, but callers may
 * hand-build a `VmssConfig` (shir-autoscale, the register-purview-shir route,
 * anything reading a stored binding). Without this, an empty coordinate composes
 * a syntactically valid but semantically wrong ARM path — `/subscriptions//
 * resourceGroups/rg/...` — which ARM answers with a generic error that names
 * neither the missing value nor this deployment. Failing here converts a silent
 * wrong-target into a specific, actionable one. Sibling of `assertActuationTarget`
 * in lib/estate/pause-actuator.ts.
 */
export function assertVmssTarget(c: VmssConfig): void {
  const missing: string[] = [];
  if (!c?.subscriptionId?.trim()) {
    missing.push('subscriptionId (LOOM_SHIR_SUB, or LOOM_DLZ_SUBSCRIPTION_ID / LOOM_SUBSCRIPTION_ID)');
  }
  if (!c?.resourceGroup?.trim()) {
    missing.push('resourceGroup (LOOM_PURVIEW_SHIR_RG for the Purview SHIR, LOOM_DLZ_RG for the ADF SHIR)');
  }
  if (!c?.name?.trim()) {
    missing.push('name (LOOM_PURVIEW_SHIR_VMSS_NAME or LOOM_SHIR_VMSS_NAME)');
  }
  if (missing.length === 0) return;
  throw new VmssError(
    `Refusing to address a SHIR VM scale set with incomplete coordinates: ${missing.join('; ')} `
      + `${missing.length === 1 ? 'is' : 'are'} empty. Which scale set would be read or scaled was `
      + 'NOT established, so no ARM request was sent.',
    400,
  );
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new VmssError('Failed to acquire ARM token', 401);
  return t.token;
}

function basePath(c: VmssConfig): string {
  assertVmssTarget(c);
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
  // An ASSUMED resource group is refused HERE and not in getVmssStatus: a GET
  // against the wrong home is a wasted request, a PATCH against it either 404s or
  // scales a same-named stranger. This is the same call the sibling resolver makes
  // one function up — `shirVmssConfig` returns null rather than pair a DLZ VMSS
  // name with the admin RG — applied at the verb instead of the resolver, so the
  // read surfaces stay informative. Recoverable in one value: setting
  // LOOM_PURVIEW_SHIR_RG turns the guess into a declaration and this passes.
  if (c?.resourceGroupAssumed) {
    throw new VmssError(
      `Refusing to scale the scale set '${c.name}': its resource group '${c.resourceGroup}' was `
        + 'ASSUMED from LOOM_ADMIN_RG, because this deployment did not create that scale set and '
        + 'so emitted no LOOM_PURVIEW_SHIR_RG for it. Where it actually lives was NOT established, '
        + 'so no PATCH was sent — a wrong home either fails or scales a same-named scale set that '
        + 'belongs to something else. Set LOOM_PURVIEW_SHIR_RG to the resource group that holds '
        + `'${c.name}' and this scales.`,
      409,
    );
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
