/**
 * AI / data-plane editor content fallback.
 *
 * Same class of fix as `pbi-content-fallback.ts`, applied to the AI Foundry /
 * AI Search / Activator / Mirrored-DB / Databricks family of editors.
 *
 * When an app bundle is installed (see /api/apps/[id]/install/route.ts), each
 * item's rich starter definition is stamped into the Cosmos item's
 * `state.content` (an `AnyContent` per lib/apps/content-bundles/types.ts) — but
 * the live Azure object it represents (the AI Search index, the Foundry prompt
 * flow / evaluation, the Fabric mirrored database, the registered AML model,
 * the Databricks job, the Activator rule) does NOT yet exist. Result: the
 * per-type editor loads from the LIVE backend, finds nothing, and opens EMPTY —
 * the bundle's fields / nodes / metrics / tasks are stranded in `state.content`.
 *
 * These builders let the per-type GET routes surface a bundle-installed item as
 * a FULLY-BUILT-OUT, config-only preview of its definition — by projecting
 * `state.content.<fields>` into the exact shape the editor already renders for
 * the live object. The live Run / Validate / Trigger / Save paths continue to
 * hit the real backend (or an honest infra-gate); these fallbacks only kick in
 * when the live object can't be fetched yet, so they never mask a real object.
 *
 * No mocks: every value comes from the bundle the operator installed. The
 * `__loomContent: true` marker + `source: 'bundle'` tells the editor this is a
 * not-yet-pushed template (the honest, no-vaporware state).
 */

import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { buildRuleQuery, safeRuleName } from '@/lib/azure/activator-monitor';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type {
  AiSearchIndexContent,
  PromptFlowContent,
  EvaluationContent,
  MlModelContent,
  ActivatorContent,
  MirroredDatabaseContent,
  DatabricksJobContent,
} from '@/lib/apps/content-bundles/types';

/** Load one tenant-owned item by id, verifying parent-workspace ownership. */
export async function loadContentBackedItem(
  cosmosItemId: string,
  itemType: string,
  tenantId: string,
): Promise<WorkspaceItem | null> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
        parameters: [
          { name: '@id', value: cosmosItemId },
          { name: '@t', value: itemType },
        ],
      })
      .fetchAll();
    const item = resources[0];
    if (!item) return null;
    const ws = await workspacesContainer();
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return item;
  } catch {
    return null;
  }
}

function contentOf<T>(item: WorkspaceItem, kind: string): T | null {
  const c = (item.state as any)?.content;
  return c && c.kind === kind ? (c as T) : null;
}

// ── AI Search index ─────────────────────────────────────────────────────────

/**
 * Build the editor's expected `index` definition from AiSearchIndexContent.
 * The editor (foundry-sub-editors AiSearchIndexEditor) reads `index.fields`,
 * `index.scoringProfiles`, `index.vectorSearch.profiles`, and renders the
 * Schema / field-designer tab off them. We synthesize a `default-profile`
 * vectorSearch profile + matching HNSW algorithm config from `vectorConfig`
 * (the same shape the aiSearchProvisioner PUTs to the service), so a vector
 * field's `vectorSearchProfile` reference resolves in the designer.
 */
export function aiSearchIndexFromContent(item: WorkspaceItem) {
  const content = contentOf<AiSearchIndexContent>(item, 'ai-search-index');
  if (!content) return null;
  const fields = (content.schema?.fields || []).map((f) => ({
    name: f.name,
    type: f.type,
    key: !!f.key,
    searchable: f.searchable ?? false,
    filterable: f.filterable ?? false,
    sortable: f.sortable ?? false,
    facetable: false,
    retrievable: f.retrievable !== false,
    ...(typeof f.dimensions === 'number' ? { dimensions: f.dimensions } : {}),
    ...(f.vectorSearchProfile ? { vectorSearchProfile: f.vectorSearchProfile } : {}),
  }));
  const dims = content.vectorConfig?.dimensions;
  const algorithm = content.vectorConfig?.algorithm || 'hnsw';
  // Synthesize the vectorSearch block the provisioner would create so the
  // designer's profile/algorithm references resolve.
  const hasVectorField = fields.some((f) => f.vectorSearchProfile);
  const vectorSearch = hasVectorField
    ? {
        algorithms: [
          {
            name: algorithm,
            kind: algorithm,
            ...(algorithm === 'hnsw'
              ? { hnswParameters: { m: 4, efConstruction: 400, efSearch: 500, metric: 'cosine' } }
              : {}),
          },
        ],
        profiles: [{ name: 'default-profile', algorithmConfigurationName: algorithm }],
      }
    : undefined;
  const index: Record<string, unknown> = {
    name: item.displayName,
    fields,
    ...(Array.isArray(content.scoringProfiles) && content.scoringProfiles.length
      ? { scoringProfiles: content.scoringProfiles.map((p) => ({ name: p.name, text: { weights: {} } })) }
      : {}),
    ...(vectorSearch ? { vectorSearch } : {}),
  };
  return {
    index,
    stats: { documentCount: (content.sampleDocs || []).length, storageSize: 0 },
    sampleDocs: content.sampleDocs || [],
    boundTo: null,
    source: 'bundle' as const,
    __loomContent: true as const,
    dimensions: dims,
  };
}

