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
  /** Optional — PUT a linked service (to satisfy a pipeline's references). */
  upsertLinkedService?(name: string, properties: Record<string, unknown>): Promise<void>;
  /** Optional — PUT a dataset (to satisfy a pipeline's DatasetReferences). */
  upsertDataset?(name: string, properties: Record<string, unknown>): Promise<void>;
}

/** A linked-service / dataset reference discovered in a pipeline's activities. */
interface PipelineRefs {
  linkedServices: Set<string>;
  /** dataset name → set of parameter names the pipeline passes to it. */
  datasets: Map<string, Set<string>>;
}

/** Recursively walk an activity graph collecting every LinkedServiceReference
 * and DatasetReference (with the parameter names passed to each dataset). The
 * bundle nests activities under `config.activities` (Until/ForEach/If), so we
 * descend into any `activities` array we find. */
export function collectPipelineRefs(content: any): PipelineRefs {
  const linkedServices = new Set<string>();
  const datasets = new Map<string, Set<string>>();
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'LinkedServiceReference' && typeof node.referenceName === 'string') {
      linkedServices.add(node.referenceName);
    }
    if (node.type === 'DatasetReference' && typeof node.referenceName === 'string') {
      const params = datasets.get(node.referenceName) || new Set<string>();
      if (node.parameters && typeof node.parameters === 'object') {
        for (const k of Object.keys(node.parameters)) params.add(k);
      }
      datasets.set(node.referenceName, params);
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(content?.activities);
  return { linkedServices, datasets };
}

/**
 * Databricks-family activity types. Synapse Studio / ADF REJECT any of these
 * with a schema-validation 400 unless the activity carries a
 * `linkedServiceName` reference to an AzureDatabricks linked service — a
 * `notebookPath` / `pythonFile` alone is NOT sufficient. Several content
 * bundles (RTA "Daily Batch Processing Pipeline", ml-pipeline "MLOps
 * Orchestration Pipeline") emit these activities with only the type-properties
 * and no linkedServiceName, which turned a legitimate honest-gate condition
 * ("no Databricks bound on this estate") into a hard install `status:'failed'`.
 * We normalize those activities to carry a canonical reference so the graph is
 * either satisfiable (Databricks wired → auto-stub the LS) or cleanly gated
 * (no Databricks → precise remediation) — never a bare PUT 400.
 */
const DATABRICKS_ACTIVITY_TYPES = new Set([
  'DatabricksNotebook',
  'DatabricksSparkJar',
  'DatabricksSparkPython',
  'DatabricksJar',
  'DatabricksPython',
]);

/** Canonical name for the auto-injected / auto-stubbed Databricks linked
 * service when a Databricks activity omits its own. */
export const CANONICAL_DATABRICKS_LS = 'AzureDatabricks_LinkedService';

/** Resolve the opt-in Databricks workspace domain (https URL, no trailing
 * slash) from env, or null when Databricks isn't wired on this estate.
 * Databricks is an Azure-native compute — this is NOT a Fabric dependency. */
function databricksDomain(): string | null {
  const raw = process.env.LOOM_DATABRICKS_HOSTNAME || process.env.LOOM_DATABRICKS_WORKSPACE_URL;
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host ? `https://${host}` : null;
}

/** Minimal, schema-valid AzureDatabricks linked service for the stub. Uses MSI
 * auth (the Console UAMI) + a job-cluster spec so the pipeline document
 * validates on PUT. Best-effort: if the estate rejects it, the caller falls
 * through to an honest remediation gate rather than a hard failure. */
function buildDatabricksLinkedService(domain: string): Record<string, unknown> {
  const workspaceResourceId = process.env.LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID;
  return {
    type: 'AzureDatabricks',
    typeProperties: {
      domain,
      authentication: 'MSI',
      ...(workspaceResourceId ? { workspaceResourceId } : {}),
      newClusterNodeType: 'Standard_DS3_v2',
      newClusterVersion: '13.3.x-scala2.12',
      newClusterNumOfWorker: '1',
    },
    annotations: ['loom-autoprovisioned'],
  };
}

