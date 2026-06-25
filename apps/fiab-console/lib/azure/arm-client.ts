/**
 * Shared, sovereign-cloud-aware ARM control-plane fetcher.
 *
 * Unifies the per-client `armFetch()` helpers (synapse-pool-arm.ts,
 * kusto-arm-client.ts, …) behind one importable surface so new ARM calls don't
 * re-implement token acquisition + error handling. Cloud endpoint + scope come
 * from cloud-endpoints (AZURE_CLOUD / LOOM_ARM_ENDPOINT aware).
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential({clientId:
 * LOOM_UAMI_CLIENT_ID}), DefaultAzureCredential) — the same chain every other
 * ARM client uses. The Console UAMI must hold the relevant Azure RBAC role for
 * each call (e.g. Contributor on the Synapse workspace for OAP writes); a 403
 * is surfaced verbatim so the caller can show an honest remediation gate.
 *
 * No mocks. Every function hits real ARM.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';

const ARM_SCOPE = armScope();

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Build a fully-qualified ARM URL from a bare `/subscriptions/...` path. */
function armUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${armBase()}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function armFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token');
  // Per-request timeout so a hung ARM call can't make the BFF route (and the
  // page) spin forever. 202 LROs are polled by the caller; each poll round-trip
  // inherits this same per-request ceiling.
  return fetchWithTimeout(armUrl(path), {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function jsonOrThrow<T = any>(res: Response, label: string): Promise<T> {
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => '');
    throw new Error(`ARM ${label} failed ${res.status}: ${body.slice(0, 600)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** GET an ARM resource by bare path (api-version included by the caller). */
export async function armGet<T = any>(path: string): Promise<T> {
  return jsonOrThrow<T>(await armFetch(path), `GET ${path}`);
}

/** PATCH an ARM resource by bare path. */
export async function armPatch<T = any>(path: string, body: unknown): Promise<T> {
  return jsonOrThrow<T>(
    await armFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
    `PATCH ${path}`,
  );
}

/** PUT an ARM resource by bare path. */
export async function armPut<T = any>(path: string, body: unknown): Promise<T> {
  return jsonOrThrow<T>(
    await armFetch(path, { method: 'PUT', body: JSON.stringify(body) }),
    `PUT ${path}`,
  );
}

/** DELETE an ARM resource by bare path (api-version included by the caller).
 *  Tolerates 200/202/204 and a 404 (already-deleted = idempotent success). */
export async function armDelete(path: string): Promise<void> {
  const res = await armFetch(path, { method: 'DELETE' });
  if (!res.ok && res.status !== 202 && res.status !== 204 && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`ARM DELETE ${path} failed ${res.status}: ${body.slice(0, 600)}`);
  }
}

// ---------------------------------------------------------------------------
// Synapse workspace Outbound Access / trusted-service bypass (OAP)
// ---------------------------------------------------------------------------
//
// In the Synapse workspace ARM resource, the "Allow Azure services and
// resources to access this workspace" network toggle is the boolean property
// `properties.trustedServiceBypassEnabled` on
//   Microsoft.Synapse/workspaces/{ws}?api-version=2021-06-01
// (PATCH with { properties: { trustedServiceBypassEnabled: <bool> } }). This
// property exists in Commercial, GCC, GCC-High and DoD — armBase() resolves the
// per-cloud ARM host so no Fabric / Power BI host is ever touched.

const SYNAPSE_API = '2021-06-01';

function synapseWorkspacePath(sub: string, rg: string, ws: string): string {
  return `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Synapse/workspaces/${encodeURIComponent(ws)}?api-version=${SYNAPSE_API}`;
}

export interface SynapseOapState {
  trustedServiceBypassEnabled: boolean;
  provisioningState: string;
}

/** Read the Synapse workspace OAP (trusted-service bypass) toggle. */
export async function getSynapseWorkspaceOap(
  sub: string,
  rg: string,
  ws: string,
): Promise<SynapseOapState> {
  const body = await armGet<{ properties?: { trustedServiceBypassEnabled?: boolean; provisioningState?: string } }>(
    synapseWorkspacePath(sub, rg, ws),
  );
  return {
    trustedServiceBypassEnabled: !!body?.properties?.trustedServiceBypassEnabled,
    provisioningState: body?.properties?.provisioningState || 'Unknown',
  };
}

/** Set the Synapse workspace OAP (trusted-service bypass) toggle. */
export async function setSynapseWorkspaceOap(
  sub: string,
  rg: string,
  ws: string,
  enabled: boolean,
): Promise<{ trustedServiceBypassEnabled: boolean }> {
  const body = await armPatch<{ properties?: { trustedServiceBypassEnabled?: boolean } }>(
    synapseWorkspacePath(sub, rg, ws),
    { properties: { trustedServiceBypassEnabled: enabled } },
  );
  return { trustedServiceBypassEnabled: !!body?.properties?.trustedServiceBypassEnabled };
}
