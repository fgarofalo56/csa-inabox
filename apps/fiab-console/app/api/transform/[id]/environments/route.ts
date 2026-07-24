/**
 * POST /api/transform/[id]/environments
 *
 * List the project's REAL virtual data environments.
 *   • sqlmesh — read straight out of the SQLMesh state store (name, plan id,
 *     expiry, model count). This is the capability dbt does not have: an
 *     environment is a set of views over shared physical tables.
 *   • dbt — returns `[]` plus an honest note. dbt has targets, not virtual
 *     environments; the wizard says so rather than inventing rows.
 *
 * POST (not GET) because the runner needs the generated project files to open
 * the state store — the environment list is derived from the project, not from
 * a Loom-side table.
 *
 * body { project? } → { ok, engine, environments, declared, note? }
 */

import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withBackendGate, withWorkspaceOwner, type OwnerContext } from '@/lib/api/route-toolkit';
import { runnerEnvironments } from '@/lib/transform/transform-runner-client';
import { isResponse, resolveTransformContext, TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withWorkspaceOwner(TRANSFORM_ITEM_TYPE,
  withBackendGate<OwnerContext<{ id: string }>>('svc-transform-runner', async (req, { item }) => {
    const body = await req.json().catch(() => ({}));
    const ctx = resolveTransformContext(item, body);
    if (isResponse(ctx)) return ctx;
    try {
      const res = await runnerEnvironments({
        files: ctx.files,
        backend: ctx.backend,
        environment: ctx.environment,
        env: ctx.env,
      });
      if (!res.ok) {
        return apiError(res.error || res.log || 'environment list failed', 502, {
          code: 'environments_failed', engine: ctx.backend,
        });
      }
      return apiOk({
        engine: ctx.backend,
        // The environments the engine ACTUALLY has …
        environments: Array.isArray(res.environments) ? res.environments : [],
        // … alongside the ones the project declares, so the wizard's picker can
        // offer a not-yet-materialized environment (planning creates it).
        declared: ctx.project.environments || [],
        ...(res.note ? { note: res.note } : {}),
      });
    } catch (e) {
      return apiServerError(e, 'environment list failed', 'environments_error');
    }
  }),
);
