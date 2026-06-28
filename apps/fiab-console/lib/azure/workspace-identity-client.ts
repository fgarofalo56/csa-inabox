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

import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

const ARM_SCOPE = armScope();
// Stable GA api-version for Microsoft.ManagedIdentity/userAssignedIdentities.
const MI_API = '2024-11-30';

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

/** Create-if-missing the per-workspace UAMI (PUT). Dormant — not on default path. */
export async function createWorkspaceUami(workspaceId: string, location: string): Promise<WorkspaceUami> {
  const r = await callArm(uamiUrl(workspaceId), { method: 'PUT', body: JSON.stringify({ location }) });
  if (!r.ok) throw new WorkspaceIdentityError(r.status, await r.text(), `create uami failed ${r.status}`);
  return shape(await r.json());
}

/** Delete the per-workspace UAMI (accepts 200/204). */
export async function deleteWorkspaceUami(workspaceId: string): Promise<void> {
  const r = await callArm(uamiUrl(workspaceId), { method: 'DELETE' });
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
