/**
 * E5 — "Run now" for the copilot-evaluator, via an ARM Container-App-Job start.
 *
 * The admin /admin/copilot-quality page's "Run now" button POSTs the BFF route,
 * which calls this module; this module starts a REAL execution of the in-VNet
 * `loom-copilot-evaluator` Container App Job
 * (modules/admin-plane/copilot-evaluator-job.bicep) with an execution-template
 * override carrying the requested mode / surfaces / domains.
 *
 * B-FN migration (2026-07-27): the evaluator used to be a Y1 Consumption
 * Function with an authLevel='function' HTTP trigger, and this module POSTed
 * `{LOOM_COPILOT_EVALUATOR_URL}/api/copilotEvaluatorHttp` with a host key. Y1 is
 * structurally broken on this estate (Azure Policy seals the storage
 * data-plane — publicNetworkAccess Disabled, AAD-only, no private endpoint —
 * and the multitenant Y1 runtime is not a trusted service, so host keys and
 * timer leases fail), so the evaluator is now an ACA job. Consequences:
 *   • no host key and no public *.azurewebsites.net surface to protect;
 *   • auth is the Console UAMI's Azure RBAC (Contributor scoped to that ONE job
 *     resource, granted in the job module — the role Learn documents as
 *     required for the start operation);
 *   • the run parameters ride an execution-template override instead of a JSON
 *     body. Per Learn the override REPLACES the whole template, so we read the
 *     job's current template first and merge our env on top of it — never a
 *     hand-built container spec (that would silently drop the image, the
 *     Cosmos/AOAI env, and the internal-token secretRef).
 *
 * Honest-gate (no-vaporware.md): when the job id is unset OR ARM rejects the
 * call, this returns a structured gate/error the route surfaces verbatim —
 * NEVER a fabricated "run started". Azure-native, no Fabric dependency.
 */
import { armGet, armPost } from '@/lib/azure/arm-client';

/** Container Apps API version for the job read + start operations (GA). */
const ACA_JOBS_API = '2024-03-01';

/** Fixed job name — set by copilot-evaluator-job.bicep. */
export const EVALUATOR_JOB_NAME = 'loom-copilot-evaluator';

/** The evaluator job's ARM resource id (bicep-wired from the job module). */
export function evaluatorJobId(): string {
  return (process.env.LOOM_COPILOT_EVALUATOR_JOB_ID || '').trim().replace(/\/+$/, '');
}

export interface EvaluatorGate {
  gated: true;
  gateId: 'svc-copilot-evaluator';
  missing: string[];
  remediation: string;
}

/** Honest config gate — null when the job id is present, else the gate. */
export function evaluatorRunGate(): EvaluatorGate | null {
  if (evaluatorJobId()) return null;
  return {
    gated: true,
    gateId: 'svc-copilot-evaluator',
    missing: ['LOOM_COPILOT_EVALUATOR_JOB_ID'],
    remediation:
      'Deploy the copilot-evaluator Container App Job (modules/admin-plane/copilot-evaluator-job.bicep, default-ON via functionAppsConfig.copilotEvaluatorEnabled) and build its image with scripts/csa-loom/deploy-copilot-evaluator-job.sh. LOOM_COPILOT_EVALUATOR_JOB_ID is then wired onto the Console automatically and "Run now" starts an execution. Nightly runs happen on the job schedule regardless of this button.',
  };
}

export interface TriggerRunInput {
  surfaces?: string[];
  trigger?: 'manual' | 'corpus';
  /** SRCH1 'search' → federated-search relevance evals; E6 'tier' → tier-router
   *  decision evals; default 'copilot' → the answer-quality evals. */
  mode?: 'copilot' | 'search' | 'tier';
  /** Search domains to run (mode 'search'); empty = all. */
  domains?: string[];
}

export interface TriggerRunResult {
  ok: boolean;
  status: number;
  /** The ARM start response (`{id, name, ...}` for the new execution) when JSON. */
  body: unknown;
  error?: string;
}

/** One container env entry as ARM returns / accepts it. */
export interface JobEnvVar {
  name: string;
  value?: string;
  secretRef?: string;
}

/** One container of a job execution template. */
export interface JobContainer {
  name?: string;
  image?: string;
  command?: string[];
  args?: string[];
  resources?: unknown;
  env?: JobEnvVar[];
}

/**
 * Merge the run parameters onto the job's CURRENT container template.
 *
 * Pure + exported so the override contract is unit-tested: the returned
 * containers keep the image, resources, command and every pre-existing env
 * entry (including `secretRef` ones such as the internal token) and only
 * replace/append the four COPILOT_EVAL_* run knobs the entrypoint reads.
 */
export function mergeRunEnv(containers: JobContainer[], input: TriggerRunInput): JobContainer[] {
  const trigger = input.trigger === 'corpus' ? 'corpus' : 'manual';
  const mode = input.mode === 'search' ? 'search' : input.mode === 'tier' ? 'tier' : 'copilot';
  const overrides: JobEnvVar[] = [
    { name: 'COPILOT_EVAL_MODE', value: mode },
    { name: 'COPILOT_EVAL_TRIGGER', value: trigger },
    {
      name: 'COPILOT_EVAL_SURFACES',
      value: mode === 'copilot' && Array.isArray(input.surfaces) ? input.surfaces.filter(Boolean).join(',') : '',
    },
    {
      name: 'COPILOT_EVAL_DOMAINS',
      value: mode === 'search' && Array.isArray(input.domains) ? input.domains.filter(Boolean).join(',') : '',
    },
  ];

  return containers.map((c) => {
    const kept = (c.env || []).filter((e) => !overrides.some((o) => o.name === e.name));
    return { ...c, env: [...kept, ...overrides] };
  });
}

/**
 * Start an on-demand evaluator execution. Returns the ARM start response; never
 * throws — a missing job, a 403 (the Console UAMI lacks Contributor on the job)
 * or any other ARM failure becomes `{ ok:false, status, error }` so the route
 * surfaces an honest message. `surfaces` empty ⇒ the execution runs every eval
 * set for the requested mode.
 */
export async function triggerEvaluatorRun(input: TriggerRunInput): Promise<TriggerRunResult> {
  const jobId = evaluatorJobId();
  if (!jobId) return { ok: false, status: 503, body: null, error: 'LOOM_COPILOT_EVALUATOR_JOB_ID not set' };

  // 1. Read the job's current execution template. A start-with-override
  //    REPLACES the template wholesale (Learn), so we must start from the real
  //    one rather than inventing a container spec.
  let containers: JobContainer[];
  try {
    const job = await armGet<{ properties?: { template?: { containers?: JobContainer[] } } }>(
      `${jobId}?api-version=${ACA_JOBS_API}`,
    );
    containers = job?.properties?.template?.containers || [];
    if (!containers.length) {
      return {
        ok: false,
        status: 502,
        body: null,
        error: `Container App Job ${EVALUATOR_JOB_NAME} has no container template — its image has not been built/deployed yet.`,
      };
    }
  } catch (e) {
    return { ok: false, status: 502, body: null, error: e instanceof Error ? e.message : String(e) };
  }

  // 2. Start an execution with the run knobs merged onto that template.
  try {
    const body = await armPost<{ id?: string; name?: string }>(`${jobId}/start?api-version=${ACA_JOBS_API}`, {
      containers: mergeRunEnv(containers, input),
    });
    return { ok: true, status: 202, body };
  } catch (e) {
    return { ok: false, status: 502, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}
