/** GET /api/foundry/keys — primary/secondary keys + regional endpoint URLs. */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getAccountKeys, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const { account, keys } = await getAccountKeys(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, keys });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
