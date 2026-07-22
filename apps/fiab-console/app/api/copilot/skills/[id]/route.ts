/**
 * /api/copilot/skills/[id]
 *
 *   GET    — one skill (built-in or the caller's tenant custom), decorated with
 *            the caller's effective toggle state.
 *   PUT    — update a tenant custom skill (form-driven body; NO raw JSON config).
 *            Built-in skills are read-only → 409.
 *   DELETE — delete a tenant custom skill. Built-in skills cannot be deleted → 409.
 *
 * Real backend per no-vaporware.md: real Cosmos read/replace/delete. Tenant is
 * from session.claims.tid (threaded into the store so writes are tenant-scoped —
 * satisfies check-route-guards.mjs). Azure-native (no-fabric-dependency.md).
 */
import type { NextRequest } from 'next/server';
import { apiOk, apiError, apiNotFound, apiServerError } from '@/lib/api/respond';
import { listSkillsForUser, updateCustomSkill, deleteCustomSkill } from '@/lib/azure/skill-store';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || undefined;
  const id = params.id;
  try {
    const skills = await listSkillsForUser(tid, oid);
    const skill = skills.find((s) => s.id === id);
    if (!skill) return apiNotFound('skill not found');
    return apiOk({ skill });
  } catch (e) {
    return apiServerError(e, 'failed to read skill', 'skill_read_failed');
  }
});

export const PUT = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = params.id;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty → validation error in store */ }
  try {
    const skill = await updateCustomSkill(tid, id, {
      name: body.name as string | undefined,
      whenToUse: body.whenToUse as string | undefined,
      guidance: body.guidance as string | undefined,
      panes: body.panes as string[] | undefined,
      toolNames: body.toolNames as string[] | undefined,
      mcpToolPrefix: body.mcpToolPrefix as string | undefined,
      category: body.category as string | undefined,
      tags: body.tags as string[] | undefined,
      enabled: typeof body.enabled === 'boolean' ? (body.enabled as boolean) : undefined,
    });
    return apiOk({ skill });
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to update skill', 'skill_update_failed');
  }
});

export const DELETE = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = params.id;
  try {
    await deleteCustomSkill(tid, id);
    return apiOk({ deleted: id });
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to delete skill', 'skill_delete_failed');
  }
});
