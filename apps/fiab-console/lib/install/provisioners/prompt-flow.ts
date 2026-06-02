/**
 * Phase 2 — Prompt Flow provisioner.
 *
 * Real REST (AML data-plane via foundry-client.createPromptFlow):
 *   POST {region}.api.azureml.ms/flow/api/.../workspaces/{project}/PromptFlows
 *
 * A bundle's `prompt-flow` content (nodes + edges + systemPrompt) is
 * translated into a prompt-flow `flowDefinition` and created under the
 * configured AI Foundry project. Idempotent: if a flow with the same
 * flowName already exists in the project, it is reused (and updated).
 *
 * Auth: ChainedTokenCredential (UAMI → DefaultAzureCredential) against
 * https://management.azure.com/.default (the AML data-plane accepts the
 * ARM token for flow CRUD).
 *
 * Remediation gates (honest config-only state, per no-vaporware.md):
 *   - LOOM_FOUNDRY_PROJECT missing → name it. Without an AI Foundry
 *     project there is no AML workspace to create the flow in, and the
 *     /api/items/prompt-flow/[id]/run route has nothing to run.
 *   - 401/403 → the Console UAMI lacks "AzureML Data Scientist" on the
 *     project workspace.
 *   - 404 → the named project does not exist / is not reachable.
 *
 * NOTE: Azure deprecation. Microsoft ended Prompt Flow feature
 * development on 2026-04-20 (read-only on 2027-04-20). The bundle's
 * walkthrough therefore drives the flow through Loom's own
 * /api/items/prompt-flow/[id]/run route (which proxies the still-live
 * data-plane submit endpoint) rather than asserting any net-new
 * portal-authoring capability.
 */
import {
  listPromptFlows,
  createPromptFlow,
  updatePromptFlow,
  FoundryError,
} from '@/lib/azure/foundry-client';
import type { Provisioner, ProvisionResult } from './types';

/**
 * Translate a bundle `prompt-flow` content blob (our editor schema) into
 * an Azure prompt-flow `flowDefinition`. We keep the original Loom node /
 * edge / systemPrompt structure under `nodes`/`edges` (the editor + run
 * route round-trip it), and additionally surface `inputs`/`outputs`
 * blocks so the flow is submittable through the data-plane /submit
 * endpoint that POST /api/items/prompt-flow/[id]/run calls.
 */
function buildFlowDefinition(content: any): unknown {
  const nodes: any[] = Array.isArray(content?.nodes) ? content.nodes : [];
  const edges: any[] = Array.isArray(content?.edges) ? content.edges : [];
  const inputNode = nodes.find((n) => n.kind === 'input');
  const inputSchema = inputNode?.config?.schema || {};
  // Map the input node's declared schema to a prompt-flow `inputs` block.
  const inputs: Record<string, { type: string; default?: unknown }> = {};
  for (const [k, v] of Object.entries(inputSchema as Record<string, any>)) {
    inputs[k] = { type: (v?.type as string) || 'string' };
  }
  if (Object.keys(inputs).length === 0) {
    inputs.question = { type: 'string' };
    inputs.tenantId = { type: 'string' };
  }
  return {
    inputs,
    outputs: {
      answer: { type: 'string', reference: '${synthesize_answer.output}' },
      grounded: { type: 'bool', reference: '${search_index.grounded}' },
    },
    nodes,
    edges,
    systemPrompt: content?.systemPrompt,
  };
}

export const promptFlowProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const project = process.env.LOOM_FOUNDRY_PROJECT;
  if (!project) {
    return {
      status: 'remediation',
      gate: {
        reason: 'No AI Foundry project configured for prompt-flow provisioning.',
        remediation:
          'Set LOOM_FOUNDRY_PROJECT to an AI Foundry (Microsoft.MachineLearningServices kind=Project) workspace name under the hub. ' +
          'The flow is created in that project and run via POST /api/items/prompt-flow/<flowId>/run (body {project, inputs}).',
        link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects',
      },
      steps,
    };
  }

  const content = input.content as any;
  if (content?.kind !== 'prompt-flow' || !Array.isArray(content?.nodes)) {
    return { status: 'skipped', steps: ['No prompt-flow content in bundle; nothing to provision.'] };
  }

  // Idempotency: reuse an existing flow with the same name.
  const flowName = input.displayName;
  let existingId: string | undefined;
  try {
    const flows = await listPromptFlows(project);
    const match = flows.find(
      (f) => (f.flowName || '').toLowerCase() === flowName.toLowerCase(),
    );
    if (match?.flowId) {
      existingId = match.flowId;
      steps.push(`Found existing prompt flow ${match.flowId}; updating definition.`);
    }
  } catch (e: any) {
    if (e instanceof FoundryError && (e.status === 401 || e.status === 403)) {
      return remediation403(project, steps);
    }
    if (e instanceof FoundryError && e.status === 404) {
      return remediation404(project, steps);
    }
    // List failure is non-fatal — fall through to create.
    steps.push(`Could not list existing flows (${e?.message || e}); attempting create.`);
  }

  const flowDefinition = buildFlowDefinition(content);

  try {
    if (existingId) {
      await updatePromptFlow(project, existingId, flowDefinition);
      steps.push(`Updated prompt flow ${existingId}.`);
      return {
        status: 'exists',
        resourceId: existingId,
        secondaryIds: { project, runRoute: `/api/items/prompt-flow/${existingId}/run` },
        steps,
      };
    }
    const created = await createPromptFlow(project, {
      flowName,
      flowType: 'chat',
      flowDefinition,
      description: `Installed from ${input.appId} — grounded RAG Q&A over the bundled AI Search corpus.`,
    });
    const newId = (created as any)?.flowId || (created as any)?.id;
    steps.push(`Created prompt flow ${newId}.`);
    return {
      status: 'created',
      resourceId: newId,
      secondaryIds: { project, runRoute: `/api/items/prompt-flow/${newId}/run` },
      steps,
    };
  } catch (e: any) {
    if (e instanceof FoundryError && (e.status === 401 || e.status === 403)) {
      return remediation403(project, steps);
    }
    if (e instanceof FoundryError && e.status === 404) {
      return remediation404(project, steps);
    }
    return { status: 'failed', error: e?.message || String(e), steps };
  }
};

function remediation403(project: string, steps: string[]): ProvisionResult {
  return {
    status: 'remediation',
    gate: {
      reason: `Prompt Flow data-plane returned 401/403 for project '${project}'.`,
      remediation:
        'Grant the Console UAMI the "AzureML Data Scientist" role on the AI Foundry project workspace: ' +
        'az role assignment create --assignee <uami-objectid> --role "AzureML Data Scientist" ' +
        '--scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.MachineLearningServices/workspaces/' + project,
      link: 'https://learn.microsoft.com/azure/machine-learning/how-to-assign-roles',
    },
    steps,
  };
}

function remediation404(project: string, steps: string[]): ProvisionResult {
  return {
    status: 'remediation',
    gate: {
      reason: `AI Foundry project '${project}' not found / data plane unreachable.`,
      remediation:
        'Create the project under the hub (Foundry portal or the ai-foundry-project editor) and confirm LOOM_FOUNDRY_PROJECT / LOOM_FOUNDRY_REGION match its workspace name + region.',
      link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects',
    },
    steps,
  };
}