// ── Prompt flow ──────────────────────────────────────────────────────────────

/**
 * Build the editor's expected `flow` (with `flowDefinition` in flow.dag shape:
 * `inputs`/`outputs`/`nodes` maps + an array) from PromptFlowContent. The
 * editor's `toFlowDag(flow.flowDefinition)` normalizer accepts an object whose
 * `nodes` is an array and `inputs`/`outputs` are maps, so we emit exactly that.
 */
export function promptFlowFromContent(item: WorkspaceItem) {
  const content = contentOf<PromptFlowContent>(item, 'prompt-flow');
  if (!content) return null;
  // Derive flow.dag inputs from the input node's declared schema, when present.
  const inputNode = (content.nodes || []).find((n) => n.kind === 'input');
  const inputs: Record<string, any> = {};
  const schema = (inputNode?.config as any)?.schema;
  if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, any>)) {
      inputs[k] = { type: v?.type || 'string', ...(v && 'default' in v ? { default: v.default } : {}) };
    }
  }
  // Map bundle nodes (input/llm/tool/python/output) onto flow.dag node kinds
  // the editor understands (llm / python / prompt). Non-llm/python nodes become
  // python placeholders so they still render on the canvas with their config.
  const nodes = (content.nodes || []).map((n) => {
    const type = n.kind === 'llm' ? 'llm' : 'python';
    return {
      name: n.name || n.id,
      type,
      inputs: (n.config as any)?.inputs && typeof (n.config as any).inputs === 'object'
        ? (n.config as any).inputs
        : {},
      ...((n.config as any)?.deployment ? { deployment_name: (n.config as any).deployment } : {}),
      ...((n.config as any)?.connection ? { connection: (n.config as any).connection } : {}),
      // Stash the original kind + full config so nothing is lost on render.
      source: { type: 'code', code: JSON.stringify(n.config ?? {}, null, 2) },
    };
  });
  const flowDefinition = {
    inputs,
    outputs: {},
    nodes,
    ...(content.systemPrompt ? { systemPrompt: content.systemPrompt } : {}),
  };
  return {
    flow: {
      flowId: item.id,
      flowName: item.displayName,
      flowType: 'standard',
      description: item.description,
      flowDefinition,
    },
    source: 'bundle' as const,
    __loomContent: true as const,
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Build the editor's expected `evaluation` from EvaluationContent. The editor
 * reads `evaluation.displayName`, `evaluation.status`, and `evaluation.metrics`
 * (a name→value map). Bundle content carries metric DEFINITIONS (name +
 * description) and no scores (scores come only from a live run — see the bundle
 * doc), so we surface the metric names mapped to their descriptions and a
 * status that names the honest config-only state.
 */
export function evaluationFromContent(item: WorkspaceItem) {
  const content = contentOf<EvaluationContent>(item, 'evaluation');
  if (!content) return null;
  const metrics: Record<string, string> = {};
  for (const m of content.metrics || []) metrics[m.name] = m.description;
  return {
    evaluation: {
      id: item.id,
      name: item.displayName,
      displayName: item.displayName,
      status: 'NotStarted (bundle template — run the suite to populate scores)',
      datasetId: content.datasetRef,
      metrics,
    },
    results: null,
    source: 'bundle' as const,
    __loomContent: true as const,
  };
}

// ── ML model ─────────────────────────────────────────────────────────────────

/**
 * Surface MlModelContent (algorithm + framework + hyperparameters + features +
 * trainingCode) so the ml-model editor can render the bundle definition even
 * before the model is registered in Azure ML. The editor's Bundle-definition
 * panel reads this `content` block; Bind / Register / Deploy still target the
 * real AML registry.
 */
export function mlModelContentFromItem(item: WorkspaceItem) {
  const content = contentOf<MlModelContent>(item, 'ml-model');
  if (!content) return null;
  return {
    algorithm: content.algorithm,
    framework: content.framework,
    hyperparameters: content.hyperparameters || {},
    features: content.features || [],
    target: content.target,
    trainingCode: content.trainingCode || '',
  };
}

// ── Activator rule ───────────────────────────────────────────────────────────

/**
 * Build the editor's rule-list entry from ActivatorContent.rule, projected onto
 * the canonical Azure-Monitor `MonitorRuleRecord` shape (lib/azure/activator-
 * monitor.ts) so a bundle-installed rule round-trips through the same controls a
 * provisioned rule does.
 *
 * The editor's Rules table reads `{ id, name, condition:{operator,value},
 * action:{kind,config} }`, so we map the bundle's `{ metric, op, threshold }`
 * condition onto `{ property, operator, value }` (keeping the metric in
 * objectName so the table still shows what's watched) and surface the window +
 * action verbatim. On top of that we add the round-trip fields the BFF routes
 * key off:
 *   • `query`        — the KQL the scheduledQueryRule would run (Trigger reads it).
 *   • `azureRuleName`— the ARM scheduledQueryRule name, derived BYTE-IDENTICALLY
 *                      to the provisioner / createMonitorActivatorRule() so it
 *                      resolves to the SAME real ARM rule (Enable/Disable/Delete/
 *                      Start/Stop key off it).
 *   • `severity`, `evaluationFrequency`, `windowSize`, `backend`.
 *   • a NON-LIVE `state: 'NotDeployed'` + a `source: 'bundle'` marker. This row
 *     ONLY renders when state.rules is empty — i.e. NO ARM scheduledQueryRule
 *     exists yet (install with deploy=off, or provisioning hit an infra-gate).
 *     Stamping it 'Active' would misrepresent an un-deployed template, and the
 *     per-row ARM actions (Enable/Disable/Delete/Edit/Trigger) would dead-end on
 *     a 404 against the empty state.rules. The editor keys off `__loomContent` /
 *     `source === 'bundle'` to DISABLE those actions until the rule is actually
 *     provisioned.
 *
 * Once the provisioner persists the real MonitorRuleRecord[] to state.rules, the
 * live rows (state 'Active') replace this preview and this fallback no longer
 * fires. We still carry `azureRuleName` + `query`, derived BYTE-IDENTICALLY to
 * the provisioner / createMonitorActivatorRule(), so the preview names the same
 * ARM rule the provisioner will create (no-vaporware: an honest not-yet-deployed
 * state, never a stub 'Active'; no-fabric-dependency: Azure Monitor path, no
 * Fabric). We keep `id = loom:<item.id>`; the routes resolve by id | name |
 * azureRuleName.
 */
export function activatorRuleFromContent(item: WorkspaceItem) {
  const content = contentOf<ActivatorContent>(item, 'activator');
  if (!content?.rule) return null;
  const r = content.rule;
  // Project onto the canonical structured condition so buildRuleQuery composes
  // the SAME KQL a re-create (createMonitorActivatorRule) would, and the editor
  // table still reads operator/value.
  const condition = {
    property: r.condition?.metric,
    operator: r.condition?.op,
    value: r.condition?.threshold,
  };
  const action = { kind: r.action?.kind, config: r.action?.config || {} };
  const { query } = buildRuleQuery({ name: r.name, condition, action });
  // BYTE-IDENTICAL to the provisioner / createMonitorActivatorRule derivation
  // (activator-monitor.ts:196-197) so this row resolves to the real ARM rule.
  const ruleSuffix = (r.name || 'rule').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 16) || 'rule';
  const azureRuleName = safeRuleName(item.displayName, ruleSuffix);
  const severity = typeof (r.condition as any)?.severity === 'number' ? (r.condition as any).severity : 3;
  return {
    id: `loom:${item.id}`,
    name: r.name,
    objectName: r.condition?.metric,
    propertyName: r.condition?.metric,
    condition,
    window: r.window,
    action,
    query,
    azureRuleName,
    severity,
    evaluationFrequency: 'PT5M',
    windowSize: 'PT5M',
    backend: 'azure-monitor' as const,
    // Non-live: this row only renders when NO ARM rule exists yet, so it must NOT
    // claim to be evaluating. The editor disables its per-row ARM actions (keyed
    // off source / __loomContent) until the activator is provisioned — preventing
    // an Enable/Disable/Delete/Edit/Trigger 404 dead-end against empty state.rules.
    state: 'NotDeployed' as const,
    source: 'bundle' as const,
    __loomContent: true as const,
  };
}

