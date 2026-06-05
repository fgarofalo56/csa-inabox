/**
 * Phase 2 — Databricks Job provisioner.
 *
 * Closes the silent-skip gap where itemType 'databricks-job' had NO
 * provisioner and fell to the Cosmos-only skipped path on deploy=true.
 *
 * This provisioner makes the bundled multi-task job REAL on the Databricks
 * workspace:
 *   1. Translate the bundle's { cluster, tasks[] } content into a Jobs 2.1
 *      JobSpec with ONE shared job cluster (job_clusters[]) and the chained
 *      notebook tasks (depends_on enforcing serial bronze → silver → gold).
 *      Idempotent: reuse the existing job by name (reset its settings) or
 *      create a new one (api/2.1/jobs/create | reset).
 *   2. Prove it's real by triggering run-now (api/2.1/jobs/run-now) and
 *      short-polling the run to surface its run id + life-cycle. Settle, don't
 *      block: the Spark job can run for minutes, so we poll only a few seconds
 *      to catch an instant auth/submit failure then return the live run id —
 *      keeping the install under the Front Door ~30s gateway window.
 *
 * Honest gates (per .claude/rules/no-vaporware.md): when LOOM_DATABRICKS_HOSTNAME
 * isn't set, or the Console UAMI lacks workspace access / job-run permission,
 * the item still installs to Cosmos and surfaces a precise remediation gate
 * naming the exact env var / role — the job is created on the next pass once
 * the gate is cleared. NO silent skip.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/databricks/jobs/automate
 *   https://learn.microsoft.com/azure/databricks/jobs/notebook
 *   https://learn.microsoft.com/azure/databricks/jobs/run-if   (depends_on)
 */
import {
  databricksConfigGate,
  listJobs,
  createJob,
  updateJob,
  runJob,
  getJobRun,
  mkdirsWorkspace,
  importNotebook,
  type JobSpec,
  type JobRun,
} from '@/lib/azure/databricks-client';
import { buildDatabricksSource } from './_seed-databricks';
import type { Provisioner, ProvisionResult } from './types';

const SHARED_CLUSTER_KEY = 'medallion_shared';

function isAuth(e: any): e is { status: number; message?: string } {
  return e && (e.status === 401 || e.status === 403);
}

/** Workspace-path-safe slug for a task name. */
function slug(s: string): string {
  return (s || 'task').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'task';
}

/**
 * Build a REAL, self-contained, idempotent Databricks SOURCE notebook for a job
 * task that ships only a `notebookPath` reference (the bundle's medallion tasks
 * point at /Workspace/Repos/csa-loom/medallion/* which is never imported — the
 * root cause of the "notebook missing/inaccessible" first-run failure). Prefer
 * an authored notebook when the bundle carries one (task.source string or
 * task.cells/task.content NotebookContent); otherwise generate a layer notebook
 * that creates its target schema and writes a small Delta table from in-notebook
 * seed rows, so the chained job runs end-to-end on the workspace cluster with no
 * external dependency on landing files. Params come from notebook_task.base_parameters
 * via widgets, so run-now / job parameters still override at run time.
 */
function taskNotebookSource(task: any, displayName: string): { source: string; generated: boolean } {
  // 1) Authored source string verbatim (ensure the SOURCE header is present).
  if (typeof task?.source === 'string' && task.source.trim()) {
    const src = task.source.startsWith('# Databricks notebook source')
      ? task.source
      : `# Databricks notebook source\n${task.source}`;
    return { source: src, generated: false };
  }
  // 2) Authored NotebookContent (cells) — reuse the shared serializer.
  const nbContent = task?.content || (Array.isArray(task?.cells) ? { cells: task.cells } : null);
  if (nbContent && Array.isArray(nbContent.cells) && nbContent.cells.length > 0) {
    return { source: buildDatabricksSource(nbContent), generated: false };
  }
  // 3) Generate a self-contained, idempotent layer notebook.
  const bp = (task?.config?.base_parameters && typeof task.config.base_parameters === 'object')
    ? task.config.base_parameters as Record<string, unknown>
    : {};
  const layer = slug(task?.name || 'layer').toLowerCase();
  const targetSchema = typeof bp.target_schema === 'string' ? bp.target_schema : layer;
  const runDate = typeof bp.run_date === 'string' ? bp.run_date : '2026-05-20';
  const desc = String(task?.config?.description || `${layer} layer transform`).replace(/`/g, "'");
  const table = `${layer}_medallion`;
  const source = [
    '# Databricks notebook source',
    `# MAGIC %md`,
    `# MAGIC ## ${displayName} — task: ${task?.name || layer}`,
    `# MAGIC ${desc}`,
    `# MAGIC`,
    `# MAGIC > Loom-provisioned, self-contained + idempotent. Writes a real Delta table for this`,
    `# MAGIC > layer so the chained job runs end-to-end on the workspace cluster without depending`,
    `# MAGIC > on external landing files. Override \`run_date\` / \`target_schema\` at run time via`,
    `# MAGIC > the job's notebook parameters.`,
    '',
    '# COMMAND ----------',
    '',
    `dbutils.widgets.text("run_date", "${runDate}")`,
    `dbutils.widgets.text("target_schema", "${targetSchema}")`,
    `run_date = dbutils.widgets.get("run_date")`,
    `target_schema = dbutils.widgets.get("target_schema")`,
    `print(f"task=${task?.name || layer} run_date={run_date} target_schema={target_schema}")`,
    '',
    '# COMMAND ----------',
    '',
    `spark.sql(f"CREATE SCHEMA IF NOT EXISTS {target_schema}")`,
    '',
    'from pyspark.sql import Row',
    'import datetime',
    `rows = [Row(id=i, layer="${layer}", run_date=run_date, metric=float(i * 100), loaded_at=datetime.datetime.utcnow().isoformat()) for i in range(1, 6)]`,
    'df = spark.createDataFrame(rows)',
    `table = f"{target_schema}.${table}"`,
    'df.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(table)',
    `print(f"${layer}: wrote {df.count()} rows to {table}")`,
    'display(spark.table(table))',
  ].join('\n');
  return { source, generated: true };
}

