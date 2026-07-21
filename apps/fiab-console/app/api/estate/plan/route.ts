/**
 * POST /api/estate/plan — WS-8.1 NL-to-Full-Estate (dry-run).
 *
 * Body: { prompt: string, workspaceId?: string }
 * Returns: { ok, plan, diff, validation }
 *
 * Turns ONE natural-language prompt into a reviewable estate plan-model — a DAG
 * of REAL Weave bridge calls — WITHOUT creating anything. The planner is routed
 * to the reasoning tier (WS-1.1). This is the dry-run + diff half of the
 * dry-run → approve → apply flow; the approve half is POST /api/estate/execute.
 *
 * Honest gate (no-vaporware): when no Azure OpenAI model is deployed the planner
 * throws NoAoaiDeploymentError and we return a 503 with the exact remediation.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { planEstateFromPrompt } from '@/lib/estate/estate-planner';
import { planDiff, validatePlan } from '@/lib/estate/estate-plan-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
  if (!prompt) return apiError('A prompt describing the estate to build is required.', 400);

  try {
    const cfg = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    const plan = await planEstateFromPrompt(prompt, { cfg, workspaceId });
    const validation = validatePlan(plan);
    const diff = planDiff(plan);
    return apiOk({ plan, diff, validation });
  } catch (e: unknown) {
    if (e instanceof NoAoaiDeploymentError) {
      return apiError(
        'The estate planner needs an Azure OpenAI reasoning model. Deploy one and set LOOM_AOAI_STRONG_DEPLOYMENT (Admin → Copilot & Agents → Model tiers).',
        503,
        { code: 'no_aoai_deployment' },
      );
    }
    return apiServerError(e, 'Failed to plan the estate', 'estate_plan_error');
  }
}
