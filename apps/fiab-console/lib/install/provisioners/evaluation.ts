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
 * THE JUDGE MODEL IS RESOLVED, NEVER REQUESTED (#3508, auto-bind-by-default).
 * `LOOM_FOUNDRY_EVAL_DEPLOYMENT` used to be a hard gate. It is set by NO bicep
 * module in this repo — `git grep LOOM_FOUNDRY_EVAL_DEPLOYMENT -- platform/fiab/bicep`
 * returns zero — so on every deployment the platform builds, that gate fired and
 * asked the customer to go set a value by hand. Meanwhile admin-plane bicep
 * already wires `LOOM_AOAI_DEPLOYMENT` (main.bicep:5892) from the Foundry
 * account's default chat deployment, and every other AI surface in Loom resolves
 * its model through `tierPolicyFromConfig()`'s `standard` tier, whose chain is
 * exactly `LOOM_AOAI_DEPLOYMENT → LOOM_AOAI_CHAT_DEPLOYMENT`. The platform had
 * the value the gate was asking for. Per auto-bind-by-default.md §5 an honest
 * gate over a value the deploy could have supplied is a DEFECT, not a compliant
 * state, so the deployment override is now an override and the standard tier is
 * the default. Which source supplied it is recorded in `steps`, so the binding
 * is inspectable rather than guessed.
 *
 * Remediation gates (honest config-only state, per no-vaporware.md) — an
 * evaluation run genuinely needs two pieces of tenant config the platform
 * cannot supply, each named precisely so an admin can unblock it:
 *   - LOOM_FOUNDRY_PROJECT       (which AML project workspace to run in)
 *   - LOOM_FOUNDRY_EVAL_DATASET  (the registered AML data asset id for the
 *                                 golden Q&A set — the bundle's logical
 *                                 datasetRef is NOT a real asset id, and a
 *                                 golden Q&A set is CONTENT, not infrastructure:
 *                                 nothing the platform deploys can author it)
 * Plus the 401/403 RBAC gate (AzureML Data Scientist on the project).
 *
 * When those are set, this calls the real createEvaluation. There is
 * NO hard-coded score path here — scores come from the live run, surfaced
 * by the evaluation editor / GET results route.
 */
import { createEvaluation, FoundryError } from '@/lib/azure/foundry-client';
import { tierPolicyFromConfig } from '@/lib/foundry/model-tier-router';
import type { Provisioner, ProvisionResult } from './types';
import { resolveInfraResidual } from './types';

/**
 * The judge model deployment, and WHERE it came from.
 *
 * Order: the explicit eval override, then the platform's own standard tier
 * (`LOOM_AOAI_DEPLOYMENT` → `LOOM_AOAI_CHAT_DEPLOYMENT`), resolved by the same
 * function the Copilot surfaces use so the two can never disagree. No tenant
 * config and no live-deployment context is passed: this runs during install,
 * where neither is available, and the env chain is what bicep guarantees.
 *
 * Returns `source: null` only when the deployment genuinely has no chat model
 * wired at all — a real infrastructure gap, not a value the platform withheld.
 */
export function resolveJudgeDeployment(): { deployment: string | undefined; source: string | null } {
  const override = (process.env.LOOM_FOUNDRY_EVAL_DEPLOYMENT || '').trim();
  if (override) return { deployment: override, source: 'LOOM_FOUNDRY_EVAL_DEPLOYMENT' };
  const standard = tierPolicyFromConfig(null).tiers.standard;
  if (standard) {
    const via = (process.env.LOOM_AOAI_DEPLOYMENT || '').trim()
      ? 'LOOM_AOAI_DEPLOYMENT'
      : 'LOOM_AOAI_CHAT_DEPLOYMENT';
    return { deployment: standard, source: `${via} (platform standard tier)` };
  }
  return { deployment: undefined, source: null };
}

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
  const { deployment: modelDeployment, source: judgeSource } = resolveJudgeDeployment();

  const missing: string[] = [];
  if (!project) missing.push('LOOM_FOUNDRY_PROJECT (AI Foundry project workspace name)');
  if (!datasetId) missing.push('LOOM_FOUNDRY_EVAL_DATASET (registered AML data asset id for the golden Q&A set)');
  // NOT `LOOM_FOUNDRY_EVAL_DEPLOYMENT` — see the header. This condition is
  // reached only when the deployment has NO chat model wired at all, which is a
  // genuine infrastructure gap, so the remediation names the var bicep actually
  // sets rather than one nothing sets.
  if (!modelDeployment) {
    missing.push(
      'LOOM_AOAI_DEPLOYMENT (the Foundry chat deployment — normally wired by admin-plane bicep; ' +
        'LOOM_FOUNDRY_EVAL_DEPLOYMENT overrides it if you want a different judge model)',
    );
  }
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
  // The judge's PROVENANCE is part of the receipt: auto-bind-by-default.md §2
  // requires a binding the platform made for you to be inspectable, not guessed.
  steps.push(`Dataset: ${datasetId} | Judge: ${modelDeployment} (from ${judgeSource})`);

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
