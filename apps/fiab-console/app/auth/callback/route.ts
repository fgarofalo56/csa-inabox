/**
 * MSAL redirect target. Exchanges the auth code for an id_token +
 * access_token, decodes claims, and stores them in the encrypted
 * loom_session cookie. On error, bounces to /?auth_error=<reason>.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { setSession } from '@/lib/auth/session';
import type { UserClaims } from '@/lib/auth/msal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(`${origin(req)}/?auth_error=missing_code`);
  }
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
    return NextResponse.redirect(`${origin(req)}/?auth_error=not_configured`);
  }
  try {
    const client = getMsalClient();
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: `${origin(req)}/auth/callback`,
    });
    if (!result?.account || !result.accessToken) {
      return NextResponse.redirect(`${origin(req)}/?auth_error=no_token`);
    }
    const account = result.account;
    const claims: UserClaims = {
      oid: account.homeAccountId.split('.')[0],
      name: account.name ?? account.username,
      email: account.username,
      upn: account.username,
    };
    setSession({
      oboAssertion: result.accessToken,
      claims,
      exp: Math.floor((result.expiresOn?.getTime() ?? Date.now() + 3600_000) / 1000),
    });
    return NextResponse.redirect(`${origin(req)}/`);
  } catch (e) {
    console.error('[auth/callback]', e);
    return NextResponse.redirect(`${origin(req)}/?auth_error=exchange_failed`);
  }
}
