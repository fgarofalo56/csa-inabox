/**
 * Logical Landing-Zone registry — the Cosmos-backed store of LIGHTWEIGHT landing
 * zones (dlz-brownfield Phase A).
 *
 * Until now the only "landing zone" a Loom operator could create was a HEAVY
 * greenfield Data Landing Zone (a full `az deployment sub create` of VNet /
 * lakehouse / ADX / Synapse …). But the brownfield flow — "create a landing zone,
 * then multi-select ALL my existing services and attach them to it" — needs a
 * lightweight LOGICAL landing zone that exists purely as a durable grouping
 * target. This store persists that: a stable-slug doc the attach wizard can point
 * `attached-services` rows at (the registry already accepts any `landingZoneId`
 * string), with zero Azure provisioning.
 *
 * Per .claude/rules/no-vaporware.md this is a real Cosmos store (no mock array);
 * per no-fabric-dependency.md every coordinate is an Azure ARM id (no Fabric
 * handle). It follows the proven `attached-services-store.ts` pattern: Cosmos
 * metadata, PK /tenantId, idempotent create.
 */
import crypto from 'node:crypto';
import { landingZonesContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';

/** Network posture the logical LZ inherits / requests (Azure-native only). */
export interface LandingZoneNetwork {
  /** Hub or spoke VNet ARM id the LZ's services sit behind, when known. */
  vnetId?: string;
  /** true when a hub↔spoke VNet peering still needs to be established. */
  peeringNeeded?: boolean;
  /** true when private-DNS zone links still need to be wired for the LZ. */
  privateDnsNeeded?: boolean;
}

/** A logical landing zone document (PK /tenantId, id = stable slug). */
export interface LandingZone {
  id: string; // stable slug (NOT tied to rg-csa-loom-dlz-* naming)
  tenantId: string; // partition key (tenantScopeId — claims.tid ?? oid)
  /** Human name / domain of the landing zone. */
  name: string;
  /** Subscription the LZ's resources predominantly live in. */
  subscriptionId?: string;
  /** Resource groups the LZ spans (brownfield RGs — any names). */
  resourceGroups: string[];
  region?: string;
  /** true when the LZ spans a subscription other than the hub's. */
  crossSubscription?: boolean;
  network?: LandingZoneNetwork;
  /**
   * Identity that manages the LZ's attached services — defaults to the Console
   * UAMI (its principal id) so the existing attach-integration RBAC path applies.
   */
  identityPrincipalId?: string;
  /** Purview collection the LZ's assets are catalogued under, when set. */
  purviewCollection?: string;
  /** Cloud boundary — inherited from the hub topology (Commercial / GCC / …). */
  boundary?: string;
  costCenter?: string;
  adminGroupId?: string;
  memberGroupId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Input to {@link createLandingZone} — everything but the server-set fields. */
export interface CreateLandingZoneInput {
  /** Optional explicit slug; derived from `name` when omitted. */
  id?: string;
  name: string;
  subscriptionId?: string;
  resourceGroups?: string[];
  region?: string;
  crossSubscription?: boolean;
  network?: LandingZoneNetwork;
  identityPrincipalId?: string;
  purviewCollection?: string;
  boundary?: string;
  costCenter?: string;
  adminGroupId?: string;
  memberGroupId?: string;
}

/** Resolve the admin-managed tenant partition for a session. */
export function landingZoneTenantId(session: SessionPayload): string {
  return tenantScopeId(session);
}

/** Slugify a landing-zone name into a stable, url-safe id. */
export function slugifyLandingZoneName(name: string): string {
  const slug = (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return slug || `lz-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create (or idempotently return) a logical landing zone. Idempotent by id: a
 * second create with the same slug returns the existing doc unchanged rather than
 * duplicating it (the attach wizard's "＋ New landing zone" can be retried safely).
 */
export async function createLandingZone(
  session: SessionPayload,
  input: CreateLandingZoneInput,
): Promise<LandingZone> {
  const name = (input.name || '').trim();
  if (!name) {
    const e: any = new Error('name is required to create a landing zone');
    e.status = 400;
    throw e;
  }
  const tenantId = landingZoneTenantId(session);
  const id = (input.id?.trim() || slugifyLandingZoneName(name));
  const c = await landingZonesContainer();

  // Idempotent: return the existing doc if this slug is already registered.
  const existing = await getLandingZone(session, id);
  if (existing) return existing;

  const now = new Date().toISOString();
  const doc: LandingZone = {
    id,
    tenantId,
    name,
    subscriptionId: input.subscriptionId?.trim() || undefined,
    resourceGroups: (input.resourceGroups || []).map((r) => r.trim()).filter(Boolean),
    region: input.region?.trim() || undefined,
    crossSubscription: !!input.crossSubscription,
    network: input.network,
    identityPrincipalId:
      input.identityPrincipalId?.trim() ||
      (process.env.LOOM_CONSOLE_PRINCIPAL_ID || '').trim() ||
      undefined,
    purviewCollection: input.purviewCollection?.trim() || undefined,
    boundary: input.boundary?.trim() || undefined,
    costCenter: input.costCenter?.trim() || undefined,
    adminGroupId: input.adminGroupId?.trim() || undefined,
    memberGroupId: input.memberGroupId?.trim() || undefined,
    createdBy: session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await c.items.create(doc);
  return (resource as unknown as LandingZone) ?? doc;
}

/** List all logical landing zones for the tenant (ordered by name). */
export async function listLandingZones(session: SessionPayload): Promise<LandingZone[]> {
  const tenantId = landingZoneTenantId(session);
  const c = await landingZonesContainer();
  const { resources } = await c.items
    .query<LandingZone>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return (resources || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Point-read one logical landing zone by id (tenant-scoped). */
export async function getLandingZone(
  session: SessionPayload,
  id: string,
): Promise<LandingZone | null> {
  const tenantId = landingZoneTenantId(session);
  const c = await landingZonesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<LandingZone>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}
