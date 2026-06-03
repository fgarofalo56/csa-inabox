/**
 * Phase 2 — Data Pipeline provisioner.
 *
 * Per .claude/rules/no-fabric-dependency.md a Loom data-pipeline NEVER requires
 * a real Fabric workspace. It defaults to the Azure-native **Synapse pipeline**
 * backend (Synapse Studio dev REST — real PUT + on-demand run), and can route to
 * **ADF** instead. A Fabric Data pipeline is an opt-in alternative selected via
 * LOOM_PIPELINE_BACKEND=fabric AND a bound workspace; if fabric is selected but
 * no workspace is bound, we transparently fall back to Synapse — no gate.
 *
 * All three backends consume the same bundle `content.activities` graph, so the
 * Azure-native path is a straight delegation to the Synapse / ADF sibling
 * provisioner (which carries its own real REST + run-and-poll + honest Azure
 * RBAC/env gates).
 *
 * Fabric path (opt-in only):
 *   1. Translate the activity graph to the Fabric pipeline JSON and upsert.
 *   2. Trigger an on-demand job run + poll job-instance history.
 *   https://learn.microsoft.com/fabric/data-factory/pipeline-rest-api-capabilities
 */
import { listDataPipelines, upsertDataPipeline, FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { buildRunParameters, triggerAndPollPipelineRun } from './_seed-data-pipeline';
import { synapsePipelineProvisioner } from './synapse-pipeline';
import { adfPipelineProvisioner } from './adf-pipeline';

function buildPipelineDefinition(content: any, displayName: string): { format: string; parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const activities = Array.isArray(content?.activities) ? content.activities : [];
  const pipelineJson = {
    properties: {
      activities: activities.map((a: any) => ({
        name: a.name,
        type: a.type,
        typeProperties: a.config || {},
        ...(a.dependsOn ? { dependsOn: a.dependsOn.map((d: string) => ({ activity: d, dependencyConditions: ['Succeeded'] })) } : {}),
      })),
      parameters: content?.parameters || {},
    },
  };
  return {
    format: 'json',
    parts: [
      { path: 'pipeline-content.json', payload: Buffer.from(JSON.stringify(pipelineJson), 'utf-8').toString('base64'), payloadType: 'InlineBase64' },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'DataPipeline', displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64',
      },
    ],
  };
}

export const dataPipelineProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  const backend = input.target.pipelineBackend || 'synapse';

  // Azure-native DEFAULT. Fabric is opt-in only AND requires a bound workspace;
  // anything else delegates to the Synapse (default) or ADF sibling. Never gate
  // on a missing Fabric workspace (no-fabric-dependency.md).
  if (backend !== 'fabric' || !ws) {
    if (backend === 'fabric' && !ws) {
      steps.push('LOOM_PIPELINE_BACKEND=fabric but no Fabric workspace bound — falling back to the Azure-native Synapse pipeline backend.');
    }
    const delegate = backend === 'adf' ? adfPipelineProvisioner : synapsePipelineProvisioner;
    steps.push(`Provisioning data pipeline on the Azure-native ${backend === 'adf' ? 'ADF' : 'Synapse'} backend.`);
    const result = await delegate(input);
    return { ...result, steps: [...steps, ...(result.steps || [])] };
  }

  // ── Fabric Data pipeline (opt-in: LOOM_PIPELINE_BACKEND=fabric + bound ws) ──
  const content = input.content as any;
  const def = buildPipelineDefinition(content, input.displayName);
  const runParams = buildRunParameters(content?.parameters);
  try {
    const existing = await listDataPipelines(ws);
    const match = existing.find((p) => (p.displayName || '').toLowerCase() === input.displayName.toLowerCase());

    // Resolve the pipeline id we'll run: existing match id on update, or
    // the id returned from create. updateDefinition can return a 202
    // long-running handle (no id) — in that case we keep the match id.
    let pipelineId: string | undefined;
    let baseStatus: ProvisionResult['status'];

    if (match?.id) {
      await upsertDataPipeline(ws, { id: match.id, displayName: match.displayName, definition: def });
      steps.push(`Updated pipeline ${match.id}.`);
      pipelineId = match.id;
      baseStatus = 'exists';
    } else {
      const created = await upsertDataPipeline(ws, {
        displayName: input.displayName,
        description: `Installed from ${input.appId}`,
        definition: def,
      });
      pipelineId = (created as any)?.id;
      // A create can return 202 (long-running) without an inline id; resolve
      // it from the workspace listing so we can still trigger the run.
      if (!pipelineId) {
        try {
          const after = await listDataPipelines(ws);
          pipelineId = after.find((p) => (p.displayName || '').toLowerCase() === input.displayName.toLowerCase())?.id;
        } catch { /* leave undefined; reported below */ }
      }
      steps.push(`Created pipeline ${pipelineId || '(id pending — long-running create)'}.`);
      baseStatus = 'created';
    }

    if (!pipelineId) {
      // Item was accepted but its id hasn't materialized yet — honest about
      // the deferred run rather than pretending we exercised it.
      steps.push('Pipeline id not yet resolvable; skipping on-demand validation run this pass.');
      return { status: baseStatus, secondaryIds: { fabricWorkspaceId: ws }, steps };
    }

    // ── Prove it's real: trigger an on-demand run + poll the job history.
    const run = await triggerAndPollPipelineRun(ws, pipelineId, runParams);
    steps.push(...run.steps);

    if (run.authGate) {
      // The pipeline was created successfully but the UAMI can't execute it.
      // Surface a precise remediation gate (the pipeline itself is real).
      return {
        status: 'remediation',
        resourceId: pipelineId,
        secondaryIds: { fabricWorkspaceId: ws },
        gate: {
          reason: `Pipeline created but on-demand run was not authorized (Fabric ${run.authGate.status}).`,
          remediation:
            'Grant the Console UAMI the Item.Execute.All Fabric permission and add it to the workspace as Member/Contributor so it can run pipelines: ' +
            run.authGate.message,
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }

    const secondaryIds: Record<string, string> = { fabricWorkspaceId: ws };
    if (run.jobInstanceId) secondaryIds.lastJobInstanceId = run.jobInstanceId;
    if (run.status) secondaryIds.lastRunStatus = run.status;

    return { status: baseStatus, resourceId: pipelineId, secondaryIds, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: { reason: `Fabric ${e.status}: ${e.message}`, remediation: fabricHint(e.status) || 'Add UAMI as Contributor.', link: `https://app.fabric.microsoft.com/groups/${ws}/settings` },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }
};
