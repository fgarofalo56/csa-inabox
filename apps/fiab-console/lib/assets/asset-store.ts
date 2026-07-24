/**
 * N5 — Cosmos store for the software-defined-asset SIDECAR (`loom-assets`).
 *
 * Reads/writes the ONLY thing lineage cannot derive: the operator's freshness
 * policy, the materializer binding, and the run/version watermarks the
 * asset-reconciler stamps. Every PRIVILEGED mutation (policy change, materializer
 * binding, manual Materialize) writes an authoritative `_auditLog` row via
 * `auditLogContainer()` AND fans out through `emitAuditEvent` — the ATO audit
 * standard, mirroring lib/admin/finops-audit.ts.
 *
 * Server-only (Cosmos). Never import from a client component — the shared TYPES
 * live in the LEAF lib/azure/asset-registry-model.ts, which is client-safe.
 *
 * IL5: pure metadata in the deployment's own Cosmos; no egress.
 */

import { assetsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { SessionPayload } from '@/lib/auth/session';
import {
  ASSET_REGISTRY_SCHEMA_VERSION,
  assetDocId,
  emptyAssetDoc,
  normalizeAssetKey,
  type AssetDoc,
  type AssetFreshnessPolicy,
  type AssetMaterializerBinding,
  type AssetRunOutcome,
} from '@/lib/azure/asset-registry-model';

function tenantOf(session: SessionPayload): string {
  return session.claims.oid;
}

function actorOf(session: SessionPayload): { oid: string; who: string; entraTenantId: string } {
  const c = session.claims;
  return { oid: c.oid, who: c.upn || c.email || c.name || c.oid, entraTenantId: c.tid || c.oid };
}

/** Every asset sidecar for the caller's tenant (single-partition read). */
export async function listAssetDocs(session: SessionPayload): Promise<AssetDoc[]> {
  const container = await assetsContainer();
  const { resources } = await container.items
    .query<AssetDoc>(
      {
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.docType = @d',
        parameters: [{ name: '@t', value: tenantOf(session) }, { name: '@d', value: 'asset' }],
      },
      { partitionKey: tenantOf(session) },
    )
    .fetchAll();
  return resources || [];
}

/** Every asset sidecar in the deployment — the reconciler's cross-tenant pass. */
export async function listAllAssetDocs(): Promise<AssetDoc[]> {
  const container = await assetsContainer();
  const { resources } = await container.items
    .query<AssetDoc>({
      query: 'SELECT * FROM c WHERE c.docType = @d',
      parameters: [{ name: '@d', value: 'asset' }],
    })
    .fetchAll();
  return resources || [];
}

/** One asset's sidecar, or null when the operator never configured it. */
export async function getAssetDoc(session: SessionPayload, assetKey: string): Promise<AssetDoc | null> {
  const key = normalizeAssetKey(assetKey);
  if (!key) return null;
  const container = await assetsContainer();
  try {
    const { resource } = await container.item(assetDocId(key), tenantOf(session)).read<AssetDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/** Index sidecars by asset key for the derive→merge pass. */
export function indexByAssetKey(docs: AssetDoc[]): Map<string, AssetDoc> {
  const map = new Map<string, AssetDoc>();
  for (const d of docs) {
    const key = normalizeAssetKey(d.assetKey);
    if (key) map.set(key, d);
  }
  return map;
}

// ── Audited mutations ───────────────────────────────────────────────────────

export type AssetAuditAction = 'policy-update' | 'materializer-bind' | 'materialize' | 'reconcile';

async function auditAssetMutation(
  session: SessionPayload,
  action: AssetAuditAction,
  assetKey: string,
  detail: { prior?: unknown; next?: unknown; reason?: string },
): Promise<void> {
  const actor = actorOf(session);
  const tenantId = tenantOf(session);
  const now = new Date().toISOString();
  try {
    const audit = await auditLogContainer();
    await audit.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `asset:${assetKey}`,
        tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at: now,
        kind: 'asset',
        action,
        target: assetKey,
        scope: 'assets',
        detail: { prior: detail.prior ?? null, next: detail.next ?? null, reason: detail.reason ?? null },
      })
      .catch(() => undefined);
  } catch {
    /* audit write failures never block the mutation (finops-audit precedent) */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action: `asset.${action}`,
    targetType: 'asset',
    targetId: assetKey,
    tenantId: actor.entraTenantId,
    detail: { prior: detail.prior ?? null, next: detail.next ?? null, reason: detail.reason ?? null },
  });
}

/**
 * Save one asset's freshness policy (and, when supplied, its materializer
 * binding). Creates the sidecar on first save. AUDITED.
 */
