/**
 * POST /api/items/synapse-dedicated-sql-pool/[id]/resume
 * Fire-and-poll resume. Returns 202 immediately, then UI polls /state.
 * Idempotent if pool already Online or already Resuming.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPoolState, resumePool } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  try {
    const current = await getPoolState();
    if (current.state === 'Online') {
      return NextResponse.json({ ok: true, state: 'Online', alreadyOnline: true });
    }
    if (current.state === 'Resuming') {
      return NextResponse.json({ ok: true, state: 'Resuming', alreadyResuming: true }, { status: 202 });
    }
    await resumePool();
    return NextResponse.json({ ok: true, state: 'Resuming' }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
