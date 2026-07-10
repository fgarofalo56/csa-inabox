/**
 * Task-flow RUN — impure item launcher (F11 execution).
 *
 * Given a resolved Cosmos `WorkspaceItem`, this kicks off a REAL backend run by
 * REUSING the same server-side helpers the item's own `/run` route calls —
 * never a self-HTTP round-trip and never a reimplementation:
 *
 *   data-pipeline    → adf-client.runPipeline           (state.adfPipelineName)
 *   adf-pipeline     → adf-client.runPipeline           (pipeline-binding + factory override)
 *   synapse-pipeline → synapse-dev-client.runPipeline   (pipeline-binding)
 *   databricks-job   → databricks-client.runJob         (state.jobId)
 *   notebook         → databricks one-time run / Synapse Livy statement (attached compute)
 *
 * Each launch returns an opaque `poll()` closure that captures whatever context
 * (factory override, Livy pool/session, run id) is needed to check that ONE run
 * to a terminal state. The driver in the BFF route calls `poll()` on an interval
 * and advances the flow. All backends are Azure-native (no Fabric dependency).
 *
 * Honest failures: an item with no live backing (unpublished pipeline, unbound
 * job, computeless notebook) THROWS a precise, user-facing message — the driver
 * records it as that item's `failed` reason (per no-vaporware.md honest gates).
 */
import type { WorkspaceItem } from '@/lib/types/workspace';

export interface PollOutcome {
  terminal: boolean;
  ok: boolean;
  message?: string;
}

export interface LaunchedRun {
  runId: string;
  detail?: string;
  poll: () => Promise<PollOutcome>;
}

// --- terminal-status mappers (backend-specific) ---------------------------

/** ADF / Synapse pipeline run status → terminal + ok. */
function pipelineOutcome(status?: string): PollOutcome {
  const s = (status || '').toLowerCase();
  if (s === 'succeeded') return { terminal: true, ok: true };
  if (s === 'failed' || s === 'cancelled') return { terminal: true, ok: false, message: status };
  return { terminal: false, ok: false, message: status || 'InProgress' };
}

/** Databricks jobs run life-cycle → terminal + ok. */
function databricksOutcome(lifeCycle?: string, result?: string, msg?: string): PollOutcome {
  const lc = (lifeCycle || '').toUpperCase();
  const terminalStates = ['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR'];
  if (terminalStates.includes(lc)) {
    const ok = (result || '').toUpperCase() === 'SUCCESS';
    return { terminal: true, ok, message: ok ? undefined : (result || msg || lc) };
  }
  return { terminal: false, ok: false, message: lc || 'PENDING' };
}

/** Assemble a runnable code blob from a notebook item's persisted state. */
function assembleNotebookCode(state: Record<string, any>): string {
  const cellsFrom = (arr: any): string =>
    (Array.isArray(arr) ? arr : [])
      .filter((c) => c && c.type === 'code' && typeof c.source === 'string' && c.source.trim())
      .map((c) => c.source)
      .join('\n\n');
  const fromCells = cellsFrom(state.cells);
  const fromContent =
    state.content && state.content.kind === 'notebook' ? cellsFrom(state.content.cells) : '';
  return (typeof state.code === 'string' ? state.code : '') || fromCells || fromContent || '';
}

// --- per-type launchers ---------------------------------------------------

async function launchDataPipeline(item: WorkspaceItem): Promise<LaunchedRun> {
  const state = (item.state || {}) as Record<string, any>;
  const adfName =
    (typeof state.adfPipelineName === 'string' && state.adfPipelineName.trim()) ||
    (typeof state.pipelineName === 'string' && state.pipelineName.trim()) ||
    '';
  if (!adfName) {
    throw new Error(
      'Pipeline has no ADF backing yet — open it in the editor and Save/Publish its activities to Azure Data Factory, then run the flow.',
    );
  }
  const { runPipeline, listPipelineRuns } = await import('@/lib/azure/adf-client');
  const { prewarmShirForPipeline } = await import('@/lib/azure/shir-autoscale');
  await prewarmShirForPipeline(adfName).catch(() => undefined);
  const res = await runPipeline(adfName, {});
  const runId = res.runId;
  return {
    runId: `adf:${runId}`,
    detail: adfName,
    poll: async () => {
      const runs = await listPipelineRuns(adfName);
      const r = runs.find((x) => x.runId === runId);
      return pipelineOutcome(r?.status);
    },
  };
}

async function launchAdfPipeline(item: WorkspaceItem, oid: string): Promise<LaunchedRun> {
  const { resolveBinding, bindingFactoryOverride } = await import('@/lib/azure/pipeline-binding');
  const { withFactoryOverride } = await import('@/lib/azure/adf-factory-context');
  const { runPipeline, listPipelineRuns } = await import('@/lib/azure/adf-client');
  const { prewarmShirForPipeline } = await import('@/lib/azure/shir-autoscale');
  const binding = await resolveBinding(item.id, ['adf-pipeline', 'data-pipeline'], oid);
  const override = bindingFactoryOverride(binding);
  const name = binding.pipelineName;
  return withFactoryOverride(override, async () => {
    await prewarmShirForPipeline(name).catch(() => undefined);
    const res = await runPipeline(name, {});
    const runId = res.runId;
    return {
      runId: `adf:${runId}`,
      detail: name,
      poll: () =>
        withFactoryOverride(override, async () => {
          const runs = await listPipelineRuns(name);
          const r = runs.find((x) => x.runId === runId);
          return pipelineOutcome(r?.status);
        }),
    };
  });
}

