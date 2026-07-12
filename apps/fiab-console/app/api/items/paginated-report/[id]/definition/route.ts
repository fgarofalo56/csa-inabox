/**
 * GET  /api/items/paginated-report/[id]/definition?workspaceId=...
 * PUT  /api/items/paginated-report/[id]/definition   body: RdlReportDefinition
 *
 * The Loom-native paginated-report (RDL) definition store. The report is a
 * STRUCTURED document — data sources, datasets, tablixes, parameters, page
 * setup — persisted in the Cosmos `paginated-report-definitions` container
 * (PK /workspaceId), NOT raw RDL XML (loom-no-freeform-config). This is the
 * Azure-native DEFAULT: no Microsoft Fabric / Power BI workspace required.
 *
 * GET returns `{ ok, definition }`. When no definition has been saved yet
 * (a freshly-created item) it seeds and returns a blank, valid definition so
 * the designer opens on an authorable canvas instead of crashing. PUT validates
 * the structured document and upserts it, returning the persisted `definition`.
 *
 * The designer (paginated-report-editor.tsx) and the /export route both speak
 * this exact structured model (`RdlReportDefinition`) — this route was
 * previously stuck on an older raw-RDL-XML shape, which broke both load
 * (`j.definition` was undefined) and save (`rdl is required`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import {
  getRdlDefinition,
  upsertRdlDefinition,
  emptyRdlDefinition,
  type RdlReportDefinition,
} from '@/lib/azure/paginated-report-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DEF_BYTES = 4 * 1024 * 1024; // 4 MB — well above any real structured report

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { id } = await ctx.params;
    // Authz + name + workspace resolution: confirm the caller's tenant owns the
    // item's workspace. The query-string workspaceId is a hint; the item is the
    // source of truth for the partition key.
    const item = await loadKustoItem(id, 'paginated-report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const workspaceId = item.workspaceId;

    let definition = await getRdlDefinition(workspaceId, id);
    if (!definition) {
      // No saved definition yet — seed a blank, valid one so the designer opens
      // on an authorable canvas. It is persisted on first Save, not here (GET
      // stays read-only).
      definition = emptyRdlDefinition(workspaceId, id, item.displayName);
    }
    return NextResponse.json({ ok: true, definition });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { id } = await ctx.params;
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf-8') > MAX_DEF_BYTES) {
      return NextResponse.json({ ok: false, error: 'report definition exceeds 4 MB limit' }, { status: 413 });
    }
    let def: RdlReportDefinition;
    try {
      def = JSON.parse(raw) as RdlReportDefinition;
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 });
    }
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      return NextResponse.json({ ok: false, error: 'report definition object is required' }, { status: 400 });
    }

    // Authz + workspace resolution: the caller's tenant must own the item's
    // workspace. The item's workspaceId is authoritative — never trust the
    // partition key from the client body.
    const item = await loadKustoItem(id, 'paginated-report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    // Normalize identity so a client cannot re-point the document at a different
    // id/workspace, and coerce the required collection fields to arrays.
    const normalized: RdlReportDefinition = {
      ...def,
      id,
      workspaceId: item.workspaceId,
      name: (typeof def.name === 'string' && def.name.trim()) || item.displayName || 'Untitled paginated report',
      pageOrientation: def.pageOrientation === 'Landscape' ? 'Landscape' : 'Portrait',
      pageSize: (['A4', 'Letter', 'Legal'] as const).includes(def.pageSize) ? def.pageSize : 'Letter',
      dataSources: Array.isArray(def.dataSources) ? def.dataSources : [],
      datasets: Array.isArray(def.datasets) ? def.datasets : [],
      tablixes: Array.isArray(def.tablixes) ? def.tablixes : [],
      parameters: Array.isArray(def.parameters) ? def.parameters : [],
      createdAt: typeof def.createdAt === 'string' && def.createdAt ? def.createdAt : new Date().toISOString(),
      createdBy: def.createdBy ?? session.claims.oid,
      updatedAt: new Date().toISOString(),
    };

    const saved = await upsertRdlDefinition(normalized);
    return NextResponse.json({ ok: true, definition: saved });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
