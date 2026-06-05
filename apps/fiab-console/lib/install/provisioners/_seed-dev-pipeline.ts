/**
 * Phase 2 — shared seeder helper for the Synapse-pipeline and ADF-pipeline
 * provisioners.
 *
 * Both Synapse Studio's pipeline dev REST and ADF's ARM REST expose the SAME
 * pipeline contract: PUT /pipelines/{name} to upsert, POST
 * /pipelines/{name}/createRun → { runId }, and POST /queryPipelineRuns to poll
 * the run status. This helper drives that shared shape against either client
 * (passed in as a small adapter) so the two provisioners stay DRY and behave
 * identically: upsert the bundle's activity graph as a REAL pipeline, then
 * prove it's real by triggering an on-demand run and short-polling its status.
 *
 * "Settle, don't block": the run is TRIGGERED via real REST and keeps
 * executing on the service. We poll only a few seconds to surface the new
 * runId (and catch an instant auth gate / failure), then return — the install
 * request must finish under the Azure Front Door ~30s gateway window, and a
 * pipeline run can outlast that. A still-running run is reported with its live
 * runId + InProgress status, NOT blocked on. This is the dev-pipeline analogue
 * of _seed-data-pipeline.ts (Fabric) and _seed-databricks.ts (Databricks).
 *
 * Docs:
 *   https://learn.microsoft.com/cli/azure/synapse/pipeline#az-synapse-pipeline-create-run
 *   https://learn.microsoft.com/azure/data-factory/quickstart-create-data-factory-rest-api#create-pipeline-run
 *   https://learn.microsoft.com/azure/synapse-analytics/monitoring/how-to-monitor-pipeline-runs
 */

/** Minimal status shape both clients return from a run-history query. */
export interface DevPipelineRunStatus {
  runId: string;
  status?: string;
  message?: string;
}

/** Pipeline `properties` payload — matches the Synapse/ADF client shape
 * (activities + the portal-shaped parameter declarations). */
export interface DevPipelineProperties {
  activities: unknown[];
  parameters?: Record<string, { type: string; defaultValue?: unknown }>;
}

/** Adapter the provisioner hands us so this helper stays client-agnostic. */
export interface DevPipelineAdapter {
  /** Friendly backend label for step logs, e.g. "Synapse" / "ADF". */
  label: string;
  /** PUT the pipeline (create or update by name). */
  upsert(name: string, properties: DevPipelineProperties): Promise<void>;
  /** POST createRun → resolve the new runId. params is a flat name→value map. */
  createRun(name: string, params?: Record<string, unknown>): Promise<string>;
  /** Resolve the latest run status for the given runId (best-effort). */
  getRunStatus(runId: string): Promise<DevPipelineRunStatus | undefined>;
}

export interface DevPipelineSeedResult {
  /** True once the pipeline was upserted. */
  upserted: boolean;
  /** The pipeline name we created/updated. */
  pipelineName?: string;
  /** True once a run was triggered. */
  triggered: boolean;
  /** The run id, once createRun returns it. */
  runId?: string;
  /** Latest observed status — Queued | InProgress | Succeeded | Failed | ... */
  status?: string;
  /** Human-readable step log lines to append to the provisioner's steps[]. */
  steps: string[];
  /**
   * Set when an operation failed with 401/403 — the surrounding tenant RBAC
   * isn't in place. The provisioner maps this to a remediation gate (the
   * action is precise and one-time) rather than a bare failure.
   */
  authGate?: { status: number; message: string };
  /** Set when a non-auth REST error occurred; provisioner reports as failed. */
  error?: string;
}

/** Pull an HTTP status out of the client error messages, which are formatted
 * `"<label> failed <status>: <body>"` by both clients' jsonOrThrow. */
function statusFromError(msg: string): number | undefined {
  const m = msg.match(/failed\s+(\d{3})\b/);
  return m ? Number(m[1]) : undefined;
}

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'Cancelling']);

/** Project bundle pipeline parameters
 *   { name: { type, defaultValue? } }
 * into the flat name→value map createRun accepts. Parameters without a
 * defaultValue are omitted (the service uses the pipeline's own default). */
