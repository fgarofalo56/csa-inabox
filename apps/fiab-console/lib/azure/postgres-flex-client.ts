/**
 * Azure Database for PostgreSQL — Flexible Server client.
 *
 * Real REST only (per .claude/rules/no-vaporware.md):
 *   - listServers / getServer                      — ARM REST (Microsoft.DBforPostgreSQL/flexibleServers)
 *   - listDatabases                                — ARM REST (.../databases)
 *   - createServer                                 — ARM PUT (LRO; returns the accept pointer)
 *   - listFirewallRules / upsertFirewallRule / deleteFirewallRule — ARM REST
 *
 * Auth: console UAMI via ChainedTokenCredential (same pattern as
 * azure-sql-client). The UAMI must hold Reader (list/get) + Contributor
 * (create) on the subscription / resource group.
 *
 * Query execution: PostgreSQL speaks the PG wire protocol, not TDS. The
 * `pg` npm driver is NOT a console dependency, so in-database SQL execution
 * is an HONEST infra-gate — the route returns a structured 501 naming the
 * `pg` driver + `LOOM_POSTGRES_QUERY_LIVE` env var the operator must wire.
 * The full UI still renders; ARM inventory, provisioning, databases, and
 * firewall are all live.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const PG_API_VERSION = '2024-08-01';

function arm(): string {
  return process.env.LOOM_ARM_ENDPOINT || 'https://management.azure.com';
}

/** Commercial: postgres.database.azure.com  Gov: postgres.database.usgovcloudapi.net */
function pgHostSuffix(): string {
  return process.env.LOOM_POSTGRES_HOST_SUFFIX || 'postgres.database.azure.com';
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

export class PostgresError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'PostgresError';
    this.status = status;
    this.body = body;
  }
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(`${arm()}/.default`);
  if (!t?.token) throw new PostgresError('Failed to acquire AAD token for ARM', 401);
  return t.token;
}

async function armRequest<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetch(`${arm()}${path}`, {
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
    const msg = (json?.error?.message || text || 'ARM call failed').toString();
    throw new PostgresError(msg, res.status, json || text);
  }
  return json as T;
}

// ============================================================
// Listing / get
// ============================================================

export interface PostgresFlexServer {
  id: string;
  name: string;
  location: string;
  fqdn: string;
  state?: string;
  version?: string;
  administratorLogin?: string;
  storageGb?: number;
  sku?: { name?: string; tier?: string };
  resourceGroup?: string;
}

function rgOf(id: string): string | undefined {
  const m = /\/resourceGroups\/([^/]+)/i.exec(id || '');
  return m?.[1];
}

function mapServer(s: any): PostgresFlexServer {
  return {
    id: s.id,
    name: s.name,
    location: s.location,
    fqdn: s.properties?.fullyQualifiedDomainName || `${s.name}.${pgHostSuffix()}`,
    state: s.properties?.state,
    version: s.properties?.version,
    administratorLogin: s.properties?.administratorLogin,
    storageGb: s.properties?.storage?.storageSizeGB,
    sku: s.sku ? { name: s.sku.name, tier: s.sku.tier } : undefined,
    resourceGroup: rgOf(s.id),
  };
}

export async function listServers(subscriptionId?: string): Promise<PostgresFlexServer[]> {
  const sub = subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) throw new PostgresError('LOOM_SUBSCRIPTION_ID not set', 400);
  const res = await armRequest<{ value: any[] }>(
    `/subscriptions/${sub}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=${PG_API_VERSION}`,
  );
  return (res.value || []).map(mapServer);
}

async function resolveScope(serverName: string): Promise<string> {
  if (serverName.startsWith('/')) return serverName;
  const cache = (resolveScope as any)._c as Map<string, string> | undefined;
  const c = cache || new Map<string, string>();
  if (!cache) (resolveScope as any)._c = c;
  if (c.has(serverName)) return c.get(serverName)!;
  const servers = await listServers();
  const hit = servers.find((s) => s.name === serverName);
  if (!hit) throw new PostgresError(`PostgreSQL flexible server '${serverName}' not found in subscription`, 404);
  c.set(serverName, hit.id);
  return hit.id;
}

export async function getServer(serverNameOrId: string): Promise<PostgresFlexServer> {
  const scope = await resolveScope(serverNameOrId);
  const res = await armRequest<any>(`${scope}?api-version=${PG_API_VERSION}`);
  return mapServer(res);
}

export interface PostgresDatabase {
  name: string;
  charset?: string;
  collation?: string;
}

export async function listDatabases(serverNameOrId: string): Promise<PostgresDatabase[]> {
  const scope = await resolveScope(serverNameOrId);
  const res = await armRequest<{ value: any[] }>(`${scope}/databases?api-version=${PG_API_VERSION}`);
  return (res.value || []).map((d) => ({
    name: d.name,
    charset: d.properties?.charset,
    collation: d.properties?.collation,
  }));
}

