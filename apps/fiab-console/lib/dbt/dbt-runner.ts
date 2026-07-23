/**
 * CSA Loom — dbt run dispatch.
 *
 * Two real, Azure-native execution paths for a generated dbt project:
 *
 *  1. Databricks (DEFAULT, fully Azure-native) — the generated project files
 *     are pushed into a Loom-managed workspace folder via the Workspace Import
 *     API, then a Databricks Job dbt_task runs them with
 *     `source: WORKSPACE` + `project_directory`. dbt runs natively on the
 *     Databricks runtime; no external runtime required.
 *
 *  2. Synapse dedicated SQL pool — Synapse has NO native dbt task, so dbt-core
 *     (with the dbt-synapse adapter + ODBC Driver 18) runs in the
 *     `loom-dbt-runner` Container App. This module POSTs the generated project
 *     tarball + commands to LOOM_DBT_RUNNER_URL and returns the run log. When
 *     the runner isn't deployed (env unset) callers surface an honest infra
 *     gate naming LOOM_DBT_RUNNER_URL + the bicep module — never a fake run.
 *
 * No Fabric dependency: Databricks + Synapse are the defaults. The Fabric
 * adapter is reachable only through the same Synapse runner (it shares the
 * ODBC stack) and is opt-in via the target adapter selection.
 */

import {
  mkdirsWorkspace, importWorkspaceFile, createJob, getJob, updateJob, runJob, getNotebook,
  type JobSpec,
} from '@/lib/azure/databricks-client';
import { DefaultAzureCredential, ManagedIdentityCredential, ChainedTokenCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import {
  parseDbtManifestLineage, parseManifestJson,
  type DbtManifest, type DbtCatalog,
} from './dbt-manifest-lineage';
import type { GeneratedFile } from './dbt-codegen';

/** Root workspace folder Loom writes generated dbt projects into. */
export function dbtWorkspaceDir(itemId: string): string {
  return `/Workspace/Shared/loom-dbt/${itemId}`;
}

/**
 * Push every generated file into a Databricks workspace folder, creating the
 * intermediate directories. Returns the project_directory the dbt_task uses.
 */
export async function pushProjectToDatabricks(
  itemId: string,
  files: GeneratedFile[],
): Promise<{ projectDir: string; written: string[] }> {
  const root = dbtWorkspaceDir(itemId);
  // mkdirs the root + every nested directory referenced by a file path.
  const dirs = new Set<string>([root]);
  for (const f of files) {
    const segs = f.path.split('/');
    segs.pop();
    let acc = root;
    for (const seg of segs) {
      acc = `${acc}/${seg}`;
      dirs.add(acc);
    }
  }
  // Sort by depth so parents are created before children.
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
    await mkdirsWorkspace(d);
  }
  const written: string[] = [];
  for (const f of files) {
    const target = `${root}/${f.path}`;
    await importWorkspaceFile(target, f.content, true);
    written.push(target);
  }
  return { projectDir: root, written };
}

/**
 * The dbt-databricks adapter library pinned on the dbt task. Databricks
 * recommends pinning the dbt task to a specific adapter version (>= 1.6.0) so
 * dev and prod runs use the same dbt-databricks; without a pin the dependent
 * library defaults to `dbt-databricks>=1.0.0,<2.0.0`, which can drift.
 * `catalog` on a warehouse-targeted task additionally requires >= 1.1.1.
 * Learn: https://learn.microsoft.com/azure/databricks/jobs/dbt
 */
export const DBT_DATABRICKS_LIBRARY = 'dbt-databricks>=1.6.0,<2.0.0';

/**
 * Build a Databricks Job spec running the generated project from the workspace
 * folder (no external git repo). `source: WORKSPACE` + `project_directory` is
 * the documented alternative to `git_source`. The generated `profiles.yml`
 * authenticates with the run-scoped `DBT_ACCESS_TOKEN` Databricks injects for
 * the task's Run-As principal, so no secret is plumbed through the job. The
 * dbt-databricks adapter is pinned (see DBT_DATABRICKS_LIBRARY) for parity.
 */