export function buildDevRunParameters(
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
 * Translate the bundle's activity graph (synapse-pipeline / adf-pipeline
 * content) into the Synapse/ADF pipeline `properties` shape. The bundle stores
 * each activity as { name, type, dependsOn?: string[], config } where `config`
 * is the activity's typeProperties + any peers (policy, linkedServiceName,
 * inputs, outputs). The Synapse/ADF wire format wants those hoisted to the
 * activity root with the engine-specific bits under typeProperties — we keep
 * the bundle's already-portal-shaped config under typeProperties and lift the
 * well-known siblings so the activity validates in Studio.
 */
export function buildDevPipelineProperties(content: any): DevPipelineProperties {
  const activities = Array.isArray(content?.activities) ? content.activities : [];
  return {
    activities: activities.map((a: any) => {
      const cfg = a?.config && typeof a.config === 'object' ? { ...a.config } : {};
      // Lift the well-known activity-root siblings out of config; whatever
      // remains is the activity's typeProperties.
      const { policy, linkedServiceName, inputs, outputs, description, ...typeProperties } = cfg;
      return {
        name: a.name,
        type: a.type,
        ...(description ? { description } : {}),
        ...(Array.isArray(a.dependsOn) && a.dependsOn.length > 0
          ? { dependsOn: a.dependsOn.map((d: string) => ({ activity: d, dependencyConditions: ['Succeeded'] })) }
          : {}),
        ...(policy ? { policy } : {}),
        ...(linkedServiceName ? { linkedServiceName } : {}),
        ...(inputs ? { inputs } : {}),
        ...(outputs ? { outputs } : {}),
        typeProperties,
      };
    }),
    ...(content?.parameters ? { parameters: content.parameters } : {}),
  };
}

/**
 * Upsert the pipeline, trigger an on-demand run, and short-poll its status.
 * Never throws — returns a structured result the provisioner folds into its
 * ProvisionResult.
 */
export async function upsertAndRunDevPipeline(
  adapter: DevPipelineAdapter,
  pipelineName: string,
  content: any,
  opts: { maxPolls?: number; pollMs?: number } = {},
): Promise<DevPipelineSeedResult> {
  const steps: string[] = [];
  const maxPolls = opts.maxPolls ?? 2;
  const pollMs = opts.pollMs ?? 3000;
  const props = buildDevPipelineProperties(content);
  const runParams = buildDevRunParameters(content?.parameters);

  // 1) Upsert the pipeline (create or update by name).
  try {
    await adapter.upsert(pipelineName, props);
    steps.push(`${adapter.label}: upserted pipeline '${pipelineName}' (${props.activities.length} activities).`);
  } catch (e: any) {
    const msg = e?.message || String(e);
    const status = statusFromError(msg);
    if (status === 401 || status === 403) {
      return { upserted: false, triggered: false, steps, authGate: { status, message: msg } };
    }
    return { upserted: false, triggered: false, steps, error: msg };
  }

  // 2) Trigger an on-demand run.
  let runId: string | undefined;
  try {
    runId = await adapter.createRun(pipelineName, runParams);
    steps.push(
      runParams
        ? `${adapter.label}: triggered on-demand run ${runId} with ${Object.keys(runParams).length} parameter(s).`
        : `${adapter.label}: triggered on-demand run ${runId}.`,
    );
  } catch (e: any) {
    const msg = e?.message || String(e);
    const status = statusFromError(msg);
    if (status === 401 || status === 403) {
      // Pipeline ITSELF was created; only the run couldn't be authorized.
      return { upserted: true, pipelineName, triggered: false, steps, authGate: { status, message: msg } };
    }
    steps.push(`${adapter.label}: on-demand run could not be triggered: ${msg}`);
    return { upserted: true, pipelineName, triggered: false, steps };
  }

  // 3) Short-poll the run status — settle, don't block.
  let status: string | undefined;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const s = await adapter.getRunStatus(runId);
      status = s?.status;
      if (s?.message) steps.push(`${adapter.label}: run message — ${s.message}`);
      if (status && TERMINAL.has(status)) break;
    } catch (e: any) {
      steps.push(`${adapter.label}: run-status poll ${i + 1} failed: ${e?.message || String(e)}`);
    }
  }
  steps.push(`${adapter.label}: pipeline run ${runId} → ${status || 'InProgress'} (still executing if not terminal).`);

  return { upserted: true, pipelineName, triggered: true, runId, status, steps };
}
