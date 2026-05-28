/**
 * Phase 2 — Notebook provisioner.
 *
 * Real REST: POST /v1/workspaces/{wsid}/notebooks (create item) then
 * POST /v1/workspaces/{wsid}/notebooks/{id}/updateDefinition (push cells
 * inline-base64 as an .ipynb part).
 *
 * Input expects state.content to be a NotebookContent bundle (cells +
 * defaultLang).  Idempotent: if a notebook with the same displayName
 * already exists in the Fabric workspace, we updateDefinition instead of
 * create.
 *
 * Remediation gates:
 *   - target.fabricWorkspaceId missing  → admin must bind the Loom
 *     workspace to a Fabric/PBI group (set LOOM_DEFAULT_FABRIC_WORKSPACE
 *     or run the Bind Capacity flow).
 *   - 401/403 from Fabric              → UAMI not a Contributor on that
 *     Fabric workspace; admin must add it.
 *
 * Per .claude/rules/no-vaporware.md every error surfaces verbatim with
 * the exact remediation in the wizard MessageBar.
 */
import { createNotebook, listNotebooks, updateNotebookDefinition, FabricError, fabricHint } from '@/lib/azure/fabric-client';
import type { Provisioner, ProvisionResult } from './types';

/** Build a minimal Fabric notebook definition with one cell per bundle cell. */
function buildDefinition(content: any, displayName: string): { format: string; parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }> } {
  const defaultLang = content?.defaultLang || 'pyspark';
  const cells: any[] = Array.isArray(content?.cells) ? content.cells : [];
  // Fabric expects a Jupyter-style .ipynb structure: cells[] with cell_type,
  // source (array of strings), language metadata.
  const ipynb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Synapse Pyspark', language: defaultLang === 'sparksql' ? 'sql' : defaultLang, name: defaultLang },
      language_info: { name: defaultLang === 'sparksql' ? 'sql' : 'python' },
      microsoft: { language: defaultLang, language_group: 'synapse_pyspark' },
    },
    cells: cells.map((c) => ({
      cell_type: c.kind === 'markdown' ? 'markdown' : 'code',
      execution_count: null,
      metadata: c.language ? { microsoft: { language: c.language } } : {},
      outputs: c.kind === 'markdown' ? undefined : [],
      source: typeof c.source === 'string'
        ? c.source.split('\n').map((line: string, i: number, arr: string[]) => i < arr.length - 1 ? line + '\n' : line)
        : (Array.isArray(c.source) ? c.source : []),
    })),
  };
  const payload = Buffer.from(JSON.stringify(ipynb), 'utf-8').toString('base64');
  return {
    format: 'ipynb',
    parts: [
      {
        path: 'notebook-content.ipynb',
        payload,
        payloadType: 'InlineBase64',
      },
      {
        path: '.platform',
        payload: Buffer.from(JSON.stringify({
          $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
          metadata: { type: 'Notebook', displayName },
          config: { version: '2.0' },
        }), 'utf-8').toString('base64'),
        payloadType: 'InlineBase64',
      },
    ],
  };
}

export const notebookProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const ws = input.target.fabricWorkspaceId;
  if (!ws) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No bound Fabric workspace for this Loom workspace.',
        remediation:
          'Bind a Fabric/Power BI workspace to this Loom workspace via /admin/workspaces > Bind capacity, OR set LOOM_DEFAULT_FABRIC_WORKSPACE so installs default to a shared Fabric workspace.',
        link: '/admin/workspaces',
      },
    };
  }
  steps.push(`Fabric workspace: ${ws}`);

  const definition = buildDefinition(input.content, input.displayName);
  steps.push(`Built notebook definition with ${(input.content as any)?.cells?.length || 0} cells.`);

  try {
    // Idempotency: see if a notebook with the same displayName already
    // lives in the Fabric workspace.  If so, updateDefinition.  Else
    // POST a new one.
    const existing = await listNotebooks(ws);
    const match = existing.find((n) => (n.displayName || '').toLowerCase() === input.displayName.toLowerCase());
    if (match?.id) {
      steps.push(`Found existing notebook '${match.displayName}' (${match.id}); updating definition.`);
      await updateNotebookDefinition(ws, match.id, definition);
      steps.push('updateDefinition accepted (long-running).');
      return { status: 'exists', resourceId: match.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
    }
    steps.push('Creating new Fabric notebook…');
    const created = await createNotebook(ws, {
      displayName: input.displayName,
      description: `Installed from ${input.appId}`,
      definition,
    });
    steps.push(`Created notebook ${created.id}.`);
    return { status: 'created', resourceId: created.id, secondaryIds: { fabricWorkspaceId: ws }, steps };
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Fabric ${e.status}: ${e.message}`,
          remediation:
            fabricHint(e.status) ||
            'The Console UAMI must be added to this Fabric workspace as a Contributor.',
          link: `https://app.fabric.microsoft.com/groups/${ws}/settings`,
        },
        steps,
      };
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }
};
