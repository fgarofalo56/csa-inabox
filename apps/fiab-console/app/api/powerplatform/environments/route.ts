/**
 * GET /api/powerplatform/environments — list Power Platform environments
 *   (BAP admin API; surfaces all envs the UAMI SP can see).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listEnvironments, PowerPlatformError } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const environments = await listEnvironments();
    return NextResponse.json({ ok: true, environments });
  } catch (e: any) { return err(e); }
}
