/**
 * Phase 2 — shared seeder helper for the Data Pipeline provisioner.
 *
 * After the pipeline item is created/updated from the bundle's activity
 * graph, this helper proves the pipeline is REAL by triggering an
 * on-demand pipeline job run (the documented Fabric "Run on demand
 * pipeline job" REST call) and polling the job-instance history until it
 * reaches a terminal status (Completed / Failed / Cancelled) or a short
 * budget elapses.
 *
 * This is the data-pipeline analogue of kql-db.ts ingesting sample rows
 * and ai-search.ts pushing sample docs: it doesn't just create the
 * artifact, it exercises the live backend so the install receipt shows a
 * real job instance id + status, not a dead shell.
 *
 * All calls are real Fabric REST via fabric-client (no mocks). Run +
 * parameters are documented at:
 *   https://learn.microsoft.com/fabric/data-factory/pipeline-rest-api-capabilities#run-on-demand-pipeline-job
 *   https://learn.microsoft.com/rest/api/fabric/core/job-scheduler/run-on-demand-item-job
 *   https://learn.microsoft.com/rest/api/fabric/core/job-scheduler/get-item-job-instance
 */
import {
  runDataPipeline,
  listJobInstances,
  FabricError,
  type FabricJobInstance,
} from '@/lib/azure/fabric-client';

export interface SeedRunResult {
  /** True when a job instance was successfully triggered. */
  triggered: boolean;
  /** The job instance id, once resolved from the run history. */
  jobInstanceId?: string;
  /** Latest observed status — NotStarted | InProgress | Completed | Failed | Cancelled. */
  status?: string;
  /** Failure detail from Fabric when the run failed. */
  failureReason?: string;
  /** Human-readable step log lines to append to the provisioner's steps[]. */
  steps: string[];
  /**
   * Set when the run could not even be triggered because the UAMI lacks
   * the Item.Execute role / capacity isn't assigned. The provisioner maps
   * this to a remediation gate rather than a hard failure, because the
   * pipeline ITSELF was created successfully.
   */
  authGate?: { status: number; message: string };
}

const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled', 'Deduped']);

/**
 * Bundle pipeline parameters are declared as
 *   { paramName: { type, defaultValue? } }
 * (SynapsePipelineContent / AdfPipelineContent.parameters). The Fabric
 * on-demand run payload accepts a flat `parameters` map of name→value, so
 * we project each declared parameter's defaultValue into the run payload.
 * Parameters with no defaultValue are omitted (Fabric uses the pipeline's
 * own default).
 */
export function buildRunParameters(
  parameters: Record<string, { type?: string; defaultValue?: unknown }> | undefined,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(parameters)) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, 'defaultValue') && spec.defaultValue !== undefined) {
      out[name] = spec.defaultValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Trigger an on-demand run of the pipeline and poll its job-instance
 * history until terminal or the budget elapses. Never throws — returns a
 * structured result the provisioner folds into its ProvisionResult.
 *
 * @param fabricWorkspaceId  the Fabric workspace the pipeline lives in
 * @param pipelineId         the created/updated pipeline item id
 * @param parameters         flat name→value run parameters (already projected)
 * @param opts.maxPolls      max GET-history polls (default 2 — short settle)
 * @param opts.pollMs        delay between polls in ms (default 3000)
 *
 * Settle, don't block: the on-demand run is TRIGGERED via real Fabric REST and
 * keeps running on the capacity. We poll only a few seconds to surface the new
 * job-instance id (and catch an instant auth gate / failure), then return —
 * the install request must finish under the Azure Front Door ~30s gateway
 * window, and a Fabric pipeline run can outlast that. A still-running instance
 * is reported with its live id + InProgress status, not blocked on. Callers
 * needing a longer wait pass opts explicitly (e.g. a background worker).
 */
export async function triggerAndPollPipelineRun(
  fabricWorkspaceId: string,
  pipelineId: string,
  parameters: Record<string, unknown> | undefined,
  opts: { maxPolls?: number; pollMs?: number } = {},
): Promise<SeedRunResult> {
  const steps: string[] = [];
  const maxPolls = opts.maxPolls ?? 2;
  const pollMs = opts.pollMs ?? 3000;

  // Snapshot existing instances so we can identify the NEW one created by
  // our run (Fabric's run-on-demand returns 202 + a Location header but
  // fabric-client surfaces it as { _accepted, location } without parsing
  // the id; the job-instance history is the documented, exported way to
  // resolve + watch the run).
  let before: Set<string> = new Set();
  try {
    const prior = await listJobInstances(fabricWorkspaceId, pipelineId);
    before = new Set(prior.map((j) => j.id).filter(Boolean));
  } catch {
    // history may be empty / not yet available — that's fine.
  }

  // Trigger the run. executionData.parameters carries the run parameters.
  try {
    const execData = parameters ? { parameters } : undefined;
    await runDataPipeline(fabricWorkspaceId, pipelineId, execData);
    steps.push(
      parameters
        ? `Triggered on-demand pipeline run with ${Object.keys(parameters).length} parameter(s).`
        : 'Triggered on-demand pipeline run (no parameters).',
    );
  } catch (e: any) {
    if (e instanceof FabricError && (e.status === 401 || e.status === 403)) {
      return {
        triggered: false,
        steps,
        authGate: { status: e.status, message: e.message },
      };
    }
    steps.push(`On-demand run could not be triggered: ${e?.message || String(e)}`);
    return { triggered: false, steps };
  }

  // Poll the job-instance history for the new instance + terminal status.
  let resolved: FabricJobInstance | undefined;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    let instances: FabricJobInstance[] = [];
    try {
      instances = await listJobInstances(fabricWorkspaceId, pipelineId);
    } catch (e: any) {
      steps.push(`Job-history poll ${i + 1} failed: ${e?.message || String(e)}`);
      continue;
    }
    // Prefer a freshly-created instance; fall back to the newest by start time.
    const fresh = instances.filter((j) => j.id && !before.has(j.id));
    const pool = fresh.length > 0 ? fresh : instances;
    pool.sort((a, b) => (b.startTimeUtc || '').localeCompare(a.startTimeUtc || ''));
    resolved = pool[0];
    if (resolved?.status && TERMINAL.has(resolved.status)) break;
  }

  if (!resolved) {
    steps.push('Run triggered but no job instance surfaced in history within the poll budget (Fabric is still scheduling it).');
    return { triggered: true, steps };
  }

  const status = resolved.status || 'InProgress';
  steps.push(`Pipeline job instance ${resolved.id} → ${status}.`);
  const failureReason =
    resolved.failureReason?.message ||
    (resolved.failureReason?.errorCode ? `errorCode=${resolved.failureReason.errorCode}` : undefined);
  if (failureReason) steps.push(`Failure reason: ${failureReason}`);

  return {
    triggered: true,
    jobInstanceId: resolved.id,
    status,
    failureReason,
    steps,
  };
}
