/**
 * Phase 2 — shared seeder helper for the Databricks-notebook provisioner.
 *
 * importAndRunNotebook() imports the bundle's notebook cells as a real
 * Databricks notebook (api/2.0/workspace/import), submits a one-time run
 * against a live cluster (api/2.1/jobs/runs/submit), and polls the run to a
 * terminal state (api/2.1/jobs/runs/get) — REAL Databricks REST, no mocks.
 * This is what actually executes the Silver/Gold transforms and PRODUCES the
 * live Delta data, closing the "notebooks never run" gap.
 *
 * (The bundle's lakehouse `sampleRows` are materialized into queryable Delta
 * tables separately by the lakehouse provisioner's OneLake Load-Table seed
 * path, so the semantic model + report render even before the run finishes.)
 *
 * All execution is gated honestly: when LOOM_DATABRICKS_HOSTNAME or a
 * runnable cluster is missing, the caller surfaces a remediation gate with
 * the exact env var / action instead of pretending the data was produced.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/databricks/api/workspace/workspace/import
 *   https://learn.microsoft.com/azure/databricks/api/workspace/jobs/submit
 *   https://learn.microsoft.com/azure/databricks/api/workspace/jobs/getrun
 */
import {
  databricksConfigGate,
  mkdirsWorkspace,
  importNotebook,
  runNotebook,
  getJobRun,
  listClusters,
  type JobRun,
  type Cluster,
} from '@/lib/azure/databricks-client';

// ── Notebook source conversion ──────────────────────────────────────────────

/** Map a bundle NotebookContent cell language to a Databricks magic prefix. */
function cellMagic(lang: string | undefined, defaultLang: string): string | null {
  const l = (lang || defaultLang || 'pyspark').toLowerCase();
  if (l === 'sparksql' || l === 'sql') return '%sql';
  if (l === 'sparkr' || l === 'r') return '%r';
  if (l === 'spark' || l === 'scala') return '%scala';
  return null; // pyspark/python is the notebook default — no magic needed.
}

/**
 * Serialize the bundle's NotebookContent cells into a Databricks SOURCE
 * notebook (Python base language). Cells are separated by the documented
 * `# COMMAND ----------` delimiter; markdown cells become `%md` commands and
 * non-python code cells carry the appropriate `%sql`/`%r`/`%scala` magic so
 * the mixed-language notebook runs correctly.
 */
export function buildDatabricksSource(content: any): string {
  const defaultLang = content?.defaultLang || 'pyspark';
  const cells: any[] = Array.isArray(content?.cells) ? content.cells : [];
  const header = '# Databricks notebook source';
  const blocks = cells.map((c) => {
    const src = typeof c.source === 'string' ? c.source : Array.isArray(c.source) ? c.source.join('') : '';
    if (c.kind === 'markdown' || c.type === 'markdown') {
      return `# MAGIC %md\n` + src.split('\n').map((l: string) => `# MAGIC ${l}`).join('\n');
    }
    const magic = cellMagic(c.lang || c.language, defaultLang);
    if (magic) {
      return `# MAGIC ${magic}\n` + src.split('\n').map((l: string) => `# MAGIC ${l}`).join('\n');
    }
    return src;
  });
  return [header, ...blocks].join('\n\n# COMMAND ----------\n\n');
}

// ── Cluster resolution ──────────────────────────────────────────────────────

export interface ClusterResolution {
  clusterId?: string;
  /** Set when no runnable cluster exists; carries the precise remediation. */
  gate?: { reason: string; remediation: string };
}

/**
 * Resolve a cluster to run the notebook on. Preference order:
 *   1. LOOM_DATABRICKS_CLUSTER_ID (explicit, fastest)
 *   2. The first RUNNING all-purpose cluster the UAMI can see.
 *   3. The first non-terminated cluster (it will be auto-started by the run).
 * Returns an honest gate when the workspace exposes no usable cluster.
 */
export async function resolveRunCluster(): Promise<ClusterResolution> {
  const explicit = process.env.LOOM_DATABRICKS_CLUSTER_ID;
  if (explicit) return { clusterId: explicit };

  let clusters: Cluster[] = [];
  try {
    clusters = await listClusters();
  } catch (e: any) {
    return {
      gate: {
        reason: `Could not list Databricks clusters: ${e?.message || String(e)}`,
        remediation:
          'Grant the Console UAMI workspace access on the Databricks workspace, or set ' +
          'LOOM_DATABRICKS_CLUSTER_ID to a specific cluster id the UAMI can run.',
      },
    };
  }
  const running = clusters.find((c) => c.state === 'RUNNING');
  if (running) return { clusterId: running.cluster_id };
  const startable = clusters.find(
    (c) => c.state && !['TERMINATED', 'TERMINATING', 'ERROR'].includes(c.state),
  ) || clusters.find((c) => c.state === 'TERMINATED');
  if (startable) return { clusterId: startable.cluster_id };

  return {
    gate: {
      reason: 'No Databricks cluster is available to run the notebook.',
      remediation:
        'Create an all-purpose cluster in the Databricks workspace (or set ' +
        'LOOM_DATABRICKS_CLUSTER_ID), then re-run install so the Silver/Gold ' +
        'notebooks execute and produce the live Delta data.',
    },
  };
}

// ── Notebook import + run + poll ────────────────────────────────────────────

