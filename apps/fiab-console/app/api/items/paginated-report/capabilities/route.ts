/**
 * GET /api/items/paginated-report/capabilities
 *   — reports whether the export renderer Function is wired in this deployment,
 *     so the designer can pre-disable the Export buttons (with the exact
 *     remediation tooltip) instead of letting the user click into a 503.
 *
 * Azure-native; no Microsoft Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { paginatedRenderGate } from '@/lib/azure/paginated-report-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = paginatedRenderGate();
  return NextResponse.json({
    ok: true,
    renderDeployed: !gate,
    renderGate: gate ? { missingEnvVar: gate.missingEnvVar, detail: gate.detail } : null,
  });
}