async function launchSynapsePipeline(item: WorkspaceItem, oid: string): Promise<LaunchedRun> {
  const { resolveBinding } = await import('@/lib/azure/pipeline-binding');
  const { runPipeline, getPipelineRun } = await import('@/lib/azure/synapse-dev-client');
  const binding = await resolveBinding(item.id, ['synapse-pipeline', 'data-pipeline'], oid);
  const name = binding.pipelineName;
  const res = await runPipeline(name, {});
  const runId = res.runId;
  return {
    runId: `synapse:${runId}`,
    detail: name,
    poll: async () => {
      const r = await getPipelineRun(runId);
      return pipelineOutcome(r?.status);
    },
  };
}

async function launchDatabricksJob(item: WorkspaceItem): Promise<LaunchedRun> {
  const state = (item.state || {}) as Record<string, any>;
  const jobId = Number(state.jobId);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error(
      'This Databricks job is not bound to a real job id yet — open it in the editor and Save the job, then run the flow.',
    );
  }
  const { runJob, getJobRun } = await import('@/lib/azure/databricks-client');
  const r = await runJob(jobId);
  const runId = r.run_id;
  return {
    runId: `databricks:${runId}`,
    poll: async () => {
      const run = await getJobRun(runId);
      return databricksOutcome(run.state?.life_cycle_state, run.state?.result_state, run.state?.state_message);
    },
  };
}

async function launchNotebook(item: WorkspaceItem): Promise<LaunchedRun> {
  const state = (item.state || {}) as Record<string, any>;
  const { substituteNotebookPlaceholders } = await import('@/lib/apps/notebook-placeholders');
  const code = substituteNotebookPlaceholders(assembleNotebookCode(state));
  if (!code.trim()) {
    throw new Error('Notebook is empty — add code cells before running the flow.');
  }
  const dbxCluster =
    (typeof state.databricksClusterId === 'string' && state.databricksClusterId.trim()) ||
    (state.sparkSession && typeof state.sparkSession.clusterId === 'string' && state.sparkSession.clusterId.trim()) ||
    '';
  const sparkPool =
    (state.sparkSession && typeof state.sparkSession.pool === 'string' && state.sparkSession.pool.trim()) ||
    (typeof state.defaultSparkPool === 'string' && state.defaultSparkPool.trim()) ||
    (typeof state.sparkPool === 'string' && state.sparkPool.trim()) ||
    '';

  if (dbxCluster) {
    const { runOneTimeNotebook, getJobRun } = await import('@/lib/azure/databricks-client');
    const r = await runOneTimeNotebook({
      clusterId: dbxCluster,
      code,
      lang: 'PYTHON',
      jobName: `flow-${item.id.slice(0, 8)}`,
    });
    const runId = r.run_id;
    return {
      runId: `databricks:${runId}`,
      detail: r.run_page_url,
      poll: async () => {
        const run = await getJobRun(runId);
        return databricksOutcome(run.state?.life_cycle_state, run.state?.result_state, run.state?.state_message);
      },
    };
  }

  if (sparkPool) {
    const { createLivySessionAsync, submitLivyStatement, getLivyStatement, getLivySession } =
      await import('@/lib/azure/synapse-dev-client');
    const sess = await createLivySessionAsync(sparkPool, 'pyspark');
    // Lazy submit: the Spark pool may cold-start for minutes, and a statement
    // can't be submitted until the session is idle. The poll closure drives the
    // whole cold-start → submit → completion lifecycle so `launch` returns fast.
    let stmtId: number | null = null;
    let submitted = false;
    return {
      runId: `spark:${sparkPool}:${sess.id}`,
      detail: sparkPool,
      poll: async () => {
        if (!submitted) {
          const live = await getLivySession(sparkPool, sess.id);
          const st = (live.state || '').toLowerCase();
          if (st === 'dead' || st === 'error' || st === 'killed' || st === 'shutting_down') {
            return { terminal: true, ok: false, message: `Spark session ${st}` };
          }
          if (st !== 'idle') return { terminal: false, ok: false, message: `session ${live.state}` };
          const stmt = await submitLivyStatement(sparkPool, sess.id, { code, kind: 'pyspark' });
          stmtId = stmt.id;
          submitted = true;
          return { terminal: false, ok: false, message: 'running' };
        }
        if (stmtId === null) return { terminal: false, ok: false, message: 'running' };
        const stmt = await getLivyStatement(sparkPool, sess.id, stmtId);
        const st = (stmt.state || '').toLowerCase();
        if (st === 'available') {
          const outStatus = stmt.output?.status;
          if (outStatus === 'error') {
            return { terminal: true, ok: false, message: stmt.output?.ename || 'statement error' };
          }
          return { terminal: true, ok: true };
        }
        if (st === 'error' || st === 'cancelled' || st === 'cancelling') {
          return { terminal: true, ok: false, message: stmt.state };
        }
        return { terminal: false, ok: false, message: stmt.state };
      },
    };
  }

  throw new Error(
    'This notebook has no attached compute — open it, attach a Spark pool or Databricks cluster, then run the flow.',
  );
}

/**
 * Launch a real backend run for one runnable item. Throws an honest, user-facing
 * message when the item has no live backing. The caller (driver) must already
 * have owner-authorized the workspace + resolved the item.
 */
export async function launchItemRun(item: WorkspaceItem, oid: string): Promise<LaunchedRun> {
  switch (item.itemType) {
    case 'data-pipeline':
      return launchDataPipeline(item);
    case 'adf-pipeline':
      return launchAdfPipeline(item, oid);
    case 'synapse-pipeline':
      return launchSynapsePipeline(item, oid);
    case 'databricks-job':
      return launchDatabricksJob(item);
    case 'notebook':
      return launchNotebook(item);
    default:
      throw new Error(`Item type '${item.itemType}' cannot be run from a task flow.`);
  }
}