// ── Mirrored database ────────────────────────────────────────────────────────

/**
 * Build the mirrored-database editor's `definition` + `tables` payload from
 * MirroredDatabaseContent. The editor renders `status.status` + a per-table
 * replication grid reading `tables.data[]` ({ sourceSchemaName, sourceTableName,
 * status, metrics }). For a bundle template there is no live replication, so we
 * list each declared source table at status "NotStarted".
 */
export function mirroredDatabaseFromContent(item: WorkspaceItem) {
  const content = contentOf<MirroredDatabaseContent>(item, 'mirrored-database');
  if (!content?.source) return null;
  const src = content.source;
  const definition = {
    properties: {
      source: {
        type: src.kind,
        typeProperties: { server: src.server, database: src.database },
      },
      target: { type: 'MountedRelationalDatabase', typeProperties: { format: 'Delta' } },
    },
  };
  const tables = {
    data: (src.tables || []).map((t) => {
      const [schema, table] = String(t).includes('.') ? String(t).split('.') : ['', String(t)];
      return {
        sourceSchemaName: schema || 'dbo',
        sourceTableName: table,
        status: 'NotStarted',
        metrics: {},
      };
    }),
  };
  return {
    definition,
    status: { mirroringStatus: 'NotStarted', status: 'Stopped' },
    tables,
    source: 'bundle' as const,
    __loomContent: true as const,
  };
}

