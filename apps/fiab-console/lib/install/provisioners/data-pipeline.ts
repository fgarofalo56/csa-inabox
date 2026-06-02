/**
 * Phase 2 — Data Pipeline (Fabric) provisioner.
 *
 * Real REST + sample-data exercise:
 *   1. Translate the bundle's activity graph + parameters to the Fabric
 *      pipeline JSON schema and upsert the item (create or update by id)
 *      via upsertDataPipeline() in fabric-client.
 *   2. Prove the pipeline is REAL by triggering an on-demand pipeline job
 *      run (the documented "Run on demand pipeline job" REST call) and
 *      polling its job-instance history until terminal — the data-pipeline
 *      analogue of kql-db.ts ingesting sample rows / ai-search.ts pushing
 *      sample docs. The install receipt then carries a live job instance
 *      id + status, not a dead shell.
 *
 * Idempotency: list first, update existing by id or create new.
 *
 * Docs:
 *   https://learn.microsoft.com/fabric/data-factory/pipeline-rest-api-capabilities
 *   https://learn.microsoft.com/rest/api/fabric/core/job-scheduler/run-on-demand-item-job
 */
import { listDataPipelines, upsertDataPipeline, FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';
import { buildRunParameters, triggerAndPollPipelineRun } from './_seed-data-pipeline';

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
  if (!ws) {
    return {
      status: 'remediation',
      gate: { reason: 'No bound Fabric workspace.', remediation: 'Bind a Fabric workspace.', link: '/admin/workspaces' },
      steps,
    };
  }
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
