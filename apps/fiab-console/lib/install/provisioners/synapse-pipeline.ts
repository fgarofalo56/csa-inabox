/**
 * Phase 2 — Synapse Pipeline provisioner.
 *
 * Closes the silent-skip gap where itemType 'synapse-pipeline' had NO
 * provisioner and fell to the Cosmos-only skipped path on deploy=true.
 *
 * This provisioner makes the bundled pipeline REAL on the Synapse workspace:
 *   1. Translate the bundle's activity graph + parameters into the Synapse
 *      pipeline `properties` shape and PUT it via synapse-dev-client.upsertPipeline
 *      (Synapse Studio dev REST — same call the editor's bind?create=true uses).
 *   2. Prove it's real by triggering an on-demand run (createRun → { runId })
 *      and short-polling queryPipelineRuns for status — the data-pipeline
 *      analogue of warehouse.ts seeding rows. Settle, don't block: we surface
 *      the live runId then return so the install stays under the Front Door
 *      ~30s gateway window even though the pipeline run outlasts it.
 *
 * Honest gates (per .claude/rules/no-vaporware.md): when the Synapse workspace
 * env vars aren't set, or the Console UAMI lacks the workspace RBAC to author /
 * run pipelines, the item still installs to Cosmos and surfaces a precise
 * remediation gate naming the exact env var / role — the pipeline is created on
 * the next pass once the gate is cleared. NO silent skip.
 *
 * Docs:
 *   https://learn.microsoft.com/cli/azure/synapse/pipeline#az-synapse-pipeline-create-run
 *   https://learn.microsoft.com/azure/synapse-analytics/monitoring/how-to-monitor-pipeline-runs
 */
import {
  upsertPipeline,
  runPipeline,
  getPipelineRun,
} from '@/lib/azure/synapse-dev-client';
import type { Provisioner, ProvisionResult } from './types';
import { upsertAndRunDevPipeline, type DevPipelineAdapter } from './_seed-dev-pipeline';

/** synapse-dev-client throws `Missing env var: <K>` for the three workspace
 * vars; surface that as a structured config gate instead of a bare failure. */
function synapseConfigGate(): { missing: string } | null {
  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_SYNAPSE_WORKSPACE']) {
    if (!process.env[k]) return { missing: k };
  }
  return null;
}

/** Synapse pipeline names allow a wider character set than ADF, but we keep
 * the Loom display name portable: letters/digits/_/- only, ≤ 140 chars. */
function safePipelineName(displayName: string): string {
  const cleaned = displayName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140);
  return cleaned || 'loom-synapse-pipeline';
}

const adapter: DevPipelineAdapter = {
  label: 'Synapse',
  async upsert(name, properties) {
    await upsertPipeline(name, { name, properties });
  },
  async createRun(name, params) {
    const r = await runPipeline(name, params);
    return r.runId;
  },
  async getRunStatus(runId) {
    const run = await getPipelineRun(runId);
    return { runId, status: run.status, message: run.message };
  },
};

export const synapsePipelineProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];

  const gate = synapseConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Synapse workspace is not configured for this deployment.',
        remediation:
          `Set ${gate.missing} (and LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_SYNAPSE_WORKSPACE) so install can author + run the Synapse pipeline. ` +
          'The pipeline definition is already saved to the workspace item; re-run install once the env var is set.',
        link: 'https://learn.microsoft.com/azure/synapse-analytics/get-started-create-workspace',
      },
      steps,
    };
  }

  const pipelineName = safePipelineName(input.displayName);
  const seed = await upsertAndRunDevPipeline(adapter, pipelineName, input.content);
  steps.push(...seed.steps);

  // Could not even author the pipeline — RBAC gate or hard failure.
  if (!seed.upserted) {
    if (seed.authGate) {
      return {
        status: 'remediation',
        gate: {
          reason: `Synapse dev REST ${seed.authGate.status}: cannot author the pipeline.`,
          remediation:
            'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Synapse Artifact Publisher + Synapse Compute Operator roles on the workspace (Synapse Studio > Manage > Access control) so it can PUT and run pipelines: ' +
            seed.authGate.message,
          link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
        },
        steps,
      };
    }
    return { status: 'failed', error: seed.error || 'Synapse pipeline upsert failed; see steps.', steps };
  }

  const secondaryIds: Record<string, string> = { backend: 'synapse', pipelineName };

  // Pipeline created/updated but the on-demand run was not authorized.
  if (seed.authGate) {
    return {
      status: 'remediation',
      resourceId: pipelineName,
      secondaryIds,
      gate: {
        reason: `Pipeline '${pipelineName}' authored, but on-demand run was not authorized (Synapse ${seed.authGate.status}).`,
        remediation:
          'Grant the Console UAMI the Synapse Compute Operator role on the workspace so it can run pipelines: ' +
          seed.authGate.message,
        link: 'https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control',
      },
      steps,
    };
  }

  if (seed.runId) secondaryIds.lastRunId = seed.runId;
  if (seed.status) secondaryIds.lastRunStatus = seed.status;

  // A TERMINAL non-success run means the pipeline errored on the backend —
  // surface it (not silent success) per no-vaporware so the operator fixes it.
  if (seed.status && (seed.status === 'Failed' || seed.status === 'Cancelled')) {
    return {
      status: 'failed',
      error: `Synapse pipeline run ${seed.runId} finished ${seed.status}.`,
      resourceId: pipelineName,
      secondaryIds,
      steps,
    };
  }

  // Created. The pipeline was authored and a real run was triggered. If the
  // run is still executing (not terminal) within the short window it is
  // tracked by runId and the install request returns promptly.
  if (seed.status && seed.status !== 'Succeeded') secondaryIds.runProgress = 'executing';
  return { status: 'created', resourceId: pipelineName, secondaryIds, steps };
};
