/**
 * Phase 2 — ADF Pipeline provisioner.
 *
 * Closes the silent-skip gap where itemType 'adf-pipeline' had NO provisioner
 * and fell to the Cosmos-only skipped path on deploy=true.
 *
 * This provisioner makes the bundled pipeline REAL on the Azure Data Factory:
 *   1. Translate the bundle's activity graph + parameters into the ADF pipeline
 *      `properties` shape and PUT it via adf-client.upsertPipeline (ARM REST —
 *      the same call the editor's bind?create=true uses).
 *   2. Prove it's real by triggering an on-demand run (createRun → { runId })
 *      and short-polling queryPipelineRuns for status. Settle, don't block: we
 *      surface the live runId then return so the install stays under the Front
 *      Door ~30s gateway window even though the pipeline run outlasts it.
 *
 * Honest gates (per .claude/rules/no-vaporware.md): when the ADF factory env
 * vars aren't set (adfConfigGate), or the Console UAMI lacks the
 * Data Factory Contributor role to author / run pipelines, the item still
 * installs to Cosmos and surfaces a precise remediation gate naming the exact
 * env var / role — the pipeline is created on the next pass once cleared. NO
 * silent skip.
 *
 * Docs:
 *   https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory-rest-api#create-pipeline-run
 *   https://learn.microsoft.com/rest/api/datafactory/pipelines/create-run
 */
import {
  adfConfigGate,
  upsertPipeline,
  runPipeline,
  listPipelineRuns,
  upsertLinkedService,
  upsertDataset,
} from '@/lib/azure/adf-client';
import type { Provisioner, ProvisionResult } from './types';
import { upsertAndRunDevPipeline, type DevPipelineAdapter } from './_seed-dev-pipeline';

/** ADF pipeline names: letters/digits/_/- only, ≤ 140 chars (matches the
 * editor's bind NAME_RE). */
function safePipelineName(displayName: string): string {
  const cleaned = displayName.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140);
  return cleaned || 'loom-adf-pipeline';
}

const adapter: DevPipelineAdapter = {
  label: 'ADF',
  async upsert(name, properties) {
    await upsertPipeline(name, { name, properties });
  },
  async createRun(name, params) {
    const r = await runPipeline(name, params);
    return r.runId;
  },
  async getRunStatus(runId) {
    // ADF has no single-run GET in the client; resolve from the recent-run
    // query (newest first) and match our runId.
    const runs = await listPipelineRuns(undefined, 1);
    const match = runs.find((r) => r.runId === runId) || runs[0];
    return match ? { runId, status: match.status, message: match.message } : undefined;
  },
  async upsertLinkedService(name, properties) {
    await upsertLinkedService(name, { name, properties } as any);
  },
  async upsertDataset(name, properties) {
    await upsertDataset(name, { name, properties } as any);
  },
};

export const adfPipelineProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];

  const gate = adfConfigGate();
  if (gate) {
    return {
      status: 'remediation',
      gate: {
        reason: 'Azure Data Factory is not configured for this deployment.',
        remediation:
          `Set ${gate.missing} (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME) so install can author + run the ADF pipeline. ` +
          'The pipeline definition is already saved to the workspace item; re-run install once the env var is set.',
        link: 'https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory-rest-api',
      },
      steps,
    };
  }

  const pipelineName = safePipelineName(input.displayName);
  const seed = await upsertAndRunDevPipeline(adapter, pipelineName, input.content);
  steps.push(...seed.steps);

  if (!seed.upserted) {
    if (seed.needsReference) {
      return {
        status: 'remediation',
        gate: {
          reason: `Pipeline references an artifact that isn't provisioned on this estate: ${seed.needsReference.message}`,
          remediation:
            'The pipeline definition is saved. Loom auto-creates the ADLS linked service + datasets it references; a remaining unresolved reference is typically a Databricks linked service — set LOOM_DATABRICKS_HOSTNAME (and grant the factory access) so the notebook activities bind, then re-run install.',
          link: 'https://learn.microsoft.com/azure/data-factory/concepts-linked-services',
        },
        steps,
      };
    }
    if (seed.authGate) {
      return {
        status: 'remediation',
        gate: {
          reason: `ADF ARM REST ${seed.authGate.status}: cannot author the pipeline.`,
          remediation:
            'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Data Factory Contributor role on the factory (LOOM_ADF_NAME) so it can PUT and run pipelines: ' +
            seed.authGate.message,
          link: 'https://learn.microsoft.com/azure/data-factory/concepts-roles-permissions',
        },
        steps,
      };
    }
    return { status: 'failed', error: seed.error || 'ADF pipeline upsert failed; see steps.', steps };
  }

  const secondaryIds: Record<string, string> = { backend: 'adf', pipelineName };

  if (seed.authGate) {
    return {
      status: 'remediation',
      resourceId: pipelineName,
      secondaryIds,
      gate: {
        reason: `Pipeline '${pipelineName}' authored, but on-demand run was not authorized (ADF ${seed.authGate.status}).`,
        remediation:
          'Grant the Console UAMI the Data Factory Contributor role on the factory so it can run pipelines: ' +
          seed.authGate.message,
        link: 'https://learn.microsoft.com/azure/data-factory/concepts-roles-permissions',
      },
      steps,
    };
  }

  if (seed.runId) secondaryIds.lastRunId = seed.runId;
  if (seed.status) secondaryIds.lastRunStatus = seed.status;

  if (seed.status && (seed.status === 'Failed' || seed.status === 'Cancelled')) {
    return {
      status: 'failed',
      error: `ADF pipeline run ${seed.runId} finished ${seed.status}.`,
      resourceId: pipelineName,
      secondaryIds,
      steps,
    };
  }

  if (seed.status && seed.status !== 'Succeeded') secondaryIds.runProgress = 'executing';
  return { status: 'created', resourceId: pipelineName, secondaryIds, steps };
};
