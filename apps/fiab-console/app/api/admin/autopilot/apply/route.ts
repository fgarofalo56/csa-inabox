/**
 * WS-10.1 — POST /api/admin/autopilot/apply  (approve → self-executing FinOps rec)
 *
 * Approve and execute exactly ONE recommendation by id. Body:
 *   { recommendationId: string }
 *
 * This is the "self-executing FinOps recommendation on approval" acceptance
 * criterion: the approved recommendation actuates itself for real — pause idle
 * compute (ARM pause/stop) or roll the capacity ceiling env-config (ACA revision)
 * — even while the tenant is still in `propose` mode. Recomputes signals so the
 * approval acts on current state, records cooldown + history + audit.
 *
 * Tenant-admin + env-config capability gated. Real backends only (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { applyAutopilotRecommendationById } from '@/lib/admin/lcu-autopilot-loop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = getSession();
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;
  const tenantId = session!.claims.oid;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const recommendationId = typeof body?.recommendationId === 'string' ? body.recommendationId.trim() : '';
  if (!recommendationId) return apiError('recommendationId is required', 400);

  try {
    const result = await applyAutopilotRecommendationById({
      tenantId,
      tid: session!.claims.tid,
      who,
      actorOid: session!.claims.oid,
      recommendationId,
    });
    if (!result.ok) {
      return apiError(result.error || 'recommendation could not be applied', 409, {
        recommendation: result.recommendation,
        receipt: result.receipt,
      }) as NextResponse;
    }
    return apiOk({ receipt: result.receipt, recommendation: result.recommendation }) as NextResponse;
  } catch (e) {
    return apiServerError(e, 'Failed to apply the recommendation');
  }
}