// ============================================================
// Provision (ARM PUT — long-running)
// ============================================================

export interface CreatePostgresSpec {
  name: string;
  resourceGroup: string;
  location: string;
  administratorLogin: string;
  administratorLoginPassword: string;
  /** e.g. Standard_B1ms / Standard_D2s_v3 */
  skuName: string;
  /** Burstable | GeneralPurpose | MemoryOptimized */
  tier: 'Burstable' | 'GeneralPurpose' | 'MemoryOptimized';
  /** PG major version, e.g. "16" */
  version?: string;
  storageGb?: number;
  subscriptionId?: string;
}

export async function createServer(
  spec: CreatePostgresSpec,
): Promise<{ ok: true; id: string; provisioningState?: string } | { ok: false; error: string; status: number }> {
  const sub = spec.subscriptionId || process.env.LOOM_SUBSCRIPTION_ID;
  if (!sub) return { ok: false, error: 'LOOM_SUBSCRIPTION_ID not set', status: 400 };
  if (!spec.name || !spec.resourceGroup || !spec.location || !spec.administratorLogin || !spec.administratorLoginPassword || !spec.skuName || !spec.tier) {
    return { ok: false, error: 'name, resourceGroup, location, administratorLogin, administratorLoginPassword, skuName, tier are required', status: 400 };
  }
  const path =
    `/subscriptions/${sub}/resourceGroups/${encodeURIComponent(spec.resourceGroup)}` +
    `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${encodeURIComponent(spec.name)}?api-version=${PG_API_VERSION}`;
  const body = {
    location: spec.location,
    sku: { name: spec.skuName, tier: spec.tier },
    properties: {
      administratorLogin: spec.administratorLogin,
      administratorLoginPassword: spec.administratorLoginPassword,
      version: spec.version || '16',
      storage: { storageSizeGB: spec.storageGb || 32 },
      createMode: 'Default',
    },
  };
  try {
    const res = await armRequest<any>(path, { method: 'PUT', body: JSON.stringify(body) });
    return { ok: true, id: res?.id || path, provisioningState: res?.properties?.state };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), status: e?.status || 502 };
  }
}

// ============================================================
// Firewall rules (ARM REST)
// ============================================================

export interface PgFirewallRule {
  name: string;
  startIpAddress: string;
  endIpAddress: string;
}

export async function listFirewallRules(serverNameOrId: string): Promise<PgFirewallRule[]> {
  const scope = await resolveScope(serverNameOrId);
  const res = await armRequest<{ value: any[] }>(`${scope}/firewallRules?api-version=${PG_API_VERSION}`);
  return (res.value || []).map((r) => ({
    name: r.name,
    startIpAddress: r.properties?.startIpAddress,
    endIpAddress: r.properties?.endIpAddress,
  }));
}

export async function upsertFirewallRule(serverNameOrId: string, rule: PgFirewallRule): Promise<PgFirewallRule> {
  if (!rule.name || !rule.startIpAddress || !rule.endIpAddress) {
    throw new PostgresError('name, startIpAddress, endIpAddress are required', 400);
  }
  const scope = await resolveScope(serverNameOrId);
  const res = await armRequest<any>(
    `${scope}/firewallRules/${encodeURIComponent(rule.name)}?api-version=${PG_API_VERSION}`,
    { method: 'PUT', body: JSON.stringify({ properties: { startIpAddress: rule.startIpAddress, endIpAddress: rule.endIpAddress } }) },
  );
  return { name: res.name, startIpAddress: res.properties?.startIpAddress, endIpAddress: res.properties?.endIpAddress };
}

export async function deleteFirewallRule(serverNameOrId: string, ruleName: string): Promise<void> {
  const scope = await resolveScope(serverNameOrId);
  await armRequest<void>(`${scope}/firewallRules/${encodeURIComponent(ruleName)}?api-version=${PG_API_VERSION}`, { method: 'DELETE' });
}

/**
 * Execute a query against a PostgreSQL flexible server. The `pg` wire-protocol
 * driver is not bundled with the console, so this is an HONEST infra-gate per
 * no-vaporware.md: the caller surfaces a MessageBar naming the requirement.
 */
export function queryGateReason(): string {
  return (
    'PostgreSQL in-database query execution requires the `pg` wire-protocol driver and ' +
    'a Microsoft Entra token mapped to a PG role. Add the `pg` dependency to apps/fiab-console ' +
    'and set LOOM_POSTGRES_QUERY_LIVE=true once the console UAMI is created as a PG AAD principal ' +
    '(SELECT * FROM pgaadauth_create_principal). Until then, ARM inventory, provisioning, ' +
    'databases, and firewall are fully live; use psql or the Azure portal Query editor for ad-hoc SQL.'
  );
}

export function isPostgresQueryLive(): boolean {
  return process.env.LOOM_POSTGRES_QUERY_LIVE === 'true';
}
