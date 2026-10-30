/**
 * API Gateway Plane — gateway registry service (W1-2).
 *
 * Pure orchestration over injected ports (repo, ARM, audit sink, clock) so the
 * routes and tests share one implementation. Ids are deterministic
 * (`gw-<sha256(lowercase resource id)[0..16]>`), so a double registration is an
 * upsert of the same document, never a second one.
 */
import { createHash } from 'node:crypto';
import { buildApiplaneAuditRecord } from '../audit';
import { ClassificationConflictError } from '../environments/types';
import type { ApiplaneAuditRecord, ApiplaneRepo } from '../types';
import { preflightGateway, type ArmPort } from './preflight';
import { parseApimResourceId } from './resource-id';
import type { GatewayAccess, GatewayCloud, GatewayDoc, GatewayOwner } from './types';

/**
 * Repository port. `replaceBatch` is ATOMIC: every doc is replaced against its
 * expected etag in one transaction; a stale etag throws ClassificationConflictError
 * (carrying that doc id) and writes nothing.
 */
export interface GatewayRepo extends ApiplaneRepo<GatewayDoc> {
  replaceBatch(tenantId: string, items: Array<{ doc: GatewayDoc; expectedEtag?: string }>): Promise<void>;
}

export interface RegistryDeps {
  repo: GatewayRepo;
  arm: ArmPort;
  writeAudit(rec: ApiplaneAuditRecord): Promise<void>;
  cloud(): GatewayCloud;
  now?: () => Date;
}

export interface Actor {
  tenantId: string;
  who: string;
  actorOid: string;
  capability: 'apiplane-admin' | 'tenant-admin';
}

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code: string; data?: unknown };

