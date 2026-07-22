/**
 * PUT /api/admin/runtime-flags/[id] — flip one registered runtime kill-switch.
 *   body: { enabled: boolean }
 *   → { ok, flag: { id, enabled, updatedAt, updatedBy } }
 *
 * FLAG0. HARD admin gate (requireTenantAdmin) — a flip reverts a user-visible
 * surface deployment-wide. Only ids in the typed RUNTIME_FLAGS registry are
 * toggleable (404 otherwise). EVERY flip writes the authoritative `_auditLog`
 * row (actor who/oid, prior/new, ts) inside setRuntimeFlag and fans out via
 * emitAuditEvent (SIEM + webhooks). No revision roll — the flag takes effect
 * on the next read (in-process cache invalidated; replicas converge ≤15 s).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { isRegisteredFlag, setRuntimeFlag } from '@/lib/admin/runtime-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiUnauthorized();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!isRegisteredFlag(id)) {
    return apiNotFound(`'${id}' is not a registered runtime flag`);
  }
  const body = await req.json().catch(() => ({}));
  if (typeof body?.enabled !== 'boolean') {
    return apiError('body must be { enabled: boolean }', 400);
  }

  try {
    const who = s.claims.upn || s.claims.email || s.claims.oid;
    const flag = await setRuntimeFlag(id, body.enabled, {
      oid: s.claims.oid,
      who,
      tenantId: s.claims.tid || s.claims.oid,
    });
    return apiOk({ flag });
  } catch (e) {
    return apiServerError(
      e,
      'Could not write the runtime flag — Cosmos DB is required. Set LOOM_COSMOS_ENDPOINT and grant the Console UAMI "Cosmos DB Built-in Data Contributor".',
    );
  }
}
