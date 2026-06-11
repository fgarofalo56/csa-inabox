/**
 * Databricks workspace discovery over Azure Resource Manager (ARM).
 *
 * The Unified Catalog → Metastores tab lets an operator register a Databricks
 * workspace so the console can federate over its Unity Catalog. Rather than
 * making the operator hand-type an `adb-….azuredatabricks.net` hostname, this
 * helper enumerates every `Microsoft.Databricks/workspaces` resource the
 * Console identity (UAMI → DefaultAzureCredential chain) can read across the
 * subscriptions it has Reader on.
 *
 * Discovery flow (real ARM REST — no mocks):
 *   1. `GET /subscriptions?api-version=2022-12-01`
 *        → every subscription the identity can see. If `LOOM_SUBSCRIPTION_ID`
 *          (single) or `LOOM_DATABRICKS_SUBSCRIPTIONS` (comma-separated) is
 *          set we scope to those instead of enumerating all — faster and
 *          avoids cross-tenant noise.
 *   2. For each subscription:
 *        `GET /subscriptions/{sub}/providers/Microsoft.Databricks/workspaces
 *             ?api-version=2024-05-01`
 *        → the workspaces. `properties.workspaceUrl` is the host the UC REST
 *          client talks to (sans scheme).
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) against the ARM
 * scope. The identity needs `Reader` (or any role that grants
 * `Microsoft.Databricks/workspaces/read`) on the subscriptions/RGs to list.
 *
 * Microsoft Learn refs:
 *   - Databricks Workspaces ARM REST (listBySubscription):
 *     https://learn.microsoft.com/rest/api/databricks/workspaces
 *   - Subscriptions - List:
 *     https://learn.microsoft.com/rest/api/resources/subscriptions/list
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope, stripArmBase } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const SUBSCRIPTIONS_API = '2022-12-01';
const DATABRICKS_API = '2024-05-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class DatabricksDiscoveryError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'DatabricksDiscoveryError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

export interface DatabricksWorkspaceSummary {
  /** ARM resource id. */
  id: string;
  /** Workspace resource name (the friendly name shown in the portal). */
  name: string;
  /** Hostname (`adb-….azuredatabricks.net`), no scheme — what the UC client uses. */
  workspaceUrl: string;
  location?: string;
  resourceGroup?: string;
  subscriptionId: string;
  sku?: string;
  provisioningState?: string;
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new DatabricksDiscoveryError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armGet<T = any>(path: string): Promise<T> {
  const token = await armToken();
  const url = `${armBase()}${path}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message ||
      (typeof json === 'string' ? json : `ARM GET ${path} failed ${res.status}`);
    throw new DatabricksDiscoveryError(msg, res.status, json, url);
  }
  return (json as T) ?? ({} as T);
}

/** Page through an ARM list endpoint that uses `nextLink` continuation. */
async function armList<T = any>(firstPath: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    // nextLink is an absolute URL; strip the host so armGet can re-prefix it.
    const path: string = stripArmBase(next);
    const page: { value?: T[]; nextLink?: string } =
      await armGet<{ value?: T[]; nextLink?: string }>(path);
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page.nextLink || null;
  }
  return out;
}

/** Subscriptions to scan for Databricks workspaces.
 *  - `LOOM_DATABRICKS_SUBSCRIPTIONS` (comma-separated) wins,
 *  - else `LOOM_SUBSCRIPTION_ID` (single),
 *  - else every subscription the identity can read via ARM. */
async function targetSubscriptionIds(): Promise<string[]> {
  const explicitMulti = process.env.LOOM_DATABRICKS_SUBSCRIPTIONS;
  if (explicitMulti) {
    return explicitMulti.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const single = process.env.LOOM_SUBSCRIPTION_ID;
  if (single) return [single.trim()];
  const subs = await armList<{ subscriptionId: string }>(
    `/subscriptions?api-version=${SUBSCRIPTIONS_API}`,
  );
  return subs.map((s) => s.subscriptionId).filter(Boolean);
}

function shape(raw: any, subscriptionId: string): DatabricksWorkspaceSummary | null {
  const url: string | undefined = raw?.properties?.workspaceUrl;
  if (!url) return null;
  const id: string = raw?.id || '';
  const rgMatch = /\/resourceGroups\/([^/]+)\//i.exec(id);
  return {
    id,
    name: raw?.name || url,
    workspaceUrl: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    location: raw?.location,
    resourceGroup: rgMatch?.[1],
    subscriptionId,
    sku: raw?.sku?.name,
    provisioningState: raw?.properties?.provisioningState,
  };
}

/**
 * List every Databricks workspace the Console identity can see across the
 * target subscriptions. Per-subscription failures (e.g. the identity lacks
 * Reader on one subscription) are swallowed so a single inaccessible sub
 * doesn't blank the whole picker — the reachable workspaces still return.
 *
 * Throws {@link DatabricksDiscoveryError} only when the *initial* subscription
 * enumeration itself fails (e.g. no ARM token / no subscription visibility),
 * which the BFF turns into an honest MessageBar gate.
 */
export async function listDatabricksWorkspaces(): Promise<DatabricksWorkspaceSummary[]> {
  const subs = await targetSubscriptionIds();
  const all: DatabricksWorkspaceSummary[] = [];
  const seen = new Set<string>();
  for (const sub of subs) {
    let raws: any[] = [];
    try {
      raws = await armList<any>(
        `/subscriptions/${sub}/providers/Microsoft.Databricks/workspaces?api-version=${DATABRICKS_API}`,
      );
    } catch {
      // Reader not granted on this subscription, or provider not registered —
      // skip it and keep enumerating the rest.
      continue;
    }
    for (const r of raws) {
      const w = shape(r, sub);
      if (w && !seen.has(w.workspaceUrl)) {
        seen.add(w.workspaceUrl);
        all.push(w);
      }
    }
  }
  // Stable, human-friendly ordering for the dropdown.
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}
