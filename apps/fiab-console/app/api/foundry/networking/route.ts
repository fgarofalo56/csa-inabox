/**
 * GET   /api/foundry/networking — public-access state, network ACLs, private endpoints.
 * PATCH /api/foundry/networking — toggle public network access. body: { publicAccess: boolean }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getNetworking,
  setPublicNetworkAccess,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { account, networking } = await getNetworking(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, networking });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (typeof body?.publicAccess !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'publicAccess (boolean) required' }, { status: 400 });
    }
    const networking = await setPublicNetworkAccess(body.publicAccess, selectorFromBody(body));
    return NextResponse.json({ ok: true, networking });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
