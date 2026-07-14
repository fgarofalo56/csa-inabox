/**
 * GET /api/copilot/skills/suggested
 *
 * CTS-11 — the tenant admin's review queue of learner-drafted SUGGESTED skills.
 * Each suggestion carries its drafted name/whenToUse/guidance + provenance (the
 * recurring keywords + sample count the usage pattern surfaced). Nothing here is
 * active in any Copilot turn — a suggestion is inert until an admin PROMOTES it
 * (POST /api/copilot/skills/suggested/[id]).
 *
 * ADMIN-ONLY: gated by requireTenantAdmin — a non-admin gets a 403, which the
 * Skills Studio uses to simply NOT render the Suggested section. Real backend per
 * no-vaporware.md: reads the Cosmos-backed skill store (scope `suggested:<tid>`);
 * no mock arrays. Azure-native (no Fabric host).
 */
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { listSuggestedSkills } from '@/lib/azure/skill-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;
  const tid = session!.claims.tid || session!.claims.oid;
  try {
    const suggested = await listSuggestedSkills(tid);
    return apiOk({ suggested });
  } catch (e) {
    return apiServerError(e, 'failed to list suggested skills', 'suggested_list_failed');
  }
}
