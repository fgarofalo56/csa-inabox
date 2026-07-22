/**
 * workspace-identity-client — Phase-1 §2.4 per-workspace managed identity
 * (DORMANT, ADDITIVE).
 *
 * Goal: let a workspace optionally run as its OWN user-assigned managed identity
 * (uami-ws-<workspaceId>) for trusted-workspace lake access, WITHOUT changing the
 * default path. {@link getWorkspaceCredential} returns a per-workspace
 * `ManagedIdentityCredential` only when that UAMI actually exists in ARM; in
 * every other case it returns the SHARED `uamiArmCredential()` — so until a
 * topology deploy provisions one (platform/fiab/bicep/modules/landing-zone/
 * workspace-identity.bicep), behaviour is bit-for-bit identical. No PE-only lake
 * is touched; this only swaps which identity mints the token.
 *
 * Azure-native, no Microsoft Fabric dependency (no-fabric-dependency.md): the
 * per-workspace UAMI is granted Storage Blob Data Contributor on the lake
 * container + admitted via networkAcls.resourceAccessRules — the bicep above.
 *
 * @azure/identity is LAZY-imported inside the credential fn (cold-start) so this
 * module stays import-cheap; ARM calls use the shared arm-credential chain.
 */

import { createHash } from 'node:crypto';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';
import type { WorkspaceGrantStatus } from '@/lib/types/workspace';

const ARM_SCOPE = armScope();
// Stable GA api-version for Microsoft.ManagedIdentity/userAssignedIdentities.
const MI_API = '2024-11-30';
// Stable GA api-version for Microsoft.Authorization/roleAssignments.
const RA_API = '2022-04-01';
// Storage Blob Data Contributor — the SAME role + GUID workspace-identity.bicep
// grants, and the ONLY role family the Console UAMI's constrained
// RBAC-Administrator (storage-rbac-admin.bicep ABAC condition) may delegate.
const STORAGE_BLOB_DATA_CONTRIBUTOR = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';

export class WorkspaceIdentityError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `workspace-identity ARM call failed (${status})`);
    this.name = 'WorkspaceIdentityError';
    this.status = status;
    this.body = body;
  }
}

export interface WorkspaceUami {
  id: string;
  name: string;
  clientId: string;
  principalId: string;
}

/** Per-workspace UAMI name — the bicep module names it the SAME way. */
export function workspaceUamiName(workspaceId: string): string {
  return `uami-ws-${workspaceId}`;
}

/** I1 — provisioning mode. Unset / unknown values are 'off' (the intended
 * day-one default; phased shadow → enforce is the sole Phase-0 exception to
 * default-ON, per the operator decision recorded in the loom-next-level PRP). */
export type WorkspaceIdentityMode = 'off' | 'shadow' | 'enforce';

export function workspaceIdentityMode(): WorkspaceIdentityMode {
  const v = (process.env.LOOM_WORKSPACE_IDENTITY_MODE || '').trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

/** I1 — true when workspace create should provision uami-ws-<id>: mode is not
 * 'off' AND the sub/RG config gate is clear. NEVER throws. */
export function workspaceIdentityProvisioningEnabled(): boolean {
  return workspaceIdentityMode() !== 'off' && !workspaceIdentityConfigGate();
}

/**
 * Honest config gate. Returns the exact missing env var so callers can show a
 * precise MessageBar; null when subscription + RG are both set. Mirrors
 * eventhubsConfigGate. NOTE: a missing gate NEVER blocks the default path —
 * getWorkspaceCredential falls back to the shared UAMI rather than throwing.
 */
export function workspaceIdentityConfigGate(): { missing: string } | null {
  if (!(process.env.LOOM_WS_IDENTITY_SUB || process.env.LOOM_SUBSCRIPTION_ID)) {
    return { missing: 'LOOM_WS_IDENTITY_SUB (or LOOM_SUBSCRIPTION_ID)' };
  }
  if (!(process.env.LOOM_WS_IDENTITY_RG || process.env.LOOM_DLZ_RG)) {
    return { missing: 'LOOM_WS_IDENTITY_RG (or LOOM_DLZ_RG)' };
  }
  return null;
}

function armConfig(): { subscriptionId: string; resourceGroup: string } {
  const subscriptionId = process.env.LOOM_WS_IDENTITY_SUB || process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_WS_IDENTITY_RG || process.env.LOOM_DLZ_RG || '';
  if (!subscriptionId || !resourceGroup) {
    throw new WorkspaceIdentityError(503, undefined, 'workspace-identity ARM not configured');
  }
  return { subscriptionId, resourceGroup };
}

function uamiUrl(workspaceId: string): string {
  const { subscriptionId, resourceGroup } = armConfig();
  return `${armBase()}/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${encodeURIComponent(workspaceUamiName(workspaceId))}?api-version=${MI_API}`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await uamiArmCredential().getToken(ARM_SCOPE);
  if (!t?.token) throw new WorkspaceIdentityError(401, undefined, 'Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
  });
}

