/**
 * N5 — MATERIALIZE: dispatch an asset's REAL backing job.
 *
 * N5 owns no runner of its own. "Materialize" resolves the asset's materializer
 * binding and calls the client that ALREADY runs that engine for the rest of
 * the product:
 *
 *   sqlmesh / dbt     → lib/transform/transform-runner-client.runnerRun
 *                       (the loom-transform-runner Container App — the exact
 *                        call the N4 Plan/Apply wizard's Run step makes)
 *   synapse-pipeline  → lib/azure/synapse-dev-client.runPipeline
 *                       (Synapse Studio dev REST createRun)
 *   databricks-job    → lib/azure/databricks-client.runJob
 *                       (jobs/2.1 run-now, Entra token, no PAT)
 *
 * Every path is a REAL backend call (no-vaporware). An unbound or unconfigured
 * materializer returns an HONEST gate naming the exact env var / binding to set
 * — never a fabricated "queued" receipt.
 *
 * Both callers — the Materialize button and the asset-reconciler — go through
 * THIS function, so the run/failure watermarks the thrash guard depends on can
 * never diverge between the manual and automatic paths.
 *
 * Azure-native only: no Fabric / Power BI / Dagster host is reachable from any
 * branch. IL5: Synapse, Databricks and the transform runner are all in-boundary
 * services in the deployment's own VNet, so materialization runs air-gapped.
 */

import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { generateTransformProject, runnerEnv } from '@/lib/transform/transform-codegen';
import { runnerPlan, runnerRun, transformRunnerConfigGate } from '@/lib/transform/transform-runner-client';
import {
  resolveTransformBackend, validateTransformProject, type TransformProject,
} from '@/lib/transform/transform-project-model';
import { runPipeline, synapseConfigGate } from '@/lib/azure/synapse-dev-client';
import { runJob, databricksConfigGate } from '@/lib/azure/databricks-client';
import type { SessionPayload } from '@/lib/auth/session';
import type { AssetMaterializerBinding } from '@/lib/azure/asset-registry-model';

/** The outcome shape both the BFF and the reconciler record. */
export interface MaterializeResult {
  ok: boolean;
  /** Engine that actually ran. */
  engine: 'sqlmesh' | 'dbt' | 'synapse-pipeline' | 'databricks-job' | 'none';
  /** Backend run identifier (SQLMesh log id, ADF runId, Databricks run_id). */
  runId?: string;
  /** True when the failure is an honest CONFIG gate, not an engine failure. */
  gated?: boolean;
  /** The env var / binding an operator must set to clear a gate. */
  missing?: string;
  /** Human-readable outcome / engine log head. */
  detail: string;
}

function gate(engine: MaterializeResult['engine'], missing: string, detail: string): MaterializeResult {
  return { ok: false, engine, gated: true, missing, detail };
}

/**
 * Run the asset's backing job. `dryRun` builds the plan WITHOUT writing (used by
 * the canvas's preview affordance and by tests) — only the transform engines
 * support a true no-write preview, so the other engines report it honestly
 * rather than pretending.
 */
export async function materializeAsset(
  session: SessionPayload,
  binding: AssetMaterializerBinding,
  opts: { assetKey: string; dryRun?: boolean } = { assetKey: '' },
): Promise<MaterializeResult> {
  switch (binding.kind) {
    case 'sqlmesh':
    case 'dbt':
      return materializeTransform(session, binding, opts);
    case 'synapse-pipeline':
      return materializeSynapsePipeline(binding, opts);
    case 'databricks-job':
      return materializeDatabricksJob(binding, opts);
    default:
      return gate(
        'none',
        'materializer',
        'No materializer is bound to this asset. Open the asset inspector and bind a transformation project, a Synapse pipeline, or a Databricks job — Materialize runs that real job.',
      );
  }
}

