/**
 * GET /api/governance/dlp/schemas
 *
 * Enumerate user schemas in the env-bound Synapse dedicated SQL pool so the DLP
 * restrict-access wizard can offer a schema dropdown (no free-text schema, per
 * loom-no-freeform-config). Returns an honest config-gate when the Azure-native
 * warehouse is not configured (LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWarehouseSchemas } from '@/lib/azure/access-policy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const res = await listWarehouseSchemas();
    if ('gate' in res) {
      return NextResponse.json({ ok: false, code: 'warehouse_not_configured', error: res.gate }, { status: 503 });
    }
    return NextResponse.json({ ok: true, schemas: res.schemas });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: (e?.message || String(e)).slice(0, 400) }, { status: 502 });
  }
}