// ── I1 ARM write queue (serialized + spaced + 429-backoff) ──────────────────
// Provision-on-create does MULTIPLE ARM writes per workspace (UAMI PUT +
// role-assignment PUT[s]); bulk topology deploys multiply that. TWO documented
// throttle buckets apply (Learn: azure-resource-manager/management/
// request-limits-and-throttling + managed-identities-azure-resources
// throttling limits):
//   1. UAMI create/update: 2 req/s per subscription, 0.25 req/s per resource.
//   2. General ARM write bucket: ~200 tokens per subscription per principal,
//      refilling ~10/s (token-bucket) — shared with every other Console write.
// So every write here is SERIALIZED through one queue with a minimum spacing
// (default 600 ms ≈ 1.7 writes/s — under bucket 1's per-sub rate and far under
// bucket 2's refill), and a 429 backs off honoring Retry-After (bounded).
// Read lazily so tests (and live tuning) can adjust without a module reload.
const armWriteSpacingMs = () => Number(process.env.LOOM_WS_IDENTITY_ARM_SPACING_MS ?? 600);
const ARM_429_MAX_RETRIES = 3;
const ARM_429_MAX_WAIT_MS = 30_000;

let armWriteTail: Promise<unknown> = Promise.resolve();
let lastArmWriteAt = 0;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Serialize an ARM WRITE through the module queue with spacing + 429 backoff.
 * Reads (GET) do not go through the queue — only writes count against the
 * write bucket / UAMI creation throttle. */
async function queuedArmWrite(url: string, init: RequestInit): Promise<Response> {
  const run = async (): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      await sleep(lastArmWriteAt + armWriteSpacingMs() - Date.now());
      lastArmWriteAt = Date.now();
      const r = await callArm(url, init);
      if (r.status !== 429 || attempt >= ARM_429_MAX_RETRIES) return r;
      const retryAfter = Number(r.headers.get('retry-after') || '0');
      await sleep(Math.min((retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000), ARM_429_MAX_WAIT_MS));
    }
  };
  const next = armWriteTail.then(run, run);
  // Keep the tail alive whatever the outcome (errors propagate to OUR caller only).
  armWriteTail = next.catch(() => undefined);
  return next;
}

function shape(json: any): WorkspaceUami {
  return {
    id: json?.id ?? '',
    name: json?.name ?? '',
    clientId: json?.properties?.clientId ?? '',
    principalId: json?.properties?.principalId ?? '',
  };
}

/** Look up the per-workspace UAMI; null when it does not exist (404). */
export async function getWorkspaceUami(workspaceId: string): Promise<WorkspaceUami | null> {
  const r = await callArm(uamiUrl(workspaceId));
  if (r.status === 404) return null;
  if (!r.ok) throw new WorkspaceIdentityError(r.status, await r.text(), `get uami failed ${r.status}`);
  return shape(await r.json());
}

/** Create-if-missing the per-workspace UAMI (PUT, queued/throttled — I1). */
export async function createWorkspaceUami(workspaceId: string, location: string): Promise<WorkspaceUami> {
  const r = await queuedArmWrite(uamiUrl(workspaceId), { method: 'PUT', body: JSON.stringify({ location }) });
  if (!r.ok) throw new WorkspaceIdentityError(r.status, await r.text(), `create uami failed ${r.status}`);
  return shape(await r.json());
}

