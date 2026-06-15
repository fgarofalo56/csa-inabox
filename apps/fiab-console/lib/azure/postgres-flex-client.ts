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

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase } from './cloud-endpoints';

const PG_API_VERSION = '2024-08-01';

function arm(): string {
  return armBase();
}

/** Commercial: postgres.database.azure.com  Gov: postgres.database.usgovcloudapi.net */
function pgHostSuffix(): string {
  return process.env.LOOM_POSTGRES_HOST_SUFFIX || 'postgres.database.azure.com';
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
  const res = await fetchWithTimeout(`${arm()}${path}`, {
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

// ============================================================
// In-database query execution (real `pg` wire-protocol + Entra token)
//
// PostgreSQL flexible server supports Microsoft Entra auth: connect with the
// AAD principal *name* as the user and an access token (scope
// https://ossrdbms-aad.database.azure.com/.default) as the password. The
// console UAMI must first be created as a PG principal:
//   SELECT * FROM pgaadauth_create_principal('<uami-name>', false, false);
// and granted the needed table privileges. We name that one-time setup in the
// honest gate when LOOM_POSTGRES_AAD_USER is unset (per no-vaporware.md).
// ============================================================

/** Entra token scope for Azure DB for PostgreSQL (Commercial default; Gov override via env). */
function pgAadScope(): string {
  return process.env.LOOM_POSTGRES_AAD_SCOPE || 'https://ossrdbms-aad.database.azure.com/.default';
}

export interface PgQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  command?: string;
  executionMs: number;
}

/**
 * Honest config gate: PG Entra query needs the AAD principal NAME the UAMI was
 * registered under in PostgreSQL (its display name, not the client id). Returns
 * `{ missing, detail }` when unset, else `null`.
 */
export function postgresQueryGate(): { missing: string; detail: string } | null {
  if (!process.env.LOOM_POSTGRES_AAD_USER) {
    return {
      missing: 'LOOM_POSTGRES_AAD_USER',
      detail:
        'Set LOOM_POSTGRES_AAD_USER to the Entra principal name the console identity is registered ' +
        'under in PostgreSQL. One-time setup: connect as the PG Entra admin and run ' +
        "SELECT * FROM pgaadauth_create_principal('<console-uami-name>', false, false); then grant it " +
        'the needed privileges. ARM inventory, provisioning, databases, and firewall are already live.',
    };
  }
  return null;
}

/**
 * List user tables in a PostgreSQL database (schema.table), excluding the
 * system schemas — used by the mirror engine to enumerate what to snapshot.
 */
export async function listPostgresTables(fqdn: string, database: string): Promise<Array<{ schema: string; table: string }>> {
  const res = await executePostgresQuery(
    fqdn, database,
    "SELECT table_schema, table_name FROM information_schema.tables " +
    "WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') " +
    'ORDER BY table_schema, table_name',
  );
  const iS = res.columns.indexOf('table_schema');
  const iT = res.columns.indexOf('table_name');
  return res.rows.map((r) => ({ schema: String(r[iS]), table: String(r[iT]) })).filter((t) => t.schema && t.table);
}

/**
 * Execute a SQL statement against a PostgreSQL flexible server over the real
 * `pg` wire protocol, authenticating with a Microsoft Entra access token (no
 * stored password). Returns columns + rows. Throws PostgresError on failure
 * (surfaced verbatim by the route). Caller-authorized — the editor's Query tab
 * runs arbitrary SQL the same way the T-SQL editor does.
 */
export async function executePostgresQuery(fqdn: string, database: string, sql: string): Promise<PgQueryResult> {
  const user = process.env.LOOM_POSTGRES_AAD_USER;
  if (!user) throw new PostgresError('LOOM_POSTGRES_AAD_USER is not set; cannot authenticate to PostgreSQL.', 503);
  const tok = await credential.getToken(pgAadScope());
  if (!tok?.token) throw new PostgresError('Failed to acquire an Entra token for PostgreSQL.', 401);

  // Lazy import so the driver only loads on this path (Node runtime only).
  const { Client } = await import('pg');
  const client = new Client({
    host: fqdn,
    port: 5432,
    database: database || 'postgres',
    user,
    password: tok.token,
    ssl: { rejectUnauthorized: true },
    statement_timeout: 30_000,
    connectionTimeoutMillis: 20_000,
    application_name: 'csa-loom-console',
  });
  const started = Date.now();
  try {
    await client.connect();
    const res = await client.query(sql);
    const fields = (res as any).fields || [];
    const columns: string[] = fields.map((f: any) => f.name);
    const rows: unknown[][] = (res.rows || []).map((r: any) => columns.map((c) => r[c]));
    return {
      columns,
      rows,
      rowCount: typeof res.rowCount === 'number' ? res.rowCount : rows.length,
      command: (res as any).command,
      executionMs: Date.now() - started,
    };
  } catch (e: any) {
    throw new PostgresError(e?.message || String(e), e?.code === '28000' || e?.code === '28P01' ? 401 : 502, e?.code);
  } finally {
    await client.end().catch(() => { /* already closed */ });
  }
}
