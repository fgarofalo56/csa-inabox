/**
 * /api/copilot/skills
 *
 *   GET  — the caller's tenant skill catalog (seeded MS + Power BI built-ins ∪
 *          tenant custom skills), each decorated with the CALLER's effective
 *          on/off toggle state so the Skills Studio renders the real switch
 *          position. Optional `?pane=<slug>` also returns the RESOLVED active-set
 *          ids for that pane (the Studio "Sandbox" affordance).
 *   POST — create a tenant-scoped custom skill (form-driven body; NO raw JSON
 *          config). Tenant is taken from session.claims.tid; author from .oid.
 *
 * Real backend per no-vaporware.md: every read/write hits the Cosmos-backed
 * skill store (copilot-skills / copilot-skill-states). No mock arrays. The
 * session's oid/tid are threaded into the store so custom skills + user toggles
 * are owner/tenant-scoped (satisfies check-route-guards.mjs). Azure-native
 * (no-fabric-dependency.md): Cosmos via LOOM_COSMOS_ENDPOINT; no Fabric host.
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { listSkillsForUser, createCustomSkill } from '@/lib/azure/skill-store';
import { resolveActiveSkills } from '@/lib/copilot/skill-registry-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || undefined;
  try {
    const skills = await listSkillsForUser(tid, oid);
    const pane = req.nextUrl.searchParams.get('pane');
    if (pane) {
      // Sandbox: which skills are ACTIVE for THIS user on the requested pane —
      // computed from the SAME resolve policy the orchestrator uses (effective
      // toggle = userOverride ?? tenant default). Build the userState map from
      // the decorated list so the resolver sees the caller's real overrides.
      const userState: Record<string, boolean> = {};
      for (const s of skills) {
        if (s.userOverride !== null && s.userOverride !== undefined) userState[s.id] = s.userOverride;
      }
      const active = resolveActiveSkills(skills, pane, userState).map((s) => s.id);
      return apiOk({ skills, active, pane });
    }
    return apiOk({ skills });
  } catch (e) {
    return apiServerError(e, 'failed to list skills', 'skill_list_failed');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const oid = session.claims.oid || session.claims.upn || session.claims.email || 'unknown';
  const tid = session.claims.tid || oid; // fall back to oid for single-operator bootstrap
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body → validation error below */ }
  try {
    const skill = await createCustomSkill(tid, oid, {
      name: body.name as string,
      whenToUse: body.whenToUse as string,
      guidance: body.guidance as string,
      panes: body.panes as string[],
      toolNames: body.toolNames as string[] | undefined,
      mcpToolPrefix: body.mcpToolPrefix as string | undefined,
      category: body.category as string | undefined,
      tags: body.tags as string[] | undefined,
    });
    return apiOk({ skill }, { status: 201 });
  } catch (e: any) {
    if (e?.name === 'SkillStoreError') return apiError(e.message, e.status ?? 400, { code: e.code });
    return apiServerError(e, 'failed to create skill', 'skill_create_failed');
  }
}
