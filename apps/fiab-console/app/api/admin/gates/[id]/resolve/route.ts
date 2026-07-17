/**
 * POST /api/admin/gates/[id]/resolve — the gate Fix-it apply.
 *
 * Body: { values: Record<envVar, string> }. Every key MUST belong to the
 * gate's requiredSettings (or an anyOf alias group member) — anything else is
 * rejected 400 (no side-channel env writes; no-freeform-config). The apply
 * goes through the ONE shared runtime-config engine (lib/admin/env-apply.ts):
 * the same whitelist → ACA-revision / AKS-rolling-update → Cosmos
 * desired-state → audit + SIEM path as PUT /api/admin/env-config — never a
 * second write path (no-vaporware.md).
 *
 * Response is HONEST about latency: the values land as a NEW container
 * revision (~1–2 min); `resolvedNow` is false until the revision rolls, and
 * the UI shows the driftWarning + re-probes the gate after apply.
 *
 * Gated to tenant admins via the same 'admin.env-config' Admin capability +
 * PDP check the env-config PUT enforces.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { apiNotFound, apiError } from '@/lib/api/respond';
import { getGate, gateStatus } from '@/lib/gates/registry';
import { applyEnvChanges } from '@/lib/admin/env-apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  const capGate = await enforceCapability(session, 'admin.env-config', 'Admin');
  if (capGate) return capGate;
  const tenantId = session!.claims.oid;
  const blocked = await pdpCheck(session!, { level: 'domain', id: tenantId }, 'admin');
  if (blocked) return blocked;
  const who = session!.claims.upn || session!.claims.email || tenantId;

  const { id } = await ctx.params;
  const gate = getGate(id);
  if (!gate) return apiNotFound(`unknown gate id '${id}'`);

  const body = await req.json().catch(() => ({}));
  const incoming = body?.values;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return apiError('values (object of envVar→value) required', 400);
  }

  // Scope check: every submitted key must be one of THIS gate's settings (or a
  // member of one of its anyOf alias groups).
  const allowed = new Set<string>();
  for (const s of gate.requiredSettings) {
    allowed.add(s.envVar);
    for (const a of s.aliasOf || []) allowed.add(a);
  }
  const unknown = Object.keys(incoming).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return apiError(
      `key(s) not part of gate '${id}': ${unknown.join(', ')}. Allowed: ${Array.from(allowed).join(', ')}.`,
      400,
    );
  }

  const result = await applyEnvChanges({
    tenantId,
    tid: session!.claims.tid,
    who,
    actorOid: session!.claims.oid,
    values: incoming as Record<string, unknown>,
    action: 'gate.resolve',
    auditDetail: { gateId: id },
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, body: result.errorBody }, { status: result.status });
  }

  // Honest post-state: process.env still shows the OLD values until the new
  // revision rolls, so the live status stays 'blocked' until then — the UI
  // polls and re-probes rather than pretending it flipped instantly.
  const status = gateStatus(id);
  return NextResponse.json({
    ok: true,
    gateId: id,
    changedCount: result.changedCount,
    changed: result.changed,
    secretsChanged: result.secretsChanged,
    rejected: result.rejected,
    revision: result.revision,
    platform: result.platform,
    resolvedNow: status?.status === 'configured',
    statusAfterApply: status?.status ?? 'blocked',
    driftWarning: result.changedCount > 0 ? result.driftWarning : undefined,
    sync: result.sync,
    message: result.changedCount === 0
      ? (result.message || 'No changes to apply.')
      : `Applied ${result.changedCount} value(s) — a new revision is rolling (~1–2 min); the gate flips to configured once it is live.`,
  });
}