export function gatewayId(resourceId: string): string {
  return `gw-${createHash('sha256').update(resourceId.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** Operator-facing sentence naming the exact role, scope and command (R6/R7: states only what was established). */
export function accessDeniedMessage(a: GatewayAccess, resourceId: string): string {
  const m = a.missingRole;
  if (!m) return `The Console identity could not read ${resourceId}.`;
  const how = a.source === 'permissions' ? 'effective permissions at the scope do not include read' : 'a direct read of the service was refused or failed';
  return (
    `The Console identity cannot read ${resourceId} (${how}). Grant role "${m.roleName}" ` +
    `(${m.roleDefinitionId}) at scope ${m.scope} with: ${m.azCommand}`
  );
}

function newDoc(
  actor: Actor,
  p: { resourceId: string; name: string; displayName?: string; ownedBy: GatewayOwner },
  access: GatewayAccess,
  cloud: GatewayCloud,
  at: string,
): GatewayDoc {
  return {
    id: gatewayId(p.resourceId),
    tenantId: actor.tenantId,
    docType: 'gateway',
    kind: 'gateway',
    displayName: p.displayName?.trim() || p.name,
    resourceId: p.resourceId,
    cloud,
    managementMode: 'observe',
    environmentKey: null,
    access,
    capabilities: { tier: 'unknown', mcpServers: 'unknown', llmPolicies: 'unknown' },
    inventory: { apis: 0, products: 0, subscriptions: 0, backends: 0, namedValues: 0, mcpServers: 0, partialTypes: [] },
    ownedBy: p.ownedBy,
    createdAt: at,
    createdBy: actor.actorOid,
  };
}

async function audit(
  d: RegistryDeps,
  actor: Actor,
  verb: string,
  target: string,
  prior: unknown,
  next: unknown,
  at: Date,
): Promise<void> {
  await d.writeAudit(
    buildApiplaneAuditRecord({ ...actor, area: 'gateway', verb, target, prior, next, now: at }),
  );
}

export async function registerGateway(
  d: RegistryDeps,
  actor: Actor,
  input: { resourceId?: unknown; displayName?: unknown },
  ownedBy: GatewayOwner = 'registered',
): Promise<ServiceResult<GatewayDoc>> {
  const target = parseApimResourceId(input.resourceId);
  if (!target) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_resource_id',
      error:
        'resourceId must be an API Management service id: /subscriptions/<guid>/resourceGroups/<rg>/providers/Microsoft.ApiManagement/service/<name>',
    };
  }
  const id = gatewayId(target.resourceId);
  const existing = await d.repo.get(actor.tenantId, id);
  if (existing && ownedBy === 'registered') {
    return { ok: false, status: 409, code: 'already_registered', error: `${target.resourceId} is already registered as gateway ${id}.` };
  }

  const now = (d.now ?? (() => new Date()))();
  let access: GatewayAccess;
  try {
    access = await preflightGateway(target, d.arm, () => now);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      code: 'preflight_failed',
      error: `Could not run the access preflight for ${target.resourceId}: ${(e as Error)?.message ?? String(e)}`,
    };
  }

  if (!access.canRead && ownedBy === 'registered') {
    return {
      ok: false,
      status: 422,
      code: 'gateway_role_missing',
      error: accessDeniedMessage(access, target.resourceId),
      data: { access, missingRole: access.missingRole },
    };
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName : undefined;
  if (existing) {
    // Re-registration refreshes ONLY access, on a fresh read, etag-guarded: it must never
    // overwrite environmentKey (or any other field) a concurrent classification just wrote.
    return { ok: true, data: await refreshAccess(d, actor.tenantId, id, access) };
  }
  const doc = newDoc(actor, { resourceId: target.resourceId, name: target.name, displayName, ownedBy }, access, d.cloud(), now.toISOString());
  await d.repo.upsert(doc);
  await audit(d, actor, 'register', id, null, { resourceId: doc.resourceId, ownedBy: doc.ownedBy }, now);
  return { ok: true, data: doc };
}

async function refreshAccess(d: RegistryDeps, tenantId: string, id: string, access: GatewayAccess): Promise<GatewayDoc> {
  for (let attempt = 0; ; attempt++) {
    const cur = await d.repo.get(tenantId, id);
    if (!cur) throw new Error(`Gateway ${id} disappeared during refresh`);
    const next: GatewayDoc = { ...cur, access };
    try {
      await d.repo.replaceBatch(tenantId, [{ doc: next, expectedEtag: cur._etag }]);
      return next;
    } catch (e) {
      if (!(e instanceof ClassificationConflictError) || attempt >= 2) throw e;
    }
  }
}

export async function listGateways(d: RegistryDeps, tenantId: string): Promise<GatewayDoc[]> {
  const all = await d.repo.list(tenantId, 'gateway');
  return all.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function removeGateway(d: RegistryDeps, actor: Actor, id: string): Promise<ServiceResult<{ id: string }>> {
  const existing = await d.repo.get(actor.tenantId, id);
  if (!existing || existing.docType !== 'gateway') {
    return { ok: false, status: 404, code: 'not_found', error: `Gateway ${id} is not registered.` };
  }
  if (existing.ownedBy === 'deploy') {
    return {
      ok: false,
      status: 409,
      code: 'deploy_owned',
      error: 'This gateway is owned by the deployment and is re-registered automatically; it cannot be removed here.',
    };
  }
  await d.repo.remove(actor.tenantId, id);
  await audit(d, actor, 'remove', id, { resourceId: existing.resourceId }, null, (d.now ?? (() => new Date()))());
  return { ok: true, data: { id } };
}

/**
 * Register the deploy-owned gateway named by LOOM_APIPLANE_DEPLOY_GATEWAY_ID.
 * Idempotent: the deterministic id makes a second call refresh access on the
 * same document (only when it was unreadable) and write no second audit row.
 */
export async function ensureDeployGateway(
  d: RegistryDeps,
  actor: Actor,
  env: Record<string, string | undefined> = process.env,
): Promise<ServiceResult<GatewayDoc | null>> {
  if ((env.LOOM_APIPLANE_ENABLED ?? 'true').toLowerCase() === 'false') return { ok: true, data: null };
  const raw = env.LOOM_APIPLANE_DEPLOY_GATEWAY_ID;
  if (!raw) return { ok: true, data: null };
  const target = parseApimResourceId(raw);
  if (!target) {
    return {
      ok: false,
      status: 500,
      code: 'invalid_deploy_gateway_id',
      error: `LOOM_APIPLANE_DEPLOY_GATEWAY_ID is not an API Management service resource id: ${raw}`,
    };
  }
  const existing = await d.repo.get(actor.tenantId, gatewayId(target.resourceId));
  if (existing?.access.canRead) return { ok: true, data: existing };
  return registerGateway(d, actor, { resourceId: raw }, 'deploy');
}
