/**
 * Landing-Zone Service Registry — the Cosmos-backed store of EXISTING Azure
 * services attached to a Loom landing zone (brownfield, Phase 1).
 *
 * This is the convergence point specified in §2.1 of
 * docs/fiab/research/brownfield-attach-design.md: one durable registry that BOTH
 * day-0 BYO (`EXISTING_*` env seed) and the day-2 attach wizard write into, and
 * that every consumer (navigators, governance, chargeback, telemetry) reads
 * LIVE — so a new attach never rolls an ACA revision and carries zero
 * bicep-param cost (the 256-cap is untouched). It follows the proven
 * `connections-store.ts` pattern: Cosmos metadata, KV `secretRef` for any
 * secret, referential-integrity guard on delete.
 *
 * "Attach" borrows a customer resource — it NEVER creates or deletes the Azure
 * resource. Detach removes only the Loom binding.
 *
 * Per .claude/rules/no-vaporware.md this is a real Cosmos store (no mock array);
 * per no-fabric-dependency.md every coordinate is an Azure ARM resource id.
 */
import crypto from 'node:crypto';
import { attachedServicesContainer, itemsContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';
import { tenantScopeId } from '@/lib/auth/session';
import {
  type AttachedServiceKind,
  isAttachedServiceKind,
  kindLabel,
} from './attached-service-kinds';
import { SETUP_SCAN_SERVICES } from '@/lib/setup/scan-services';
import { scanKeyToKind } from './attached-service-kinds';

export type { AttachedServiceKind } from './attached-service-kinds';

// ---------------------------------------------------------------------------
// Registry resolution cache (hot path). `resolveAttachedService` is called by
// the backend resolver on EVERY navigator request (e.g. the ADX guard), and a
// KQL dashboard fires many concurrent tile queries — so an uncached Cosmos read
// per call would burn a round-trip + RUs each time. This is a dependency-free
// module-level TTL cache (Map + timestamps) that caches BOTH hits AND nulls
// (null caching is what matters: the common case today is an empty registry, so
// every resolve would otherwise re-query for nothing). Writes (attach / detach /
// upsert) invalidate the mutated tenant's entries so a fresh attach is visible
// immediately. Key: `${tenantId}:${kind}:${landingZoneId ?? ''}`.
// ---------------------------------------------------------------------------
const RESOLVE_CACHE_TTL_MS = 60_000;
interface ResolveCacheEntry { value: AttachedService | null; expires: number }
const resolveCache = new Map<string, ResolveCacheEntry>();

function resolveCacheKey(tenantId: string, kind: AttachedServiceKind, landingZoneId?: string): string {
  return `${tenantId}:${kind}:${landingZoneId ?? ''}`;
}

/** Invalidate every cached resolution for a tenant (called on any write). */
function invalidateResolveCache(tenantId: string): void {
  const prefix = `${tenantId}:`;
  for (const key of resolveCache.keys()) {
    if (key.startsWith(prefix)) resolveCache.delete(key);
  }
}

/** Test/ops hook: clear the whole resolution cache. */
export function clearAttachedServiceCache(): void {
  resolveCache.clear();
}

/** Live reachability posture captured at attach + refreshable on demand. */
export type Reachability = 'reachable' | 'private-endpoint-needed' | 'blocked' | 'unknown';
export type RbacState = 'granted' | 'pending' | 'manual-gate';
export type NetworkPosture = 'public' | 'private-endpoint' | 'service-endpoint' | 'unknown';

export interface AttachedServiceValidation {
  reachability?: Reachability;
  rbacState?: RbacState;
  networkPosture?: NetworkPosture;
  /** The navigator role the Console UAMI needs on this resource (name). */
  rbacRoleName?: string;
  /** The scope the role is (or must be) assigned at — the ARM resource id. */
  rbacScope?: string;
  /** When the posture was last probed. */
  checkedAt?: string;
  /** Honest remediation text when a check is not green. */
  remediation?: string;
}

export interface AttachedService {
  id: string; // uuid
  tenantId: string; // partition key (tenantScopeId — claims.tid ?? oid)
  /** `${subscriptionId}/${rg}` of a DLZ, or 'hub' for admin-plane services. */
  landingZoneId: string;
  kind: AttachedServiceKind;
  displayName: string;
  // ARM provenance (non-secret) — the source of truth for coordinates.
  armResourceId: string;
  subscriptionId: string;
  resourceGroup: string;
  location?: string;
  // Live posture (captured at attach, refreshable).
  validation?: AttachedServiceValidation;
  // Integration toggles — everything default-ON (loom_default_on_opt_out).
  // Populated by the Phase-2 auto-integration hooks; recorded here so every
  // consumer can enumerate "what belongs to Loom" and its integration state.
  governanceRegistered?: boolean;
  purviewSourceName?: string;
  telemetryWired?: boolean;
  chargebackIncluded?: boolean;
  /** Optional data-plane secret (KV secret name) for kinds that need one. */
  secretRef?: string;
  status: 'attached' | 'pending-grants';
  origin: 'day0-byo' | 'day2-attach';
  attachedBy: string;
  attachedAt: string;
  updatedAt: string;
}

/** Public (no-secret) shape returned to the UI. */
export type AttachedServiceView = Omit<AttachedService, 'secretRef'> & { hasSecret: boolean };

function toView(s: AttachedService): AttachedServiceView {
  const { secretRef, ...rest } = s;
  return { ...rest, hasSecret: !!secretRef };
}

/** Resolve the admin-managed tenant partition for a session. */
export function attachedTenantId(session: SessionPayload): string {
  return tenantScopeId(session);
}

export interface CreateAttachedServiceInput {
  landingZoneId: string;
  kind: AttachedServiceKind;
  displayName: string;
  armResourceId: string;
  subscriptionId: string;
  resourceGroup: string;
  location?: string;
  validation?: AttachedServiceValidation;
  origin?: 'day0-byo' | 'day2-attach';
  status?: 'attached' | 'pending-grants';
}

/**
 * List attached services for the tenant, optionally scoped to one landing zone.
 * Ordered by kind then displayName for a stable UI grouping.
 */
export async function listAttachedServices(
  session: SessionPayload,
  landingZoneId?: string,
): Promise<AttachedServiceView[]> {
  const tenantId = attachedTenantId(session);
  const c = await attachedServicesContainer();
  const query = landingZoneId
    ? {
        query:
          'SELECT * FROM c WHERE c.tenantId = @t AND c.landingZoneId = @lz',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@lz', value: landingZoneId },
        ],
      }
    : {
        query: 'SELECT * FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      };
  const { resources } = await c.items.query<AttachedService>(query).fetchAll();
  // Sort in JS: a Cosmos `ORDER BY c.kind, c.displayName` needs a composite
  // index the container doesn't define — the query 502s live ("The order by
  // query does not have a corresponding composite index"). Result sets here
  // are small (one landing zone's services), so client-side sort is free.
  return (resources || [])
    .sort(
      (a, b) =>
        (a.kind || '').localeCompare(b.kind || '') ||
        (a.displayName || '').localeCompare(b.displayName || ''),
    )
    .map(toView);
}

/** Internal: server-side load of the full record (incl. secretRef). */
export async function loadAttachedService(
  tenantId: string,
  id: string,
): Promise<AttachedService | null> {
  const c = await attachedServicesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<AttachedService>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/**
 * Find an already-attached service by ARM resource id within a landing zone —
 * so attach is idempotent (re-attaching the same resource updates in place
 * rather than creating a duplicate registry doc).
 */
export async function findAttachedByArmId(
  tenantId: string,
  landingZoneId: string,
  armResourceId: string,
): Promise<AttachedService | null> {
  const c = await attachedServicesContainer();
  const { resources } = await c.items
    .query<AttachedService>({
      query:
        'SELECT * FROM c WHERE c.tenantId = @t AND c.landingZoneId = @lz AND c.armResourceId = @arm',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@lz', value: landingZoneId },
        { name: '@arm', value: armResourceId },
      ],
    })
    .fetchAll();
  return resources?.[0] ?? null;
}

/**
 * Register (or idempotently update) an attached service. Real Cosmos upsert —
 * no mock. Returns the no-secret view. The caller (attach route) has already
 * validated the ARM id + preflight; this persists the binding.
 */
export async function createAttachedService(
  session: SessionPayload,
  input: CreateAttachedServiceInput,
): Promise<AttachedServiceView> {
  const tenantId = attachedTenantId(session);
  if (!isAttachedServiceKind(input.kind)) {
    const e: any = new Error(`Unsupported service kind: ${input.kind}`);
    e.status = 400;
    throw e;
  }
  const who = session.claims.upn || session.claims.email || tenantId;
  const now = new Date().toISOString();

  // Idempotent: update the existing binding in place when the same resource is
  // re-attached to the same landing zone.
  const existing = await findAttachedByArmId(tenantId, input.landingZoneId, input.armResourceId);
  const c = await attachedServicesContainer();
  if (existing) {
    const merged: AttachedService = {
      ...existing,
      displayName: input.displayName?.trim() || existing.displayName,
      subscriptionId: input.subscriptionId || existing.subscriptionId,
      resourceGroup: input.resourceGroup || existing.resourceGroup,
      location: input.location ?? existing.location,
      validation: input.validation ?? existing.validation,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    const { resource } = await c.items.upsert(merged);
    invalidateResolveCache(tenantId); // a re-attach may change what resolves
    return toView((resource as unknown as AttachedService) ?? merged);
  }

  const doc: AttachedService = {
    id: crypto.randomUUID(),
    tenantId,
    landingZoneId: input.landingZoneId,
    kind: input.kind,
    displayName: input.displayName?.trim() || kindLabel(input.kind),
    armResourceId: input.armResourceId.trim(),
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    location: input.location,
    validation: input.validation,
    // Integration defaults — Phase-2 hooks flip these to true as they succeed.
    governanceRegistered: false,
    telemetryWired: false,
    chargebackIncluded: true, // cost attribution keys on resourceId — in by default
    status: input.status ?? 'attached',
    origin: input.origin ?? 'day2-attach',
    attachedBy: who,
    attachedAt: now,
    updatedAt: now,
  };
  const { resource } = await c.items.create(doc);
  invalidateResolveCache(tenantId); // a new attach must be resolvable immediately
  return toView((resource as unknown as AttachedService) ?? doc);
}

/** An item that binds this attached service — enough to name it in a gate. */
export interface AttachedServiceDependent {
  id: string;
  itemType: string;
  displayName: string;
  workspaceId?: string;
}

/** Thrown by {@link detachService} when items still bind the attached service. */
export class AttachedServiceInUseError extends Error {
  readonly status = 409;
  readonly dependents: AttachedServiceDependent[];
  constructor(dependents: AttachedServiceDependent[]) {
    const names = dependents.slice(0, 5).map((d) => d.displayName || d.id).join(', ');
    const more = dependents.length > 5 ? ` and ${dependents.length - 5} more` : '';
    super(
      `This attached service is still used by ${dependents.length} item${dependents.length !== 1 ? 's' : ''}: ${names}${more}. Remove those references before detaching it.`,
    );
    this.name = 'AttachedServiceInUseError';
    this.dependents = dependents;
  }
}

/**
 * Find every workspace item that binds this attached service. Items reference an
 * attached backend via `state.attachedServiceId` (set when an item selects a
 * registry-backed backend — Phase 2/3). A service id is a tenant-unique UUID so
 * a cross-partition match is safe to attribute to the tenant.
 */
export async function findAttachedServiceDependents(id: string): Promise<AttachedServiceDependent[]> {
  if (!id) return [];
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<{ id: string; itemType?: string; displayName?: string; workspaceId?: string }>({
      query:
        'SELECT c.id, c.itemType, c.displayName, c.workspaceId FROM c WHERE c.state.attachedServiceId = @id',
      parameters: [{ name: '@id', value: id }],
    })
    .fetchAll();
  return (resources || []).map((r) => ({
    id: r.id,
    itemType: r.itemType || 'item',
    displayName: r.displayName || r.id,
    workspaceId: r.workspaceId,
  }));
}

/**
 * Detach — remove ONLY the Loom binding (+ its KV secret if any). Never deletes
 * the customer's Azure resource (brownfield = we borrow, we don't own). Refuses
 * with a 409 + dependents when an item still binds it (referential integrity,
 * mirror of ConnectionInUseError).
 */
export async function detachService(session: SessionPayload, id: string): Promise<void> {
  const tenantId = attachedTenantId(session);
  const dependents = await findAttachedServiceDependents(id);
  if (dependents.length > 0) throw new AttachedServiceInUseError(dependents);

  invalidateResolveCache(tenantId); // the detached service must stop resolving
  const c = await attachedServicesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<AttachedService>();
    if (resource?.secretRef) {
      // Best-effort KV cleanup — a detach must not fail on a secret-delete blip.
      try {
        const { deleteKeyVaultSecret } = await import('./kv-secrets-client');
        await deleteKeyVaultSecret(resource.secretRef);
      } catch { /* best-effort */ }
    }
    await c.item(id, tenantId).delete();
  } catch (e: any) {
    if (e?.code === 404) return;
    throw e;
  }
}

/**
 * Resolve the attached service of a given kind bound to a landing zone (or the
 * hub) — the coordinate source the backend resolver consults FIRST (§2.5).
 * Returns the first match (attach is idempotent per resource, and a landing zone
 * has at most one primary backend per kind in Phase 1). Falls back to any
 * hub-scoped attach of the kind when the landing zone has none, so a
 * hub-attached shared service (Synapse/ADX) still resolves for DLZ-less callers.
 */
export async function resolveAttachedService(
  tenantId: string,
  kind: AttachedServiceKind,
  landingZoneId?: string,
): Promise<AttachedService | null> {
  // Hot path — serve from the TTL cache (hits AND nulls) when fresh.
  const key = resolveCacheKey(tenantId, kind, landingZoneId);
  const cached = resolveCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const c = await attachedServicesContainer();
  const { resources } = await c.items
    .query<AttachedService>({
      query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.kind = @k',
      parameters: [
        { name: '@t', value: tenantId },
        { name: '@k', value: kind },
      ],
    })
    .fetchAll();
  const rows = resources || [];
  let value: AttachedService | null;
  if (rows.length === 0) {
    value = null;
  } else if (landingZoneId && rows.find((r) => r.landingZoneId === landingZoneId)) {
    value = rows.find((r) => r.landingZoneId === landingZoneId)!;
  } else {
    // Prefer a hub-scoped attach, else the first (stable) match.
    value = rows.find((r) => r.landingZoneId === 'hub') ?? rows[0];
  }
  resolveCache.set(key, { value, expires: Date.now() + RESOLVE_CACHE_TTL_MS });
  return value;
}

/** Result of the day-0 BYO → registry seed reconcile. */
export interface Day0SeedResult {
  seeded: number;
  kinds: AttachedServiceKind[];
  skippedExisting: number;
}

/**
 * Day-0 convergence (§2.6): read the `EXISTING_*` env triples a byo-wizard.sh /
 * bicep BYO deploy wired, and upsert a matching `origin:'day0-byo'`
 * AttachedService bound to the hub for each. Idempotent — a service already in
 * the registry is left as-is. Runs best-effort on first admin read of the
 * landing-zones surface so day-0 BYO shows in the same registry as day-2 attach.
 *
 * Reuses `scan-services.ts` as the shared catalog (its keys ARE the core
 * AttachedServiceKind set), so the Setup Wizard, byo-wizard.sh, and the attach
 * wizard all speak the same vocabulary.
 */
export async function reconcileDay0Byo(session: SessionPayload): Promise<Day0SeedResult> {
  const tenantId = attachedTenantId(session);
  const kinds: AttachedServiceKind[] = [];
  let skippedExisting = 0;

  for (const svc of SETUP_SCAN_SERVICES) {
    const name = (process.env[svc.envName] || '').trim();
    if (!name) continue; // this service was not reused (no EXISTING_* wiring)
    const kind = scanKeyToKind(svc.key);
    if (!kind) continue; // no registry kind for this scan key (skip silently)
    const sub = (process.env[svc.envSub] || '').trim();
    const rg = (process.env[svc.envRg] || '').trim();
    // Build the ARM id when we have the coordinates; otherwise store what we
    // know (name-only) — the registry is the day-0 seed, coordinates self-heal
    // via Resource Graph later. Skip if we can't even attribute a resource id.
    const def = (await import('./attached-service-kinds')).getKindDef(kind);
    const armType = def?.armType ?? '';
    const armResourceId =
      sub && rg && armType
        ? `/subscriptions/${sub}/resourceGroups/${rg}/providers/${armType}/${name}`
        : `byo:${kind}:${name}`;

    const existing = await findAttachedByArmId(tenantId, 'hub', armResourceId);
    if (existing) {
      skippedExisting++;
      continue;
    }
    await createAttachedService(session, {
      landingZoneId: 'hub',
      kind,
      displayName: name,
      armResourceId,
      subscriptionId: sub,
      resourceGroup: rg,
      origin: 'day0-byo',
      status: 'attached',
    });
    kinds.push(kind);
  }
  return { seeded: kinds.length, kinds, skippedExisting };
}
