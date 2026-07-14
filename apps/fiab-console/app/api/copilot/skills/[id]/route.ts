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
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { listSkillsForUser, updateCustomSkill, deleteCustomSkill } from '@/lib/azure/skill-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || undefined;
  const id = (await ctx.params).id;
  try {
    const skills = await listSkillsForUser(tid, oid);
    const skill = skills.find((s) => s.id === id);
    if (!skill) return apiNotFound('skill not found');
    return apiOk({ skill });
  } catch (e) {
    return apiServerError(e, 'failed to read skill', 'skill_read_failed');
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = (await ctx.params).id;
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
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid;
  const id = (await ctx.params).id;
  try {
    await deleteCustomSkill(tid, id);
    return apiOk({ deleted: id });
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to delete skill', 'skill_delete_failed');
  }
}
