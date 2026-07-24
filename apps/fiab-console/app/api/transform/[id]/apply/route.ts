/**
 * POST /api/transform/[id]/apply
 *
 * Apply a previously-previewed plan.
 *   • sqlmesh — builds the plan and applies it: the virtual-environment VIEW
 *     SWAP plus any backfill the plan listed. A dev environment becomes a set of
 *     views over the shared physical tables — no full rebuild.
 *   • dbt — dbt has no view-swap apply, so applying IS `dbt deps` + `dbt build`
 *     over the project (stated plainly in the response `note`, never disguised).
 *
 * body { environment?, project?, confirmProd? }
 *   → { ok, engine, impact, applied, log }
 *
 * Applying to a PROD environment requires `confirmProd: true` — the wizard's
 * explicit second confirmation. The apply + its outcome are recorded to
 * loom-transform-plans AND the `_auditLog` trail (privileged mutation).
 */

import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withBackendGate, withWorkspaceOwner, type OwnerContext } from '@/lib/api/route-toolkit';
import { parsePlanPayload } from '@/lib/transform/plan-impact';
import { recordApply } from '@/lib/transform/transform-plan-store';
import { runnerApply } from '@/lib/transform/transform-runner-client';
import { defaultDbtCommands } from '@/lib/transform/transform-codegen';
import { isResponse, resolveTransformContext, TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withWorkspaceOwner(TRANSFORM_ITEM_TYPE,
  withBackendGate<OwnerContext<{ id: string }>>('svc-transform-runner', async (req, { session, item }) => {
    const body = await req.json().catch(() => ({}));
    const ctx = resolveTransformContext(item, body);
    if (isResponse(ctx)) return ctx;

    const target = (ctx.project.environments || []).find((e) => e.name === ctx.environment);
    const isProd = !!target?.isProd || ctx.environment === 'prod';
    if (isProd && (body as { confirmProd?: unknown }).confirmProd !== true) {
      return apiError(
        `Applying to "${ctx.environment}" changes production. Re-send with confirmProd: true (the wizard's second confirmation step).`,
        409,
        { code: 'prod_confirmation_required', environment: ctx.environment },
      );
    }

    try {
      const res = await runnerApply({
        files: ctx.files,
        backend: ctx.backend,
        environment: ctx.environment,
        env: ctx.env,
        commands: ctx.backend === 'dbt' ? defaultDbtCommands() : [],
      });
      const impact = parsePlanPayload(res, ctx.backend, ctx.environment);
      await recordApply(session, ctx.itemId, ctx.backend, impact, {
        ok: !!res.ok, log: res.log,
      });
      if (!res.ok) {
        return apiError(res.error || res.log || 'apply failed', 502, {
          code: 'apply_failed', engine: ctx.backend, log: res.log,
        });
      }
      return apiOk({
        engine: ctx.backend,
        environment: ctx.environment,
        applied: true,
        impact,
        results: res.results,
        log: res.log || '',
        ...(res.manifest ? { manifest: res.manifest } : {}),
        ...(res.catalog ? { catalog: res.catalog } : {}),
        ...(ctx.backend === 'dbt'
          ? { note: 'dbt has no virtual-environment view swap: applying a dbt plan runs `dbt deps` + `dbt build`, materializing the modified models and their downstream. Switch the project backend to SQLMesh for view-swap environments.' }
          : {}),
      });
    } catch (e) {
      return apiServerError(e, 'transformation apply failed', 'apply_error');
    }
  }),
);