export interface NotebookRunResult {
  /** Workspace path the notebook was imported to. */
  notebookPath?: string;
  /** True if a run was submitted. */
  triggered: boolean;
  /** True only if the run reached a TERMINAL life-cycle state within the
   * short settle window. False means it was submitted and is still executing
   * (tracked by runId) — NOT a failure. */
  settled?: boolean;
  runId?: number;
  /** life_cycle_state (TERMINATED/INTERNAL_ERROR/…) + result_state (SUCCESS/FAILED). */
  lifeCycleState?: string;
  resultState?: string;
  stateMessage?: string;
  steps: string[];
  /** Set when import/run could not happen because of config/cluster gate. */
  gate?: { reason: string; remediation: string };
}

// Short SYNCHRONOUS settle window only. The Databricks run is submitted via
// real REST and keeps executing on the cluster; we poll just long enough to
// catch an instant auth/submit failure, then return the live run id so the
// install request finishes well under the Azure Front Door ~30s gateway
// window. Blocking the HTTP request on the full Spark medallion build (which
// can take minutes) was the root cause of the 504 on deploy:true — the FD
// abort killed the request before the route could stamp the items. A long
// budget can be opted into out-of-band (e.g. a background re-run worker) via
// LOOM_DATABRICKS_RUN_POLLS, but the install path stays short by default.
const RUN_POLL_MS = 3000;
const RUN_SETTLE_POLLS = (() => {
  const n = Number(process.env.LOOM_DATABRICKS_RUN_POLLS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 80) : 3; // ~9s settle by default
})();
const RUN_TERMINAL = new Set(['TERMINATED', 'SKIPPED', 'INTERNAL_ERROR']);

/**
 * Import the notebook source into /Shared/loom-installs/<app>/<name> and run
 * it on a resolved cluster, polling to terminal. Never throws — folds errors
 * into the result so the provisioner can decide remediation vs failure.
 */
export async function importAndRunNotebook(
  appId: string,
  displayName: string,
  content: any,
): Promise<NotebookRunResult> {
  const steps: string[] = [];

  const gate = databricksConfigGate();
  if (gate) {
    return {
      triggered: false,
      steps,
      gate: {
        reason: 'Databricks workspace is not configured for this deployment.',
        remediation: `Set ${gate.missing} (the Databricks workspace hostname) so install can import + run the notebook that produces the lakehouse Delta data.`,
      },
    };
  }

  const cluster = await resolveRunCluster();
  if (cluster.gate || !cluster.clusterId) {
    return { triggered: false, steps, gate: cluster.gate };
  }
  steps.push(`Target cluster: ${cluster.clusterId}.`);

  const source = buildDatabricksSource(content);
  const safeName = displayName.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'notebook';
  const dir = `/Shared/loom-installs/${appId}`;
  const nbPath = `${dir}/${safeName}`;

  try {
    await mkdirsWorkspace(dir);
    await importNotebook(nbPath, 'PYTHON', source, true);
    steps.push(`Imported notebook → ${nbPath} (${content?.cells?.length || 0} cells).`);
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      return {
        triggered: false,
        notebookPath: nbPath,
        steps,
        gate: {
          reason: `Databricks ${e.status}: cannot import the notebook.`,
          remediation:
            'Add the Console UAMI as a workspace user/admin on the Databricks workspace ' +
            '(SCIM bootstrap) so it can import + run notebooks.',
        },
      };
    }
    steps.push(`Notebook import failed: ${e?.message || String(e)}`);
    return { triggered: false, notebookPath: nbPath, steps };
  }

  let runId: number | undefined;
  try {
    const submitted = await runNotebook(nbPath, cluster.clusterId, undefined, `loom-${appId}-${safeName}`);
    runId = submitted.run_id;
    steps.push(`Submitted run ${runId}.`);
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      return {
        triggered: false,
        notebookPath: nbPath,
        steps,
        gate: {
          reason: `Databricks ${e.status}: cannot submit the notebook run.`,
          remediation:
            'Grant the Console UAMI "Can Restart"/"Can Attach To" on the cluster (or job-run ' +
            'permission) so install can execute the medallion build.',
        },
      };
    }
    steps.push(`Run submit failed: ${e?.message || String(e)}`);
    return { triggered: false, notebookPath: nbPath, steps };
  }

  // Short settle poll: catch an instant terminal (e.g. immediate
  // INTERNAL_ERROR / config failure) without blocking the HTTP request on the
  // full medallion build. A still-running Spark job is reported as PENDING and
  // tracked by run id — it continues executing on the cluster and the Gold
  // commit → eventstream → Activator path (and any re-run worker) observes its
  // completion. This is what keeps deploy:true under the Front Door window.
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

  const lifeCycleState = run?.state?.life_cycle_state;
  const resultState = run?.state?.result_state;
  const stateMessage = run?.state?.state_message;
  const settled = lifeCycleState ? RUN_TERMINAL.has(lifeCycleState) : false;
  steps.push(
    settled
      ? `Run ${runId} → ${lifeCycleState}${resultState ? `/${resultState}` : ''}${stateMessage ? ` (${stateMessage})` : ''}.`
      : `Run ${runId} submitted and executing (${lifeCycleState || 'PENDING'}); not blocking install on the full medallion build — tracked by run id.`,
  );

  return { triggered: true, settled, notebookPath: nbPath, runId, lifeCycleState, resultState, stateMessage, steps };
}
