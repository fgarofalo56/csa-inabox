/**
 * POST /api/items/dbt-job/[id]/run
 *
 * Runs a dbt project. Three real, Azure-native execution paths, chosen by the
 * persisted state:
 *
 *   A. Visual project + databricks target (DEFAULT) — generate the project
 *      files from state.project, push them into a Loom workspace folder, and
 *      run a Databricks Job dbt_task with source=WORKSPACE. Fully Azure-native;
 *      works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *   B. Visual project + synapse/fabric target — generate the files and POST
 *      them to the loom-dbt-runner Container App (dbt-core + dbt-synapse over
 *      ODBC). Honest gate when LOOM_DBT_RUNNER_URL is unset.
 *   C. Legacy BYO-repo (state.repoUrl, no state.project) — the original
 *      git_source dbt_task path, preserved for back-compat.
 *
 * Persists the resolved Databricks job id back into state.databricksJobId so
 * subsequent Databricks runs reuse the same job container.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createJob, getJob, runJob, updateJob, type JobSpec,
} from '@/lib/azure/databricks-client';
import {
  pushProjectToDatabricks, runDbtOnDatabricks, runDbtOnRunner, dbtRunnerConfigGate,
} from '@/lib/dbt/dbt-runner';
import { generateProject, defaultDbtCommands, findDanglingRefs } from '@/lib/dbt/dbt-codegen';
import { type DbtProjectGraph, validateDbtProjectGraph } from '@/lib/dbt/dbt-project-model';
import { jerr, loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'dbt-job';

interface DbtState {
  // Visual builder graph (new model).
  project?: DbtProjectGraph;
  // Legacy BYO-repo fields.
  repoUrl?: string;
  branch?: string;
  target?: string;
  profilesYaml?: string;
  models?: string[];
  commands?: string[];
  clusterId?: string;
  databricksJobId?: number;
}

function legacyCommands(spec: DbtState): string[] {
  if (spec.commands && spec.commands.length > 0) return spec.commands;
  const sel = spec.models && spec.models.length > 0 ? ` --select ${spec.models.join(' ')}` : '';
  return ['dbt deps', `dbt run --target ${spec.target || 'prod'}${sel}`];
}

function buildLegacyJobSpec(itemId: string, spec: DbtState): JobSpec {
  if (!spec.clusterId) throw new Error('spec.clusterId is required (existing Databricks cluster)');
  return {
    name: `loom-dbt-${itemId}`,
    git_source: {
      git_url: spec.repoUrl,
      git_provider: 'gitHub',
      git_branch: spec.branch || 'main',
    },
    tasks: [
      {
        task_key: 'dbt',
        existing_cluster_id: spec.clusterId,
        dbt_task: { commands: legacyCommands(spec), source: 'GIT' },
      },
    ],
    max_concurrent_runs: 1,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const override = await req.json().catch(() => ({}));
  try {
    const { id } = await ctx.params;
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec: DbtState = { ...((item.state as any) || {}), ...override };

    // ── A/B: visual-builder project present ───────────────────────────────
    // Validate the graph BEFORE codegen. A malformed graph (missing sources[], a
    // model with no layer, etc.) previously threw an unguarded TypeError in
    // generateProject → raw 502 (audit B10). Validate first and answer 400 with
    // field-level errors. A project with no usable models falls through to the
    // legacy BYO-repo path (which 400s honestly on its own).
    if (spec.project && typeof spec.project === 'object' &&
        Array.isArray(spec.project.models) && spec.project.models.length > 0) {
      const validation = validateDbtProjectGraph(spec.project);
      if (validation.length) {
        return NextResponse.json(
          {
            ok: false,
            code: 'invalid_project_graph',
            error: `Invalid dbt project graph: ${validation.map((v) => `${v.field}: ${v.message}`).join('; ')}`,
            errors: validation,
          },
          { status: 400 },
        );
      }
      const dangling = findDanglingRefs(spec.project);
      if (dangling.length) {
        return jerr(
          `Model graph has unresolved refs: ${dangling.map((d) => `${d.model}→${d.ref}`).join(', ')}. Fix or add the referenced models.`,
          400,
        );
      }
      const files = generateProject(spec.project);
      const commands = (spec.commands && spec.commands.length)
        ? spec.commands
        : defaultDbtCommands(spec.models);
      const adapter = spec.project.target.adapter;

      if (adapter === 'databricks') {
        if (!spec.clusterId) {
          return jerr('Select a Databricks cluster to run the project against.', 400);
        }
        // Bake the real workspace host into the generated profiles.yml so it is a
        // static literal on the pushed project (the dbt task authenticates with
        // the Databricks-injected DBT_ACCESS_TOKEN; only host/http_path are
        // baked). Default the host from the console's LOOM_DATABRICKS_HOSTNAME
        // when the builder left it blank.
        const hostFqdn = (spec.project.target.databricksHost
          || process.env.LOOM_DATABRICKS_HOSTNAME || '')
          .replace(/^https?:\/\//, '').replace(/\/$/, '');
        const dbxProject: DbtProjectGraph = {
          ...spec.project,
          target: { ...spec.project.target, databricksHost: hostFqdn || undefined },
        };
        const dbxFiles = generateProject(dbxProject);
        const { projectDir, written } = await pushProjectToDatabricks(id, dbxFiles);
        const { jobId, runId } = await runDbtOnDatabricks({
          itemId: id, projectDir, clusterId: spec.clusterId, commands,
          existingJobId: spec.databricksJobId,
        });
        if (jobId !== spec.databricksJobId) {
          await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
            state: { ...spec, databricksJobId: jobId },
          });
        }
        return NextResponse.json({
          ok: true, backend: 'databricks', databricksJobId: jobId, run_id: runId,
          projectDir, filesWritten: written.length,
        });
      }

      // synapse / fabric → loom-dbt-runner Container App
      const gate = dbtRunnerConfigGate();
      if (gate) {
        return NextResponse.json({
          ok: false,
          code: 'not_configured',
          backend: adapter,
          error: `The ${adapter} dbt runtime is not deployed in this environment.`,
          hint: `Synapse/Fabric have no native dbt task. Deploy the loom-dbt-runner Container App and set ${gate.missing}. See platform/fiab/bicep/modules/integration/dbt-runner.bicep. The Databricks target runs today with no extra infra.`,
        }, { status: 503 });
      }
      const result = await runDbtOnRunner({
        files, commands, adapter,
        env: {
          DBT_SYNAPSE_SERVER: spec.project.target.synapseServer || '',
          DBT_SYNAPSE_DATABASE: spec.project.target.database || '',
          DBT_FABRIC_ENDPOINT: spec.project.target.fabricEndpoint || '',
          DBT_FABRIC_DATABASE: spec.project.target.database || '',
        },
      });
      return NextResponse.json({
        ok: result.ok, backend: adapter, log: result.log,
        results: result.results, exitCode: result.exitCode,
      }, { status: result.ok ? 200 : 502 });
    }

    // ── C: legacy BYO-repo path ───────────────────────────────────────────
    if (!spec.repoUrl) {
      return jerr('Build a model graph in the visual builder, or set a git repo URL for the BYO-repo path.', 400);
    }
    const jobSpec = buildLegacyJobSpec(id, spec);
    let jobId = spec.databricksJobId;
    if (jobId) {
      try {
        await getJob(jobId);
        await updateJob(jobId, jobSpec);
      } catch (e: any) {
        if (e?.status === 404) {
          jobId = (await createJob(jobSpec)).job_id;
          await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...spec, databricksJobId: jobId } });
        } else { throw e; }
      }
    } else {
      jobId = (await createJob(jobSpec)).job_id;
      await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...spec, databricksJobId: jobId } });
    }
    const run = await runJob(jobId!);
    return NextResponse.json({ ok: true, backend: 'databricks', databricksJobId: jobId, ...run });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
