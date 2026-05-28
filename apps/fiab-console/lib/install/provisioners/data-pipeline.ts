/**
 * Phase 2 — Data Pipeline (Fabric) provisioner.
 *
 * Real REST: upsertDataPipeline() in fabric-client.  Bundle's activities
 * are translated to the Fabric pipeline JSON schema.
 *
 * Idempotency: list first, update existing by id or create new.
 */
import { listDataPipelines, upsertDataPipeline, FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

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
  const def = buildPipelineDefinition(input.content, input.displayName);
  try {
    const existing = await listDataPipelines(ws);
    const match = existing.find((p) => (p.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    if (match?.id) {
      await upsertDataPipeline(ws, { id: match.id, displayName: match.displayName, definition: def });
      steps.push(`Updated pipeline ${match.id}.`);
      return { status: 'exists', resourceId: match.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
    }
    const created = await upsertDataPipeline(ws, { displayName: input.displayName, description: `Installed from ${input.appId}`, definition: def });
    const id = (created as any)?.id;
    steps.push(`Created pipeline ${id}.`);
    return { status: 'created', resourceId: id, secondaryIds: { fabricWorkspaceId: ws }, steps };
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
