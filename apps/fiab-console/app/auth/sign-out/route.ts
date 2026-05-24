/**
 * Sign-out: clears the loom_session cookie and bounces home.
 * Also kicks off AAD federated sign-out so a different user can
 * sign in from the same browser without leaking the previous session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clearSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function origin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function logoutUrl(req: NextRequest): string {
  const tenantId = process.env.AZURE_TENANT_ID;
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  const base = cloud === 'azureusgovernment' ? 'https://login.microsoftonline.us' : 'https://login.microsoftonline.com';
  const post = encodeURIComponent(`${origin(req)}/`);
  if (!tenantId) return `${origin(req)}/`;
  return `${base}/${tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`;
}

export async function GET(req: NextRequest) {
  clearSession();
  return NextResponse.redirect(logoutUrl(req));
}

export const POST = GET;
