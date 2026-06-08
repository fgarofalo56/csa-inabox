/**
 * GET    /api/data-products/[id]  — preconditions check for a destructive delete.
 * DELETE /api/data-products/[id]  — precondition-gated delete of the Cosmos doc.
 *
 * Preconditions mirror the Microsoft Purview Unified Catalog "Delete data
 * products" procedure
 * (https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage):
 *   1. lifecycleStatus must be 'Draft' or 'Expired' (NOT 'Published').
 *   2. Zero data assets attached  (state.datasets empty).
 *   3. Zero glossary terms linked  (state.glossaryLinks empty).
 *   4. Zero open access requests   (no audit-log `access-requested` rows).
 *
 * Only when ALL four hold may the data product be deleted. The Cosmos delete is
 * authoritative; Purview Unified Catalog cleanup is best-effort — on the
 * deployed CLASSIC Data Map account it honestly gates (PurviewUnifiedCatalogGateError)
 * and never blocks the Cosmos delete, per .claude/rules/no-vaporware.md.
 *
 * GET    : 200 { ok, displayName, workspaceId, preconditions, current }
 * DELETE : 200 { ok, workspaceId, purviewDeleted, purviewNote? }
 *          422 { ok:false, error, code:'precondition_failed', blockers, current }
 * Both   : 401 unauthenticated · 404 not found · 500 unexpected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  deleteDataProductBestEffort,
  PurviewUnifiedCatalogGateError,
  PurviewNotConfiguredError,
} from '@/lib/azure/purview-client';
import { loadOwnedItem, deleteOwnedItem, jerr } from '../../items/_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface PreconditionResult {
  item: WorkspaceItem;
  preconditions: {
    statusAllowed: boolean;
    datasetsEmpty: boolean;
    glossaryEmpty: boolean;
    noOpenAccessRequests: boolean;
    canDelete: boolean;
  };
  current: {
    lifecycleStatus: string;
    datasetCount: number;
    glossaryCount: number;
    openAccessRequestCount: number;
  };
}

/**
 * Resolve every delete precondition for a data product. Returns null when the
 * item does not exist (or is not owned by the caller's tenant). Used by BOTH
 * the GET (UI preflight) and DELETE (server-side enforcement) handlers so the
 * checks can never drift apart.
 */
async function checkPreconditions(id: string, tenantId: string): Promise<PreconditionResult | null> {
  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return null;

  const state = (item.state || {}) as Record<string, unknown>;
  const lifecycleStatus = (state.lifecycleStatus as string) || 'Draft';
  const datasets = Array.isArray(state.datasets) ? state.datasets : [];
  const glossaryLinks = Array.isArray(state.glossaryLinks) ? state.glossaryLinks : [];

  // Single-partition aggregate on audit-log (PK = /itemId) — counts the open
  // access requests recorded by POST /api/catalog/request-access. There is no
  // resolution tracking today, so every such row counts as "open".
  const audit = await auditLogContainer();
  const { resources: counts } = await audit.items
    .query<number>(
      {
        query: 'SELECT VALUE COUNT(1) FROM c WHERE c.action = @a',
        parameters: [{ name: '@a', value: 'access-requested' }],
      },
      { partitionKey: id },
    )
    .fetchAll();
  const openAccessRequestCount = Number(counts?.[0] ?? 0);

  const statusAllowed = lifecycleStatus !== 'Published';
  const datasetsEmpty = datasets.length === 0;
  const glossaryEmpty = glossaryLinks.length === 0;
  const noOpenAccessRequests = openAccessRequestCount === 0;
  const canDelete = statusAllowed && datasetsEmpty && glossaryEmpty && noOpenAccessRequests;

  return {
    item,
    preconditions: { statusAllowed, datasetsEmpty, glossaryEmpty, noOpenAccessRequests, canDelete },
    current: {
      lifecycleStatus,
      datasetCount: datasets.length,
      glossaryCount: glossaryLinks.length,
      openAccessRequestCount,
    },
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const result = await checkPreconditions(id, session.claims.oid);
    if (!result) return jerr('data-product not found', 404);
    return NextResponse.json({
      ok: true,
      displayName: result.item.displayName,
      workspaceId: result.item.workspaceId,
      preconditions: result.preconditions,
      current: result.current,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  try {
    const result = await checkPreconditions(id, session.claims.oid);
    if (!result) return jerr('data-product not found', 404);

    const { preconditions, current, item } = result;
    if (!preconditions.canDelete) {
      const blockers: string[] = [];
      if (!preconditions.statusAllowed)
        blockers.push(
          `Status is '${current.lifecycleStatus}' — unpublish the data product first (set its lifecycle status to Draft or Expired).`,
        );
      if (!preconditions.datasetsEmpty)
        blockers.push(
          `${current.datasetCount} data asset(s) attached — remove all data assets (Datasets tab) before deleting.`,
        );
      if (!preconditions.glossaryEmpty)
        blockers.push(
          `${current.glossaryCount} glossary term(s) linked — unlink all terms (Glossary tab) before deleting.`,
        );
      if (!preconditions.noOpenAccessRequests)
        blockers.push(
          `${current.openAccessRequestCount} open access request(s) exist — delete all access requests (Governance → Policies) before deleting.`,
        );
      return NextResponse.json(
        {
          ok: false,
          error: 'Delete blocked: preconditions not met.',
          code: 'precondition_failed',
          blockers,
          current,
        },
        { status: 422 },
      );
    }

    // 1. Delete from Cosmos (authoritative). deleteOwnedItem also removes the
    //    AI Search mirror (deleteLoomDoc) on success.
    const deleted = await deleteOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!deleted) return jerr('data-product not found or already deleted', 404);

    // 2. Best-effort: delete from the Purview Unified Catalog. The expected
    //    PurviewUnifiedCatalogGateError on the deployed classic Data Map account
    //    NEVER fails the Cosmos delete — the Cosmos record is the source of truth.
    const state = (item.state || {}) as Record<string, unknown>;
    const purviewId = state.purviewDataProductId as string | undefined;
    let purviewDeleted = false;
    let purviewNote: string | undefined;
    if (purviewId) {
      try {
        const r = await deleteDataProductBestEffort(purviewId);
        purviewDeleted = r.deleted;
        purviewNote = r.note;
      } catch (e: any) {
        if (e instanceof PurviewUnifiedCatalogGateError) {
          purviewNote =
            'Purview Unified Catalog delete skipped (classic Data Map account). If this product was registered via a unified-catalog account, delete it manually in the Purview portal.';
        } else if (e instanceof PurviewNotConfiguredError) {
          purviewNote = 'Purview not configured (LOOM_PURVIEW_ACCOUNT unset) — no catalog cleanup needed.';
        } else {
          purviewNote = `Purview cleanup failed (best-effort, ignored): ${e?.message || String(e)}`;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      workspaceId: item.workspaceId,
      purviewDeleted,
      ...(purviewNote ? { purviewNote } : {}),
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
