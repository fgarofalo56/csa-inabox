/**
 * ARM-side helpers for the Dedicated SQL pool: state, pause, resume.
 * Uses DefaultAzureCredential to call the ARM REST API directly.
 * MI must hold Synapse Administrator (or equivalent) at the workspace.
 */

import { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';
import { discoverResourceCoordsByName } from './resource-graph-coords';

const ARM_SCOPE = armScope();
const ARM_API = '2021-06-01';
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

// LOOM_SYNAPSE_SUB wins for a reused workspace in another subscription (BYO
// wizard), else the deployment sub. Keeps cross-sub Synapse pool ops on-target.
function synapseSub(): string { return process.env.LOOM_SYNAPSE_SUB || required('LOOM_SUBSCRIPTION_ID'); }

// The RG the workspace lives in. Bicep emits LOOM_SYNAPSE_RG (defaults to the
// DLZ RG); honour it first, then LOOM_DLZ_RG. This used to read ONLY
// LOOM_DLZ_RG, which combined with the wrong sub produced a sub/RG mismatch.
function synapseRg(): string {
  return process.env.LOOM_SYNAPSE_RG || process.env.LOOM_DLZ_RG || required('LOOM_DLZ_RG');
}

interface WorkspaceCoords { sub: string; rg: string; }

// Resolved coordinates win once discovered (cached for the process). When the
// env-configured sub/RG don't match where the workspace ACTUALLY lives (the
// common multi-sub topology — workspace in the DLZ sub, LOOM_SYNAPSE_SUB still
// pointing at the admin plane), the configured ARM scope 404s and the status
// probe falsely reports "Unknown". We then discover the real {sub, rg} by
// workspace name via Azure Resource Graph and cache it.
let resolvedCoords: WorkspaceCoords | null = null;

function configuredCoords(): WorkspaceCoords {
  return { sub: synapseSub(), rg: synapseRg() };
}

function poolUrlFor(coords: WorkspaceCoords): string {
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  return `${armBase()}/subscriptions/${coords.sub}/resourceGroups/${coords.rg}/providers/Microsoft.Synapse/workspaces/${ws}/sqlPools/${pool}?api-version=${ARM_API}`;
}

function actionUrlFor(coords: WorkspaceCoords, action: 'resume' | 'pause'): string {
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  return `${armBase()}/subscriptions/${coords.sub}/resourceGroups/${coords.rg}/providers/Microsoft.Synapse/workspaces/${ws}/sqlPools/${pool}/${action}?api-version=${ARM_API}`;
}

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token');
  return fetchWithTimeout(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

/**
 * Discover where the Synapse workspace ACTUALLY lives (subscription + resource
 * group) by name, via Azure Resource Graph, across every subscription the
 * Console identity can read. Used as a self-healing fallback when the
 * env-configured ARM scope doesn't resolve the pool — so the status badge
 * reflects the real ARM state instead of a false "Unknown".
 *
 * Delegates to the shared `discoverResourceCoordsByName` helper (PR
 * generalizing #1445) so every DLZ-targeting ARM client self-heals identically.
 */
async function discoverCoordsByName(): Promise<WorkspaceCoords | null> {
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const coords = await discoverResourceCoordsByName({
    resourceType: 'Microsoft.Synapse/workspaces',
    name: ws,
    credential,
  });
  return coords ? { sub: coords.subscriptionId, rg: coords.resourceGroup } : null;
}

/**
 * GET the pool, self-healing across a sub/RG mismatch. Tries the cached coords,
 * then the env-configured coords; on a 404/403 (the pool isn't where we looked)
 * it discovers the workspace's real coords via Resource Graph, caches them, and
 * retries — so the returned Response reflects the pool's REAL ARM state instead
 * of a false "Unknown". Returns the live Response (so callers don't re-fetch).
 */
async function fetchPool(): Promise<Response> {
  if (resolvedCoords) return armFetch(poolUrlFor(resolvedCoords));

  const configured = configuredCoords();
  const res = await armFetch(poolUrlFor(configured)).catch(() => null);
  if (res && res.ok) {
    resolvedCoords = configured;
    return res;
  }
  // 404/403 (or transport error): the env scope is wrong/insufficient. Discover.
  if (!res || res.status === 404 || res.status === 403) {
    const discovered = await discoverCoordsByName();
    if (discovered) {
      resolvedCoords = discovered;
      return armFetch(poolUrlFor(discovered));
    }
  }
  // No discovery hit — re-issue against the configured URL so the real ARM
  // error (status + body) surfaces to the caller instead of a swallowed null.
  return res ?? armFetch(poolUrlFor(configured));
}

async function resolveActionUrl(action: 'resume' | 'pause'): Promise<string> {
  // Ensure coords are resolved (probes + caches via fetchPool) before acting.
  if (!resolvedCoords) { await fetchPool().catch(() => null); }
  return actionUrlFor(resolvedCoords || configuredCoords(), action);
}

export type PoolState = 'Online' | 'Paused' | 'Pausing' | 'Resuming' | 'Scaling' | 'Unknown';

export async function getPoolState(): Promise<{ state: PoolState; sku: string; status: string }> {
  const res = await fetchPool();
  if (!res.ok) {
    throw new Error(`ARM getPool failed ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const status = body?.properties?.status as string | undefined;
  return {
    state: (status as PoolState) || 'Unknown',
    sku: body?.sku?.name || 'unknown',
    status: status || 'Unknown',
  };
}

export async function resumePool(): Promise<void> {
  const url = await resolveActionUrl('resume');
  const res = await armFetch(url, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    throw new Error(`ARM resume failed ${res.status}: ${await res.text()}`);
  }
}

export async function pausePool(): Promise<void> {
  const url = await resolveActionUrl('pause');
  const res = await armFetch(url, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    throw new Error(`ARM pause failed ${res.status}: ${await res.text()}`);
  }
}

/** Poll until pool is Online or fails. ~2 min wall time at the upper bound. */
export async function waitForOnline(maxMs = 180_000, intervalMs = 5_000): Promise<PoolState> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { state } = await getPoolState();
    if (state === 'Online') return state;
    if (state === 'Paused') return state; // caller decides whether to resume
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'Unknown';
}
