/**
 * POST /api/copilot/skills/[id]/duplicate
 *
 * Duplicate any skill (built-in or custom) into a new EDITABLE tenant-scoped
 * custom skill (name suffixed " (copy)"). Lets a tenant customize a read-only
 * built-in without mutating it.
 *
 * Real backend per no-vaporware.md: real Cosmos read of the source + create of
 * the copy. Tenant from session.claims.tid, author from .oid (threaded into the
 * store so the copy is tenant/owner-scoped — satisfies check-route-guards.mjs).
 * Azure-native (no-fabric-dependency.md).
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { duplicateSkill } from '@/lib/azure/skill-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = (await ctx.params).id;
  try {
    const skill = await duplicateSkill(tid, oid, id);
    return apiOk({ skill }, { status: 201 });
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to duplicate skill', 'skill_duplicate_failed');
  }
}
