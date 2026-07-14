/**
 * POST /api/copilot/skills/suggested/[id]
 *
 * CTS-11 — act on a learner-drafted SUGGESTED skill (tenant-admin only):
 *   { action: 'promote' }            → publish the suggestion as a tenant custom
 *                                       skill (scope tenant:<tid>) + remove it
 *                                       from the queue.
 *   { action: 'promote', edits:{…} } → publish an EDITED version (the admin's
 *                                       form edits are applied over the draft
 *                                       before publishing).
 *   { action: 'dismiss' }            → delete the suggestion from the queue.
 *
 * ADMIN-ONLY: gated by requireTenantAdmin (a suggestion becomes an org-wide,
 * default-ON skill on promote, so this must be an admin decision). Real backend
 * per no-vaporware.md: promote/dismiss hit the Cosmos-backed skill store. Edits
 * are form-shaped fields (NO raw JSON config, per loom_no_freeform_config) and
 * are re-validated by the store's custom-skill validator. Azure-native (no Fabric).
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  promoteSuggestedSkill,
  dismissSuggestedSkill,
  type CustomSkillInput,
} from '@/lib/azure/skill-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Coerce the (form-shaped) edits payload — never a raw JSON blob. */
function coerceEdits(raw: unknown): Partial<CustomSkillInput> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const out: Partial<CustomSkillInput> = {};
  if (typeof e.name === 'string') out.name = e.name;
  if (typeof e.whenToUse === 'string') out.whenToUse = e.whenToUse;
  if (typeof e.guidance === 'string') out.guidance = e.guidance;
  if (Array.isArray(e.panes)) out.panes = (e.panes as unknown[]).map((p) => String(p));
  if (Array.isArray(e.toolNames)) out.toolNames = (e.toolNames as unknown[]).map((t) => String(t));
  if (Array.isArray(e.tags)) out.tags = (e.tags as unknown[]).map((t) => String(t));
  if (typeof e.mcpToolPrefix === 'string') out.mcpToolPrefix = e.mcpToolPrefix;
  if (typeof e.category === 'string') out.category = e.category;
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const tid = session!.claims.tid || session!.claims.oid;
  const oid = session!.claims.oid || session!.claims.upn || session!.claims.email || 'unknown';
  const { id } = await ctx.params;
  if (!id) return apiError('id required', 400);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body → invalid action below */ }
  const action = String(body?.action ?? '').trim();

  try {
    if (action === 'promote') {
      const edits = coerceEdits(body?.edits);
      const skill = await promoteSuggestedSkill(tid, id, oid, edits);
      return apiOk({ promoted: true, skill });
    }
    if (action === 'dismiss') {
      await dismissSuggestedSkill(tid, id);
      return apiOk({ dismissed: true });
    }
    return apiError("action must be 'promote' or 'dismiss'", 400);
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to act on suggested skill', 'suggested_action_failed');
  }
}
