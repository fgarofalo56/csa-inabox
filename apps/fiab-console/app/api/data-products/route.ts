/**
 * /api/data-products — owner-side management for marketplace data products.
 *
 * A "data product" is a `data-product` WorkspaceItem whose `state` carries the
 * marketplace metadata (domain, productType, owner, glossaryTerms, CDEs, sla,
 * publishStatus). These routes are the producer counterpart to the consumer
 * discovery surface in /api/data-products/search.
 *
 * Writes go through the shared item-crud helpers (createOwnedItem /
 * loadOwnedItem / listOwnedItems), so every create automatically mirrors the
 * product into the `loom-data-products` AI Search index — only Published
 * products are visible to consumers (the index push happens regardless; the
 * consumer query filters on publishStatus).
 *
 * GET  /api/data-products            — list this tenant's data products (Cosmos)
 * POST /api/data-products            — create a data product
 *
 * Azure-native by default: no Microsoft Fabric / Power BI dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { PUBLISH_STATUSES, type PublishStatus } from '@/lib/azure/loom-data-products-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

/** Whitelist + normalize the marketplace metadata that lands in item.state. */
function normalizeState(raw: any): Record<string, unknown> {
  const asArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    return [];
  };
  const ps = String(raw?.publishStatus || 'Draft') as PublishStatus;
  const state: Record<string, unknown> = {
    publishStatus: PUBLISH_STATUSES.includes(ps) ? ps : 'Draft',
  };
  if (raw?.domain) state.domain = String(raw.domain);
  if (raw?.productType) state.productType = String(raw.productType);
  if (raw?.owner) state.owner = String(raw.owner);
  if (raw?.sla) state.sla = String(raw.sla);
  const glossaryTerms = asArray(raw?.glossaryTerms);
  if (glossaryTerms.length) state.glossaryTerms = glossaryTerms;
  const CDEs = asArray(raw?.CDEs);
  if (CDEs.length) state.CDEs = CDEs;
  return state;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const items = await listOwnedItems(ITEM_TYPE, s.claims.oid);
    const products = items.map((it) => ({
      id: it.id,
      workspaceId: it.workspaceId,
      displayName: it.displayName,
      description: it.description,
      state: it.state || {},
      createdBy: it.createdBy,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    }));
    return NextResponse.json({ ok: true, products });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({} as any));
  const workspaceId = String(body?.workspaceId || '').trim();
  const displayName = String(body?.displayName || '').trim();
  if (!workspaceId || !displayName) {
    return NextResponse.json({ ok: false, error: 'workspaceId and displayName are required' }, { status: 400 });
  }
  const state = normalizeState(body?.state ?? body);
  // Default the owner to the creator when not supplied.
  if (!state.owner) state.owner = s.claims.upn || s.claims.email || s.claims.oid;
  try {
    const res = await createOwnedItem(s, ITEM_TYPE, {
      workspaceId,
      displayName,
      description: body?.description ? String(body.description) : undefined,
      state,
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: res.status });
    return NextResponse.json({ ok: true, product: res.item });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