export async function saveAssetPolicy(
  session: SessionPayload,
  input: {
    assetKey: string;
    policy: AssetFreshnessPolicy;
    materializer?: AssetMaterializerBinding;
    name?: string;
    kind?: AssetDoc['kind'];
    group?: string;
  },
): Promise<AssetDoc> {
  const key = normalizeAssetKey(input.assetKey);
  if (!key) throw new Error('assetKey is required');
  const container = await assetsContainer();
  const prior = await getAssetDoc(session, key);
  const actor = actorOf(session);
  const next: AssetDoc = {
    ...(prior ?? emptyAssetDoc(tenantOf(session), key)),
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    assetKey: key,
    policy: input.policy,
    materializer: input.materializer ?? prior?.materializer ?? { kind: 'none' },
    ...(input.name ? { name: input.name } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.group ? { group: input.group } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: actor.who,
  };
  const { resource } = await container.items.upsert<AssetDoc>(next);
  await auditAssetMutation(session, 'policy-update', key, {
    prior: prior ? { policy: prior.policy, materializer: prior.materializer } : null,
    next: { policy: next.policy, materializer: next.materializer },
  });
  return (resource as AssetDoc) ?? next;
}

/**
 * Stamp the outcome of a materialization dispatch onto the sidecar. Used by BOTH
 * the manual Materialize action and the reconciler, so the thrash-guard
 * watermarks (`lastTriggerAt`, `consecutiveFailures`) can never diverge between
 * the two paths. AUDITED when `audit` is true (the privileged dispatch).
 */
export async function recordMaterialization(
  session: SessionPayload,
  input: {
    assetKey: string;
    outcome: AssetRunOutcome;
    runId?: string;
    detail?: string;
    reason?: string;
    /** Delta version observed at dispatch — becomes materializedVersion on success. */
    version?: number;
    audit?: boolean;
    /** Seed values used when the sidecar does not exist yet. */
    seed?: { policy?: AssetFreshnessPolicy; materializer?: AssetMaterializerBinding; name?: string };
  },
): Promise<AssetDoc> {
  const key = normalizeAssetKey(input.assetKey);
  if (!key) throw new Error('assetKey is required');
  const container = await assetsContainer();
  const prior = await getAssetDoc(session, key);
  const base = prior ?? emptyAssetDoc(tenantOf(session), key);
  const now = new Date().toISOString();
  const succeeded = input.outcome === 'succeeded';
  const failed = input.outcome === 'failed';

  const next: AssetDoc = {
    ...base,
    ...(input.seed?.policy && !prior ? { policy: input.seed.policy } : {}),
    ...(input.seed?.materializer && (!prior || prior.materializer?.kind === 'none')
      ? { materializer: input.seed.materializer }
      : {}),
    ...(input.seed?.name && !base.name ? { name: input.seed.name } : {}),
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    assetKey: key,
    lastTriggerAt: now,
    ...(input.runId ? { lastRunId: input.runId } : {}),
    lastRunOutcome: input.outcome,
    ...(input.detail ? { lastDetail: input.detail.slice(0, 2000) } : {}),
    ...(succeeded
      ? {
          lastMaterializedAt: now,
          consecutiveFailures: 0,
          ...(typeof input.version === 'number' ? { materializedVersion: input.version } : {}),
        }
      : {}),
    ...(failed ? { consecutiveFailures: (base.consecutiveFailures ?? 0) + 1 } : {}),
    updatedAt: now,
    updatedBy: actorOf(session).who,
  };
  const { resource } = await container.items.upsert<AssetDoc>(next);
  if (input.audit !== false) {
    await auditAssetMutation(session, 'materialize', key, {
      prior: prior ? { lastRunOutcome: prior.lastRunOutcome, lastMaterializedAt: prior.lastMaterializedAt } : null,
      next: { outcome: input.outcome, runId: input.runId ?? null },
      reason: input.reason,
    });
  }
  return (resource as AssetDoc) ?? next;
}

/**
 * Persist an observed data version (Delta commit / eventstream watermark) on the
 * sidecar. Not a privileged mutation — this is the reconciler's OBSERVATION
 * write, so it is not audited (the reconcile pass itself is).
 */
export async function recordObservedVersion(
  session: SessionPayload,
  assetKey: string,
  version: number,
): Promise<void> {
  const key = normalizeAssetKey(assetKey);
  if (!key || !Number.isFinite(version)) return;
  const container = await assetsContainer();
  const prior = await getAssetDoc(session, key);
  const base = prior ?? emptyAssetDoc(tenantOf(session), key);
  const now = new Date().toISOString();
  await container.items.upsert<AssetDoc>({
    ...base,
    assetKey: key,
    schemaVersion: ASSET_REGISTRY_SCHEMA_VERSION,
    observedVersion: version,
    observedAt: now,
    updatedAt: now,
  });
}

/** Stamp the alert dedup watermark after an overdue alert fires. */
export async function recordAssetAlert(session: SessionPayload, assetKey: string): Promise<void> {
  const key = normalizeAssetKey(assetKey);
  if (!key) return;
  const container = await assetsContainer();
  const prior = await getAssetDoc(session, key);
  const base = prior ?? emptyAssetDoc(tenantOf(session), key);
  const now = new Date().toISOString();
  await container.items.upsert<AssetDoc>({ ...base, assetKey: key, lastAlertAt: now, updatedAt: now });
}
