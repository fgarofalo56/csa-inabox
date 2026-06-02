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
  type JobSpec,
  type JobRun,
} from '@/lib/azure/databricks-client';
import type { Provisioner, ProvisionResult } from './types';

const SHARED_CLUSTER_KEY = 'medallion_shared';

function isAuth(e: any): e is { status: number; message?: string } {
  return e && (e.status === 401 || e.status === 403);
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
function buildJobSpec(content: any, jobName: string): JobSpec {
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
        notebook_path: t.notebookPath,
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
  const spec = buildJobSpec(content, jobName);

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
