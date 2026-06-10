/**
 * /api/items/rayfin-app/models
 *
 * Backs the Rayfin app builder's "Bind a semantic model" picker and model-bound
 * entity derivation.
 *
 *   GET  → { ok, models: BoundModelLite[] }
 *          The tenant's Loom-native semantic-model items (the no-Fabric default
 *          backend), surfaced from Cosmos via the shared pbi-content-fallback
 *          helper — the SAME source the /semantic-model workspace pane lists.
 *          Each entry carries its table + column structure so the builder can
 *          DERIVE Rayfin entities one-for-one from the model (real binding),
 *          rather than asking the author to hand-type entities (Rayfin's general
 *          case). NEVER hard-coded — an empty list is honest when the tenant has
 *          no semantic models.
 *
 *   GET ?id=loom:<cosmosId> → { ok, model: BoundModelDetail }
 *          The bound model's full structure (tables → columns + measures,
 *          relationships) so the builder can regenerate the model.ts + the web
 *          app whenever the source model changes.
 *
 * Per .claude/rules/no-fabric-dependency.md this reads Loom-native semantic
 * models from Cosmos — it does NOT require a Fabric/Power BI workspace. Per
 * .claude/rules/no-vaporware.md every value is a real Cosmos read (no mocks).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listContentBackedItems, loadContentBackedItem, semanticModelDetailFromContent,
  cosmosIdFromLoomId, isLoomContentId, LOOM_ID_PREFIX,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BoundColumn { name: string; dataType: string }
interface BoundTable { name: string; columns: BoundColumn[]; measures: { name: string; expression?: string }[] }
interface BoundRelationship {
  name: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string;
  crossFilteringBehavior: string;
}
interface BoundModelLite {
  id: string;
  name: string;
  tables: BoundTable[];
}
interface BoundModelDetail extends BoundModelLite {
  relationships: BoundRelationship[];
}

function detailToLite(modelId: string, name: string, detail: ReturnType<typeof semanticModelDetailFromContent>): BoundModelDetail {
  const tables: BoundTable[] = (detail?.tables || []).map((t: any) => ({
    name: t.name,
    columns: (t.columns || []).map((c: any) => ({ name: c.name, dataType: c.dataType || 'string' })),
    measures: (t.measures || []).map((m: any) => ({ name: m.name, expression: m.expression })),
  }));
  const relationships: BoundRelationship[] = (detail?.relationships || []).map((r: any) => ({
    name: r.name,
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toTable: r.toTable,
    toColumn: r.toColumn,
    crossFilteringBehavior: r.crossFilteringBehavior || 'OneDirection',
  }));
  return { id: modelId, name, tables, relationships };
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = session.claims.oid;

  const id = (req.nextUrl.searchParams.get('id') || '').trim();

  // Single-model detail — the bound model's full structure.
  if (id) {
    if (!isLoomContentId(id)) {
      return NextResponse.json({ ok: false, error: 'only Loom-native semantic models (loom:<id>) can be bound' }, { status: 400 });
    }
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    if (!item) return NextResponse.json({ ok: false, error: 'semantic model not found (or not owned by this tenant)' }, { status: 404 });
    const detail = semanticModelDetailFromContent(item);
    if (!detail) return NextResponse.json({ ok: false, error: 'this item has no semantic-model content to bind' }, { status: 422 });
    const model = detailToLite(id, item.displayName, detail);
    return NextResponse.json({ ok: true, model });
  }

  // List — every tenant-owned Loom-native semantic model with its structure.
  try {
    const items = await listContentBackedItems('semantic-model', 'semantic-model', tenantId);
    const models: BoundModelLite[] = items.map((it) => {
      const detail = semanticModelDetailFromContent(it);
      const full = detailToLite(`${LOOM_ID_PREFIX}${it.id}`, it.displayName, detail);
      return { id: full.id, name: full.name, tables: full.tables };
    });
    try { console.info(`[rayfin-app/models.GET] receipt: ${JSON.stringify({ ok: true, count: models.length }).slice(0, 200)}`); } catch { /* noop */ }
    return NextResponse.json({ ok: true, models });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), models: [] as BoundModelLite[] }, { status: 200 });
  }
}
