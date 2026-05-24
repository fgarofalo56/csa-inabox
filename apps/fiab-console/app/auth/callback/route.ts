/**
 * MSAL redirect target. Exchanges the auth code for an id_token +
 * access_token, decodes claims, and stores them in the encrypted
 * loom_session cookie. On error, bounces to /?auth_error=<reason>.
 *
 * v1.13: cookie now attached to the redirect response directly
 * (Next.js route-handler quirk — see lib/auth/session.ts) so the
 * Set-Cookie header actually reaches the browser.
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
  const aadError = url.searchParams.get('error');
  if (aadError) {
    console.error('[auth/callback] AAD returned error', aadError, url.searchParams.get('error_description'));
    return NextResponse.redirect(`${origin(req)}/?auth_error=aad_${aadError}`);
  }
  if (!code) {
    return NextResponse.redirect(`${origin(req)}/?auth_error=missing_code`);
  }
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
    return NextResponse.redirect(`${origin(req)}/?auth_error=not_configured`);
  }
  if (!process.env.AZURE_CLIENT_SECRET) {
    console.error('[auth/callback] AZURE_CLIENT_SECRET missing');
    return NextResponse.redirect(`${origin(req)}/?auth_error=no_client_secret`);
  }
  if (!process.env.SESSION_SECRET) {
    console.error('[auth/callback] SESSION_SECRET missing');
    return NextResponse.redirect(`${origin(req)}/?auth_error=no_session_secret`);
  }
  try {
    const client = getMsalClient();
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: `${origin(req)}/auth/callback`,
    });
    if (!result?.account || !result.accessToken) {
      console.error('[auth/callback] no account or accessToken in MSAL response');
      return NextResponse.redirect(`${origin(req)}/?auth_error=no_token`);
    }
    const account = result.account;
    const claims: UserClaims = {
      oid: account.homeAccountId.split('.')[0],
      name: account.name ?? account.username,
      email: account.username,
      upn: account.username,
    };
    const response = NextResponse.redirect(`${origin(req)}/`);
    setSession(
      {
        oboAssertion: result.accessToken,
        claims,
        exp: Math.floor((result.expiresOn?.getTime() ?? Date.now() + 3600_000) / 1000),
      },
      response,
    );
    console.log('[auth/callback] session set for', claims.upn);
    return response;
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown';
    console.error('[auth/callback] exception during token exchange:', msg);
    return NextResponse.redirect(`${origin(req)}/?auth_error=exchange_failed&detail=${encodeURIComponent(msg.slice(0, 80))}`);
  }
}
