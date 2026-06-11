/**
 * GET /api/admin/dspm-ai?days=30 — DSPM for AI posture report.
 *
 * The Azure-native 1:1 of Microsoft Purview DSPM for AI → "Apps and agents":
 * an admin security report of which AI agents / Copilots touch sensitive-labeled
 * data, how much they're used, and whether the most-sensitive data is protected.
 *
 * Admin-gated (F2): only tenant admins may read estate-wide AI posture. Non-admins
 * get a 403 with the bootstrap remediation.
 *
 * Honest gate: LOOM_COSMOS_ENDPOINT unset → 503 `dspm_ai_not_configured` with a
 * structured hint. Individual sources (MIP label ordering / Log Analytics usage)
 * degrade to a `gates[...]` entry while the label-exposure report still renders.
 *
 * Shape:
 *   { ok:true, agents, summary, gates }                — report computed
 *   { ok:false, error, code:'admin_only', remediation } — non-admin (403)
 *   { ok:false, error, code:'dspm_ai_not_configured', hint } — Cosmos unset (503)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { computeDspmAiPosture, DspmAiNotConfiguredError } from '@/lib/azure/dspm-ai-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        code: 'admin_only',
        reason: 'The DSPM for AI report exposes estate-wide agent label exposure and is restricted to tenant admins.',
        remediation:
          'Set LOOM_TENANT_ADMIN_OID to your user OID (or add yourself to LOOM_TENANT_ADMIN_GROUP_ID) — both are deploy params wired into the Console app env.',
      },
      { status: 403 },
    );
  }

  const days = Math.max(1, Math.min(90, Number(req.nextUrl.searchParams.get('days') || '30') || 30));

  try {
    const result = await computeDspmAiPosture(s.claims.oid, days);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof DspmAiNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: e.message, code: 'dspm_ai_not_configured', hint: e.hint },
        { status: 503 },
      );
    }
    const msg = (e as any)?.message || String(e);
    return NextResponse.json({ ok: false, error: msg, code: 'unexpected' }, { status: 500 });
  }
}