/** Delete the per-workspace UAMI (accepts 200/204; queued/throttled — I1). */
export async function deleteWorkspaceUami(workspaceId: string): Promise<void> {
  const r = await queuedArmWrite(uamiUrl(workspaceId), { method: 'DELETE' });
  if (!r.ok && r.status !== 204) throw new WorkspaceIdentityError(r.status, await r.text(), `delete uami failed ${r.status}`);
}

/**
 * Return the credential a workspace should use. PER-WORKSPACE when a
 * uami-ws-<id> exists AND its clientId is known; otherwise the SHARED UAMI — so
 * the default path is identical. Any ARM failure (unconfigured / unreachable)
 * silently falls back: per-workspace identity is opt-in, never a gate.
 *
 * `@azure/identity` is lazy-imported here so the per-workspace branch only pays
 * the cold-start when it is actually taken.
 */
export async function getWorkspaceCredential(workspaceId: string) {
  let uami: WorkspaceUami | null = null;
  try {
    if (workspaceId && !workspaceIdentityConfigGate()) {
      uami = await getWorkspaceUami(workspaceId);
    }
  } catch {
    uami = null; // unreachable / unconfigured → shared UAMI (unchanged default)
  }
  if (uami?.clientId) {
    const { ManagedIdentityCredential } = await import('@azure/identity');
    return new ManagedIdentityCredential({ clientId: uami.clientId });
  }
  return uamiArmCredential();
}

// ── I1 — scoped role grants for the workspace UAMI ──────────────────────────

/** Deterministic role-assignment GUID from (scope, principal, role) — the SAME
 * idempotency contract as bicep's guid(): re-running the provision PUTs the
 * SAME assignment name, so ARM returns the existing assignment instead of
 * accumulating duplicates. */
export function roleAssignmentGuid(scope: string, principalId: string, roleDefinitionId: string): string {
  const h = createHash('sha256').update(`${scope}|${principalId}|${roleDefinitionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Resolve the ADLS lake scope the workspace UAMI gets Storage Blob Data
 * Contributor on — the tightest scope resolvable from config, mirroring
 * workspace-identity.bicep (which grants on ONE lake container):
 *   1. an explicit per-workspace storage binding (ws.storageAccountId) → account scope;
 *   2. LOOM_BRONZE_URL / LOOM_LANDING_URL (https://<acct>.dfs...../<container>)
 *      → container scope on the DLZ lake account;
 *   3. LOOM_ADLS_ACCOUNT → account scope.
 * Null (with the missing var named) when none resolves.
 */
export function workspaceLakeGrantScope(ws: { storageAccountId?: string }): { scope: string } | { missing: string } {
  if (ws.storageAccountId) return { scope: ws.storageAccountId };
  const { subscriptionId, resourceGroup } = armConfig();
  const lakeUrl = process.env.LOOM_BRONZE_URL || process.env.LOOM_LANDING_URL || '';
  const m = lakeUrl.match(/^https:\/\/([^./]+)\.dfs\.[^/]+\/([^/?#]+)/i);
  const accountId = (name: string) =>
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Storage/storageAccounts/${name}`;
  if (m) return { scope: `${accountId(m[1])}/blobServices/default/containers/${m[2]}` };
  const account = process.env.LOOM_ADLS_ACCOUNT || '';
  if (account) return { scope: accountId(account) };
  return { missing: 'LOOM_BRONZE_URL (or LOOM_LANDING_URL / LOOM_ADLS_ACCOUNT)' };
}

/**
 * Idempotently PUT the workspace UAMI's scoped role assignments (I1 — the ADLS
 * lake grant; the full per-backend matrix lands with I2). Deterministic guid()
 * names + 409 RoleAssignmentExists tolerated, so a re-run is a no-op. Writes go
 * through the serialized ARM write queue (both throttle buckets — see above).
 * NEVER throws — every outcome is recorded per grant.
 */
export async function ensureWorkspaceGrants(
  ws: { id: string; storageAccountId?: string },
  uami: Pick<WorkspaceUami, 'principalId'>,
): Promise<WorkspaceGrantStatus[]> {
  const roleDefinitionId = STORAGE_BLOB_DATA_CONTRIBUTOR;
  let scope = '';
  try {
    const resolved = workspaceLakeGrantScope(ws);
    if ('missing' in resolved) {
      return [{
        backend: 'adls-lake', roleDefinitionId, scope: '', status: 'failed',
        error: `Cannot resolve the lake grant scope — set ${resolved.missing}.`,
      }];
    }
    scope = resolved.scope;
    const { subscriptionId } = armConfig();
    const name = roleAssignmentGuid(scope, uami.principalId, roleDefinitionId);
    const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=${RA_API}`;
    const r = await queuedArmWrite(url, {
      method: 'PUT',
      body: JSON.stringify({
        properties: {
          roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`,
          principalId: uami.principalId,
          principalType: 'ServicePrincipal',
        },
      }),
    });
    if (r.ok) return [{ backend: 'adls-lake', roleDefinitionId, scope, status: 'granted' }];
    const body = await r.text();
    if (r.status === 409 && /RoleAssignmentExists|already exists/i.test(body)) {
      return [{ backend: 'adls-lake', roleDefinitionId, scope, status: 'exists' }];
    }
    return [{
      backend: 'adls-lake', roleDefinitionId, scope, status: 'failed',
      error: `ARM ${r.status}: ${body.slice(0, 300)}${r.status === 403
        ? ' (the Console UAMI needs the constrained RBAC-Administrator grant from landing-zone/storage-rbac-admin.bicep on the lake account)'
        : ''}`,
    }];
  } catch (e: any) {
    return [{ backend: 'adls-lake', roleDefinitionId, scope, status: 'failed', error: e?.message || String(e) }];
  }
}

