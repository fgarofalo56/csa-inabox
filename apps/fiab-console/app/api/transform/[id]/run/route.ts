/**
 * POST /api/transform/[id]/run
 *
 * Materialize the project on its cadence.
 *   • sqlmesh — `sqlmesh run <environment>`: executes whatever the environment's
 *     model crons say is due (no plan, no schema change).
 *   • dbt — the command list the wizard's checkbox picker produced (validated
 *     against the runner's allow-list; no freeform command string).
 *
 * body { environment?, project?, commands? } → { ok, engine, results, log }
 *
 * dbt runs return `target/manifest.json` + `target/catalog.json` VERBATIM, which
 * is exactly what the existing L6 dbt manifest-lineage parser
 * (lib/dbt/dbt-manifest-lineage.ts) consumes — so column/model lineage flows
 * into the Weave thread-edge graph with NO change to that parser.
 */

import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withBackendGate, withWorkspaceOwner, type OwnerContext } from '@/lib/api/route-toolkit';
import { emitDbtManifestLineage } from '@/lib/dbt/dbt-runner';
import { parseManifestJson } from '@/lib/dbt/dbt-manifest-lineage';
import { defaultDbtCommands } from '@/lib/transform/transform-codegen';
import { runnerRun } from '@/lib/transform/transform-runner-client';
import { isResponse, resolveTransformContext, TRANSFORM_ITEM_TYPE } from '../../_lib/project-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The canonical dbt commands the wizard's picker offers (no freeform input). */
const ALLOWED_DBT_COMMANDS = new Set([
  'dbt deps', 'dbt seed', 'dbt run', 'dbt build', 'dbt test',
  'dbt snapshot', 'dbt compile', 'dbt docs generate', 'dbt parse',
]);

export const POST = withWorkspaceOwner(TRANSFORM_ITEM_TYPE,
  withBackendGate<OwnerContext<{ id: string }>>('svc-transform-runner', async (req, { session, item }) => {
    const body = await req.json().catch(() => ({}));
    const ctx = resolveTransformContext(item, body);
    if (isResponse(ctx)) return ctx;

    const requested = Array.isArray((body as { commands?: unknown }).commands)
      ? ((body as { commands: unknown[] }).commands).map((c) => String(c).trim()).filter(Boolean)
      : [];
    const rejected = requested.filter((c) => !ALLOWED_DBT_COMMANDS.has(c));
    if (rejected.length) {
      return apiError(
        `Unsupported dbt command(s): ${rejected.join(', ')}. Pick from the command list in the Run step.`,
        400,
        { code: 'unsupported_command' },
      );
    }

    try {
      const res = await runnerRun({
        files: ctx.files,
        backend: ctx.backend,
        environment: ctx.environment,
        env: ctx.env,
        commands: ctx.backend === 'dbt' ? (requested.length ? requested : defaultDbtCommands()) : [],
      });
      // L6 lineage emit — the runner returns the dbt artifacts inline (the ODBC
      // path is synchronous), so the manifest is available right here. Uses the
      // SAME parser + emitter L6 already ships; N4 does not fork it.
      if (res.ok && ctx.backend === 'dbt') {
        const manifest = parseManifestJson(res.manifest);
        if (manifest) await emitDbtManifestLineage(session, manifest);
      }
      if (!res.ok) {
        return apiError(res.error || res.log || 'run failed', 502, {
          code: 'run_failed', engine: ctx.backend, log: res.log, results: res.results,
        });
      }
      return apiOk({
        engine: ctx.backend,
        environment: ctx.environment,
        results: res.results || [],
        log: res.log || '',
        ...(res.manifest ? { manifest: res.manifest } : {}),
        ...(res.catalog ? { catalog: res.catalog } : {}),
      });
    } catch (e) {
      return apiServerError(e, 'transformation run failed', 'run_error');
    }
  }),
);
