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
  // Cross-cloud mirror sources (Fabric parity: Mirrored BigQuery / Mirrored Oracle).
  // Azure-native default replicates them with ADF's Google BigQuery / Oracle
  // connectors over a self-hosted integration runtime — no real Fabric.
  | 'bigquery' | 'oracle';

export type AuthMethod =
  | 'entra-mi'          // the Console managed identity (no secret)
  | 'sql-password'      // SQL/PG username + password (password → KV)
  | 'connection-string' // full connection string → KV
  | 'account-key'       // storage account key → KV
  | 'service-principal' // Entra SPN: tenantId + clientId + clientSecret (secret → KV)
  | 'service-key'       // GCP service-account JSON key file contents (key → KV) — BigQuery
  | 'basic';            // username + password over a data gateway (password → KV) — Oracle

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
  /** GCP project id (BigQuery) — the project whose datasets/tables are mirrored. */
  projectId?: string;
  /**
   * On-premises / self-hosted data gateway (integration runtime) name. Required by
   * Fabric's Oracle mirroring (OPDG) and optional for BigQuery (OPDG/VNET). The
   * Azure-native ADF path binds this to a self-hosted IR so the connector can reach
   * a source that isn't publicly routable.
   */
  dataGateway?: string;
  /** Service-account email (BigQuery service-key auth). */
  serviceAccountEmail?: string;
  /** KV secret name holding the password / connection string / key / SPN secret. */
  secretRef?: string;
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
  projectId?: string;
  dataGateway?: string;
  serviceAccountEmail?: string;
  description?: string;
  /** The secret value (password / connection string / key / SPN secret) — written to KV, never stored. */
  secret?: string;
}

/** Does this auth method require a secret in Key Vault? */
export function authNeedsSecret(m: AuthMethod): boolean {
  return m === 'sql-password' || m === 'connection-string' || m === 'account-key'
    || m === 'service-principal' || m === 'service-key' || m === 'basic';
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
    projectId: input.projectId?.trim() || undefined,
    dataGateway: input.dataGateway?.trim() || undefined,
    serviceAccountEmail: input.serviceAccountEmail?.trim() || undefined,
    description: input.description?.trim() || undefined,
    secretRef,
    createdBy: session.claims.upn || session.claims.email || tenantId,
    createdAt: now,
    updatedAt: now,
  };
  const c = await connectionsContainer();
  const { resource } = await c.items.create(doc);
  return toView((resource as LoomConnection) ?? doc);
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
