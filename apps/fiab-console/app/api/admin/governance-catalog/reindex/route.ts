/**
 * POST /api/admin/governance-catalog/reindex — ensure the
 * `loom-governance-items` AI Search index exists, then backfill it from Cosmos
 * (full scan of the caller's tenant). This is the "Cosmos change-feed → AI
 * Search indexer" in practice for the PE-locked deployment: a one-shot
 * admin-triggered full scan, followed by incremental push-from-BFF on every
 * subsequent item write (see app/api/items/_lib/item-crud.ts).
 *
 * Cosmos + the search service are PE-locked, so the operator calls this from a
 * signed-in browser; the BFF has data-plane access from inside the VNet.
 *
 * Per-tenant scope: only mirrors the calling user's tenant. Honest 503 gate when
 * LOOM_AI_SEARCH_SERVICE is unset.
 *
 * Returns: { ok, indexCreated, tenantId, indexed, errors }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  ensureGovernanceCatalogIndex,
  upsertGovernanceItems,
  docForGovernanceItem,
  isCatalogDataType,
  isGovernanceCatalogSearchConfigured,
  type GovernanceCatalogDoc,
} from '@/lib/azure/governance-catalog-index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BATCH = 1000;

export async function POST(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  if (!isGovernanceCatalogSearchConfigured()) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: 'LOOM_AI_SEARCH_SERVICE is not set in this environment',
      hint: 'Set LOOM_AI_SEARCH_SERVICE on the loom-console container app to enable the AI Search catalog (bicep: platform/fiab/bicep/modules/admin-plane/ai-search.bicep).',
    }, { status: 503 });
  }

  const ensured = await ensureGovernanceCatalogIndex();
  if (!ensured.ok) {
    return NextResponse.json({ ok: false, error: `ensure index failed: ${ensured.error}` }, { status: 502 });
  }

  const tenantId = s.claims.oid;
  const errors: string[] = [];
  let indexed = 0;

  const ws = await workspacesContainer();
  const { resources: wsList } = await ws.items
    .query({
      query: 'SELECT c.id, c.name, c.domain FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    }, { partitionKey: tenantId })
    .fetchAll();

  const items = await itemsContainer();
  let batch: GovernanceCatalogDoc[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await upsertGovernanceItems(batch);
    if (r.ok) indexed += batch.length;
    else errors.push(r.error || 'batch upsert failed');
    batch = [];
  };

  for (const w of wsList as any[]) {
    const { resources } = await items.items
      .query({
        query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.createdBy, c.updatedAt, c.createdAt, c.state FROM c WHERE c.workspaceId = @w',
        parameters: [{ name: '@w', value: w.id }],
      }, { partitionKey: w.id })
      .fetchAll();
    for (const it of resources as any[]) {
      if (!isCatalogDataType(it.itemType)) continue;
      batch.push(docForGovernanceItem(it, { tenantId, workspaceName: w.name, workspaceDomain: w.domain }));
      if (batch.length >= BATCH) await flush();
    }
  }
  await flush();

  return NextResponse.json({
    ok: true,
    indexCreated: ensured.created,
    tenantId,
    indexed,
    errors,
  });
}
