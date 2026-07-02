/**
 * PDP — `loadPolicyBundle()`: the IMPURE side of the authorize() spine.
 *
 * Batch-reads the MINIMAL PolicyBundle from the REAL existing silos — no mock,
 * no `return []` placeholder (per .claude/rules/no-vaporware.md). This module
 * imports `@azure/*` and is therefore NEVER imported by the pure
 * evaluate.test.ts (which only touches resource-ref.ts + evaluate.ts).
 *
 * Silo wiring (the real APIs, discovered by reading each file):
 *   - tenant-admin + domain tier → lib/auth/domain-role.ts
 *       isTenantAdminTier(session) / resolveDomainTier(session, domain).
 *   - workspace role             → lib/azure/workspace-roles-client.ts
 *       resolveEffectiveRole(oid, workspaceId, { userGroupIds }).
 *   - item shares (additive)     → lib/azure/item-permissions-client.ts
 *       listItemPermissions(itemId) — the REAL per-principal grant store. (The
 *       `shares` Cosmos container holds share-LINK tokens, not per-principal
 *       Read/Edit/Reshare/ReadData grants — the algebra's "item share grants"
 *       are the item-permissions rows, so that is the faithful source.)
 *   - OneLake roles              → lib/azure/onelake-security-client.ts
 *       listRoles(itemId), filtered to roles this principal is a member of.
 *   - acl grants (_aclGrants)    → a dedicated `acl-grants` container, created
 *       here via createIfNotExists (the shared cosmos-client.ts is NOT edited in
 *       this additive increment). Empty = no grants.
 *   - protection policies        → a dedicated `protection-policies` container,
 *       createIfNotExists. Empty = none.
 *
 * MEMOIZATION: an in-process LRU keyed by (oid, resourceId) with a 60s TTL. The
 * bundle is action-independent (it is the full input set evaluate() composes
 * ANY action from), so action is not part of the key. `bustAclCache(oid?)`
 * clears a single principal's entries (call after a grant write) or the whole
 * cache.
 */

import { CosmosClient, type Container } from '@azure/cosmos';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

import type { SessionPayload } from '@/lib/auth/session';
import {
  isTenantAdminTier,
  resolveDomainTier,
  type DomainTier,
  type DomainTierDomain,
} from '@/lib/auth/domain-role';
import { resolveEffectiveRole } from '@/lib/azure/workspace-roles-client';
import { listItemPermissions } from '@/lib/azure/item-permissions-client';
import { listRoles, type OneLakeSecurityRole } from '@/lib/azure/onelake-security-client';
import { governanceDomainsContainer } from '@/lib/azure/cosmos-client';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

import type {
  AclGrant,
  OneLakeRoleBinding,
  PolicyBundle,
  Principal,
  ProtectionPolicy,
  ResourceRef,
  ShareGrant,
} from './resource-ref';

// ---------------------------------------------------------------------------
// Dedicated Cosmos containers for the two NEW stores (_aclGrants,
// _protectionPolicies). A parallel client is used so this additive increment
// does NOT edit the shared cosmos-client.ts. Same endpoint / database /
// credential contract as cosmos-client.ts.
// ---------------------------------------------------------------------------

let _client: CosmosClient | null = null;
let _aclGrants: Container | null = null;
let _protectionPolicies: Container | null = null;
let _ensured = false;

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

/** Lazily create the two PDP containers (idempotent). PK /resourceId so every
 *  per-resource grant/policy lookup hits a single physical partition. */
async function ensurePdpContainers(): Promise<void> {
  if (_ensured) return;
  const c = cosmos();
  const { database } = await c.databases.createIfNotExists({ id: databaseId() });
  _aclGrants = (
    await database.containers.createIfNotExists({ id: 'acl-grants', partitionKey: { paths: ['/resourceId'] } })
  ).container;
  _protectionPolicies = (
    await database.containers.createIfNotExists({
      id: 'protection-policies',
      partitionKey: { paths: ['/resourceId'] },
    })
  ).container;
  _ensured = true;
}

// ---------------------------------------------------------------------------
// In-process LRU (oid, resourceId) → PolicyBundle, 60s TTL.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;
const MAX_ENTRIES = 512;

