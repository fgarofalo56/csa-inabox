/**
 * MSAL sign-in initiator. When AZURE_CLIENT_ID is configured the
 * confidential client builds an OAuth code URL and 302s the browser
 * to AAD. Until then we return 503 with a clear message so the
 * unblock action is obvious in the network tab.
 *
 * Wire-up steps live in docs/fiab/MSAL-handoff.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Base login scopes (Graph audience for the session) + the delegated Azure
// Service Management scope. Requesting ARM user_impersonation at consent time
// means that after callback we can silently obtain an ARM-audience token for
// the user and cache it (lib/azure/user-token-store) — enabling per-user RBAC
// in the cross-subscription resource picker. If this scope isn't admin-
// consented, AAD simply omits it and login still succeeds (MSAL won't fail the
// code exchange for the base scopes).
const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read', ARM_SCOPE];

function redirectUri(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/auth/callback`;
}

export async function GET(req: NextRequest) {
  if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_TENANT_ID) {
    return NextResponse.json(
      {
        status: 'msal-not-configured',
        unblock: 'See docs/fiab/MSAL-handoff.md for the az ad app create steps.',
      },
      { status: 503 },
    );
  }
  const client = getMsalClient();
  const url = await client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(req),
    prompt: 'select_account',
  });
  return NextResponse.redirect(url);
}
