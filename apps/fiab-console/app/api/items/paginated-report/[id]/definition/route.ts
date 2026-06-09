/**
 * GET  /api/items/paginated-report/[id]/definition
 * PUT  /api/items/paginated-report/[id]/definition   body: { rdl: string }
 *
 * The Loom-native RDL definition store for a paginated-report item. The RDL XML
 * is persisted on the item's Cosmos `state.rdlXml` — this is the Azure-native
 * report definition source (no Fabric / Power BI workspace required). GET
 * returns the stored RDL plus its parsed parameter schema; PUT validates the
 * uploaded RDL parses as a <Report> and saves it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import { parseRdlMetadata, RdlRenderError } from '@/lib/azure/rdl-parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_RDL_BYTES = 4 * 1024 * 1024; // 4 MB — well above any real .rdl

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { id } = await ctx.params;
    const item = await loadKustoItem(id, 'paginated-report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const rdl = typeof item.state?.rdlXml === 'string' ? item.state.rdlXml : '';
    if (!rdl) {
      return NextResponse.json({ ok: true, hasDefinition: false, rdl: '', params: [], reportName: item.displayName });
    }
    const meta = parseRdlMetadata(rdl);
    return NextResponse.json({
      ok: true, hasDefinition: true, rdl,
      params: meta.params, datasetCount: meta.datasetCount, reportName: item.displayName,
    });
  } catch (e: any) {
    if (e instanceof RdlRenderError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const rdl = typeof body?.rdl === 'string' ? body.rdl : '';
    if (!rdl.trim()) return NextResponse.json({ ok: false, error: 'rdl is required' }, { status: 400 });
    if (Buffer.byteLength(rdl, 'utf-8') > MAX_RDL_BYTES) {
      return NextResponse.json({ ok: false, error: 'RDL exceeds 4 MB limit' }, { status: 413 });
    }
    // Validate it parses to a <Report> before persisting (no junk in the store).
    const meta = parseRdlMetadata(rdl);

    const item = await loadKustoItem(id, 'paginated-report', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    await saveItemState(item, { rdlXml: rdl });
    return NextResponse.json({ ok: true, params: meta.params, datasetCount: meta.datasetCount });
  } catch (e: any) {
    if (e instanceof RdlRenderError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
