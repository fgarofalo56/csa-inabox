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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const VALID = ['PUBLISHED', 'DRAFT', 'EXPIRED'] as const;
type LifecycleStatus = (typeof VALID)[number];

interface PreconditionFailure {
  reason: 'no_assets' | 'no_active_policy' | 'domain_not_published';
  message: string;
  field: string;
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
  // 1. >= 1 data asset attached.
  const datasets = Array.isArray(state.datasets) ? (state.datasets as unknown[]) : [];
  if (datasets.length < 1) {
    return {
      reason: 'no_assets',
      message:
        'Cannot publish: attach at least one data asset on the Datasets tab before publishing.',
      field: 'state.datasets',
    };
  }

  // 2. an active Access policy scoped to this data product.
  const policies = await readPolicies(tenantId);
  const hasActivePolicy = policies.some(
    (p: any) => p?.kind === 'Access' && p?.scope === `data-product:${id}` && p?.enabled !== false,
  );
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

    // Authoritative write: persist the lifecycle status on the Cosmos item.
    const lifecycleStatusAt = new Date().toISOString();
    const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
      state: { ...state, lifecycleStatus: status, lifecycleStatusAt },
    });
    if (!updated) return jerr('Cosmos write to record lifecycleStatus failed', 500);

    return NextResponse.json({
      ok: true,
      lifecycleStatus: status,
      lifecycleStatusAt,
      purviewSync,
      purviewSyncNote,
      item: updated,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
