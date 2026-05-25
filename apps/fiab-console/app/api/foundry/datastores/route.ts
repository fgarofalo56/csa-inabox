/** GET /api/foundry/datastores */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDatastores, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const datastores = await listDatastores();
    return NextResponse.json({ ok: true, datastores });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
