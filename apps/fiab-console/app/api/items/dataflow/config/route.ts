/**
 * GET /api/items/dataflow/config
 *   Reports whether the Azure-native ADF path is configured. Lets the editor
 *   pick the right Run wiring without a NEXT_PUBLIC_ env var. The only backend
 *   is ADF (no Fabric required).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { adfConfigGate } from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
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
    backend: 'adf',
    adfConfigured: !adfGate,
    adfMissing: adfGate?.missing || null,
    adlsConfigured,
  });
}
