/**
 * GET /api/items/dataflow/config
 *   Reports the active Dataflow Gen2 backend + whether the Azure-native ADF
 *   path is configured. Lets the editor pick the right Run wiring without a
 *   NEXT_PUBLIC_ env var. Default backend is 'adf' (no Fabric required).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { adfConfigGate } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const backend = process.env.LOOM_DATAFLOW_BACKEND || 'adf';
  const adfGate = adfConfigGate();
  const adlsConfigured = !!(
    process.env.LOOM_BRONZE_URL ||
    process.env.LOOM_SILVER_URL ||
    process.env.LOOM_GOLD_URL ||
    process.env.LOOM_LANDING_URL ||
    process.env.LOOM_ADLS_ACCOUNT
  );
  return NextResponse.json({
    ok: true,
    backend,
    adfConfigured: !adfGate,
    adfMissing: adfGate?.missing || null,
    adlsConfigured,
    fabricWorkspaceBound: !!process.env.LOOM_DEFAULT_FABRIC_WORKSPACE,
  });
}
