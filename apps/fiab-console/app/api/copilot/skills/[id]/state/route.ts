/**
 * PATCH /api/copilot/skills/[id]/state
 *
 * Toggle a skill on/off for the CURRENT user (per-user override that wins over
 * the tenant default). Body: { enabled: boolean }. Applies to BOTH built-in and
 * custom skills — a built-in skill is read-only for CRUD but freely toggled per
 * user. Optional { scope: 'tenant' } lets a TENANT ADMIN flip the tenant DEFAULT
 * instead (honest admin gate) — the per-user override still wins at resolve time.
 *
 * Real backend per no-vaporware.md: real Cosmos upsert into copilot-skill-states.
 * The caller's oid/tid are threaded into the store so the write is scoped to the
 * caller's own state doc (user:<oid>) — satisfies check-route-guards.mjs.
 * Azure-native (no-fabric-dependency.md).
 */
import type { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { setUserSkillState, setTenantSkillDefault } from '@/lib/azure/skill-store';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = params.id;
  let body: { enabled?: unknown; scope?: unknown } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  if (typeof body.enabled !== 'boolean') {
    return apiError('enabled (boolean) is required', 400);
  }
  const enabled = body.enabled;
  try {
    // Tenant-DEFAULT flip — admin only (org-wide default state).
    if (body.scope === 'tenant') {
      const gate = requireTenantAdmin(session);
      if (gate) return gate;
      const states = await setTenantSkillDefault(tid, id, enabled);
      return apiOk({ scope: 'tenant', id, enabled, states });
    }
    // Default: per-user override for the caller.
    const states = await setUserSkillState(oid, id, enabled);
    return apiOk({ scope: 'user', id, enabled, states });
  } catch (e) {
    return apiServerError(e, 'failed to update skill state', 'skill_state_failed');
  }
});
