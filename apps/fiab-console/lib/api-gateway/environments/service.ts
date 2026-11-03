/**
 * Environment service (W1-4): catalog load/seed, catalog edits under the
 * invariant, and the single batch re-classification (ADR-008 decisions 4-6).
 * Pure orchestration over ports; routes and tests both call it.
 */
import { buildApiplaneAuditRecord } from '../audit';
import type { ApiplaneAuditRecord } from '../types';
import {
  createEnvironment, deleteEnvironment, updateEnvironment, type CatalogEdit, type EnvironmentInput,
} from './catalog';
import { blockedPublications, classificationMap, newlyBlocked, resourceRef, type BlockedPublication } from './invariant';
import { ENVIRONMENTS_SCOPE, lockOrder } from './locks';
import type { PermitsSettings } from './permits';
import { seedCatalog } from './seed';
import {
  ClassificationConflictError,
  type CatalogStore, type ClassifiableResource, type ClassificationChange, type ClassificationStore,
  type EnvironmentCatalogDoc, type LockPort, type PublicationPort,
} from './types';

/** Cosmos transactional batches hold at most 100 operations. */
export const MAX_BATCH = 100;
export const LOCK_TTL_MS = 30_000;

export interface Actor { who: string; oid: string; capability: 'apiplane-admin' | 'tenant-admin' }

export interface EnvironmentDeps {
  catalog: CatalogStore;
  locks: LockPort;
  /** Registered by W1-2 (gateways) / W2 (endpoints). Absent = nothing is registered yet. */
  classification?: ClassificationStore;
  publications?: PublicationPort;
  writeAudit: (rec: ApiplaneAuditRecord) => Promise<void>;
  /** Loom pipeline stage names for the D9 seed. */
  pipelineStageNames?: () => Promise<string[]>;
}

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; blocking?: BlockedPublication[] };

const fail = (status: number, error: string, blocking?: BlockedPublication[]): ServiceResult<never> => ({ ok: false, status, error, blocking });

export const settingsOf = (doc: EnvironmentCatalogDoc): PermitsSettings => ({ ...doc.settings, environments: doc.environments });

export async function loadCatalog(deps: EnvironmentDeps, tenantId: string): Promise<EnvironmentCatalogDoc> {
  const existing = await deps.catalog.get(tenantId);
  if (existing) return existing;
  const stages = deps.pipelineStageNames ? await deps.pipelineStageNames().catch(() => []) : [];
  const seeded = seedCatalog(tenantId, stages);
  await deps.catalog.save(seeded);
  return seeded;
}

async function allResources(deps: EnvironmentDeps, tenantId: string): Promise<ClassifiableResource[]> {
  return deps.classification ? deps.classification.list(tenantId) : [];
}
async function appliedPublications(deps: EnvironmentDeps, tenantId: string) {
  return deps.publications ? deps.publications.listApplied(tenantId) : [];
}

async function audit(deps: EnvironmentDeps, actor: Actor, tenantId: string, verb: string, target: string, prior: unknown, next: unknown): Promise<boolean> {
  try {
    await deps.writeAudit(buildApiplaneAuditRecord({
      tenantId, who: actor.who, actorOid: actor.oid, area: 'environment', verb, target, capability: actor.capability, prior, next,
    }));
    return true;
  } catch {
    return false;
  }
}

