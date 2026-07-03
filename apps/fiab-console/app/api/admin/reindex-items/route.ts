/**
 * POST /api/admin/reindex-items — ensure `loom-items` AI Search index exists
 * + push every workspace + item from Cosmos into the index. Idempotent
 * (uses mergeOrUpload).
 *
 * Cosmos is PE-locked so the operator-side approach is to call this
 * endpoint from a signed-in browser; the BFF has data-plane access from
 * inside the VNet.
 *
 * Per-tenant scope: only mirrors the calling user's tenant. Run once per
 * tenant after sign-in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  ensureLoomIndex, upsertLoomDoc, docForWorkspace, docForItem,
  isSearchConfigured,
} from '@/lib/azure/loom-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  if (!isSearchConfigured()) {
    return NextResponse.json({
      ok: false,
      error: 'LOOM_AI_SEARCH_SERVICE is not set in this environment',
      hint: 'Set LOOM_AI_SEARCH_SERVICE on the loom-console container app to enable AI Search.',
    }, { status: 503 });
  }

  const ensured = await ensureLoomIndex();
  if (!ensured.ok) {
    return NextResponse.json({ ok: false, error: `ensure index failed: ${ensured.error}` }, { status: 502 });
  }

  const tenantId = s.claims.oid;
  let wsCount = 0;
  let itemCount = 0;
  const errors: string[] = [];

  // Workspaces
  const ws = await workspacesContainer();
  const { resources: wsList } = await ws.items
    .query({
      query: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  for (const w of wsList as any[]) {
    try { await upsertLoomDoc(docForWorkspace(w)); wsCount++; }
    catch (e: any) { errors.push(`ws:${w.id}: ${e?.message}`); }
  }

  // Items — filter to tenant via workspace lookup
  const tenantWsIds = new Set<string>(wsList.map((w: any) => w.id));
  if (tenantWsIds.size) {
    const items = await itemsContainer();
    // Pull in batches per workspace to keep partition reads tight.
    for (const wsid of tenantWsIds) {
      const { resources } = await items.items
        .query({
          query: 'SELECT * FROM c WHERE c.workspaceId = @w',
          parameters: [{ name: '@w', value: wsid }],
        }, { partitionKey: wsid })
        .fetchAll();
      for (const it of resources as any[]) {
        try { await upsertLoomDoc(docForItem(it, tenantId)); itemCount++; }
        catch (e: any) { errors.push(`it:${it.id}: ${e?.message}`); }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    indexCreated: ensured.created,
    tenantId,
    workspacesIndexed: wsCount,
    itemsIndexed: itemCount,
    errors,
  });
}
