/**
 * POST /api/transform/[id]/diff
 *
 * Column-level (and row-count) diff of ONE model between two environments —
 * SQLMesh `table_diff`. This is the "what actually changed in the data" view the
 * impact grid links to from a row.
 *
 * body { model, sourceEnvironment, targetEnvironment, project? }
 *   → { ok, diffs: TableDiffResult[] }
 *
 * dbt has no cross-environment table diff (it has no virtual environments), so
 * a dbt-backed project gets an honest 409 naming the exact remedy — switch the
 * project backend to SQLMesh — instead of a fabricated diff.
 */

import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withBackendGate, withWorkspaceOwner, type OwnerContext } from '@/lib/api/route-toolkit';
import { parseTableDiff } from '@/lib/transform/plan-impact';
import { runnerDiff } from '@/lib/transform/transform-runner-client';
import { isResponse, resolveTransformContext, TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withWorkspaceOwner(TRANSFORM_ITEM_TYPE,
  withBackendGate<OwnerContext<{ id: string }>>('svc-transform-runner', async (req, { item }) => {
    const body = await req.json().catch(() => ({}));
    const ctx = resolveTransformContext(item, body);
    if (isResponse(ctx)) return ctx;

    const b = body as { model?: unknown; sourceEnvironment?: unknown; targetEnvironment?: unknown };
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    if (!model) return apiError('model is required', 400);
    if (ctx.backend !== 'sqlmesh') {
      return apiError(
        'Cross-environment table diff needs virtual data environments, which dbt does not have. Switch this project\'s backend to SQLMesh (Settings → Engine) to compare a model between two environments.',
        409,
        { code: 'diff_requires_sqlmesh', engine: ctx.backend },
      );
    }
    const source = typeof b.sourceEnvironment === 'string' && b.sourceEnvironment.trim()
      ? b.sourceEnvironment.trim() : ctx.environment;
    const targetEnv = typeof b.targetEnvironment === 'string' && b.targetEnvironment.trim()
      ? b.targetEnvironment.trim() : 'prod';

    try {
      const res = await runnerDiff({
        files: ctx.files,
        backend: ctx.backend,
        env: ctx.env,
        model,
        sourceEnvironment: source,
        targetEnvironment: targetEnv,
      });
      if (!res.ok) {
        return apiError(res.error || res.log || 'table diff failed', 502, {
          code: 'diff_failed', engine: ctx.backend,
        });
      }
      return apiOk({
        engine: ctx.backend,
        model,
        sourceEnvironment: source,
        targetEnvironment: targetEnv,
        diffs: parseTableDiff(res),
      });
    } catch (e) {
      return apiServerError(e, 'table diff failed', 'diff_error');
    }
  }),
);
