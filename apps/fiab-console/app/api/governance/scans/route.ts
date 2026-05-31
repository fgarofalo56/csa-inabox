/**
 * /api/governance/scans — Microsoft Purview Data Map: sources, scans, runs.
 *
 * This is the BFF route the /governance/scans surface names. It mirrors the
 * Purview portal Data Map "Sources" + "Scans" experience against the real
 * Purview scan plane (`/scan/datasources/...`).
 *
 *   GET                                  → list registered data sources
 *   GET ?source=<name>                   → list scans defined on a source
 *   GET ?source=<name>&scan=<n>&runs=1   → list last 10 runs for a scan
 *   POST { name, kind, properties }      → register a new source
 *   POST { source, scan, run: true }     → trigger a scan run
 *   DELETE ?name=<source>                → de-register a source
 *
 * Purview-not-configured / cross-cloud → 503 with the structured hint (so the
 * surface renders the honest gate). 4xx/5xx from Purview propagate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDataSources, registerDataSource, deleteDataSource,
  listScansForSource, listScanRuns, triggerScanRun,
} from '@/lib/azure/purview-client';
import { handleSecurityError } from '@/app/api/admin/security/_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const source = req.nextUrl.searchParams.get('source');
  const scan = req.nextUrl.searchParams.get('scan');
  const runs = req.nextUrl.searchParams.get('runs') === '1';

  try {
    if (source && runs) {
      if (!scan) return NextResponse.json({ ok: false, error: 'scan required when runs=1' }, { status: 400 });
      const runsList = await listScanRuns(source, scan);
      return NextResponse.json({ ok: true, runs: runsList, source: 'purview-scan-api' });
    }
    if (source) {
      const scans = await listScansForSource(source);
      return NextResponse.json({ ok: true, scans, source: 'purview-scan-api' });
    }
    const sources = await listDataSources();
    return NextResponse.json({ ok: true, sources, source: 'purview-scan-api' });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }

  try {
    // Trigger a scan run: { source, scan, run: true }
    if (body?.run && body?.source && body?.scan) {
      const result = await triggerScanRun(body.source, body.scan);
      return NextResponse.json({ ok: true, ...result }, { status: 202 });
    }
    // Register a new source: { name, kind, properties }
    if (!body?.name || !body?.kind || !body?.properties) {
      return NextResponse.json({ ok: false, error: 'name, kind, and properties are required (or source+scan+run for a run)' }, { status: 400 });
    }
    const ds = await registerDataSource({ name: body.name, kind: body.kind, properties: body.properties });
    return NextResponse.json({ ok: true, source: ds }, { status: 201 });
  } catch (e) { return handleSecurityError(e); }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
    const deleted = await deleteDataSource(name);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) { return handleSecurityError(e); }
}
