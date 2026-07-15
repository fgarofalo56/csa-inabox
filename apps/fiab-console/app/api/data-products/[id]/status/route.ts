/**
 * POST /api/data-products/[id]/status
 *
 * F6 — Publish / Unpublish / Expire lifecycle controls for a data-product.
 *
 * Body: { status: 'PUBLISHED' | 'DRAFT' | 'EXPIRED' }
 *
 * Mirrors the Microsoft Purview unified-catalog data-product lifecycle
 * (CatalogModelStatus = DRAFT | PUBLISHED | EXPIRED, REST 2026-03-20-preview).
 * Cosmos is the authoritative status store (`state.lifecycleStatus`) so the
 * lifecycle is 100% functional with NO Microsoft Fabric / Power BI / unified-
 * catalog dependency. When a unified-catalog Purview account is bound the
 * transition is ALSO pushed to Purview (best-effort) — otherwise the honest
 * PurviewUnifiedCatalogGateError keeps the Cosmos write authoritative.
 *
 * Publish (-> PUBLISHED) is GUARDED server-side. All three preconditions must
 * hold (matching Purview "Publish, draft, and expire"):
 *   1. >= 1 data asset attached       (state.datasets) -> 422 reason=no_assets
 *   2. an active Access policy exists  (governance policies, scope=data-product:{id},
 *      kind=Access, enabled)           -> 422 reason=no_active_policy
 *   3. the governance domain is set    (state.domain)  -> 422 reason=domain_not_published
 *
 * Unpublish transitions (-> DRAFT / -> EXPIRED) have no preconditions; EXPIRED
 * restricts consumer visibility (the item is filtered out of the consumer
 * discovery catalog at /api/governance/catalog).
 *
 * Status semantics:
 *   200 — transition applied + Cosmos updated.
 *   400 — invalid status value.
 *   401 — unauthenticated.
 *   404 — Cosmos item not found / not owned by caller's tenant.
 *   422 — a publish precondition failed (body.preconditionFailed.reason).
 *   500 — Cosmos write failed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';
import {
  updateDataProductStatus,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { loadOwnedItem, updateOwnedItem, jerr } from '@/app/api/items/_lib/item-crud';
import { upsertDataProductDoc, docForDataProduct } from '@/lib/azure/loom-data-products-search';
import { setLifecycleState, type LifecycleState } from '@/lib/dataproducts/lifecycle';
import { diffContracts, parseSemver } from '@/lib/dataproducts/versioning';
import { evaluateContractGate, resolveContractTable } from '@/lib/dataproducts/contract-gate';
import type { DataContract } from '@/lib/dataproducts/contract';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const VALID = ['PUBLISHED', 'DRAFT', 'EXPIRED'] as const;
type LifecycleStatus = (typeof VALID)[number];

/** F6 ribbon UPPERCASE status → the ONE canonical lifecycle state (DP-1). */
const CANONICAL: Record<LifecycleStatus, LifecycleState> = {
  PUBLISHED: 'published',
  DRAFT: 'draft',
  EXPIRED: 'deprecated',
};

interface PreconditionFailure {
  reason: 'no_assets' | 'no_active_policy' | 'domain_not_published' | 'contract_validation_failed';
  message: string;
  field: string;
}

/**
 * Resolve the data product's EFFECTIVE data contract for the publish gate: a
 * bound standalone `data-contract` item (state.dataContractId) takes precedence,
 * else the inline state.contract. Owner-scoped; a missing/unreadable bound
 * contract falls back to the inline one (never throws).
 */
async function resolveEffectiveContract(
  state: Record<string, unknown>,
  tenantId: string,
): Promise<DataContract | undefined> {
  const boundId = typeof state.dataContractId === 'string' ? state.dataContractId.trim() : '';
  if (boundId) {
    try {
      const item = await loadOwnedItem(boundId, 'data-contract', tenantId, { allowReadRoles: true });
      const c = (item?.state as Record<string, unknown> | undefined)?.contract;
      if (c && typeof c === 'object') return c as DataContract;
    } catch { /* fall through to inline */ }
  }
  const inline = state.contract;
  return inline && typeof inline === 'object' ? (inline as DataContract) : undefined;
}

