/**
 * Loom Connections — reusable, Key Vault-backed data-source connections.
 *
 * A Connection is a named way to reach a data source (Azure SQL, Synapse,
 * Databricks SQL, PostgreSQL, ADLS, Cosmos, generic SQL) with a chosen AUTH
 * method. Any secret (password / connection string / account key / SPN secret)
 * is written to **Key Vault**; the Cosmos record keeps only the non-secret
 * metadata + the KV `secretRef`. Connections are reused across mirroring, ADF /
 * Synapse linked services, datasets — so a user supplies creds ONCE and never
 * pastes them into item config (no plaintext secrets in Cosmos / UI state).
 *
 * Per .claude/rules/no-vaporware.md the secret really lands in Key Vault (real
 * KV REST) or the create fails with the exact gate (missing vault / role).
 */
import crypto from 'node:crypto';
import { connectionsContainer } from './cosmos-client';
import { putKeyVaultSecret, deleteKeyVaultSecret, kvSecretsConfigGate } from './kv-secrets-client';
import type { SessionPayload } from '@/lib/auth/session';

export type ConnectionType =
  | 'azure-sql' | 'synapse-dedicated' | 'synapse-serverless' | 'databricks-sql'
  | 'postgres' | 'storage-adls' | 'cosmos' | 'generic-sql'
  | 'adx'
  | 'event-hub' | 'service-bus' | 'key-vault';

export type AuthMethod =
  | 'entra-mi'          // the Console managed identity (no secret)
  | 'sql-password'      // SQL/PG username + password (password → KV)
  | 'connection-string' // full connection string → KV
  | 'account-key'       // storage account key → KV
  | 'service-principal';// Entra SPN: tenantId + clientId + clientSecret (secret → KV)

export interface LoomConnection {
  id: string;
  tenantId: string;
  name: string;
  type: ConnectionType;
  authMethod: AuthMethod;
  /** Non-secret connection coordinates. */
  host?: string;
  database?: string;
  username?: string;
  spnTenantId?: string;
  spnClientId?: string;
  /** KV secret name holding the password / connection string / key / SPN secret. */
  secretRef?: string;
  /**
   * Non-secret provenance for connections imported via "Add existing" (Azure
   * Resource Graph cross-subscription discovery with the caller's RBAC/ABAC).
   * These pin the connection to the exact Azure resource the user already had
   * access to — never a secret, so they live on the Cosmos doc and the view.
   */
  armResourceId?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
  /** 'existing' = imported from an Azure resource the user can reach; 'manual' = hand-entered. */
  origin?: 'manual' | 'existing';
  description?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Public (no-secret) shape returned to the UI. */
export type LoomConnectionView = Omit<LoomConnection, 'secretRef'> & { hasSecret: boolean };

function toView(c: LoomConnection): LoomConnectionView {
  const { secretRef, ...rest } = c;
  return { ...rest, hasSecret: !!secretRef };
}

export interface CreateConnectionInput {
  name: string;
  type: ConnectionType;
  authMethod: AuthMethod;
  host?: string;
  database?: string;
  username?: string;
  spnTenantId?: string;
  spnClientId?: string;
  description?: string;
  /** Non-secret Azure provenance for "Add existing" imports (ARG-discovered). */
  armResourceId?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  location?: string;
  origin?: 'manual' | 'existing';
  /** The secret value (password / connection string / key / SPN secret) — written to KV, never stored. */
  secret?: string;
}

/** Does this auth method require a secret in Key Vault? */
export function authNeedsSecret(m: AuthMethod): boolean {
  return m === 'sql-password' || m === 'connection-string' || m === 'account-key' || m === 'service-principal';
}

export async function listConnections(session: SessionPayload): Promise<LoomConnectionView[]> {
  const c = await connectionsContainer();
  const { resources } = await c.items
    .query<LoomConnection>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name',
      parameters: [{ name: '@t', value: session.claims.oid }],
    })
    .fetchAll();
  return (resources || []).map(toView);
}

export async function createConnection(session: SessionPayload, input: CreateConnectionInput): Promise<LoomConnectionView> {
  const tenantId = session.claims.oid;
  const id = crypto.randomUUID();
  let secretRef: string | undefined;

  if (authNeedsSecret(input.authMethod)) {
    if (!input.secret) throw new Error(`The "${input.authMethod}" auth method requires a secret value.`);
    const gate = kvSecretsConfigGate();
    if (gate) { const e: any = new Error(gate.detail); e.status = 503; e.missing = gate.missing; throw e; }
    const { name } = await putKeyVaultSecret(`loom-conn-${id}`, input.secret);
    secretRef = name;
  }

  const now = new Date().toISOString();
  const doc: LoomConnection = {
    id, tenantId,
    name: input.name.trim(),
    type: input.type,
    authMethod: input.authMethod,
    host: input.host?.trim() || undefined,
    database: input.database?.trim() || undefined,
    username: input.username?.trim() || undefined,
    spnTenantId: input.spnTenantId?.trim() || undefined,
    spnClientId: input.spnClientId?.trim() || undefined,
    description: input.description?.trim() || undefined,
    armResourceId: input.armResourceId?.trim() || undefined,
    subscriptionId: input.subscriptionId?.trim() || undefined,
    resourceGroup: input.resourceGroup?.trim() || undefined,
    location: input.location?.trim() || undefined,
    origin: input.origin || (input.armResourceId ? 'existing' : 'manual'),
    secretRef,
    createdBy: session.claims.upn || session.claims.email || tenantId,
    createdAt: now,
    updatedAt: now,
  };
  const c = await connectionsContainer();
  const { resource } = await c.items.create(doc);

  // Best-effort: surface the new connection in Microsoft Purview (Data Map scan
  // source + a lightweight Atlas catalog entity). NON-BLOCKING — it never throws
  // and is a silent no-op when LOOM_PURVIEW_ACCOUNT is unset, so it can never
  // break connection create (no-vaporware.md: real registration or honest skip).
  try { await registerConnectionInPurview((resource as LoomConnection) ?? doc); } catch { /* never break create */ }

  return toView((resource as LoomConnection) ?? doc);
}