/**
 * Deep-clone the bundle content and ensure every Databricks-family activity
 * carries a `config.linkedServiceName` (ADF/Synapse require it). We NEVER
 * mutate the shared bundle object — installs run concurrently and the content
 * is registry-owned. Returns the normalized clone plus the set of Databricks
 * linked-service names now referenced (usually just CANONICAL_DATABRICKS_LS,
 * unless a bundle already named its own). Descends into nested activity
 * containers (Until / ForEach / If under `config.activities`).
 */
export function normalizePipelineContent(rawContent: any): { content: any; databricksLs: Set<string> } {
  const databricksLs = new Set<string>();
  // structuredClone is available in the Node runtime + vitest env; fall back to
  // JSON round-trip for exotic shapes (content is plain JSON anyway).
  let content: any;
  try {
    content = typeof structuredClone === 'function' ? structuredClone(rawContent) : JSON.parse(JSON.stringify(rawContent));
  } catch {
    content = JSON.parse(JSON.stringify(rawContent ?? {}));
  }
  const preferredLs = process.env.LOOM_DATABRICKS_LINKED_SERVICE || CANONICAL_DATABRICKS_LS;
  const visit = (list: any): void => {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      if (!a || typeof a !== 'object') continue;
      if (typeof a.type === 'string' && DATABRICKS_ACTIVITY_TYPES.has(a.type)) {
        const cfg = a.config && typeof a.config === 'object' ? a.config : (a.config = {});
        const ref = cfg.linkedServiceName;
        if (!ref || typeof ref !== 'object' || typeof ref.referenceName !== 'string') {
          cfg.linkedServiceName = { referenceName: preferredLs, type: 'LinkedServiceReference' };
        }
        databricksLs.add(cfg.linkedServiceName.referenceName);
      }
      // Descend into control-flow activity containers.
      if (a.config && Array.isArray(a.config.activities)) visit(a.config.activities);
      if (Array.isArray(a.activities)) visit(a.activities);
    }
  };
  visit(Array.isArray(content?.activities) ? content.activities : []);
  return { content, databricksLs };
}

/** Best-effort ADLS Gen2 endpoint for the stub linked service — derived from
 * the DLZ container env vars. A placeholder still commits (Synapse validates
 * reference existence, not connectivity, at PUT time). */
function adlsStubUrl(): string {
  for (const k of ['LOOM_LANDING_URL', 'LOOM_BRONZE_URL', 'LOOM_SILVER_URL', 'LOOM_GOLD_URL']) {
    const v = process.env[k];
    const m = v && v.match(/^https:\/\/([^/]+)/i);
    if (m) return `https://${m[1]}`;
  }
  const acct = process.env.LOOM_ADLS_ACCOUNT;
  if (acct) return `https://${acct}.dfs.core.windows.net`;
  return 'https://loomdlzstub.dfs.core.windows.net';
}

/**
 * Auto-provision minimal valid stubs for every linked service + dataset the
 * pipeline references, so the pipeline document validates on commit. Linked
 * services are AzureBlobFS (workspace MI auth); datasets are parameterized
 * DelimitedText on the first referenced ADLS linked service. Best-effort: each
 * failure is logged and skipped (the pipeline upsert then surfaces an honest
 * gate). No-op when the adapter doesn't support reference upserts. */
