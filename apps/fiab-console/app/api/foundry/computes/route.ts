/** GET /api/foundry/computes */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listComputes, FoundryError } from '@/lib/azure/foundry-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const computes = await listComputes();
    // { ok, data, error } envelope per .claude/rules/no-vaporware.md. `computes`
    // kept as a back-compat alias for any older caller still reading it.
    return NextResponse.json({ ok: true, data: computes, computes });
  } catch (e: any) {
    if (e instanceof FoundryError && e.status === 403) {
      return NextResponse.json(computeRoleGate('list compute instances'), { status: 403 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