async function withLocks<T>(deps: EnvironmentDeps, tenantId: string, scopes: string[], fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  const release = await deps.locks.acquire(tenantId, lockOrder([ENVIRONMENTS_SCOPE, ...scopes]), LOCK_TTL_MS);
  if (!release) return fail(409, 'Another environment change is in progress. Try again in a moment.');
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

/** The invariant for a catalog edit: refuse if it newly blocks an applied publication. */
async function guardCatalogEdit(deps: EnvironmentDeps, tenantId: string, before: EnvironmentCatalogDoc, next: EnvironmentCatalogDoc): Promise<ServiceResult<null>> {
  const pubs = await appliedPublications(deps, tenantId);
  const classOf = classificationMap(await allResources(deps, tenantId));
  const refused = newlyBlocked(blockedPublications(pubs, classOf, settingsOf(before)), blockedPublications(pubs, classOf, settingsOf(next)));
  if (refused.length) {
    return fail(409, `This change would block ${refused.length} applied publication${refused.length === 1 ? '' : 's'}: ${refused.map((b) => b.publication.displayName).join(', ')}.`, refused);
  }
  return { ok: true, data: null };
}

export type CatalogMutation =
  | { op: 'create'; displayName: string; input?: EnvironmentInput }
  | { op: 'update'; key: string; input: EnvironmentInput }
  | { op: 'delete'; key: string }
  | { op: 'settings'; requireClassification: boolean };

export async function mutateCatalog(deps: EnvironmentDeps, tenantId: string, actor: Actor, m: CatalogMutation): Promise<ServiceResult<EnvironmentCatalogDoc>> {
  const pubs = await appliedPublications(deps, tenantId);
  return withLocks(deps, tenantId, pubs.map((p) => `publication:${p.id}`), async () => {
    const before = await loadCatalog(deps, tenantId);
    let edit: CatalogEdit;
    let target: string;
    if (m.op === 'create') { edit = createEnvironment(before, m.displayName, m.input); target = m.displayName; }
    else if (m.op === 'update') { edit = updateEnvironment(before, m.key, m.input); target = m.key; }
    else if (m.op === 'delete') {
      const used = (await allResources(deps, tenantId)).filter((r) => r.environmentKey === m.key);
      edit = deleteEnvironment(before, m.key, used); target = m.key;
    } else {
      edit = { ok: true, doc: { ...before, settings: { ...before.settings, requireClassification: m.requireClassification } } };
      target = 'settings';
    }
    if (!edit.ok) return fail(400, edit.error);
    const guard = await guardCatalogEdit(deps, tenantId, before, edit.doc);
    if (!guard.ok) return guard;
    await deps.catalog.save(edit.doc);
    await audit(deps, actor, tenantId, m.op === 'settings' ? 'settings' : m.op, target, m.op === 'create' ? null : before, edit.doc);
    return { ok: true, data: edit.doc };
  });
}

export interface ReclassifyResult { changed: number; auditWritten: number; auditFailed: number }

/** The single batch route's logic: validate the final state, lock in order, one atomic write, one audit event per resource. */
export async function reclassify(deps: EnvironmentDeps, tenantId: string, actor: Actor, changes: ClassificationChange[]): Promise<ServiceResult<ReclassifyResult>> {
  if (!deps.classification) {
    return fail(503, 'The gateway registry is not available in this deployment yet, so there is nothing to classify.');
  }
  if (changes.length === 0) return fail(400, 'No changes were provided.');
  if (changes.length > MAX_BATCH) return fail(413, `A batch can hold at most ${MAX_BATCH} resources (one Cosmos transaction); got ${changes.length}. Split it.`);
  const seen = new Set<string>();
  for (const c of changes) {
    const ref = resourceRef(c.kind, c.id);
    if (seen.has(ref)) return fail(400, `${c.id} appears more than once in the batch.`);
    seen.add(ref);
  }
  const catalog = await loadCatalog(deps, tenantId);
  const known = new Set(catalog.environments.map((e) => e.key));
  const unknown = changes.find((c) => c.environmentKey !== null && !known.has(c.environmentKey));
  if (unknown) return fail(400, `"${unknown.environmentKey}" is not in the environment catalog.`);

  const pubs = await appliedPublications(deps, tenantId);
  const touching = pubs.filter((p) => seen.has(resourceRef('gateway', p.gatewayId)) || p.resources.some((r) => seen.has(resourceRef(r.kind, r.id))));
  const scopes = [
    ...changes.map((c) => `${c.kind === 'gateway' ? 'gateway' : 'endpoint'}:${c.id}`),
    ...touching.map((p) => `publication:${p.id}`),
  ];
  return withLocks(deps, tenantId, scopes, async () => {
    const current = await allResources(deps, tenantId);
    const byRef = new Map(current.map((r) => [resourceRef(r.kind, r.id), r]));
    const missing = changes.find((c) => !byRef.has(resourceRef(c.kind, c.id)));
    if (missing) return fail(404, `${missing.kind} "${missing.id}" is not registered.`);

    const settings = settingsOf(catalog);
    const classBefore = classificationMap(current);
    const classAfter = new Map(classBefore);
    for (const c of changes) classAfter.set(resourceRef(c.kind, c.id), c.environmentKey);
    const refused = newlyBlocked(blockedPublications(pubs, classBefore, settings), blockedPublications(pubs, classAfter, settings));
    if (refused.length) {
      return fail(409, `This change would block ${refused.length} applied publication${refused.length === 1 ? '' : 's'}: ${refused.map((b) => b.publication.displayName).join(', ')}. Unpublish them or pick a compatible environment.`, refused);
    }
    try {
      await deps.classification!.applyBatch(tenantId, changes.map((c) => ({ ...c, expectedEtag: byRef.get(resourceRef(c.kind, c.id))!.etag })));
    } catch (e) {
      if (e instanceof ClassificationConflictError) return fail(409, `${e.resourceId} was changed by someone else while this was in progress. Reload and try again.`);
      throw e;
    }
    let written = 0;
    for (const c of changes) {
      const prior = byRef.get(resourceRef(c.kind, c.id))!.environmentKey;
      if (await audit(deps, actor, tenantId, 'reclassify', `${c.kind}:${c.id}`, { environmentKey: prior }, { environmentKey: c.environmentKey })) written++;
    }
    return { ok: true, data: { changed: changes.length, auditWritten: written, auditFailed: changes.length - written } };
  });
}
