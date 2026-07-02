/**
 * Protection-policy CRUD (EH Phase-1 §2.3) — sovereign-rbac default.
 *
 * A protection policy is a LABEL-driven, restrict-ONLY rule: every resource
 * carrying `label` allows ONLY `allowPrincipals` (+ the issuer, never blocked).
 * The PDP already consumes a per-resource projection of this object as the
 * restrict-only layer 7 (`ProtectionPolicy` in lib/auth/pdp/resource-ref.ts —
 * { resourceId, label, allowPrincipals, exportBlock, reason }). This client is
 * a SUPERSET of that shape: it adds the management fields (id, domainId, scope,
 * mode, retainFullControl) and stores `resourceId` so the PDP query keeps
 * working unchanged. PDP / §2.2 are untouched — this is purely additive.
 *
 * Container: the `_protectionPolicies` / `protection-policies` store the PDP
 * context-loader already createIfNotExists's, partitioned by /resourceId. We
 * keep that PK (so the per-resource PDP lookup stays a single physical
 * partition) and set resourceId = scope || domainId for sovereign-rbac domain
 * policies. domainId is carried as a field; tenant-scoped list is a cross-
 * partition query bounded by tenantId. NO Fabric/Purview dependency by default —
 * mode='sovereign-rbac' enforces ADLS RBAC + Synapse DENY-by-omission + ADX RLS;
 * mode='purview' is strictly opt-in.
 *
 * Validators are PURE where possible (validatePolicy / normalizePolicy) so the
 * reconciler tests need no Azure backend.
 */

import { CosmosClient, type Container } from '@azure/cosmos';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

export type ProtectionMode = 'sovereign-rbac' | 'purview';

/**
 * The Loom protection-policy object. SUPERSET of the PDP's ProtectionPolicy —
 * `resourceId`, `label`, `allowPrincipals`, `exportBlock` are the exact fields
 * the PDP reads; the rest are management metadata.
 */
export interface ProtectionPolicy {
  id: string;
  /** Partition key field — what the policy applies to (scope || domainId). */
  resourceId: string;
  /** Governance domain this policy belongs to. */
  domainId: string;
  /** Display label issued/owned by the issuer (never blocked). */
  label: string;
  /** The exhaustive allow-list of principals (oids/groups) for labeled data. */
  allowPrincipals: string[];
  /** The label issuer/owner oid — always retained, never revoked. */
  issuer?: string;
  /** Keep issuer full control even outside allowPrincipals (default true). */
  retainFullControl?: boolean;
  /** Optional explicit resource scope (workspace/item id). Default = domain. */
  scope?: string;
  /** Forbid export for allow-listed principals too. */
  exportBlock?: boolean;
  /** Enforcement backend. sovereign-rbac (default, no Fabric/Purview) | purview. */
  mode: ProtectionMode;
  reason?: string;
  tenantId: string;
  updatedAt: string;
  updatedBy?: string;
}

// ── Pure validators / normalizers ────────────────────────────────────────────

export interface ProtectionPolicyInput {
  id?: string;
  domainId: string;
  label: string;
  allowPrincipals?: string[];
  issuer?: string;
  retainFullControl?: boolean;
  scope?: string;
  exportBlock?: boolean;
  mode?: ProtectionMode;
  reason?: string;
}

/** Validate an incoming policy. Returns the first error, or null when valid. */
export function validatePolicy(p: ProtectionPolicyInput): string | null {
  if (!p) return 'policy body required';
  if (!String(p.domainId || '').trim()) return 'domainId required';
  if (!String(p.label || '').trim()) return 'label required';
  if (p.mode && p.mode !== 'sovereign-rbac' && p.mode !== 'purview') {
    return "mode must be 'sovereign-rbac' or 'purview'";
  }
  if (p.allowPrincipals && !Array.isArray(p.allowPrincipals)) return 'allowPrincipals must be an array';
  return null;
}

/** Normalize an input into a stored ProtectionPolicy (pure). mode defaults to sovereign-rbac. */
export function normalizePolicy(
  p: ProtectionPolicyInput,
  ctx: { tenantId: string; updatedBy?: string; now?: string },
): ProtectionPolicy {
  const domainId = String(p.domainId).trim();
  const scope = p.scope ? String(p.scope).trim() : undefined;
  const allow = Array.from(
    new Set((p.allowPrincipals || []).map((s) => String(s).trim()).filter(Boolean)),
  );
  const id = (p.id && String(p.id).trim()) || `pp:${domainId}:${String(p.label).trim()}`;
  return {
    id,
    resourceId: scope || domainId, // PDP queries by resourceId; default = domain
    domainId,
    label: String(p.label).trim(),
    allowPrincipals: allow,
    issuer: p.issuer ? String(p.issuer).trim() : ctx.updatedBy,
    retainFullControl: p.retainFullControl !== false,
    scope,
    exportBlock: p.exportBlock === true,
    mode: p.mode === 'purview' ? 'purview' : 'sovereign-rbac',
    reason: p.reason ? String(p.reason).trim() : undefined,
    tenantId: ctx.tenantId,
    updatedAt: ctx.now || new Date().toISOString(),
    updatedBy: ctx.updatedBy,
  };
}

// ── Cosmos wiring (parallel client; does NOT edit cosmos-client.ts) ───────────

let _client: CosmosClient | null = null;
let _container: Container | null = null;

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_ENDPOINT;
  if (!v) throw new Error('LOOM_COSMOS_ENDPOINT is not configured');
  return v;
}
function databaseId(): string {
  return process.env.LOOM_COSMOS_DATABASE || 'loom';
}
function credential() {
  const clientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  const chain: any[] = [];
  if (clientId) chain.push(new ManagedIdentityCredential({ clientId }));
  chain.push(new DefaultAzureCredential());
  return new ChainedTokenCredential(new AcaManagedIdentityCredential(), ...chain);
}
function cosmos(): CosmosClient {
  if (_client) return _client;
  _client = new CosmosClient({ endpoint: endpoint(), aadCredentials: credential() });
  return _client;
}

async function container(): Promise<Container> {
  if (_container) return _container;
  const c = cosmos();
  const { database } = await c.databases.createIfNotExists({ id: databaseId() });
  _container = (
    await database.containers.createIfNotExists({
      id: 'protection-policies',
      partitionKey: { paths: ['/resourceId'] },
    })
  ).container;
  return _container;
}

/** List every protection policy for a tenant (cross-partition, tenant-scoped). */
export async function listPolicies(tenantId: string): Promise<ProtectionPolicy[]> {
  const c = await container();
  const { resources } = await c.items
    .query<ProtectionPolicy>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources;
}

/** Point-read one policy by id within a resource partition. */
export async function getPolicy(id: string, resourceId: string): Promise<ProtectionPolicy | null> {
  const c = await container();
  try {
    const { resource } = await c.item(id, resourceId).read<ProtectionPolicy>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Upsert a normalized policy. */
export async function upsertPolicy(policy: ProtectionPolicy): Promise<ProtectionPolicy> {
  const c = await container();
  const { resource } = await c.items.upsert<ProtectionPolicy>(policy);
  return (resource as ProtectionPolicy) ?? policy;
}

/** Delete a policy by id + resourceId. Idempotent (404 → ok). */
export async function deletePolicy(id: string, resourceId: string): Promise<void> {
  const c = await container();
  try {
    await c.item(id, resourceId).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
}
