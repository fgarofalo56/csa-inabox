/**
 * GET  /api/items/compute — list compute instances + clusters on the hub
 * POST /api/items/compute — create { name, computeType, vmSize, minNodeCount?, maxNodeCount? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listComputes, createCompute, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const computes = await listComputes();
    return NextResponse.json({ ok: true, computes });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.name || !body?.computeType || !body?.vmSize) {
      return NextResponse.json({ ok: false, error: 'name, computeType, vmSize required' }, { status: 400 });
    }
    const compute = await createCompute(body.name, {
      computeType: body.computeType,
      vmSize: body.vmSize,
      minNodeCount: body.minNodeCount,
      maxNodeCount: body.maxNodeCount,
    });
    return NextResponse.json({ ok: true, compute });
  } catch (e: any) { return err(e); }
}