async function ensurePipelineReferences(
  adapter: DevPipelineAdapter,
  content: any,
  databricksLs: Set<string>,
  steps: string[],
): Promise<{ unresolvedDatabricks: string[]; authGate?: { status: number; message: string } }> {
  // No reference-upsert surface on this adapter: any Databricks activity is
  // unresolvable here (caller gates). Non-Databricks refs are left to the PUT.
  if (!adapter.upsertLinkedService || !adapter.upsertDataset) {
    return { unresolvedDatabricks: [...databricksLs] };
  }
  const refs = collectPipelineRefs(content);

  // ── Databricks linked services need an AzureDatabricks-typed LS (NOT the
  //    AzureBlobFS stub used for ADLS refs). Auto-stub from the opt-in
  //    LOOM_DATABRICKS_HOSTNAME; if that's absent (or the operator points us at
  //    an already-registered LS via LOOM_DATABRICKS_LINKED_SERVICE), we don't
  //    fabricate one — the caller turns any residual into an honest gate.
  const unresolvedDatabricks: string[] = [];
  const preRegistered = process.env.LOOM_DATABRICKS_LINKED_SERVICE; // operator-supplied existing LS
  const domain = databricksDomain();
  for (const ls of databricksLs) {
    if (preRegistered && ls === preRegistered) {
      // Operator asserts this LS already exists in the workspace — trust it.
      steps.push(`${adapter.label}: using operator-registered Databricks linked service '${ls}'.`);
      continue;
    }
    if (!domain) { unresolvedDatabricks.push(ls); continue; }
    try {
      await adapter.upsertLinkedService(ls, buildDatabricksLinkedService(domain));
      steps.push(`${adapter.label}: ensured Databricks linked service '${ls}' → ${domain}.`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      const status = statusFromError(msg);
      // An auth failure authoring the LS is an RBAC gate, not a missing
      // reference — surface it precisely so the operator grants the role.
      if (status === 401 || status === 403) {
        return { unresolvedDatabricks, authGate: { status, message: msg } };
      }
      steps.push(`${adapter.label}: could not auto-create Databricks linked service '${ls}': ${msg}`);
      unresolvedDatabricks.push(ls);
    }
  }
  // A Databricks activity that can't bind its LS on this estate → the pipeline
  // PUT would 400. Short-circuit to an honest gate; skip the rest of the stubs.
  if (unresolvedDatabricks.length > 0) return { unresolvedDatabricks };

  // ── ADLS / dataset stubs (unchanged) for every NON-Databricks reference. ──
  const nonDbxLinkedServices = [...refs.linkedServices].filter((n) => !databricksLs.has(n));
  if (nonDbxLinkedServices.length === 0 && refs.datasets.size === 0) return { unresolvedDatabricks: [] };
  const url = adlsStubUrl();
  const lsList = nonDbxLinkedServices;
  for (const ls of lsList) {
    try {
      await adapter.upsertLinkedService(ls, {
        type: 'AzureBlobFS',
        typeProperties: { url },
        annotations: ['loom-autoprovisioned'],
      });
    } catch (e: any) {
      steps.push(`${adapter.label}: could not auto-create linked service '${ls}': ${e?.message || e}`);
    }
  }
  const defaultLs = lsList.find((n) => /adls|blob|storage|gen2/i.test(n)) || lsList[0] || 'ls_loom_adls';
  // Ensure a fallback ADLS linked service exists for datasets even if the
  // pipeline only referenced non-ADLS linked services.
  if (!refs.linkedServices.has(defaultLs)) {
    try {
      await adapter.upsertLinkedService(defaultLs, { type: 'AzureBlobFS', typeProperties: { url }, annotations: ['loom-autoprovisioned'] });
    } catch { /* best-effort */ }
  }
  for (const [ds, paramNames] of refs.datasets) {
    const parameters: Record<string, { type: string }> = {};
    for (const p of paramNames) parameters[p] = { type: 'String' };
    try {
      await adapter.upsertDataset(ds, {
        type: 'DelimitedText',
        linkedServiceName: { referenceName: defaultLs, type: 'LinkedServiceReference' },
        ...(paramNames.size > 0 ? { parameters } : {}),
        typeProperties: {
          location: { type: 'AzureBlobFSLocation', fileSystem: 'landing' },
          columnDelimiter: ',',
          firstRowAsHeader: true,
        },
        annotations: ['loom-autoprovisioned'],
      });
    } catch (e: any) {
      steps.push(`${adapter.label}: could not auto-create dataset '${ds}': ${e?.message || e}`);
    }
  }
  steps.push(`${adapter.label}: ensured ${lsList.length} linked service(s) + ${refs.datasets.size} dataset(s) the pipeline references.`);
  return { unresolvedDatabricks: [] };
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
  /** Set when the pipeline still references an artifact that couldn't be
   * auto-created (e.g. a Databricks linked service on an estate without
   * Databricks). The provisioner maps this to a precise remediation gate. */
  needsReference?: { message: string };
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
/**
 * Synapse/ADF's commit validator textually scans EVERY string in the doc —
 * including plain-prose `description` fields — for `@pipeline().parameters.X`
 * references and fails the PUT when X isn't a defined parameter. Its parser is
 * greedy across spaces (a description saying "targets the
 * @pipeline().parameters.targetWorkspace warehouse" fails with
 * "Missing parameter definition for 'targetWorkspace warehouse'", #1576).
 * Descriptions are documentation, not expressions — strip the expression `@`
 * so the prose survives verbatim minus the trigger.
 */
function sanitizeDescription(d: unknown): string | undefined {
  if (typeof d !== 'string' || !d) return undefined;
  return d.replace(/@(?=pipeline\(\))/g, '');
}

export function buildDevPipelineProperties(content: any): DevPipelineProperties {
  const activities = Array.isArray(content?.activities) ? content.activities : [];
  return {
    activities: activities.map((a: any) => {
      const cfg = a?.config && typeof a.config === 'object' ? { ...a.config } : {};
      // Lift the well-known activity-root siblings out of config; whatever
      // remains is the activity's typeProperties.
      const { policy, linkedServiceName, inputs, outputs, description: rawDescription, ...typeProperties } = cfg;
      const description = sanitizeDescription(rawDescription);
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
  rawContent: any,
  opts: { maxPolls?: number; pollMs?: number } = {},
): Promise<DevPipelineSeedResult> {
  const steps: string[] = [];
  const maxPolls = opts.maxPolls ?? 2;
  const pollMs = opts.pollMs ?? 3000;

  // Normalize: deep-clone + ensure every Databricks-family activity carries a
  // linkedServiceName (ADF/Synapse require it; several bundles omit it, which
  // otherwise 400s the PUT as a hard failure). Never mutates the shared bundle.
  const { content, databricksLs } = normalizePipelineContent(rawContent);
  const props = buildDevPipelineProperties(content);
  const runParams = buildDevRunParameters(content?.parameters);

  // 0) Auto-provision the linked services + datasets the pipeline references so
  //    its document validates on commit (Synapse/ADF reject a pipeline that
  //    references a non-existent dataset/linked service: "invalid reference
  //    '<name>'"). Best-effort; residual unresolved refs become an honest gate.
  const refResult = await ensurePipelineReferences(adapter, content, databricksLs, steps);

  // Authoring the Databricks linked service was refused (401/403) — the UAMI
  // lacks the workspace RBAC. Surface the auth gate (the provisioner maps it to
  // a precise "grant the role" remediation), NOT a hard failure.
  if (refResult.authGate) {
    return { upserted: false, triggered: false, steps, authGate: refResult.authGate };
  }
  const { unresolvedDatabricks } = refResult;

  // A Databricks-orchestrating pipeline on an estate with no Databricks bound
  // (LOOM_DATABRICKS_HOSTNAME unset) can't have its notebook/Spark activities
  // satisfied — surface a precise, honest remediation gate BEFORE the failing
  // PUT rather than letting Synapse/ADF reject the document with an opaque 400
  // that reads as a hard product failure. Databricks is Azure-native compute,
  // so this is an Azure infra gate, NOT a Fabric dependency.
  if (unresolvedDatabricks.length > 0) {
    const names = unresolvedDatabricks.join(', ');
    return {
      upserted: false,
      triggered: false,
      steps,
      needsReference: {
        message:
          `Pipeline '${pipelineName}' orchestrates Databricks notebook/Spark activities that require an ` +
          `AzureDatabricks linked service (${names}), but no Databricks workspace is bound on this estate. ` +
          `Set LOOM_DATABRICKS_HOSTNAME (workspace hostname, no scheme) — optionally LOOM_DATABRICKS_WORKSPACE_RESOURCE_ID ` +
          `for MSI auth, or LOOM_DATABRICKS_LINKED_SERVICE to reuse an already-registered linked service — then re-run install.`,
      },
    };
  }

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
    // An "invalid reference" after auto-provisioning means the pipeline still
    // points at an artifact we can't synthesize on this estate (typically a
    // Databricks linked service when Databricks isn't wired). Honest gate, not
    // a hard product failure — the pipeline definition is saved to Cosmos and
    // commits once the referenced backend is provisioned.
    if (/invalid reference|not exist|cannot be found|notfound/i.test(msg)) {
      return { upserted: false, triggered: false, steps, needsReference: { message: msg } };
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
