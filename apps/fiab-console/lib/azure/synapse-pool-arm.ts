/**
 * ARM-side helpers for the Dedicated SQL pool: state, pause, resume.
 * Uses DefaultAzureCredential to call the ARM REST API directly.
 * MI must hold Synapse Administrator (or equivalent) at the workspace.
 */

import { DefaultAzureCredential } from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const ARM_API = '2021-06-01';
const credential = new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function poolUrl(): string {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = required('LOOM_DLZ_RG');
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  return `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Synapse/workspaces/${ws}/sqlPools/${pool}?api-version=${ARM_API}`;
}

async function armFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

export type PoolState = 'Online' | 'Paused' | 'Pausing' | 'Resuming' | 'Scaling' | 'Unknown';

export async function getPoolState(): Promise<{ state: PoolState; sku: string; status: string }> {
  const res = await armFetch(poolUrl());
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
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = required('LOOM_DLZ_RG');
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Synapse/workspaces/${ws}/sqlPools/${pool}/resume?api-version=${ARM_API}`;
  const res = await armFetch(url, { method: 'POST' });
  if (!res.ok && res.status !== 202) {
    throw new Error(`ARM resume failed ${res.status}: ${await res.text()}`);
  }
}

export async function pausePool(): Promise<void> {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = required('LOOM_DLZ_RG');
  const ws = required('LOOM_SYNAPSE_WORKSPACE');
  const pool = required('LOOM_SYNAPSE_DEDICATED_POOL');
  const url = `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Synapse/workspaces/${ws}/sqlPools/${pool}/pause?api-version=${ARM_API}`;
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