export function buildWorkspaceDbtJobSpec(
  itemId: string,
  projectDir: string,
  clusterId: string,
  commands: string[],
): JobSpec {
  return {
    name: `loom-dbt-${itemId}`,
    tasks: [
      {
        task_key: 'dbt',
        existing_cluster_id: clusterId,
        dbt_task: {
          project_directory: projectDir,
          commands,
          source: 'WORKSPACE',
        },
        libraries: [{ pypi: { package: DBT_DATABRICKS_LIBRARY } }],
      },
    ],
    max_concurrent_runs: 1,
  };
}

/**
 * Materialize (create or re-sync) the Databricks Job for a workspace-sourced
 * dbt project and trigger run-now. Returns the job id + run id.
 *
 * After the run is triggered, a best-effort L6 lineage emit runs
 * fire-and-forget: it exports the project's `target/manifest.json` (present when
 * the run's dbt artifacts have been committed back to the workspace project
 * folder) and records the model→model DAG + column mappings into the Weave
 * thread-edge graph. Wrapped so it NEVER affects the run trigger — a Databricks
 * job run is asynchronous, so when the artifact isn't yet present the export
 * simply no-ops (no fabricated lineage). The synchronous, always-populated
 * lineage path is {@link runDbtOnRunner} for the Synapse/Fabric backend.
 */
export async function runDbtOnDatabricks(opts: {
  itemId: string;
  projectDir: string;
  clusterId: string;
  commands: string[];
  existingJobId?: number;
  /** Session for the lineage emit; falls back to the request-scoped session. */
  session?: SessionPayload;
}): Promise<{ jobId: number; runId: number }> {
  const spec = buildWorkspaceDbtJobSpec(opts.itemId, opts.projectDir, opts.clusterId, opts.commands);
  let jobId = opts.existingJobId;
  if (jobId) {
    try {
      await getJob(jobId);
      await updateJob(jobId, spec);
    } catch (e: any) {
      if (e?.status === 404) {
        jobId = (await createJob(spec)).job_id;
      } else {
        throw e;
      }
    }
  } else {
    jobId = (await createJob(spec)).job_id;
  }
  const run = await runJob(jobId!);
  // Fire-and-forget L6 lineage emit (never blocks / never throws into the run).
  void emitDatabricksManifestLineage(opts.projectDir, resolveEmitSession(opts.session));
  return { jobId: jobId!, runId: run.run_id };
}

/**
 * Best-effort: export `<projectDir>/target/manifest.json` from the workspace and
 * record its lineage. Silent on any failure (the manifest may not be committed
 * back yet — a triggered Databricks run is asynchronous). Never throws.
 */
async function emitDatabricksManifestLineage(
  projectDir: string,
  session: SessionPayload | null,
): Promise<void> {
  if (!session) return;
  try {
    const nb = await getNotebook(`${projectDir}/target/manifest.json`);
    const manifest = parseManifestJson(nb.content);
    if (manifest) await emitDbtManifestLineage(session, manifest);
  } catch {
    // No committed manifest artifact (async run) — no lineage to emit, no error.
  }
}

// ------------------------------------------------------------
// Synapse / Fabric ODBC path — loom-dbt-runner Container App
// ------------------------------------------------------------

export interface DbtRunnerResult {
  ok: boolean;
  /** Combined stdout/stderr of the dbt invocation. */
  log: string;
  /** Per-node results parsed from dbt's run_results.json when available. */
  results?: { name: string; status: string; message?: string }[];
  /** Process exit code (0 = success). */
  exitCode?: number;
}

/** Honest gate: returns the missing env var when the runner isn't deployed. */
export function dbtRunnerConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_DBT_RUNNER_URL) return { missing: 'LOOM_DBT_RUNNER_URL' };
  return null;
}

// The runner Container App accepts an Entra bearer for its own app-id audience
// (LOOM_DBT_RUNNER_AUDIENCE) when private ingress + Easy Auth is configured.
// Default audience is the runner URL itself (App Service / Container Apps Easy
// Auth pattern). When unset we still call it (VNet-internal trust).
const runnerCred: ChainedTokenCredential | DefaultAzureCredential =
  (process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID)
    ? new ChainedTokenCredential(
        new AcaManagedIdentityCredential(),
        new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID! }),
        new DefaultAzureCredential(),
      )
    : new DefaultAzureCredential();