/** Read the tenant governance-policies doc (read-only — no seed write). */
async function readPolicies(tenantId: string): Promise<any[]> {
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(`policies:${tenantId}`, tenantId).read<any>();
    return Array.isArray(resource?.items) ? resource.items : [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/**
 * Evaluate the three publish preconditions. Returns the FIRST failure (so the
 * UI surfaces one precise, actionable reason) or null when all hold.
 */
async function checkPublishPreconditions(
  id: string,
  state: Record<string, unknown>,
  tenantId: string,
): Promise<PreconditionFailure | null> {
  // 1. >= 1 data asset attached — count EITHER the Datasets-tab `datasets` OR the
  //    Data-Map `dataAssets` (DP-3: the guided wizard attaches via dataAssets),
  //    so "at least one asset" is satisfied by either attachment surface.
  const datasets = Array.isArray(state.datasets) ? (state.datasets as unknown[]) : [];
  const dataAssets = Array.isArray(state.dataAssets) ? (state.dataAssets as unknown[]) : [];
  if (datasets.length + dataAssets.length < 1) {
    return {
      reason: 'no_assets',
      message:
        'Cannot publish: attach at least one data asset (Datasets or Data assets tab) before publishing.',
      field: 'state.datasets',
    };
  }

  // 2. an active Access policy — EITHER a tenant governance Access policy scoped
  //    to this product, OR the product's own `state.accessPolicy` (DP-3: the
  //    guided wizard / the access-policy route configure the latter). A product
  //    explicitly marked self-serve also satisfies this (no approval needed).
  const policies = await readPolicies(tenantId);
  const hasTenantPolicy = policies.some(
    (p: any) => p?.kind === 'Access' && p?.scope === `data-product:${id}` && p?.enabled !== false,
  );
  const ap = state.accessPolicy as { allowedPurposes?: unknown[]; approvers?: unknown[] } | undefined;
  const hasProductPolicy = !!ap && (
    (Array.isArray(ap.allowedPurposes) && ap.allowedPurposes.length > 0) ||
    (Array.isArray(ap.approvers) && ap.approvers.length > 0)
  );
  const isSelfServe = state.accessModel === 'self-serve';
  const hasActivePolicy = hasTenantPolicy || hasProductPolicy || isSelfServe;
  if (!hasActivePolicy) {
    return {
      reason: 'no_active_policy',
      message:
        'Cannot publish: create at least one active Access policy on the Access policies tab.',
      field: 'policies',
    };
  }

  // 3. the governance domain is set (a published governance domain).
  const domain = typeof state.domain === 'string' ? state.domain.trim() : '';
  if (!domain) {
    return {
      reason: 'domain_not_published',
      message:
        'Cannot publish: the governance domain field is empty. Set a published governance domain on the Overview tab before publishing.',
      field: 'state.domain',
    };
  }

  // 4. BR-CONTRACT-GATE (W10) — if a bound/inline data contract carries
  //    error-severity quality expectations, they must pass against the bound
  //    ADX table. Only a REAL measured failure blocks (missing infra never does).
  const contract = await resolveEffectiveContract(state, tenantId);
  const { database, tableName } = resolveContractTable(state);
  const gate = await evaluateContractGate({ contract, database, tableName });
  if (gate.blocked && gate.block) {
    return { reason: 'contract_validation_failed', message: gate.block.message, field: 'contract' };
  }

  return null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);

  const id = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const status = String(body?.status || '').toUpperCase() as LifecycleStatus;
  if (!VALID.includes(status)) {
    return jerr(`status must be one of ${VALID.join(', ')}`, 400);
  }

  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('data-product item not found', 404);
    const state = (item.state || {}) as Record<string, unknown>;

    // Publish is guarded by the three real preconditions.
    if (status === 'PUBLISHED') {
      const failure = await checkPublishPreconditions(id, state, session.claims.oid);
      if (failure) {
        return NextResponse.json(
          { ok: false, error: failure.message, preconditionFailed: failure },
          { status: 422 },
        );
      }
      // DP-9 breaking-change gate: if the current contract has a breaking change
      // vs the last-PUBLISHED contract and the version wasn't MAJOR-bumped, block
      // publish (honest, never silent) — the owner must bump major + note it.
      const published = state.publishedContract as DataContract | undefined;
      const current = state.contract as DataContract | undefined;
      if (published && current) {
        const diff = diffContracts(published, current);
        const majorBumped = parseSemver(current.version)[0] > parseSemver(published.version)[0];
        if (diff.breaking && !majorBumped) {
          return NextResponse.json(
            {
              ok: false,
              error: 'Cannot publish a breaking contract change without a MAJOR version bump. Bump the version (major) and record a migration note in the Versions tab.',
              preconditionFailed: { reason: 'breaking_change', field: 'state.contract', message: 'Breaking contract change requires a major version bump.' },
              breakingChanges: diff.changes.filter((c) => c.breaking),
            },
            { status: 422 },
          );
        }
      }
    }

    // Best-effort push to the Purview unified catalog (gated on the classic
    // account — never blocks the authoritative Cosmos write).
    let purviewSync = false;
    let purviewSyncNote: string | undefined;
    const purviewId = typeof state.purviewDataProductId === 'string' ? state.purviewDataProductId : '';
    if (purviewId) {
      try {
        await updateDataProductStatus(purviewId, status);
        purviewSync = true;
      } catch (e: any) {
        if (e instanceof PurviewNotConfiguredError) {
          purviewSyncNote =
            'Cosmos status updated. Purview unified-catalog sync is gated in this deployment (classic Data Map account); the lifecycle is fully functional without it.';
        } else if (e instanceof PurviewError) {
          purviewSyncNote = `Cosmos status updated. Purview sync returned ${e.status}.`;
        } else {
          purviewSyncNote = `Cosmos status updated. Purview sync error: ${e?.message || String(e)}`;
        }
      }
    }

    // Authoritative write: persist the ONE canonical lifecycle on the Cosmos
    // item. DP-1 — setLifecycleState writes `lifecycleState` AND mirrors the
    // legacy trio (lifecycleStatus/status/publishStatus) so this ribbon Publish
    // is ALSO reflected on the details badge and in marketplace search, closing
    // the "Publish here doesn't publish there" defect.
    const lifecycleStatusAt = new Date().toISOString();
    const nextState = setLifecycleState(state, CANONICAL[status], lifecycleStatusAt);
    // DP-9: on a successful Publish, snapshot the contract as the baseline the
    // NEXT publish's breaking-change gate diffs against.
    if (status === 'PUBLISHED' && state.contract) nextState.publishedContract = state.contract;
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!updated) return jerr('Cosmos write to record lifecycleStatus failed', 500);

    // Re-project the consumer-discovery index off the mirrored publishStatus so a
    // ribbon Publish makes the product discoverable (and Unpublish/Expire removes
    // it from consumer search). AWAITED so it completes within the request;
    // best-effort — the index is derived and never fails the lifecycle write.
    try { await upsertDataProductDoc(docForDataProduct(updated, session.claims.oid)); } catch { /* index is derived */ }

    return NextResponse.json({
      ok: true,
      lifecycleStatus: status,
      lifecycleState: CANONICAL[status],
      lifecycleStatusAt,
      purviewSync,
      purviewSyncNote,
      item: updated,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
