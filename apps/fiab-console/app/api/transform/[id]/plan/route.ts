/**
 * POST /api/transform/[id]/plan
 *
 * Build a transformation plan — the Terraform-style preview. **Writes nothing**
 * to the warehouse.
 *
 * body { environment?, project?, previousManifest?, previousCatalog? }
 *   → { ok, impact: PlanImpact, engine, log }
 *
 * Backend selector (state.project.backend, DEFAULT 'dbt'):
 *   • sqlmesh — the real SQLMesh plan: per-snapshot BREAKING / NON_BREAKING /
 *     FORWARD_ONLY / INDIRECT_* categorization, indirect downstream, column
 *     maps, and the intervals apply would backfill.
 *   • dbt — the real state comparison: compile the project and diff the fresh
 *     `target/manifest.json` against the deployed-state manifest (the
 *     `dbt ls --select state:modified` mechanism), with `catalog.json` columns.
 *
 * Both land in ONE normalized impact grid (lib/transform/plan-impact.ts).
 * The previewed plan is recorded to loom-transform-plans + the audit trail.
 */

import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withBackendGate, withWorkspaceOwner, type OwnerContext } from '@/lib/api/route-toolkit';
import { parsePlanPayload } from '@/lib/transform/plan-impact';
import { recordPlan } from '@/lib/transform/transform-plan-store';
import { runnerPlan } from '@/lib/transform/transform-runner-client';
import { isResponse, resolveTransformContext, TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withWorkspaceOwner(TRANSFORM_ITEM_TYPE,
  withBackendGate<OwnerContext<{ id: string }>>('svc-transform-runner', async (req, { session, item }) => {
    const body = await req.json().catch(() => ({}));
    const ctx = resolveTransformContext(item, body);
    if (isResponse(ctx)) return ctx;
    try {
      const res = await runnerPlan({
        files: ctx.files,
        backend: ctx.backend,
        environment: ctx.environment,
        env: ctx.env,
        // dbt only: the deployed-state artifacts the plan diffs against. The
        // wizard passes what the last apply returned; absent → first-plan case,
        // which the parser reports honestly via `noDeployedState`.
        previousManifest: (body as { previousManifest?: unknown }).previousManifest,
        previousCatalog: (body as { previousCatalog?: unknown }).previousCatalog,
      });
      if (!res.ok) {
        return apiError(res.error || res.log || 'plan failed', 502, {
          code: 'plan_failed', engine: ctx.backend, log: res.log,
        });
      }
      const impact = parsePlanPayload(res, ctx.backend, ctx.environment);
      await recordPlan(session, ctx.itemId, ctx.backend, impact);
      return apiOk({
        engine: ctx.backend,
        environment: ctx.environment,
        impact,
        log: res.log || '',
        // dbt has no manifest state store — hand the artifacts back so the next
        // plan can diff against THIS compile without a server-side cache.
        ...(res.manifest ? { manifest: res.manifest } : {}),
        ...(res.catalog ? { catalog: res.catalog } : {}),
      });
    } catch (e) {
      return apiServerError(e, 'transformation plan failed', 'plan_error');
    }
  }),
);
