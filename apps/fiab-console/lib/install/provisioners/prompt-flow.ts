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
 * the sovereign-cloud ARM `.default` scope (the AML data-plane accepts the
 * ARM token for flow CRUD).
 *
 * A MISSING PROJECT IS CREATED, NOT REPORTED (#3510, auto-bind-by-default).
 * The 404 branch used to tell the operator to go create the project under the
 * hub, in the Foundry portal or the ai-foundry-project editor — an action the
 * platform already performs elsewhere with the very client this file imports:
 * `foundry-client.createProject()`, in live use by
 * `app/api/items/ai-foundry-project/route.ts`. Per auto-bind-by-default.md a
 * remediation whose fix is something the PLATFORM could have done is a defect,
 * not an honest gate. So a 404 now attempts the create and retries once.
 *
 * Remediation gates (honest config-only state, per no-vaporware.md):
 *   - LOOM_FOUNDRY_PROJECT missing → name it. Without an AI Foundry
 *     project there is no AML workspace to create the flow in, and the
 *     /api/items/prompt-flow/[id]/run route has nothing to run.
 *   - 401/403 → the Console UAMI lacks "AzureML Data Scientist" on the
 *     project workspace.
 *   - 404 AND no hub-kind workspace to create the project under → the one
 *     case left. `createProject()` refuses (NotDeployedError) rather than
 *     inventing a project, because a Foundry project is a CHILD of a hub and
 *     nothing here can conjure the parent.
 *   - 404 and the create itself was refused (403 on the ARM PUT) → the
 *     deployment identity lacks Contributor on the resource group.
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
  createProject,
  FoundryError,
  NotDeployedError,
} from '@/lib/azure/foundry-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

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

  // ONE self-heal attempt per install. Bounded deliberately: `createProject` is
  // an ARM PUT, and an unbounded "404 → create → retry" loop against a project
  // that keeps 404ing would hammer ARM instead of failing closed.
  let projectCreateAttempted = false;

  /**
   * The 404 recovery. Returns `null` when the project now exists and the caller
   * should retry, or a ProvisionResult when the platform genuinely cannot make
   * it exist — which is the only case that is still allowed to reach the user.
   */
  const ensureProject = async (): Promise<ProvisionResult | null> => {
    if (projectCreateAttempted) {
      // Already tried this install and we are back here: the project is not
      // appearing. Say exactly that rather than asking for the create again.
      return remediationCreateFailed(
        project,
        'the project was created (or already reported as created) earlier in this install and the data plane still ' +
          'returns 404 for it. Azure ML project creation is asynchronous; retry the install in a minute.',
        steps,
      );
    }
    projectCreateAttempted = true;
    steps.push(`Project '${project}' not found; creating it under the Foundry hub.`);
    try {
      await createProject(project, project);
      steps.push(`Created AI Foundry project '${project}'.`);
      return null;
    } catch (ce: any) {
      // The ONLY genuinely-unfixable case: no hub-kind workspace to parent it.
      // createProject refuses rather than inventing one, and so do we.
      if (ce instanceof NotDeployedError) return remediationNoHub(project, ce, steps);
      if (ce instanceof FoundryError && (ce.status === 401 || ce.status === 403)) {
        return remediationCreateForbidden(project, steps);
      }
      return remediationCreateFailed(project, String(ce?.message || ce), steps);
    }
  };

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
      const gate = await ensureProject();
      if (gate) return gate;
      // A brand-new project has no flows, so there is nothing to reuse; fall
      // through to create rather than listing again.
    } else {
      // List failure is non-fatal — fall through to create.
      steps.push(`Could not list existing flows (${e?.message || e}); attempting create.`);
    }
  }

  const flowDefinition = buildFlowDefinition(content);

  const writeFlow = async (): Promise<ProvisionResult> => {
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
  };

  try {
    return await writeFlow();
  } catch (e: any) {
    if (e instanceof FoundryError && (e.status === 401 || e.status === 403)) {
      return remediation403(project, steps);
    }
    if (e instanceof FoundryError && e.status === 404) {
      const gate = await ensureProject();
      if (gate) return gate;
      // The project exists now. Retry the write ONCE — `ensureProject` has
      // already set the attempted flag, so a second 404 lands on its honest
      // "still 404 after create" gate instead of looping.
      try {
        return await writeFlow();
      } catch (e2: any) {
        if (e2 instanceof FoundryError && (e2.status === 401 || e2.status === 403)) {
          return remediation403(project, steps);
        }
        if (e2 instanceof FoundryError && e2.status === 404) {
          return (await ensureProject()) as ProvisionResult;
        }
        return resolveInfraResidual(e2, `The AI Foundry project '${project}' was created, but authoring the prompt flow in it still failed. Grant the Console UAMI the data-plane role needed to author prompt flows on that project.`, { link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk', steps });
      }
    }
    return resolveInfraResidual(e, `Confirm LOOM_FOUNDRY_PROJECT names an existing AI Foundry project and grant the Console UAMI the data-plane role needed to author prompt flows on project '${project}'.`, { link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk', steps });
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

/**
 * The ONE case the platform genuinely cannot fix itself: a Foundry project is a
 * CHILD of a hub-kind Azure ML workspace, and `createProject()` refuses rather
 * than inventing a parent. The message carries `createProject`'s own verbatim
 * hint, which already names whether the hub is absent or merely the wrong kind
 * — never a generic "not found" that asserts more than was established
 * (deploy-integrity.md R7).
 */
function remediationNoHub(project: string, cause: NotDeployedError, steps: string[]): ProvisionResult {
  // `NotDeployedError.message` is the GENERIC sentence ("<service> is not
  // provisioned in this deployment"); the sentence that actually says whether
  // the hub is absent or merely the wrong kind — and names the env var — is
  // `.hint`. Reading `.message` here would drop exactly the part an operator
  // needs, which is how a "helpful" gate becomes a dead end.
  const detail = (cause.hint || '').trim() || cause.message;
  return {
    status: 'remediation',
    gate: {
      reason:
        `AI Foundry project '${project}' does not exist, and Loom could not create it: there is no hub-kind ` +
        'Azure ML workspace for it to belong to.',
      remediation:
        `${detail} ` +
        'Deploy the hub with platform/fiab/bicep (the ai-foundry module) or set LOOM_FOUNDRY_HUB_NAME to an ' +
        'existing Azure AI Foundry hub workspace, then re-run the install — Loom creates the project itself.',
      link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects',
    },
    steps,
  };
}

/** The deployment identity cannot PUT the workspace. Names the exact role + scope. */
function remediationCreateForbidden(project: string, steps: string[]): ProvisionResult {
  return {
    status: 'remediation',
    gate: {
      reason: `AI Foundry project '${project}' does not exist and creating it was refused (401/403).`,
      remediation:
        'Grant the Console UAMI "Contributor" on the resource group so it can create the project workspace: ' +
        'az role assignment create --assignee <uami-objectid> --role Contributor ' +
        '--scope /subscriptions/<sub>/resourceGroups/<rg>',
      link: 'https://learn.microsoft.com/azure/machine-learning/how-to-assign-roles',
    },
    steps,
  };
}

/**
 * The create was attempted and did not produce a usable project. States what
 * was TRIED and what came back — never "create the project", which is the
 * instruction #3510 removed and which is now demonstrably not the missing step.
 */
function remediationCreateFailed(project: string, detail: string, steps: string[]): ProvisionResult {
  return {
    status: 'remediation',
    gate: {
      reason: `Loom tried to create AI Foundry project '${project}' and it is still not usable.`,
      remediation:
        `The create was attempted automatically and did not leave a reachable project: ${detail} ` +
        'Confirm LOOM_FOUNDRY_PROJECT / LOOM_FOUNDRY_REGION match the intended workspace name + region, then ' +
        're-run the install.',
      link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/create-projects',
    },
    steps,
  };
}