async function runnerAuthHeader(): Promise<Record<string, string>> {
  const aud = process.env.LOOM_DBT_RUNNER_AUDIENCE;
  if (!aud) return {};
  try {
    const t = await runnerCred.getToken(`${aud}/.default`);
    return t?.token ? { authorization: `Bearer ${t.token}` } : {};
  } catch {
    return {};
  }
}

/**
 * POST a generated project to the loom-dbt-runner Container App, which runs
 * `dbt deps` + the requested commands against Synapse/Fabric over ODBC with its
 * managed identity, and returns the run log + parsed node results.
 */
export async function runDbtOnRunner(opts: {
  files: GeneratedFile[];
  commands: string[];
  /** Adapter the runner should target (synapse | fabric). */
  adapter: string;
  /** Optional per-run env overrides (server/database) the runner injects. */
  env?: Record<string, string>;
  /** Session for the L6 lineage emit; falls back to the request-scoped session. */
  session?: SessionPayload;
}): Promise<DbtRunnerResult> {
  const base = process.env.LOOM_DBT_RUNNER_URL;
  if (!base) throw new Error('LOOM_DBT_RUNNER_URL not configured');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(await runnerAuthHeader()),
  };
  const res = await fetch(`${base.replace(/\/$/, '')}/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      files: opts.files,
      commands: opts.commands,
      adapter: opts.adapter,
      env: opts.env || {},
    }),
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { log: text }; }
  if (!res.ok) {
    return { ok: false, log: body.log || text || `runner HTTP ${res.status}`, exitCode: body.exitCode ?? res.status };
  }
  const ok = body.exitCode === 0 || body.ok === true;
  // L6 lineage emit — the runner returns the dbt artifacts inline (the ODBC
  // path is synchronous), so `target/manifest.json` is available right here.
  // Best-effort: never lets a lineage failure affect the run result.
  if (ok) {
    const manifest = parseManifestJson(body.manifest ?? body.artifacts?.['manifest.json']);
    if (manifest) {
      const session = resolveEmitSession(opts.session);
      if (session) {
        const catalog = parseCatalogJson(body.catalog ?? body.artifacts?.['catalog.json']);
        await emitDbtManifestLineage(session, manifest, catalog ? { catalog } : undefined);
      }
    }
  }
  return {
    ok,
    log: body.log || '',
    results: body.results,
    exitCode: body.exitCode,
  };
}

// ------------------------------------------------------------
// L6 — dbt manifest lineage emit (shared by both run paths)
// ------------------------------------------------------------

/** Resolve the session for a lineage emit: explicit arg, else request-scoped. */
function resolveEmitSession(explicit?: SessionPayload): SessionPayload | null {
  if (explicit) return explicit;
  try {
    return getSession();
  } catch {
    return null; // no request scope (e.g. background caller) — skip the emit.
  }
}

/** Coerce a runner `catalog.json` payload; null when absent/invalid. */
function parseCatalogJson(raw: unknown): DbtCatalog | null {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && ('nodes' in obj || 'sources' in obj)) {
      return obj as DbtCatalog;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a dbt manifest into Weave thread-edge lineage and persist each edge via
 * `recordThreadEdge` (itself best-effort / never-throws). Returns the number of
 * edges recorded. Any failure is swallowed — lineage is an observability layer
 * over the real dbt run and must never fail it (no-vaporware: the run itself is
 * the backend; this graph mirrors it).
 */
export async function emitDbtManifestLineage(
  session: SessionPayload,
  manifest: DbtManifest,
  opts?: { catalog?: DbtCatalog; action?: string },
): Promise<number> {
  try {
    const edges = parseDbtManifestLineage(manifest, opts);
    let recorded = 0;
    for (const edge of edges) {
      await recordThreadEdge(session, edge);
      recorded += 1;
    }
    return recorded;
  } catch {
    return 0;
  }
}
