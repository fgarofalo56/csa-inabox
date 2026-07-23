/**
 * N13 — GET/POST /api/admin/copilot-quality/prompts/[promptId]
 *
 *   GET  → one prompt + every semver'd version (newest first) with its REAL
 *          copilot-evaluator score, floor verdict, and approval record.
 *   POST → one of four actions, all real Cosmos mutations, all audited:
 *            { action:'publish',  template, bump?|version?, notes? }
 *              — creates the next semver AND requests a run from the EXISTING
 *                E2 copilot-evaluator Function (the same HTTP trigger E5's
 *                "Run now" and the E4 workflow use). NO second harness, NO
 *                second CI gate: the run lands as an ordinary `eval-run` doc
 *                that the EXISTING check-eval-regression.mjs floor gate grades.
 *            { action:'refresh-score' , version }
 *              — stamps the surface's newest REAL eval run onto the version.
 *            { action:'approve', version, note?, overrideBelowFloor? }
 *              — AUDITED ({kind:'llmops.prompt.approve'}); refuses a version
 *                with no score, or one below its E3 floor without an override.
 *            { action:'rollback', version, reason? }
 *              — AUDITED; restores an earlier APPROVED version.
 *
 * Tenant-admin only. Azure-native, no Fabric dependency.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiBadRequest, apiError, apiServerError } from '@/lib/api/respond';
import { tenantScopeId } from '@/lib/auth/session';
import {
  approveVersion,
  attachLatestEvalScore,
  getPrompt,
  publishVersion,
  rollbackTo,
} from '@/lib/copilot/prompt-registry';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (_req: NextRequest, { params }) => {
  try {
    const promptId = String((params as { promptId?: string }).promptId || '').trim();
    if (!promptId) return apiBadRequest('promptId required');
    const loaded = await getPrompt(promptId);
    if (!loaded) return apiError(`Prompt "${promptId}" is not registered.`, 404);
    return apiOk({ prompt: loaded.prompt, versions: loaded.versions });
  } catch (e) {
    return apiServerError(e, 'failed to load the prompt', 'prompt_registry_get_failed');
  }
});

export const POST = withTenantAdmin(async (req: NextRequest, { params, session }) => {
  try {
    const promptId = String((params as { promptId?: string }).promptId || '').trim();
    if (!promptId) return apiBadRequest('promptId required');
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? '');
    const actor = {
      oid: session.claims.oid,
      who: session.claims.upn || session.claims.email || session.claims.name || session.claims.oid,
      tenantId: tenantScopeId(session),
    };

    if (action === 'publish') {
      const result = await publishVersion(
        promptId,
        {
          template: String(body.template ?? ''),
          bump: body.bump === 'major' || body.bump === 'patch' ? body.bump : 'minor',
          version: body.version ? String(body.version) : undefined,
          notes: body.notes ? String(body.notes) : undefined,
        },
        actor,
      );
      return apiOk({
        version: result.version,
        evalRequested: result.evalRequested,
        evalGate: result.evalGate,
        note: result.evalRequested
          ? 'Version published. An eval run was requested from the copilot-evaluator Function — refresh the score in a minute, then approve.'
          : 'Version published. No eval run was requested (see evalGate); it cannot be approved until a real score lands.',
      });
    }

    const version = String(body.version ?? '').trim();
    if (!version) return apiBadRequest('version required');

    if (action === 'refresh-score') {
      const score = await attachLatestEvalScore(promptId, version);
      return apiOk({
        score,
        note: score
          ? `Stamped run ${score.runId} (${score.surface}) onto ${version}.`
          : 'No eval runs exist for this prompt’s surface yet — run the evals, then refresh.',
      });
    }
    if (action === 'approve') {
      const result = await approveVersion(promptId, version, actor, {
        note: body.note ? String(body.note) : undefined,
        overrideBelowFloor: body.overrideBelowFloor === true,
      });
      return apiOk({ prompt: result.prompt, version: result.version, note: `Version ${version} approved and made active.` });
    }
    if (action === 'rollback') {
      const result = await rollbackTo(promptId, version, actor, {
        reason: body.reason ? String(body.reason) : undefined,
      });
      return apiOk({ prompt: result.prompt, version: result.version, note: `Rolled back to ${version}.` });
    }
    return apiBadRequest("action must be one of 'publish' | 'refresh-score' | 'approve' | 'rollback'");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string })?.code;
    // Governance refusals + validation errors are 409/400, never a 500 — the UI
    // shows the exact reason (no eval score yet / below floor / never approved).
    if (code === 'prompt_approval_no_eval' || code === 'prompt_approval_below_floor') {
      return apiError(msg, 409, { code });
    }
    if (/required|must be|already exists|already the active|not registered|not found|never approved|not a valid/i.test(msg)) {
      return apiError(msg, 400);
    }
    return apiServerError(e, 'prompt registry action failed', 'prompt_registry_action_failed');
  }
});
