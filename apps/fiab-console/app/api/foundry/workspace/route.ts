/** GET /api/foundry/workspace — hub workspace info + identity. */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getWorkspaceInfo, FoundryError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const workspace = await getWorkspaceInfo();
    if (!workspace) return NextResponse.json({ ok: false, error: 'workspace not found', status: 404 }, { status: 404 });
    return NextResponse.json({ ok: true, workspace });
  } catch (e: any) {
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
