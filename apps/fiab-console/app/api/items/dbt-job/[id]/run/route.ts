/**
 * POST /api/items/dbt-job/[id]/run
 *
 * Materialises a Databricks Job with one `dbt_task` (or reuses the
 * previously-persisted job id) and triggers run-now. Persists the
 * Databricks job id back into `item.state.databricksJobId` so subsequent
 * runs reuse the same job container.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createJob, getJob, runJob, updateJob, type JobSpec,
} from '@/lib/azure/databricks-client';
import { jerr, loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'dbt-job';

interface DbtSpec {
  repoUrl: string;
  branch?: string;
  target?: string;
  profilesYaml?: string;
  models?: string[];
  commands?: string[];
  clusterId?: string;
  databricksJobId?: number;
}

function defaultCommands(spec: DbtSpec): string[] {
  if (spec.commands && spec.commands.length > 0) return spec.commands;
  const sel = spec.models && spec.models.length > 0 ? ` --select ${spec.models.join(' ')}` : '';
  return ['dbt deps', `dbt run --target ${spec.target || 'prod'}${sel}`];
}

function buildJobSpec(itemId: string, spec: DbtSpec): JobSpec {
  if (!spec.clusterId) {
    throw new Error('spec.clusterId is required (existing Databricks cluster)');
  }
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
        dbt_task: {
          commands: defaultCommands(spec),
          source: 'GIT',
        },
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
    const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
    if (!item) return jerr('not found', 404);
    const spec: DbtSpec = { ...((item.state as any) || {}), ...override };
    if (!spec.repoUrl) return jerr('spec.repoUrl is required', 400);

    const jobSpec = buildJobSpec((await ctx.params).id, spec);
    let jobId = spec.databricksJobId;
    if (jobId) {
      // Re-sync settings so changes to repo/branch/commands take effect.
      try {
        await getJob(jobId);
        await updateJob(jobId, jobSpec);
      } catch (e: any) {
        if (e?.status === 404) {
          const created = await createJob(jobSpec);
          jobId = created.job_id;
          await updateOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, {
            state: { ...spec, databricksJobId: jobId },
          });
        } else {
          throw e;
        }
      }
    } else {
      const created = await createJob(jobSpec);
      jobId = created.job_id;
      await updateOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid, {
        state: { ...spec, databricksJobId: jobId },
      });
    }

    const run = await runJob(jobId!);
    return NextResponse.json({ ok: true, databricksJobId: jobId, ...run });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
}
