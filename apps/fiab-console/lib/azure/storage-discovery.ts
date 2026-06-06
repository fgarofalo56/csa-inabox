/**
 * Storage-account discovery over Azure Resource Manager (ARM).
 *
 * Powers the lakehouse "New shortcut" wizard's in-tenant ADLS Gen2 / Blob
 * account picker — instead of hand-typing an `abfss://…dfs.core.windows.net`
 * URI, the user picks a real storage account the Console identity can read
 * across the subscriptions it has Reader on, then a container + path. Real ARM
 * REST, no mocks; per-subscription failures are swallowed.
 *
 * Auth: ChainedTokenCredential(UAMI → DefaultAzureCredential) on the ARM scope.
 * Needs Reader (Microsoft.Storage/storageAccounts/read).
 * Docs: https://learn.microsoft.com/rest/api/storagerp/storage-accounts/list
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const SUBSCRIPTIONS_API = '2022-12-01';
const STORAGE_API = '2023-05-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class StorageDiscoveryError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'StorageDiscoveryError'; this.status = status; }
}

export interface StorageAccountSummary {
  id: string;
  name: string;
  resourceGroup?: string;
  subscriptionId: string;
  location?: string;
  /** True when the account is hierarchical-namespace (ADLS Gen2). */
  isHns: boolean;
  /** dfs endpoint host (no scheme), e.g. acct.dfs.core.windows.net. */
  dfsHost?: string;
  blobHost?: string;
  sku?: string;
}

async function armGet<T = any>(path: string): Promise<T> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new StorageDiscoveryError('Failed to acquire ARM token', 401);
  const res = await fetch(`https://management.azure.com${path}`, {
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json' }, cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || `ARM GET ${path} failed ${res.status}`;
    throw new StorageDiscoveryError(msg, res.status);
  }
  return (json as T) ?? ({} as T);
}

async function armList<T = any>(firstPath: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath; let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const p = next.startsWith('https://management.azure.com') ? next.slice('https://management.azure.com'.length) : next;
    const page: { value?: T[]; nextLink?: string } = await armGet(p);
    if (Array.isArray(page.value)) out.push(...page.value);
    next = page.nextLink || null;
  }
  return out;
}

async function subscriptionIds(): Promise<string[]> {
  const single = process.env.LOOM_SUBSCRIPTION_ID;
  if (single) return [single.trim()];
  const subs = await armList<{ subscriptionId: string }>(`/subscriptions?api-version=${SUBSCRIPTIONS_API}`);
  return subs.map((s) => s.subscriptionId).filter(Boolean);
}

function shape(raw: any, sub: string): StorageAccountSummary {
  const id: string = raw?.id || '';
  const ep = raw?.properties?.primaryEndpoints || {};
  const host = (u?: string) => (u ? u.replace(/^https?:\/\//, '').replace(/\/$/, '') : undefined);
  return {
    id, name: raw?.name || '',
    resourceGroup: /\/resourceGroups\/([^/]+)\//i.exec(id)?.[1],
    subscriptionId: sub,
    location: raw?.location,
    isHns: raw?.properties?.isHnsEnabled === true,
    dfsHost: host(ep.dfs),
    blobHost: host(ep.blob),
    sku: raw?.sku?.name,
  };
}

/** Every storage account the Console identity can read across target subs. */
export async function listStorageAccounts(): Promise<StorageAccountSummary[]> {
  const subs = await subscriptionIds();
  const all: StorageAccountSummary[] = [];
  for (const sub of subs) {
    try {
      const raws = await armList<any>(`/subscriptions/${sub}/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE_API}`);
      for (const r of raws) all.push(shape(r, sub));
    } catch { /* skip inaccessible sub */ }
  }
  // ADLS Gen2 (HNS) first — those are the canonical shortcut targets.
  all.sort((a, b) => (Number(b.isHns) - Number(a.isHns)) || a.name.localeCompare(b.name));
  return all;
}