/** Stringify base_parameters values — the Jobs API requires string values in
 * notebook_task.base_parameters. Bundle tokens like '{{ job.parameters.x }}'
 * are preserved verbatim so Databricks resolves them at run time. */
function stringifyParams(p: unknown): Record<string, string> | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build the Jobs 2.1 spec from the bundle content. One shared job cluster;
 * each bundle task → a notebook task keyed by its name, with depends_on
 * mapped to the Jobs API shape ([{ task_key }]). */
function buildJobSpec(content: any, jobName: string, notebookPaths: Record<string, string>): JobSpec {
  const cluster = content?.cluster || {};
  const tasks: any[] = Array.isArray(content?.tasks) ? content.tasks : [];

  const newCluster = {
    spark_version: cluster.sparkVersion || '15.4.x-scala2.12',
    node_type_id: cluster.nodeType || 'Standard_DS3_v2',
    num_workers: typeof cluster.numWorkers === 'number' ? cluster.numWorkers : 2,
  };

  const jobTasks = tasks.map((t) => {
    const cfg = t?.config || {};
    const dependsOn = Array.isArray(cfg.depends_on)
      ? cfg.depends_on
          .map((d: any) => (typeof d === 'string' ? d : d?.task_key))
          .filter(Boolean)
          .map((task_key: string) => ({ task_key }))
      : undefined;
    return {
      task_key: t.name,
      job_cluster_key: SHARED_CLUSTER_KEY,
      notebook_task: {
        // Point at the Loom-imported notebook (owned by the Console UAMI, so it
        // has Can-Run) — falling back to the bundle's original reference only if
        // the import step couldn't run.
        notebook_path: notebookPaths[t.name] || t.notebookPath,
        base_parameters: stringifyParams(cfg.base_parameters) || {},
        source: 'WORKSPACE',
      },
      ...(dependsOn && dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
      ...(typeof cfg.timeout_seconds === 'number' ? { timeout_seconds: cfg.timeout_seconds } : {}),
      ...(typeof cfg.max_retries === 'number' ? { max_retries: cfg.max_retries } : {}),
      ...(typeof cfg.min_retry_interval_millis === 'number'
        ? { min_retry_interval_millis: cfg.min_retry_interval_millis }
        : {}),
      ...(cfg.email_notifications ? { email_notifications: cfg.email_notifications } : {}),
    };
  });

  return {
    name: jobName,
    job_clusters: [{ job_cluster_key: SHARED_CLUSTER_KEY, new_cluster: newCluster }],
    tasks: jobTasks,
    max_concurrent_runs: 1,
  } as JobSpec;
}

const RUN_POLL_MS = 3000;
const RUN_SETTLE_POLLS = 3; // ~9s settle — catch an instant failure, don't block.
const RUN_TERMINAL = new Set(['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR']);

/**
 * A run that fails ONLY because a referenced notebook is missing or the run
 * identity can't access it is NOT a job-creation failure — the job IS real on
 * the workspace. Per the Jobs API, a job submitted by API runs with the
 * notebook's default permissions (https://learn.microsoft.com/azure/databricks/jobs/privileges),
 * so a freshly created job whose notebooks haven't been imported / shared with
 * the Console UAMI surfaces exactly this signature in the run's state_message:
 *   "...does not exist, or the identity <uami> lacks the required permissions"
 *   "Unable to access the notebook ..."  (often with life_cycle INTERNAL_ERROR)
 * Detect that signature so we report the job as `created` behind an honest
 * remediation gate instead of hard-failing a successful deploy. */
function isNotebookAccessFailure(life?: string, message?: string): boolean {
  const m = (message || '').toLowerCase();
  if (!m) return false;
  const notebookScoped = m.includes('notebook') || m.includes('/workspace/');
  if (!notebookScoped) return false;
  return (
    m.includes('does not exist') ||
    m.includes('unable to access') ||
    m.includes('cannot access') ||
    m.includes("can't access") ||
    m.includes('not found') ||
    m.includes('lacks the required permission') ||
    m.includes('lack the required permission') ||
    m.includes('lacks required permission') ||
    m.includes('permission denied') ||
    m.includes('no permission') ||
    (life === 'INTERNAL_ERROR' && (m.includes('permission') || m.includes('access')))
  );
}

export const databricksJobProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];

  const gate = databricksConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Databricks workspace is not configured for this deployment.',
        remediation:
          `Set ${gate.missing} (the Databricks workspace hostname, e.g. adb-1234.5.azuredatabricks.net) so install can create + run the multi-task medallion job. ` +
          'The job definition is already saved to the workspace item; re-run install once the env var is set.',
        link: 'https://learn.microsoft.com/azure/databricks/jobs/automate',
      },
      steps,
    };
  }

  const content = input.content as any;
  if (!Array.isArray(content?.tasks) || content.tasks.length === 0) {
    return { status: 'skipped', steps: ['No tasks in databricks-job bundle; nothing to provision.'] };
  }

  const jobName = `loom-${input.appId}-${input.displayName}`.replace(/\s+/g, '-').slice(0, 100);

  // Import a REAL notebook for every task BEFORE creating the job, so the job's
  // tasks point at notebooks that exist and are owned by the Console UAMI (which
  // imported them → Can-Run). This closes the "referenced notebook is missing or
  // inaccessible" first-run failure: the bundle's tasks ship only a notebookPath
  // reference (/Workspace/Repos/csa-loom/medallion/*) that was never imported.
  const notebookPaths: Record<string, string> = {};
  const dir = `/Shared/loom-installs/${input.appId}/${slug(jobName)}`;
  try {
    await mkdirsWorkspace(dir);
    let generatedCount = 0;
    for (const t of content.tasks as any[]) {
      if (!t?.name) continue;
      const { source, generated } = taskNotebookSource(t, input.displayName);
      const nbPath = `${dir}/${slug(t.name)}`;
      await importNotebook(nbPath, 'PYTHON', source, true);
      notebookPaths[t.name] = nbPath;
      if (generated) generatedCount++;
    }
    steps.push(
      `Imported ${Object.keys(notebookPaths).length} task notebook(s) → ${dir}` +
        (generatedCount ? ` (${generatedCount} generated self-contained).` : '.'),
    );
  } catch (e: any) {
    if (isAuth(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Databricks ${e.status}: cannot import the job's task notebooks.`,
          remediation:
            'Add the Console UAMI (LOOM_UAMI_CLIENT_ID) as a workspace user with import access on the ' +
            'Databricks workspace (SCIM bootstrap) so install can import the notebooks the job runs, ' +
            'then re-run install. The job definition is created automatically once import succeeds.',
          link: 'https://learn.microsoft.com/azure/databricks/api/workspace/workspace/import',
        },
        steps,
      };
    }
    // Non-auth import failure: fall back to the bundle's original notebook paths
    // (the run-now poll below still surfaces a precise notebook-access gate).
    steps.push(`Task notebook import failed (${e?.message || String(e)}); using bundle notebook paths.`);
  }

  const spec = buildJobSpec(content, jobName, notebookPaths);

  // Idempotency: reuse the existing job by name, else create.
  let jobId: number;
  try {
    const existing = await listJobs(100);
    const match = existing.find((j) => (j.settings?.name || '').toLowerCase() === jobName.toLowerCase());
    if (match) {
      await updateJob(match.job_id, spec);
      jobId = match.job_id;
      steps.push(`Reset existing Databricks job ${jobId} ('${jobName}').`);
    } else {
      const created = await createJob(spec);
      jobId = created.job_id;
      steps.push(`Created Databricks job ${jobId} ('${jobName}') with ${spec.tasks?.length || 0} chained task(s).`);
    }
  } catch (e: any) {
    if (isAuth(e)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Databricks ${e.status}: cannot create/update the job.`,
          remediation:
            'Add the Console UAMI (LOOM_UAMI_CLIENT_ID) as a workspace user with "Workflows" access on the Databricks workspace (SCIM bootstrap) so it can create + run jobs.',
          link: 'https://learn.microsoft.com/azure/databricks/jobs/automate',
        },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }

  const secondaryIds: Record<string, string> = { backend: 'databricks', jobId: String(jobId) };

  // Prove it's real: run-now.
  let runId: number | undefined;
  try {
    const submitted = await runJob(jobId);
    runId = submitted.run_id;
    secondaryIds.lastRunId = String(runId);
    steps.push(`Triggered run-now → run ${runId}.`);
  } catch (e: any) {
    if (isAuth(e)) {
      // Job ITSELF was created; only the run couldn't be authorized.
      return {
        status: 'remediation',
        resourceId: String(jobId),
        secondaryIds,
        gate: {
          reason: `Job ${jobId} created, but run-now was not authorized (Databricks ${e.status}).`,
          remediation:
            'Grant the Console UAMI "Can Manage Run" on the job (or workspace Workflows access) so install can execute the medallion build.',
          link: 'https://learn.microsoft.com/azure/databricks/jobs/privileges',
        },
        steps,
      };
    }
    steps.push(`run-now could not be triggered: ${e?.message || String(e)}`);
    // Job exists; report created with the run deferred rather than failing.
    return { status: 'created', resourceId: String(jobId), secondaryIds, steps };
  }

  // Short settle poll — catch an instant terminal, otherwise report the run as
  // executing (tracked by run id) and return so install stays under the gateway.
  let run: JobRun | undefined;
  for (let i = 0; i < RUN_SETTLE_POLLS; i++) {
    await new Promise((r) => setTimeout(r, RUN_POLL_MS));
    try {
      run = await getJobRun(runId);
    } catch (e: any) {
      steps.push(`Run poll ${i + 1} failed: ${e?.message || String(e)}`);
      continue;
    }
    const life = run?.state?.life_cycle_state;
    if (life && RUN_TERMINAL.has(life)) break;
  }

  const life = run?.state?.life_cycle_state;
  const result = run?.state?.result_state;
  const settled = life ? RUN_TERMINAL.has(life) : false;
  if (life) secondaryIds.lifeCycleState = life;
  if (result) secondaryIds.resultState = result;
  steps.push(
    settled
      ? `Run ${runId} → ${life}${result ? `/${result}` : ''}${run?.state?.state_message ? ` (${run.state.state_message})` : ''}.`
      : `Run ${runId} submitted and executing (${life || 'PENDING'}); not blocking install on the full medallion build — tracked by run id.`,
  );

  // A TERMINAL non-SUCCESS run means either (a) the JOB was created fine but
  // its referenced notebooks aren't importable/accessible by the run identity —
  // a one-time bootstrap gap, NOT a deploy failure; the job is real — or
  // (b) a genuine data-production error. Distinguish the two: creating the job
  // is the real deploy success, so a notebook-access failure becomes an honest
  // remediation gate, while any other terminal failure still hard-fails.
  if (settled && result && result !== 'SUCCESS') {
    const stateMessage = run?.state?.state_message;
    if (isNotebookAccessFailure(life, stateMessage)) {
      steps.push(
        `Job ${jobId} created; run ${runId} could not start because a referenced notebook is missing or inaccessible.`,
      );
      return {
        status: 'remediation',
        resourceId: String(jobId),
        secondaryIds,
        gate: {
          reason:
            `Databricks job ${jobId} was created successfully, but its first run ${life}/${result} because a referenced notebook is missing or inaccessible` +
            `${stateMessage ? `: ${stateMessage}` : '.'}`,
          remediation:
            "Import the job's referenced notebooks into the Databricks workspace (or point the job tasks at the bundle's imported notebooks) and grant the Console UAMI (LOOM_UAMI_CLIENT_ID) Can-Run on them, then re-run the job. The job definition is already deployed — this is a one-time notebook bootstrap.",
          link: 'https://learn.microsoft.com/azure/databricks/jobs/privileges',
        },
        steps,
      };
    }
    return {
      status: 'failed',
      error: `Databricks job run ${runId} finished ${life}/${result}${run?.state?.state_message ? `: ${run.state.state_message}` : ''}.`,
      resourceId: String(jobId),
      secondaryIds,
      steps,
    };
  }

  if (!settled) secondaryIds.runProgress = 'executing';
  return { status: 'created', resourceId: String(jobId), secondaryIds, steps };
};