// ── I1 — delete cascade (workspace delete → UAMI + role assignments) ────────

export interface WorkspaceIdentityCascadeOutcome {
  status: 'deleted' | 'skipped' | 'failed';
  uamiName?: string;
  /** Role assignments removed for the UAMI's principal before deleting it
   * (deleting a UAMI does NOT delete its assignments — they orphan). */
  roleAssignmentsRemoved?: number;
  error?: string;
  at: string;
}

/**
 * Best-effort cascade-delete of the per-workspace UAMI + its role assignments
 * (the #2020 delete-cascade sibling for identity). NEVER throws and never
 * blocks the workspace delete — the outcome is recorded (returned to the
 * DELETE route, which surfaces it in the response body).
 */
export async function cascadeDeleteWorkspaceIdentity(
  workspaceId: string,
  principalIdHint?: string,
): Promise<WorkspaceIdentityCascadeOutcome> {
  const at = new Date().toISOString();
  const uamiName = workspaceUamiName(workspaceId);
  try {
    if (workspaceIdentityConfigGate()) {
      return { status: 'skipped', uamiName, error: `workspace-identity ARM not configured (${workspaceIdentityConfigGate()!.missing})`, at };
    }
    // Resolve the principal (doc hint first; ARM lookup as fallback) so the
    // role assignments can be swept even after the UAMI itself is gone.
    let principalId = principalIdHint || '';
    const existing = await getWorkspaceUami(workspaceId).catch(() => null);
    if (!principalId) principalId = existing?.principalId || '';
    if (!existing && !principalId) return { status: 'skipped', uamiName, at };

    // 1. Remove the principal's role assignments (list at sub scope by filter,
    //    delete each — writes go through the throttle queue).
    let removed = 0;
    if (principalId) {
      try {
        const { subscriptionId } = armConfig();
        const listUrl = `${armBase()}/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=${RA_API}&$filter=principalId eq '${principalId}'`;
        const lr = await callArm(listUrl);
        if (lr.ok) {
          const rows: Array<{ id?: string }> = (await lr.json())?.value ?? [];
          for (const row of rows) {
            if (!row.id) continue;
            const dr = await queuedArmWrite(`${armBase()}${row.id}?api-version=${RA_API}`, { method: 'DELETE' });
            if (dr.ok || dr.status === 204) removed++;
          }
        }
      } catch { /* best-effort — the UAMI delete below still proceeds */ }
    }

    // 2. Delete the UAMI itself (204 also OK when already gone).
    if (existing) await deleteWorkspaceUami(workspaceId);
    return { status: 'deleted', uamiName, roleAssignmentsRemoved: removed, at };
  } catch (e: any) {
    return { status: 'failed', uamiName, error: e?.message || String(e), at };
  }
}
