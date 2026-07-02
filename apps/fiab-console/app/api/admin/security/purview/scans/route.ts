/**
 * /api/admin/security/purview/scans
 *
 * GET ?source=<sourceName>           → list scans for a registered source
 * GET ?source=<n>&scan=<n>&runs=1    → list last 10 runs for a scan
 * POST { source, scan }              → trigger a run
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { listScansForSource, listScanRuns, triggerScanRun } from '@/lib/azure/purview-client';
import { prewarmPurviewShirForScan } from '@/lib/azure/shir-autoscale';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  const source = req.nextUrl.searchParams.get('source');
  const scan = req.nextUrl.searchParams.get('scan');
  const runs = req.nextUrl.searchParams.get('runs') === '1';
  if (!source) return NextResponse.json({ ok: false, error: 'source query param required' }, { status: 400 });
  try {
    if (runs) {
      if (!scan) return NextResponse.json({ ok: false, error: 'scan required when runs=1' }, { status: 400 });
      const runsList = await listScanRuns(source, scan);
      return NextResponse.json({ ok: true, runs: runsList });
    }
    const scans = await listScansForSource(source);
    return NextResponse.json({ ok: true, scans });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.source || !body?.scan) {
    return NextResponse.json({ ok: false, error: 'source and scan are required' }, { status: 400 });
  }
  try {
    // Scale the shared Purview SHIR VMSS up first if this scan runs on a
    // SelfHosted IR (fail-open — never blocks the scan).
    const shir = await prewarmPurviewShirForScan(body.source, body.scan);
    const result = await triggerScanRun(body.source, body.scan);
    return NextResponse.json({ ok: true, ...result, ...(shir || {}) }, { status: 202 });
  } catch (e) { return handleSecurityError(e); }
}
