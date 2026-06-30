/**
 * POST /api/governance/govern/trigger-scan — Protect, secure, comply sub-tab.
 *
 * Body: { source: string; scan: string }
 * Proxies to the classic Purview Data Map scan plane (triggerScanRun) — a REAL
 * async scan (HTTP 202 with a runId). Verify in the Purview portal under
 * Data Map → Sources → Scans → Scan runs.
 *
 * GET ?sources=1 — list registered Purview data sources (for the dropdown).
 * GET ?source=<name> — list the scans defined on a source.
 *
 * Admin-gated (F2). Purview unset → 503 `purview_not_configured` + hint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listDataSources, listScansForSource, triggerScanRun } from '@/lib/azure/purview-client';
import { prewarmPurviewShirForScan } from '@/lib/azure/shir-autoscale';
import { handleSecurityError } from '@/app/api/admin/security/_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminGate() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden', code: 'admin_only' },
      { status: 403 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = adminGate();
  if (denied) return denied;
  const source = req.nextUrl.searchParams.get('source');
  try {
    if (source) {
      const scans = await listScansForSource(source);
      return NextResponse.json({ ok: true, scans });
    }
    const sources = await listDataSources();
    return NextResponse.json({ ok: true, sources });
  } catch (e) {
    return handleSecurityError(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = adminGate();
  if (denied) return denied;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.source || !body?.scan) {
    return NextResponse.json({ ok: false, error: 'source and scan are required' }, { status: 400 });
  }
  try {
    // Scale the shared Purview SHIR VMSS up first if this scan runs on a
    // SelfHosted IR (fail-open — never blocks the scan).
    const shir = await prewarmPurviewShirForScan(String(body.source), String(body.scan));
    const result = await triggerScanRun(String(body.source), String(body.scan));
    return NextResponse.json({ ok: true, ...result, ...(shir || {}) }, { status: 202 });
  } catch (e) {
    return handleSecurityError(e);
  }
}
