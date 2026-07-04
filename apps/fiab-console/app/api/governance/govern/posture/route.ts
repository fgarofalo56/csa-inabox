/**
 * GET /api/governance/govern/posture — Govern → Admin view (F2) metric feed.
 *
 * Returns the full posture aggregate for the three sub-tabs (Manage estate /
 * Protect, secure, comply / Discover, trust, reuse) plus the Log Analytics
 * feature-usage rows and any per-metric honest gates.
 *
 * Read path:
 *   1. FAST — a fresh (< 5 min) pre-computed `posture:${tenantId}` doc written
 *      by the posture-refresh Azure Function.
 *   2. LIVE — recompute inline from Cosmos + Graph + Monitor + Purview.
 *
 * Admin-gated (F2): only tenant admins (LOOM_TENANT_ADMIN_OID /
 * LOOM_TENANT_ADMIN_GROUP_ID) may read the estate-wide posture. Non-admins get
 * a 403 with the bootstrap remediation.
 *
 * Honest gate: LOOM_COSMOS_ENDPOINT unset → 503 `posture_not_configured` with a
 * structured hint. Individual metric sources (MIP / DLP / Purview / Log
 * Analytics) degrade to a `gates[...]` entry while the rest of the tiles render.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  computePosture,
  readPostureDoc,
  PostureNotConfiguredError,
} from '@/lib/azure/posture-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        code: 'admin_only',
        reason: 'The Govern Admin view exposes estate-wide posture and is restricted to tenant admins.',
        remediation:
          'Set LOOM_TENANT_ADMIN_OID to your user OID (or add yourself to LOOM_TENANT_ADMIN_GROUP_ID) — both are deploy params wired into the Console app env.',
      },
      { status: 403 },
    );
  }

  const tenantId = s.claims.oid;

  try {
    // Always compute live so the feature-usage rows + per-metric gates are
    // current. The pre-computed `posture-aggregates` doc (written by the
    // posture-refresh Function) is surfaced via `precomputedAt` so the UI can
    // show whether the background refresh is healthy, without masking the live
    // gate hints behind a possibly-stale snapshot.
    const result = await computePosture(tenantId);
    const cached = await readPostureDoc(tenantId).catch(() => null);
    return NextResponse.json({ ok: true, ...result, precomputedAt: cached?.updatedAt ?? null });
  } catch (e) {
    if (e instanceof PostureNotConfiguredError) {
      return NextResponse.json(
        { ok: false, error: e.message, code: 'posture_not_configured', hint: e.hint },
        { status: 503 },
      );
    }
    return apiServerError(e, 'internal error', 'unexpected');
  }
}
