/**
 * GET  /api/items/paginated-report/[id]/definition?workspaceId=...
 *   — load the Loom-native RDL authoring document for this report.
 * PUT  /api/items/paginated-report/[id]/definition
 *   body: RdlReportDefinition — upsert the authoring document.
 *
 * Azure-native (Cosmos `paginated-report-definitions`, PK /workspaceId). No
 * Microsoft Fabric / Power BI workspace required — authoring works fully with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. See no-fabric-dependency.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRdlDefinition,
  upsertRdlDefinition,
  emptyRdlDefinition,
  type RdlReportDefinition,
} from '@/lib/azure/paginated-report-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = await ctx.params;
  try {
    const existing = await getRdlDefinition(workspaceId, id);
    // Return a seeded blank definition (not persisted yet) so the editor always
    // has a valid document to bind to — first Save persists it.
    const definition = existing ?? emptyRdlDefinition(workspaceId, id, '');
    return NextResponse.json({ ok: true, definition, isNew: !existing });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let body: Partial<RdlReportDefinition>;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json body' }, { status: 400 }); }
  if (!body?.workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  // Server forces the document id to the path id so a client can never write a
  // report definition under a different report's id within the partition.
  const now = new Date().toISOString();
  const doc: RdlReportDefinition = {
    id,
    workspaceId: body.workspaceId,
    name: (body.name || 'Untitled paginated report').slice(0, 200),
    description: body.description,
    pageOrientation: body.pageOrientation === 'Landscape' ? 'Landscape' : 'Portrait',
    pageSize: body.pageSize === 'A4' || body.pageSize === 'Legal' ? body.pageSize : 'Letter',
    dataSources: Array.isArray(body.dataSources) ? body.dataSources : [],
    datasets: Array.isArray(body.datasets) ? body.datasets : [],
    tablixes: Array.isArray(body.tablixes) ? body.tablixes : [],
    parameters: Array.isArray(body.parameters) ? body.parameters : [],
    createdBy: body.createdBy || session.claims.upn || session.claims.email || session.claims.oid,
    createdAt: body.createdAt || now,
    updatedAt: now,
  };
  try {
    const saved = await upsertRdlDefinition(doc);
    return NextResponse.json({ ok: true, definition: saved });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