/** Outcome of a best-effort Connection → Purview registration. */
export interface ConnectionPurviewResult {
  ok: boolean;
  registered?: boolean;
  scanned?: boolean;
  sourceName?: string;
  kind?: string;
  /** Why nothing was registered (when registered === false). */
  skipped?: 'not_configured' | 'unsupported';
  reason?: string;
  error?: string;
  scanError?: string;
}

/** Purview source name for a connection (letters/digits/-/_; ≤ 63 chars). */
function connectionSourceName(conn: { name: string; id: string }): string {
  const slug = (conn.name || conn.id || 'connection')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52) || 'connection';
  return `loom-conn-${slug}`;
}

/**
 * Best-effort: register a Loom Connection as a Microsoft Purview CLASSIC Data
 * Map scan source (real PUT /scan/datasources) and a lightweight Atlas catalog
 * entity, so connections discovered/imported in Loom also show up in Purview.
 *
 * NEVER throws — every failure is folded into the returned result so callers
 * (createConnection's hook AND the per-connection "Register in Purview / Scan
 * now" action) can use it without try/catch. Silent no-op when
 * LOOM_PURVIEW_ACCOUNT is unset; honest skip for connection types Purview's Data
 * Map can't scan (Event Hubs / Service Bus / Key Vault). Purview-client and the
 * source mapper are imported lazily so the Connections create path carries no
 * static dependency on the Azure-identity credential chain.
 */
export async function registerConnectionInPurview(
  conn: LoomConnection,
  opts?: { defineScan?: boolean },
): Promise<ConnectionPurviewResult> {
  if (!process.env.LOOM_PURVIEW_ACCOUNT) {
    return { ok: true, registered: false, skipped: 'not_configured' };
  }
  try {
    const { purviewSourceForConnectable, isUnsupportedPurviewSource } = await import('./purview-source-map');
    const mapped = purviewSourceForConnectable({
      connType: conn.type,
      host: conn.host,
      database: conn.database,
      subscriptionId: conn.subscriptionId,
      resourceGroup: conn.resourceGroup,
      location: conn.location,
    });
    if (isUnsupportedPurviewSource(mapped)) {
      return { ok: true, registered: false, skipped: 'unsupported', reason: mapped.reason };
    }

    const { registerDataSource, registerAtlasEntity, upsertScan } = await import('./purview-client');
    const sourceName = connectionSourceName(conn);
    await registerDataSource({ name: sourceName, kind: mapped.kind, properties: mapped.properties });

    // Lightweight Atlas catalog node for the connection (built-in DataSet
    // supertype always exists → the upsert is valid for any source kind).
    try {
      await registerAtlasEntity({
        typeName: 'DataSet',
        qualifiedName: conn.armResourceId || `${mapped.endpoint || conn.host || sourceName}#loom-connection`,
        displayName: conn.name,
        comment: `Loom Connection (${conn.type}) registered as a Purview source.`,
        owner: conn.createdBy,
      });
    } catch { /* catalog node is a bonus — scan source is the primary outcome */ }

    let scanned = false;
    let scanError: string | undefined;
    if (opts?.defineScan) {
      try {
        await upsertScan({
          sourceName, scanName: `${sourceName}-scan`, kind: mapped.kind,
          scanRulesetName: mapped.scanRulesetName, scanRulesetType: 'System',
        });
        scanned = true;
      } catch (e: any) {
        scanError = e?.message || String(e);
      }
    }

    return { ok: true, registered: true, scanned, sourceName, kind: mapped.kind, scanError };
  } catch (e: any) {
    return { ok: false, registered: false, error: e?.message || String(e) };
  }
}

export async function deleteConnection(session: SessionPayload, id: string): Promise<void> {
  const tenantId = session.claims.oid;
  const c = await connectionsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<LoomConnection>();
    if (resource?.secretRef) await deleteKeyVaultSecret(resource.secretRef);
    await c.item(id, tenantId).delete();
  } catch (e: any) {
    if (e?.code === 404) return;
    throw e;
  }
}

/** Internal: resolve a connection's full record (incl. secretRef) for server-side use. */
export async function loadConnection(tenantId: string, id: string): Promise<LoomConnection | null> {
  const c = await connectionsContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<LoomConnection>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}
