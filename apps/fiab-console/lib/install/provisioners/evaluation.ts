/**
 * Phase 2 — Evaluation provisioner.
 *
 * Real REST (AML data-plane via foundry-client.createEvaluation):
 *   POST {region}.api.azureml.ms/flow/api/.../workspaces/{project}/evaluations
 *
 * A bundle's `evaluation` content (metrics + datasetRef) is submitted as a
 * real evaluation run against the configured AI Foundry project. The
 * bundle's metric names are mapped to Azure AI evaluation evaluator ids
 * (groundedness, relevance, retrieval, ...). Results are read back later
 * by GET /api/items/evaluation/<id>?project=<project>&results=1.
 *
 * Auth: ChainedTokenCredential (UAMI → DefaultAzureCredential) against
 * the sovereign-cloud ARM `.default` scope.
 *
 * Remediation gates (honest config-only state, per no-vaporware.md) — an
 * evaluation run genuinely needs three pieces of tenant config, each named
 * precisely so an admin can unblock it:
 *   - LOOM_FOUNDRY_PROJECT       (which AML project workspace to run in)
 *   - LOOM_FOUNDRY_EVAL_DATASET  (the registered AML data asset id for the
 *                                 golden Q&A set — the bundle's logical
 *                                 datasetRef is NOT a real asset id)
 *   - LOOM_FOUNDRY_EVAL_DEPLOYMENT (the judge model deployment, e.g. gpt-4o)
 * Plus the 401/403 RBAC gate (AzureML Data Scientist on the project).
 *
 * When all three are set, this calls the real createEvaluation. There is
 * NO hard-coded score path here — scores come from the live run, surfaced
 * by the evaluation editor / GET results route.
 */
import { createEvaluation, FoundryError } from '@/lib/azure/foundry-client';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

/**
 * Map a bundle metric name to an Azure AI evaluation evaluator id.
 * Unknown metrics fall through to themselves so a custom evaluator
 * registered under the same name still resolves.
 */
const EVALUATOR_BY_METRIC: Record<string, string> = {
  groundedness: 'groundedness',
  retrieval_recall: 'retrieval',
  retrieval_precision: 'retrieval',
  answer_relevance: 'relevance',
  citation_coverage: 'groundedness', // citation coverage rides the groundedness judge
  latency_p95: 'latency',
  hallucination_rate: 'groundedness',
};

export const evaluationProvisioner: Provisioner = async (input): Promise<ProvisionResult> => {
  const steps: string[] = [];
  const content = input.content as any;
  if (content?.kind !== 'evaluation' || !Array.isArray(content?.metrics)) {
    return { status: 'skipped', steps: ['No evaluation content in bundle; nothing to provision.'] };
  }

  const project = process.env.LOOM_FOUNDRY_PROJECT;
  const datasetId = process.env.LOOM_FOUNDRY_EVAL_DATASET;
  const modelDeployment = process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT;

  const missing: string[] = [];
  if (!project) missing.push('LOOM_FOUNDRY_PROJECT (AI Foundry project workspace name)');
  if (!datasetId) missing.push('LOOM_FOUNDRY_EVAL_DATASET (registered AML data asset id for the golden Q&A set)');
  if (!modelDeployment) missing.push('LOOM_FOUNDRY_EVAL_DEPLOYMENT (judge model deployment, e.g. gpt-4o)');
  if (missing.length > 0) {
    return {
      status: 'remediation',
      gate: {
        reason: 'AI Foundry evaluation is not fully configured in this deployment.',
        remediation:
          'Set the following env var(s) so a real evaluation run can be submitted: ' +
          missing.join('; ') +
          '. Until then the evaluation item renders read-only (metric definitions + dataset ref) with no fabricated scores.',
        link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk',
      },
      steps,
    };
  }

  // Distinct evaluator ids derived from the bundle's metrics.
  const evaluatorIds = Array.from(
    new Set(
      content.metrics.map((m: any) => EVALUATOR_BY_METRIC[m?.name] || m?.name).filter(Boolean),
    ),
  ) as string[];
  steps.push(`Evaluators: ${evaluatorIds.join(', ')}`);
  steps.push(`Dataset: ${datasetId} | Judge: ${modelDeployment}`);

  try {
    const created = await createEvaluation(project as string, {
      displayName: input.displayName,
      datasetId: datasetId as string,
      modelDeployment: modelDeployment as string,
      evaluatorIds,
    });
    const evalId = (created as any)?.id || (created as any)?.evaluationId;
    steps.push(`Submitted evaluation run ${evalId}.`);
    return {
      status: 'created',
      resourceId: evalId,
      secondaryIds: {
        project: project as string,
        resultsRoute: `/api/items/evaluation/${evalId}?project=${project}&results=1`,
      },
      steps,
    };
  } catch (e: any) {
    if (e instanceof FoundryError && (e.status === 401 || e.status === 403)) {
      return {
        status: 'remediation',
        gate: {
          reason: `Evaluation data-plane returned ${e.status} for project '${project}'.`,
          remediation:
            'Grant the Console UAMI "AzureML Data Scientist" on the project workspace: ' +
            'az role assignment create --assignee <uami-objectid> --role "AzureML Data Scientist" ' +
            '--scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.MachineLearningServices/workspaces/' + project,
          link: 'https://learn.microsoft.com/azure/machine-learning/how-to-assign-roles',
        },
        steps,
      };
    }
    if (e instanceof FoundryError && e.status === 404) {
      return {
        status: 'remediation',
        gate: {
          reason: `AI Foundry project '${project}' or dataset '${datasetId}' not found.`,
          remediation:
            'Confirm LOOM_FOUNDRY_PROJECT names an existing project and LOOM_FOUNDRY_EVAL_DATASET is a registered AML data asset id in that project.',
          link: 'https://learn.microsoft.com/azure/ai-foundry/how-to/develop/evaluate-sdk',
        },
        steps,
      };
    }
    return resolveInfraResidual(e, `Confirm LOOM_FOUNDRY_PROJECT names an existing AI Foundry project and grant the Console UAMI "AzureML Data Scientist" on the project workspace '${project}'.`, { link: 'https://learn.microsoft.com/azure/machine-learning/how-to-assign-roles', steps });
  }
};