interface CacheEntry {
  oid: string;
  bundle: PolicyBundle;
  expiresAt: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheKey(oid: string, resourceId: string): string {
  return `${oid}|${resourceId}`;
}

function cacheGet(key: string): PolicyBundle | null {
  const e = _cache.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    _cache.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to the end of the iteration order.
  _cache.delete(key);
  _cache.set(key, e);
  return e.bundle;
}

function cacheSet(key: string, oid: string, bundle: PolicyBundle): void {
  _cache.set(key, { oid, bundle, expiresAt: Date.now() + TTL_MS });
  while (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

/** Clear the PDP bundle cache for one principal (call after a grant/policy
 *  write to that principal), or the entire cache when `oid` is omitted. */
export function bustAclCache(oid?: string): void {
  if (!oid) {
    _cache.clear();
    return;
  }
  for (const [key, entry] of _cache) {
    if (entry.oid === oid) _cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Resource-chain helpers
// ---------------------------------------------------------------------------

function findLevelId(resource: ResourceRef, level: ResourceRef['level']): string | undefined {
  let r: ResourceRef | undefined = resource;
  while (r) {
    if (r.level === level) return r.id;
    r = r.parent;
  }
  return undefined;
}

function ancestorIdList(resource: ResourceRef): string[] {
  const ids: string[] = [];
  let r: ResourceRef | undefined = resource;
  while (r) {
    ids.push(r.id);
    r = r.parent;
  }
  return ids;
}

/** Build a minimal SessionPayload from a Principal so the domain-role helpers
 *  (which take a SessionPayload) can be reused verbatim. */
function principalToSession(principal: Principal): SessionPayload {
  return {
    claims: {
      oid: principal.oid,
      upn: principal.upn,
      name: principal.upn,
      groups: principal.groups,
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

// ---------------------------------------------------------------------------
// Per-silo readers
// ---------------------------------------------------------------------------

async function loadDomainTier(
  session: SessionPayload,
  principal: Principal,
  domainId: string | undefined,
  tenantAdmin: boolean,
): Promise<DomainTier> {
  if (tenantAdmin) return 'tenant-admin';
  if (!domainId) return null;
  let doc: any = null;
  try {
    const c = await governanceDomainsContainer();
    const { resource } = await c.item(domainId, principal.tenantId).read<any>();
    doc = resource ?? null;
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  if (!doc) return null;
  const td: DomainTierDomain = {
    id: doc.id,
    adminGroupId: doc.adminGroupId,
    contributorGroupId: doc.contributorGroupId,
    memberGroupId: doc.memberGroupId,
    admins: Array.isArray(doc.admins) ? doc.admins : undefined,
    // LoomDomain.contributors is a string[]; the tier model's {scope} shape is
    // a registry-only field — pass it through only when it is the object shape.
    contributors:
      doc.contributors && !Array.isArray(doc.contributors) ? doc.contributors : undefined,
  };
  return resolveDomainTier(session, td);
}

function mapOneLakeRole(role: OneLakeSecurityRole): OneLakeRoleBinding {
  // OLS (paths/permissions/members) is persisted today; RLS/CLS predicates flow
  // through when present on the doc (read defensively — the current OLS model
  // does not yet persist them, so absent = unrestricted).
  const raw = role as any;
  return {
    roleName: role.roleName,
    itemId: role.itemId,
    paths: role.paths || [],
    permissions: role.permissions || [],
    memberOids: (role.members || []).map((m) => m.objectId).filter(Boolean),
    rls: Array.isArray(raw.rls) ? raw.rls : undefined,
    cls: Array.isArray(raw.cls) ? raw.cls : undefined,
    exportBlocked: raw.exportBlocked === true,
  };
}

async function loadOneLakeRoles(itemId: string | undefined, principal: Principal): Promise<OneLakeRoleBinding[]> {
  if (!itemId) return [];
  const roles = await listRoles(itemId);
  const principalIds = new Set<string>([principal.oid, ...principal.groups]);
  return roles
    .map(mapOneLakeRole)
    .filter((r) => r.memberOids.some((id) => principalIds.has(id)));
}

async function loadShares(itemId: string | undefined, principal: Principal): Promise<ShareGrant[]> {
  if (!itemId) return [];
  const perms = await listItemPermissions(itemId);
  const principalIds = new Set<string>([principal.oid, ...principal.groups]);
  return perms
    .filter((p) => principalIds.has(p.principalId))
    .map<ShareGrant>((p) => ({
      principalId: p.principalId,
      principalType: p.principalType,
      itemId: p.itemId,
      permissionTypes: p.permissionTypes,
    }));
}

async function loadAclGrants(resource: ResourceRef, principal: Principal): Promise<AclGrant[]> {
  await ensurePdpContainers();
  const ids = ancestorIdList(resource);
  if (!ids.length) return [];
  const principalIds = [principal.oid, ...principal.groups];
  const { resources } = await _aclGrants!.items
    .query<AclGrant>({
      query:
        'SELECT c.principalId, c.resourceId, c.effect, c.action, c.reason FROM c ' +
        'WHERE ARRAY_CONTAINS(@ids, c.resourceId) AND ARRAY_CONTAINS(@principals, c.principalId)',
      parameters: [
        { name: '@ids', value: ids },
        { name: '@principals', value: principalIds },
      ],
    })
    .fetchAll();
  return resources;
}

async function loadProtectionPolicies(resource: ResourceRef): Promise<ProtectionPolicy[]> {
  await ensurePdpContainers();
  const ids = ancestorIdList(resource);
  if (!ids.length) return [];
  const { resources } = await _protectionPolicies!.items
    .query<ProtectionPolicy>({
      query:
        'SELECT c.resourceId, c.label, c.allowPrincipals, c.exportBlock, c.reason FROM c ' +
        'WHERE ARRAY_CONTAINS(@ids, c.resourceId)',
      parameters: [{ name: '@ids', value: ids }],
    })
    .fetchAll();
  return resources;
}

// ---------------------------------------------------------------------------
// loadPolicyBundle()
// ---------------------------------------------------------------------------

/** Resolve an item's workspace (and the workspace's domain) from the item doc,
 *  so a gate that passes only an item-level ResourceRef still gets workspace +
 *  domain inheritance. Returns {} on any miss/read failure — authorization must
 *  never break on a lookup error (the PDP then evaluates without that ancestor). */
async function resolveItemAncestors(
  itemId: string,
  tenantId: string,
): Promise<{ workspaceId?: string; domainId?: string }> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<{ workspaceId?: string }>({
        query: 'SELECT TOP 1 c.workspaceId FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: itemId }],
      })
      .fetchAll();
    const workspaceId = resources[0]?.workspaceId;
    if (!workspaceId) return {};
    let domainId: string | undefined;
    try {
      const ws = await workspacesContainer();
      const { resource } = await ws.item(workspaceId, tenantId).read<{ domainId?: string }>();
      domainId = resource?.domainId;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    return { workspaceId, domainId };
  } catch {
    return {};
  }
}

/**
 * Batch-read the minimal PolicyBundle the PDP needs for (`principal`,
 * `resource`). Memoized 60s per (oid, resourceId). The reads run concurrently;
 * a missing optional input (no domain / workspace / item in the chain) resolves
 * to its empty value, never an error.
 */
export async function loadPolicyBundle(principal: Principal, resource: ResourceRef): Promise<PolicyBundle> {
  // Key on the FULL ancestor chain, not just the leaf id: leaf ids at table/
  // column/row level (e.g. "sales") are not globally unique, so two different
  // resource chains sharing a leaf id must not collide to the same cached bundle.
  const key = cacheKey(principal.oid, ancestorIdList(resource).join('>'));
  const cached = cacheGet(key);
  if (cached) return cached;

  const session = principalToSession(principal);
  const tenantAdmin = isTenantAdminTier(session);

  const domainId = findLevelId(resource, 'domain');
  const workspaceId = findLevelId(resource, 'workspace');
  const itemId = findLevelId(resource, 'item');

  // A gate may pass only an item-level ResourceRef (no workspace/domain parent).
  // Resolve the missing ancestors from the item doc so workspace-role + domain
  // inheritance still evaluate (otherwise the PDP would deny a user whose only
  // grant is an inherited workspace role). One cheap read each, memoized 60s.
  let wsId = workspaceId;
  let domId = domainId;
  if (itemId && (!wsId || !domId)) {
    const anc = await resolveItemAncestors(itemId, principal.tenantId);
    if (!wsId) wsId = anc.workspaceId;
    if (!domId) domId = anc.domainId;
  }

  const [domainTier, workspaceRole, shares, onelakeRoles, aclGrants, protectionPolicies] = await Promise.all([
    loadDomainTier(session, principal, domId, tenantAdmin),
    wsId
      ? resolveEffectiveRole(principal.oid, wsId, { userGroupIds: principal.groups })
      : Promise.resolve(null),
    loadShares(itemId, principal),
    loadOneLakeRoles(itemId, principal),
    loadAclGrants(resource, principal),
    loadProtectionPolicies(resource),
  ]);

  const bundle: PolicyBundle = {
    tenantAdmin,
    domainTier,
    workspaceRole,
    shares,
    onelakeRoles,
    aclGrants,
    protectionPolicies,
  };
  cacheSet(key, principal.oid, bundle);
  return bundle;
}