async function materializeTransform(
  session: SessionPayload,
  binding: AssetMaterializerBinding,
  opts: { assetKey: string; dryRun?: boolean },
): Promise<MaterializeResult> {
  const engine = binding.kind === 'sqlmesh' ? 'sqlmesh' : 'dbt';
  if (!binding.itemId) {
    return gate(engine, 'materializer.itemId', 'The bound transformation project is missing. Re-bind the asset to a transformation-project item.');
  }
  const runnerGate = transformRunnerConfigGate();
  if (runnerGate) {
    return gate(
      engine,
      runnerGate.missing,
      `The transformation runner is not deployed in this environment (${runnerGate.missing} unset — svc-transform-runner). Authoring, the asset graph, and every freshness policy keep working; only the engine call is gated.`,
    );
  }

  // Ownership is re-checked here because the reconciler runs OUTSIDE a user
  // request: an asset can never materialize a project the caller cannot reach.
  const item = await loadOwnedItem(binding.itemId, 'transformation-project', session.claims.oid);
  if (!item) {
    return gate(engine, 'materializer.itemId', `The bound transformation project (${binding.itemId}) is not reachable for this principal.`);
  }
  const raw: unknown = item.state?.project;
  if (!raw || validateTransformProject(raw).length) {
    return gate(engine, 'materializer.itemId', 'The bound transformation project does not currently validate — open it and resolve the model errors before materializing.');
  }
  const project = raw as TransformProject;
  const backend = resolveTransformBackend({ project });
  const environment = binding.environment || project.defaultEnvironment || 'dev';
  const call = {
    files: generateTransformProject({ ...project, backend }),
    backend,
    environment,
    env: runnerEnv(project),
  };

  const res = opts.dryRun ? await runnerPlan(call) : await runnerRun(call);
  const log = String(res.log || res.error || '').slice(0, 2000);
  if (!res.ok) {
    return { ok: false, engine, detail: log || `${backend} ${opts.dryRun ? 'plan' : 'run'} failed (exit ${res.exitCode ?? 'unknown'}).` };
  }
  return {
    ok: true,
    engine,
    runId: `${backend}:${environment}:${new Date().toISOString()}`,
    detail: log || `${backend} ${opts.dryRun ? 'plan' : 'run'} completed against ${environment}.`,
  };
}

async function materializeSynapsePipeline(
  binding: AssetMaterializerBinding,
  opts: { assetKey: string; dryRun?: boolean },
): Promise<MaterializeResult> {
  if (!binding.pipelineName) {
    return gate('synapse-pipeline', 'materializer.pipelineName', 'No Synapse pipeline is bound to this asset.');
  }
  const g = synapseConfigGate();
  if (g) {
    return gate(
      'synapse-pipeline',
      g.missing,
      `Synapse is not configured in this deployment (${g.missing} unset). Set it in Admin → Environment configuration to let this asset materialize.`,
    );
  }
  if (opts.dryRun) {
    return {
      ok: false,
      engine: 'synapse-pipeline',
      detail: 'A Synapse pipeline has no no-write preview — use the pipeline editor\'s Debug run for a dry pass. Materialize triggers the real run.',
    };
  }
  const run = await runPipeline(binding.pipelineName, {});
  return {
    ok: true,
    engine: 'synapse-pipeline',
    runId: run.runId,
    detail: `Synapse pipeline ${binding.pipelineName} started (runId ${run.runId}).`,
  };
}

async function materializeDatabricksJob(
  binding: AssetMaterializerBinding,
  opts: { assetKey: string; dryRun?: boolean },
): Promise<MaterializeResult> {
  if (!binding.jobId) {
    return gate('databricks-job', 'materializer.jobId', 'No Databricks job is bound to this asset.');
  }
  const g = databricksConfigGate();
  if (g) {
    return gate(
      'databricks-job',
      g.missing,
      `Databricks is not configured in this deployment (${g.missing} unset). Set it in Admin → Environment configuration to let this asset materialize.`,
    );
  }
  if (opts.dryRun) {
    return {
      ok: false,
      engine: 'databricks-job',
      detail: 'A Databricks job has no no-write preview. Materialize triggers the real run-now.',
    };
  }
  const run = await runJob(binding.jobId, {
    // Idempotency token bounds a retry storm at the Databricks side too: the
    // SAME asset + minute can never enqueue two runs (thrash guard, defence 2).
    idempotency_token: `loom-asset-${opts.assetKey}-${new Date().toISOString().slice(0, 16)}`.slice(0, 64),
  });
  return {
    ok: true,
    engine: 'databricks-job',
    runId: String(run.run_id),
    detail: `Databricks job ${binding.jobId} started (run_id ${run.run_id}).`,
  };
}
