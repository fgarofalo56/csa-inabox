/**
 * GET /api/governance/purview/status
 *
 * Single source of truth for "is Microsoft Purview wired in this deployment?"
 * Every governance / unified-catalog surface calls this (via usePurviewStatus)
 * to decide whether to render the live experience or the honest infra gate.
 *
 * Response (always 200 — the *body* carries the state so the client renders a
 * MessageBar rather than treating it as an error):
 *   {
 *     ok: true,
 *     configured: boolean,
 *     account: string | null,
 *     reason: 'live' | 'not_configured' | 'role_missing' | 'upstream_error',
 *     message?: string,
 *     hint?: { missingEnvVar, bicepModule, bicepStatus, rolesRequired[], followUp },
 *     purviewPortal: string
 *   }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { probePurview } from '@/lib/azure/purview-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PURVIEW_PORTAL = 'https://purview.microsoft.com/';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const probe = await probePurview();
  return NextResponse.json({
    ok: true,
    configured: probe.configured,
    account: probe.account,
    reason: probe.reason,
    message: probe.message,
    hint: probe.hint,
    // The data-plane base URL that was actually probed (cloud-correct:
    // *.purview.azure.us in Azure Government) + how it was derived
    // ('arm' = ARM properties.endpoints, 'env' = LOOM_PURVIEW_ENDPOINT,
    // 'convention' = cloud-aware {account}.purview.azure.{us|com} fallback).
    endpoint: probe.endpoint,
    endpointSource: probe.endpointSource,
    purviewPortal: PURVIEW_PORTAL,
  });
}