// ── Databricks job ───────────────────────────────────────────────────────────

/**
 * Build the databricks-job editor's expected `job` (Databricks Jobs API 2.1
 * shape: `{ job_id, settings:{ name, tasks[], job_clusters[] } }`) from
 * DatabricksJobContent. The editor's `selectJob` reads `job.settings.name` +
 * `job.settings.tasks[]` (each mapped through `specToTask`) + cluster info, so
 * the bundle's chained tasks + shared cluster render fully. There is no live
 * Databricks job yet (no numeric id), so `job_id` is null — Create/Run target
 * the real workspace once provisioned.
 */
export function databricksJobFromContent(item: WorkspaceItem) {
  const content = contentOf<DatabricksJobContent>(item, 'databricks-job');
  if (!content) return null;
  // The editor's specToTask reads `new_cluster` ON EACH TASK (not a shared
  // job_clusters[] block), so inline the bundle's shared cluster onto every
  // task — that's how the chained tasks + cluster render in the form.
  const newCluster = content.cluster
    ? {
        spark_version: content.cluster.sparkVersion,
        node_type_id: content.cluster.nodeType,
        num_workers: content.cluster.numWorkers,
      }
    : undefined;
  const tasks = (content.tasks || []).map((t) => {
    const cfg = (t.config || {}) as Record<string, any>;
    const task: Record<string, any> = {
      task_key: t.name,
      ...(newCluster ? { new_cluster: newCluster } : {}),
      ...(cfg.description ? { description: cfg.description } : {}),
      ...(Array.isArray(cfg.depends_on) ? { depends_on: cfg.depends_on } : {}),
      ...(typeof cfg.timeout_seconds === 'number' ? { timeout_seconds: cfg.timeout_seconds } : {}),
      ...(typeof cfg.max_retries === 'number' ? { max_retries: cfg.max_retries } : {}),
      ...(typeof cfg.min_retry_interval_millis === 'number' ? { min_retry_interval_millis: cfg.min_retry_interval_millis } : {}),
      ...(Array.isArray(cfg.libraries) ? { libraries: cfg.libraries } : {}),
      ...(cfg.email_notifications ? { email_notifications: cfg.email_notifications } : {}),
    };
    // Map the bundle task type → the Databricks task block the editor reads.
    if (t.type === 'notebook_task' || t.notebookPath) {
      task.notebook_task = {
        notebook_path: t.notebookPath || cfg.notebook_path || '',
        ...(cfg.base_parameters ? { base_parameters: cfg.base_parameters } : {}),
      };
    } else if (t.type === 'spark_python_task' && cfg.python_file) {
      task.spark_python_task = { python_file: cfg.python_file };
    }
    return task;
  });
  const settings: Record<string, any> = {
    name: item.displayName,
    tasks,
    max_concurrent_runs: 1,
  };
  return {
    job: { job_id: null, settings },
    source: 'bundle' as const,
    __loomContent: true as const,
  };
}
