/**
 * Lakebase (Databricks) — OPT-IN alternate backend for the lakebase-postgres
 * item (DBX-4).
 *
 * The DEFAULT Lakebase backend is Azure Database for PostgreSQL Flexible Server
 * (postgres-flex-client.ts) — 100% functional with zero Databricks dependency,
 * per no-fabric-dependency.md / the Databricks-parity PRP. This module drives
 * REAL Databricks Lakebase REST (`/api/2.0/database/instances`) and is reached
 * ONLY when the operator explicitly opts in with:
 *
 *     LOOM_LAKEBASE_BACKEND = databricks     (backend selector)
 *     LOOM_DATABRICKS_HOSTNAME = adb-….azuredatabricks.net   (bound workspace)
 *
 * If either is absent the caller gets a structured honest gate (never a silent
 * failure, never a fake instance) and the editor stays on the Azure-native path.
 * This mirrors the SQL-database Fabric-vs-Azure pattern (docs/fiab/prp/databases.md).
 *
 * Auth: AAD token for the Azure Databricks first-party app
 * (2ff814a6-3304-4ab8-85cb-cd0e6f879c1d), same credential chain as
 * databricks-client.ts. The Console UAMI must be a workspace user with the
 * Lakebase (Database) entitlement.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const DBX_SCOPE = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class LakebaseDatabricksError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LakebaseDatabricksError';
    this.status = status;
  }
}

/**
 * Honest opt-in gate. Returns `{ missing, detail }` when the Databricks backend
 * is NOT fully opted into (so the route 503s with a precise MessageBar and the
 * editor stays Azure-native), or `null` when both the selector AND a bound
 * workspace are present.
 */
export function lakebaseDatabricksGate(): { missing: string; detail: string } | null {
  if ((process.env.LOOM_LAKEBASE_BACKEND || '').toLowerCase() !== 'databricks') {
    return {
      missing: 'LOOM_LAKEBASE_BACKEND',
      detail:
        'The Databricks Lakebase backend is opt-in. Set LOOM_LAKEBASE_BACKEND=databricks and bind a ' +
        'workspace (LOOM_DATABRICKS_HOSTNAME) to use real Lakebase REST. The default backend is Azure ' +
        'Database for PostgreSQL Flexible Server, which is fully functional with no Databricks dependency.',
    };
  }
  if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
    return {
      missing: 'LOOM_DATABRICKS_HOSTNAME',
      detail:
        'LOOM_LAKEBASE_BACKEND=databricks is set but no workspace is bound. Set LOOM_DATABRICKS_HOSTNAME to ' +
        'the workspace host (adb-….azuredatabricks.net) whose Lakebase instances Loom should drive.',
    };
  }
  return null;
}

/** True when the Databricks backend is fully opted into. */
export function isLakebaseDatabricksSelected(): boolean {
  return lakebaseDatabricksGate() === null;
}

function host(): string {
  const h = process.env.LOOM_DATABRICKS_HOSTNAME;
  if (!h) throw new LakebaseDatabricksError('LOOM_DATABRICKS_HOSTNAME not configured', 503);
  return h.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function dbxToken(): Promise<string> {
  const t = await credential.getToken(DBX_SCOPE);
  if (!t?.token) throw new LakebaseDatabricksError('Failed to acquire a Databricks AAD token', 401);
  return t.token;
}

async function dbxRequest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const gate = lakebaseDatabricksGate();
  if (gate) throw new LakebaseDatabricksError(gate.detail, 503);
  const token = await dbxToken();
  const res = await fetchWithTimeout(`https://${host()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.message || json?.error_code || text || 'Databricks Lakebase call failed').toString();
    throw new LakebaseDatabricksError(msg, res.status);
  }
  return json as T;
}

export interface LakebaseInstance {
  name: string;
  uid?: string;
  state?: string;
  capacity?: string;
  readWriteDns?: string;
  creationTime?: string;
}

function mapInstance(i: any): LakebaseInstance {
  return {
    name: i?.name,
    uid: i?.uid,
    state: i?.state,
    capacity: i?.capacity,
    readWriteDns: i?.read_write_dns,
    creationTime: i?.creation_time,
  };
}

/** List Lakebase database instances in the bound workspace. */
export async function listInstances(): Promise<LakebaseInstance[]> {
  const res = await dbxRequest<{ database_instances?: any[] }>('/api/2.0/database/instances');
  return (res?.database_instances || []).map(mapInstance);
}

export interface CreateInstanceSpec {
  name: string;
  /** Lakebase capacity, e.g. "CU_1" | "CU_2" | "CU_4" | "CU_8". */
  capacity: string;
}

/** Create a Lakebase database instance (real POST /api/2.0/database/instances). */
export async function createInstance(spec: CreateInstanceSpec): Promise<LakebaseInstance> {
  if (!spec.name || !spec.capacity) throw new LakebaseDatabricksError('name and capacity are required', 400);
  const res = await dbxRequest<any>('/api/2.0/database/instances', {
    method: 'POST',
    body: JSON.stringify({ name: spec.name, capacity: spec.capacity }),
  });
  return mapInstance(res);
}
