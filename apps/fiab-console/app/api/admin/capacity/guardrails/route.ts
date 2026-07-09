/**
 * FGC-25 — Capacity surge protection policy API.
 *
 * GET  /api/admin/capacity/guardrails — the tenant's surge-protection policy
 *      (auto-seeds the default-ON doc on first call).
 * PUT  /api/admin/capacity/guardrails — body: partial CapacityGuardrails.
 *      Sanitized + clamped, persisted, and audit-logged.
 *
 * Tenant-admin gated (requireTenantAdmin): this administers an ORG-WIDE cost
 * guardrail that rejects jobs across every workspace, so it must never be
 * per-user self-scoped. Real Cosmos persistence — no mocks.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiUnauthorized } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { tenantScopeId } from '@/lib/auth/session';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  loadGuardrails,
  saveGuardrails,
  sanitizeGuardrails,
  ENGINE_FAMILIES,
  ENGINE_LABELS,
  type CapacityGuardrails,
} from '@/lib/azure/capacity-guardrails';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Static metadata so the UI can render the per-engine grid without hardcoding. */
const engines = ENGINE_FAMILIES.map((id) => ({ id, label: ENGINE_LABELS[id] }));

export async function GET() {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const policy = await loadGuardrails(tenantScopeId(s));
    return apiOk({ policy, engines });
  } catch (e) {
    return apiServerError(e, 'Failed to load surge-protection policy');
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Partial<CapacityGuardrails> | null;
  if (!body || typeof body !== 'object') return apiError('request body required', 400);

  try {
    const tenantId = tenantScopeId(s);
    const current = await loadGuardrails(tenantId);
    const next = sanitizeGuardrails(body, current);
    next.updatedBy = s.claims.upn || s.claims.oid;
    const saved = await saveGuardrails(next);

    // Audit the policy change (per no-vaporware — every admin mutation is logged).
    emitAuditEvent({
      actorOid: s.claims.oid,
      actorUpn: s.claims.upn || s.claims.oid,
      action: 'capacity.surge-protection.update',
      targetType: 'capacity-guardrails',
      targetId: tenantId,
      tenantId,
      detail: {
        enabled: saved.enabled,
        rejectionThresholdPct: saved.rejectionThresholdPct,
        workspaceCuCapPerHour: saved.workspaceCuCapPerHour,
        perEngine: saved.perEngine,
      },
    });

    return apiOk({ policy: saved, engines });
  } catch (e) {
    return apiServerError(e, 'Failed to save surge-protection policy');
  }
}
