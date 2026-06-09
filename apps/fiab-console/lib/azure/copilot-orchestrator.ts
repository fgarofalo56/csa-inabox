/**
 * CSA Loom v3 — Cross-item Copilot orchestrator.
 *
 * Calls the AOAI deployment hanging off the Foundry hub (auto-discovered
 * via foundry-client.listConnections() with override LOOM_AOAI_ENDPOINT /
 * LOOM_AOAI_DEPLOYMENT). Exposes 25+ tools spanning every wired Loom
 * service: Synapse SQL, Lakehouse/ADLS, Databricks, APIM, ADX, ADF,
 * Power BI, Fabric, Foundry, Cosmos, Workspaces.
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential({clientId:
 * LOOM_UAMI_CLIENT_ID}), DefaultAzureCredential) → cognitiveservices
 * scope for AOAI; the wrapped client libs each own their own scopes.
 *
 * Conversation history is persisted in the Cosmos `copilot-sessions`
 * container (PK /sessionId). Steps are streamed back to the caller as
 * an AsyncIterable so the BFF can SSE-pipe them straight to the UI.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { listConnections, isSafetyConfigured, shieldPrompt, moderateContent } from './foundry-client';
import { cogScope } from './cloud-endpoints';
import type { TenantCopilotConfig } from '../types/copilot-config';
import {
  executeQuery as synapseExecute,
  dedicatedTarget,
  serverlessTarget,
} from './synapse-sql-client';
import * as synapseDev from './synapse-dev-client';
import * as synapsePool from './synapse-pool-arm';
import * as databricks from './databricks-client';
import * as apim from './apim-client';
import * as adf from './adf-client';
import * as kusto from './kusto-client';
import * as adls from './adls-client';
import * as powerbi from './powerbi-client';
import * as fabric from './fabric-client';
import * as activator from './activator-client';
import { copilotSessionsContainer } from './cosmos-client';
import { runSelfAudit, applyFix } from '@/lib/admin/self-audit';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';

// ---------- item-type slug normalization (build-assist robustness) ----------
// The model often guesses item-type slugs with underscores or marketing names
// (e.g. "synapse_dedicated_sql_pool", "powerbi_semantic_model"). Creating an
// item with a slug that has no registered editor 404s the item. Normalize to a
// real catalog slug (hyphenate + alias common synonyms) or reject with the
// valid list — never silently store a bogus type.
const VALID_ITEM_SLUGS: ReadonlySet<string> = new Set(FABRIC_ITEM_TYPES.map((t) => t.slug));
const ITEM_TYPE_ALIASES: Record<string, string> = {
  'powerbi-semantic-model': 'semantic-model',
  'power-bi-semantic-model': 'semantic-model',
  'powerbi-dataset': 'semantic-model',
  'dataset': 'semantic-model',
  'powerbi-report': 'report',
  'power-bi-report': 'report',
  'powerbi-dashboard': 'dashboard',
  'sql-dw': 'synapse-dedicated-sql-pool',
  'sql-data-warehouse': 'synapse-dedicated-sql-pool',
  'data-warehouse': 'warehouse',
  'sql-pool': 'synapse-dedicated-sql-pool',
  'dedicated-sql-pool': 'synapse-dedicated-sql-pool',
  'databricks-sql': 'databricks-sql-warehouse',
  'azure-sql': 'azure-sql-database',
  'sql': 'sql-database',
  'pipeline': 'data-pipeline',
  'kql-db': 'kql-database',
  'notebook-databricks': 'databricks-notebook',
};

function normalizeItemType(raw: string): { slug: string } | { error: string } {
  let s = String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (ITEM_TYPE_ALIASES[s]) s = ITEM_TYPE_ALIASES[s];
  if (VALID_ITEM_SLUGS.has(s)) return { slug: s };
  return {
    error:
      `Unknown item type "${raw}". Use a hyphenated Loom slug. Common ones: ` +
      'data-pipeline, lakehouse, warehouse, synapse-dedicated-sql-pool, sql-database, ' +
      'azure-sql-database, databricks-sql-warehouse, databricks-notebook, notebook, ' +
      'kql-database, eventstream, semantic-model, report, dashboard, data-agent.',
  };
}

// ---------- Credential ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------- AOAI discovery ----------

export class NoAoaiDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAoaiDeploymentError';
  }
}

export interface AoaiTarget {
  endpoint: string;    // e.g. https://aoai-foo.openai.azure.com
  deployment: string;  // e.g. gpt-4o
  apiVersion: string;  // e.g. 2024-10-21
}

let _aoaiTarget: AoaiTarget | null = null;

/**
 * Resolve the AOAI chat target.
 *
 * Resolution order:
 *   1. `cfg` — the tenant's admin-selected Copilot config (aoaiEndpoint +
 *      copilotChatDeployment, or just copilotChatDeployment paired with the
 *      foundry account's endpoint). The admin picker is the source of truth.
 *   2. LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT env vars (existing behaviour).
 *   3. Discovery via Foundry hub connections.
 *
 * When `cfg` is supplied the result is NOT cached (config is per-tenant); the
 * module cache only memoizes the env/discovery default.
 */
export async function resolveAoaiTarget(
  forceOrCfg: boolean | TenantCopilotConfig | null = false,
  maybeCfg?: TenantCopilotConfig | null,
): Promise<AoaiTarget> {
  const force = typeof forceOrCfg === 'boolean' ? forceOrCfg : false;
  const cfg: TenantCopilotConfig | null =
    typeof forceOrCfg === 'object' && forceOrCfg ? forceOrCfg : (maybeCfg ?? null);

  const apiVersion = process.env.LOOM_AOAI_API_VERSION || '2024-10-21';

  // 1. Tenant admin-selected config (highest priority).
  if (cfg && (cfg.copilotChatDeployment || cfg.aoaiEndpoint)) {
    const endpoint = (cfg.aoaiEndpoint || process.env.LOOM_AOAI_ENDPOINT || '').replace(/\/$/, '');
    const deployment = cfg.copilotChatDeployment || process.env.LOOM_AOAI_DEPLOYMENT || '';
    if (endpoint && deployment) {
      return { endpoint, deployment, apiVersion };
    }
    // Endpoint known but no deployment chosen yet → honest gate.
    if (!deployment) {
      throw new NoAoaiDeploymentError(
        'A Foundry account is selected in admin tenant-settings but no Copilot chat-model deployment is chosen. ' +
          'Pick one under Admin → Tenant settings → Copilot & Agents (deploy a gpt-4o / gpt-4.1 class model first).',
      );
    }
  }

  if (_aoaiTarget && !force && !cfg) return _aoaiTarget;

  // 2. Env overrides (works even when no Foundry connection is registered)
  const envEndpoint = process.env.LOOM_AOAI_ENDPOINT;
  const envDeployment = process.env.LOOM_AOAI_DEPLOYMENT;

  if (envEndpoint && envDeployment) {
    const t = { endpoint: envEndpoint.replace(/\/$/, ''), deployment: envDeployment, apiVersion };
    if (!cfg) _aoaiTarget = t;
    return t;
  }

  // 3. Discover via Foundry hub connections
  let conns: Awaited<ReturnType<typeof listConnections>> = [];
  try {
    conns = await listConnections();
  } catch (e: any) {
    throw new NoAoaiDeploymentError(
      `No AOAI deployment on Foundry hub. Deploy a gpt-4 / gpt-4o model first. (Foundry connection lookup failed: ${e?.message || e})`,
    );
  }

  const aoai = conns.find(
    (c) => (c.category || '').toLowerCase().includes('openai') ||
           (c.category || '').toLowerCase() === 'azureopenai',
  );
  if (!aoai || !aoai.target) {
    throw new NoAoaiDeploymentError(
      'No AOAI deployment on Foundry hub. Deploy a gpt-4 / gpt-4o model first.',
    );
  }

  const deployment =
    cfg?.copilotChatDeployment || envDeployment || (aoai.metadata?.['DeploymentApiVersion'] as string) || 'gpt-4o';
  const discovered: AoaiTarget = {
    endpoint: aoai.target.replace(/\/$/, ''),
    deployment,
    apiVersion,
  };
  if (!cfg) _aoaiTarget = discovered;
  return discovered;
}

async function aoaiToken(): Promise<string> {
  const t = await credential.getToken(cogScope());
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Tool registry ----------

/** Per-turn context passed to every tool handler (caller identity). Lets the
 *  build-assist tools create/configure items OWNED by the signed-in user. */
export interface ToolContext {
  userOid: string;
  /** Minimal session shape the item-crud helpers consume (claims.oid = tenant). */
  session: { claims: { oid: string; upn?: string; email?: string } };
}

export interface ToolDef {
  name: string;
  description: string;
  service: string;
  parameters: Record<string, unknown>; // JSON Schema object
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

export class LoomToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(t: ToolDef) { this.tools.set(t.name, t); }

  list(): ToolDef[] { return Array.from(this.tools.values()); }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }

  /** OpenAI-compatible tools array for the AOAI chat-completions call. */
  toAoaiTools(): unknown[] {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

// JSON-schema helpers
const S_STRING = { type: 'string' } as const;
const S_NUMBER = { type: 'number' } as const;
const S_OBJECT = { type: 'object' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

// ---------- Build the default registry ----------

export function buildDefaultRegistry(): LoomToolRegistry {
  const r = new LoomToolRegistry();

  // -------- Synapse SQL --------
  r.register({
    name: 'synapse_serverless_query',
    service: 'Synapse',
    description: 'Run a T-SQL query against the Synapse serverless SQL pool (read-only ad-hoc analytics over ADLS).',
    parameters: obj({ sql: S_STRING, database: S_STRING }, ['sql']),
    handler: async ({ sql, database }) => synapseExecute(serverlessTarget(database || 'master'), sql),
  });
  r.register({
    name: 'synapse_dedicated_query',
    service: 'Synapse',
    description: 'Run a T-SQL query against the Synapse dedicated SQL pool (provisioned MPP warehouse).',
    parameters: obj({ sql: S_STRING }, ['sql']),
    handler: async ({ sql }) => synapseExecute(dedicatedTarget(), sql),
  });
  r.register({
    name: 'synapse_pool_state',
    service: 'Synapse',
    description: 'Get state (Online/Paused/Resuming/Pausing/Scaling) of the dedicated SQL pool.',
    parameters: obj({}),
    handler: async () => synapsePool.getPoolState(),
  });
  r.register({
    name: 'synapse_pool_resume',
    service: 'Synapse',
    description: 'Resume the dedicated SQL pool (idempotent if already Online).',
    parameters: obj({}),
    handler: async () => { await synapsePool.resumePool(); return { ok: true }; },
  });
  r.register({
    name: 'synapse_list_pipelines',
    service: 'Synapse',
    description: 'List all Synapse Integrate pipelines in the workspace.',
    parameters: obj({}),
    handler: async () => synapseDev.listPipelines(),
  });
  r.register({
    name: 'synapse_run_pipeline',
    service: 'Synapse',
    description: 'Trigger a Synapse pipeline run.',
    parameters: obj({ name: S_STRING, parameters: S_OBJECT }, ['name']),
    handler: async ({ name, parameters }) => synapseDev.runPipeline(name, parameters),
  });

  // -------- Lakehouse / ADLS --------
  r.register({
    name: 'lakehouse_list',
    service: 'Lakehouse',
    description: 'List files / folders under an ADLS Gen2 container path.',
    parameters: obj({ container: S_STRING, prefix: S_STRING }, ['container']),
    handler: async ({ container, prefix }) => adls.listPaths(container, prefix || ''),
  });
  r.register({
    name: 'lakehouse_read',
    service: 'Lakehouse',
    description: 'Get metadata (size, last-modified, content-type) for a path in ADLS Gen2.',
    parameters: obj({ container: S_STRING, path: S_STRING }, ['container', 'path']),
    handler: async ({ container, path }) => adls.getMetadata(container, path),
  });
  r.register({
    name: 'lakehouse_write',
    service: 'Lakehouse',
    description: 'Upload a UTF-8 text or base64 binary file to ADLS Gen2.',
    parameters: obj(
      { container: S_STRING, path: S_STRING, content: S_STRING, contentBase64: { type: 'boolean' } },
      ['container', 'path', 'content'],
    ),
    handler: async ({ container, path, content, contentBase64 }) => {
      const buf = contentBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
      const ct = contentBase64 ? 'application/octet-stream' : 'text/plain; charset=utf-8';
      await adls.uploadFile(container, path, buf, ct);
      return { ok: true, bytes: buf.length, url: adls.pathToHttpsUrl(container, path) };
    },
  });

  // -------- Databricks --------
  r.register({
    name: 'databricks_run_warehouse_query',
    service: 'Databricks',
    description: 'Execute a SQL statement on a Databricks SQL warehouse.',
    parameters: obj({ warehouseId: S_STRING, sql: S_STRING, catalog: S_STRING, schema: S_STRING }, ['warehouseId', 'sql']),
    handler: async ({ warehouseId, sql, catalog, schema }) =>
      databricks.executeStatement(warehouseId, sql, catalog, schema),
  });
  r.register({
    name: 'databricks_run_notebook',
    service: 'Databricks',
    description: 'Submit a one-time Databricks notebook run against an existing cluster.',
    parameters: obj(
      { path: S_STRING, clusterId: S_STRING, parameters: S_OBJECT, runName: S_STRING },
      ['path', 'clusterId'],
    ),
    handler: async ({ path, clusterId, parameters, runName }) =>
      databricks.runNotebook(path, clusterId, parameters || {}, runName),
  });
  r.register({
    name: 'databricks_list_warehouses',
    service: 'Databricks',
    description: 'List all SQL warehouses in the workspace.',
    parameters: obj({}),
    handler: async () => databricks.listWarehouses(),
  });
  r.register({
    name: 'databricks_list_jobs',
    service: 'Databricks',
    description: 'List Databricks jobs.',
    parameters: obj({ limit: S_NUMBER }),
    handler: async ({ limit }) => databricks.listJobs(limit || 50),
  });

  // -------- APIM --------
  r.register({
    name: 'apim_list_apis',
    service: 'APIM',
    description: 'List APIs registered in Azure API Management.',
    parameters: obj({}),
    handler: async () => apim.listApis(),
  });
  r.register({
    name: 'apim_publish_api',
    service: 'APIM',
    description: 'Create or update an APIM API, optionally importing an OpenAPI spec.',
    parameters: obj(
      { apiId: S_STRING, displayName: S_STRING, path: S_STRING, openapiSpec: S_STRING, protocols: { type: 'array', items: S_STRING } },
      ['apiId', 'displayName', 'path'],
    ),
    handler: async ({ apiId, displayName, path, openapiSpec, protocols }) =>
      apim.upsertApi(apiId, {
        displayName,
        path,
        protocols: protocols || ['https'],
        ...(openapiSpec ? { value: openapiSpec, format: 'openapi+json' } : {}),
      }),
  });
  r.register({
    name: 'apim_list_products',
    service: 'APIM',
    description: 'List published APIM products.',
    parameters: obj({}),
    handler: async () => apim.listProducts(),
  });

  // -------- ADX / Kusto --------
  r.register({
    name: 'adx_query',
    service: 'ADX',
    description: 'Run a KQL query against an ADX database.',
    parameters: obj({ database: S_STRING, kql: S_STRING }, ['database', 'kql']),
    handler: async ({ database, kql }) => kusto.executeQuery(database, kql),
  });
  r.register({
    name: 'adx_list_databases',
    service: 'ADX',
    description: 'List databases on the ADX cluster.',
    parameters: obj({}),
    handler: async () => kusto.listDatabases(),
  });
  r.register({
    name: 'adx_list_tables',
    service: 'ADX',
    description: 'List tables inside an ADX database.',
    parameters: obj({ database: S_STRING }, ['database']),
    handler: async ({ database }) => kusto.listTables(database),
  });

  // -------- ADF --------
  r.register({
    name: 'adf_run_pipeline',
    service: 'ADF',
    description: 'Trigger an Azure Data Factory pipeline run.',
    parameters: obj({ name: S_STRING, parameters: S_OBJECT }, ['name']),
    handler: async ({ name, parameters }) => adf.runPipeline(name, parameters),
  });
  r.register({
    name: 'adf_list_pipelines',
    service: 'ADF',
    description: 'List ADF pipelines.',
    parameters: obj({}),
    handler: async () => adf.listPipelines(),
  });

  // -------- Power BI --------
  r.register({
    name: 'powerbi_list_workspaces',
    service: 'Power BI',
    description: 'List Power BI workspaces visible to the Loom UAMI.',
    parameters: obj({}),
    handler: async () => powerbi.listWorkspaces(),
  });
  r.register({
    name: 'powerbi_list_reports',
    service: 'Power BI',
    description: 'List reports in a Power BI workspace.',
    parameters: obj({ workspaceId: S_STRING }, ['workspaceId']),
    handler: async ({ workspaceId }) => powerbi.listReports(workspaceId),
  });
  r.register({
    name: 'powerbi_refresh_dataset',
    service: 'Power BI',
    description: 'Trigger a refresh of a Power BI dataset.',
    parameters: obj(
      { workspaceId: S_STRING, datasetId: S_STRING, notifyOption: S_STRING },
      ['workspaceId', 'datasetId'],
    ),
    handler: async ({ workspaceId, datasetId, notifyOption }) =>
      powerbi.refreshDataset(workspaceId, datasetId, { notifyOption: notifyOption || 'NoNotification' }),
  });

  // -------- Fabric --------
  r.register({
    name: 'fabric_list_workspaces',
    service: 'Fabric',
    description: 'List Microsoft Fabric workspaces.',
    parameters: obj({}),
    handler: async () => fabric.listFabricWorkspaces(),
  });
  r.register({
    name: 'fabric_create_notebook',
    service: 'Fabric',
    description: 'Create a Fabric notebook with the supplied .ipynb / .py source.',
    parameters: obj(
      { workspaceId: S_STRING, displayName: S_STRING, description: S_STRING, code: S_STRING },
      ['workspaceId', 'displayName', 'code'],
    ),
    handler: async ({ workspaceId, displayName, description, code }) =>
      fabric.createNotebook(workspaceId, {
        displayName,
        description: description || '',
        definition: {
          format: 'ipynb',
          parts: [
            { path: 'notebook-content.py', payload: Buffer.from(code, 'utf-8').toString('base64'), payloadType: 'InlineBase64' },
          ],
        },
      }),
  });
  r.register({
    name: 'fabric_run_notebook',
    service: 'Fabric',
    description: 'Submit a Fabric notebook run.',
    parameters: obj({ workspaceId: S_STRING, notebookId: S_STRING }, ['workspaceId', 'notebookId']),
    handler: async ({ workspaceId, notebookId }) => fabric.runNotebook(workspaceId, notebookId),
  });

  // -------- Foundry --------
  r.register({
    name: 'foundry_list_connections',
    service: 'Foundry',
    description: 'List Azure AI Foundry hub connections (AOAI, Search, Content Safety, etc.).',
    parameters: obj({}),
    handler: async () => listConnections(),
  });

  // -------- Activator --------
  r.register({
    name: 'activator_list',
    service: 'Activator',
    description: 'List Activator (Reflex) items in a Fabric workspace.',
    parameters: obj({ workspaceId: S_STRING }, ['workspaceId']),
    handler: async ({ workspaceId }) => activator.listActivators(workspaceId),
  });
  r.register({
    name: 'activator_trigger_rule',
    service: 'Activator',
    description: 'Manually trigger an Activator rule.',
    parameters: obj({ workspaceId: S_STRING, activatorId: S_STRING, ruleId: S_STRING }, ['workspaceId', 'activatorId', 'ruleId']),
    handler: async ({ workspaceId, activatorId, ruleId }) =>
      activator.triggerRule(workspaceId, activatorId, ruleId),
  });

  // -------- Workspace / item meta (Loom Cosmos) --------
  r.register({
    name: 'workspace_create',
    service: 'Loom',
    description: 'Create a new Loom workspace OWNED by the current user. Call this before item_create when the user has no workspace yet. Returns the new workspace id.',
    parameters: obj({ name: S_STRING, description: S_STRING }, ['name']),
    handler: async ({ name, description }, ctx) => {
      const wsName = String(name ?? '').trim();
      if (!wsName) throw new Error('A workspace name is required (to list existing workspaces, use workspace_list).');
      const { workspacesContainer } = await import('./cosmos-client');
      const c = await workspacesContainer();
      const now = new Date().toISOString();
      const ws = {
        id: crypto.randomUUID(),
        tenantId: ctx.userOid,
        name: wsName,
        description: description ? String(description).trim() : undefined,
        createdBy: ctx.userOid,
        createdAt: now,
        updatedAt: now,
      };
      const { resource } = await c.items.create(ws);
      return { id: resource?.id ?? ws.id, name: ws.name };
    },
  });
  r.register({
    name: 'item_create',
    service: 'Loom',
    description:
      'Create a new Loom item of a given type inside a workspace, OWNED by the current user. ' +
      'The `type` MUST be a hyphenated Loom slug (NOT underscores). Common slugs: data-pipeline, ' +
      'lakehouse, warehouse, synapse-dedicated-sql-pool, sql-database, azure-sql-database, ' +
      'databricks-sql-warehouse, databricks-notebook, notebook, kql-database, eventstream, activator, ' +
      'semantic-model (Power BI semantic model), report (Power BI report), dashboard, graph-model, ' +
      'data-agent. Optionally pass an initial `state` object to create a PRE-CONFIGURED item — e.g. a ' +
      'data-agent with {sources:[…], instructions}, a data-pipeline with {activities:[…]}. ' +
      'Returns the created item id (open it in the editor to continue). This is the primary build-assist tool.',
    parameters: obj({
      workspaceId: S_STRING, type: S_STRING, displayName: S_STRING, description: S_STRING,
      state: { type: 'object', description: 'Initial item state/config (item-type specific). Omit for an empty item.' },
    }, ['workspaceId', 'type', 'displayName']),
    handler: async ({ workspaceId, type, displayName, description, state }, ctx) => {
      const norm = normalizeItemType(String(type));
      if ('error' in norm) throw new Error(norm.error);
      const { createOwnedItem } = await import('@/app/api/items/_lib/item-crud');
      const res = await createOwnedItem(ctx.session as any, norm.slug, {
        workspaceId: String(workspaceId),
        displayName: String(displayName),
        description: description ? String(description) : undefined,
        state: state && typeof state === 'object' ? (state as Record<string, unknown>) : undefined,
      });
      if (!res.ok) throw new Error(res.error);
      return { id: res.item.id, itemType: res.item.itemType, displayName: res.item.displayName, workspaceId: res.item.workspaceId };
    },
  });
  r.register({
    name: 'item_configure',
    service: 'Loom',
    description:
      'Update an existing Loom item the current user owns — patch its displayName/description and/or merge a ' +
      'new `state` config. Use this to BUILD an item incrementally (e.g. add sources to a data-agent, add ' +
      'activities to a pipeline, set a dataset schema). Pass the item id + itemType.',
    parameters: obj({
      id: S_STRING, itemType: S_STRING, displayName: S_STRING, description: S_STRING,
      state: { type: 'object', description: 'New item state to store (replaces the existing state object).' },
    }, ['id', 'itemType']),
    handler: async ({ id, itemType, displayName, description, state }, ctx) => {
      const { updateOwnedItem } = await import('@/app/api/items/_lib/item-crud');
      const updated = await updateOwnedItem(String(id), String(itemType), ctx.userOid, {
        displayName: displayName ? String(displayName) : undefined,
        description: description !== undefined ? String(description) : undefined,
        state: state && typeof state === 'object' ? (state as Record<string, unknown>) : undefined,
      });
      if (!updated) throw new Error(`item ${id} (${itemType}) not found or not owned by you`);
      return { id: updated.id, itemType: updated.itemType, displayName: updated.displayName, updatedAt: updated.updatedAt };
    },
  });
  r.register({
    name: 'item_list',
    service: 'Loom',
    description: 'List the Loom items the current user owns (id + type + displayName + workspace). Omit itemType (or pass "all") to list every type; pass a hyphenated slug to filter; optionally pass workspaceId to scope to one workspace. Use to find an item to configure or check for duplicates.',
    parameters: obj({ itemType: S_STRING, workspaceId: S_STRING }, []),
    handler: async ({ itemType, workspaceId }, ctx) => {
      const raw = String(itemType ?? '').trim().toLowerCase();
      const wid = String(workspaceId ?? '').trim() || undefined;
      const { listOwnedItems, listAllOwnedItems } = await import('@/app/api/items/_lib/item-crud');
      // No type, "all"/"*", or a workspace filter → list across all types.
      let items: any[];
      if (!raw || raw === 'all' || raw === '*' || wid) {
        items = await listAllOwnedItems(ctx.userOid, wid);
        if (raw && raw !== 'all' && raw !== '*') {
          const norm = normalizeItemType(raw);
          if (!('error' in norm)) items = items.filter((it) => it.itemType === norm.slug);
        }
      } else {
        const norm = normalizeItemType(raw);
        items = await listOwnedItems('error' in norm ? raw : norm.slug, ctx.userOid);
      }
      return items.map((it: any) => ({ id: it.id, itemType: it.itemType, displayName: it.displayName, workspaceId: it.workspaceId }));
    },
  });
  r.register({
    name: 'workspace_list',
    service: 'Loom',
    description: 'List the Loom workspaces the current user owns (id + name + description). Use this to answer "what workspaces exist" or to find a workspace id before item_create — do NOT call workspace_create to list.',
    parameters: obj({}),
    handler: async (_args, ctx) => {
      const { listOwnedWorkspaces } = await import('@/app/api/items/_lib/item-crud');
      return listOwnedWorkspaces(ctx.userOid);
    },
  });

  // -------- agent-loom: self-audit + healer --------
  // These let the built-in Copilot (agent-loom) review the whole deployment and
  // apply runtime-safe fixes conversationally — the same engine the Admin →
  // Health page uses. agent-loom understands every Loom requirement (identity,
  // data plane, Azure services, permissions, security) via the audit registry.
  r.register({
    name: 'loom_self_audit',
    service: 'Loom',
    description: 'Run a full CSA Loom self-audit: identity, data plane (Cosmos), the Azure services each workload needs (Synapse, ADX, Event Hubs, ADLS, AI Search, AOAI/Foundry, Monitor, ADF, Purview), permissions (bootstrap admin), and security posture. Returns a scored report with the exact remediation for every warning/failure. Use this first when asked to check, validate, or fix the deployment.',
    parameters: obj({}),
    handler: async () => runSelfAudit(new Date().toISOString()),
  });
  r.register({
    name: 'loom_heal',
    service: 'Loom',
    description: "Apply a runtime-safe healer fix by its fixId (from loom_self_audit results, e.g. 'ensure-cosmos'). Only fixes the Console identity can safely apply at runtime are executed; deploy-time issues (env vars / RBAC grants) return guidance to apply + redeploy instead of pretending to fix. Requires tenant-admin approval at the UI layer.",
    parameters: obj({ fixId: S_STRING }, ['fixId']),
    handler: async ({ fixId }) => applyFix(String(fixId)),
  });

  return r;
}

// ---------- Orchestrator ----------

export interface OrchestratorUsage { promptTokens: number; completionTokens: number; totalTokens: number; aoaiCalls: number; toolCalls: number; }

export type OrchestratorStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: OrchestratorUsage; model?: string }
  | { kind: 'error'; error: string; code?: string };

export interface OrchestrateOptions {
  prompt: string;
  sessionId: string;
  userOid: string;
  maxIterations?: number;
  /** Tenant admin-selected Copilot config (account + chat deployment). When
   *  supplied it takes priority over env / discovery. */
  tenantConfig?: TenantCopilotConfig | null;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

const SYSTEM_PROMPT = `You are CSA Loom Copilot — the assistant for CSA Loom, a self-contained data + AI platform that runs on Azure (Synapse, Databricks, ADF, APIM, Azure Data Explorer, AI Foundry, ADLS, Event Hubs, Azure Monitor). CSA Loom is its OWN product, NOT Microsoft Fabric. When you describe a feature, describe it as a CSA Loom feature (e.g. "the CSA Loom Real-Time hub", "a CSA Loom Eventstream", "the CSA Loom lakehouse") — never say "in Microsoft Fabric". You may name the underlying Azure services since those are the real backends.

You decompose user requests into concrete tool calls against the registered CSA Loom tools. Always prefer real tool calls over describing what you would do. Chain results: feed output of one call into the next. Be concise in your final summary; the user already sees the step trace.

If a tool errors, surface the error clearly and either retry with corrected inputs or abandon that branch and explain why.`;

/**
 * True when an AOAI 400 body is the "this model only supports the default
 * temperature" rejection that newer reasoning models (o1/o3/gpt-5/MAI-*) emit.
 * Those deployments reject any non-default temperature (and top_p); the right
 * move is to retry without the sampling params, not to fail the chat.
 */
function isUnsupportedSamplingParam(body: string): boolean {
  return /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(body)
    && /temperature|top_p/i.test(body);
}

async function callAoai(
  target: AoaiTarget,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<any> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const base: Record<string, unknown> = { messages, tools, tool_choice: 'auto' };

  // First attempt sends temperature for determinism; if the model rejects it,
  // retry once with the default sampling (no temperature). Works by default
  // across both classic chat models and the newer reasoning models.
  const send = async (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(withTemperature ? { ...base, temperature: 0.2 } : base),
    });

  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) {
      res = await send(false);
    } else {
      throw new Error(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
  }
  return res.json();
}

let _registry: LoomToolRegistry | null = null;
export function getRegistry(): LoomToolRegistry {
  if (!_registry) _registry = buildDefaultRegistry();
  return _registry;
}

/**
 * Append a single orchestrator/chat step to this user's Cosmos session doc
 * (`copilot-sessions`, PK /sessionId). Read-modify-write; failures never throw
 * so a Cosmos outage can't break the live SSE stream. Exported so other chat
 * surfaces (e.g. the notebook Copilot pane) persist into the SAME session
 * store the cross-item Copilot uses, and show up in GET /api/copilot/sessions.
 */
export async function persistStep(sessionId: string, userOid: string, step: OrchestratorStep, prompt?: string) {
  try {
    const c = await copilotSessionsContainer();
    // Read-modify-write a single session doc
    const existing = await c.item(sessionId, sessionId).read<any>().catch(() => ({ resource: null }));
    const now = new Date().toISOString();
    if (!existing.resource) {
      const doc = {
        id: sessionId,
        sessionId,
        userOid,
        prompt: prompt || '',
        steps: [step],
        createdAt: now,
        updatedAt: now,
      };
      await c.items.create(doc);
    } else {
      const doc = existing.resource;
      doc.steps = [...(doc.steps || []), step];
      doc.updatedAt = now;
      if (prompt && !doc.prompt) doc.prompt = prompt;
      await c.item(sessionId, sessionId).replace(doc);
    }
  } catch {
    // Persistence failures don't break the stream
  }
}

export async function* orchestrate(opts: OrchestrateOptions): AsyncIterable<OrchestratorStep> {
  const { prompt, sessionId, userOid } = opts;
  const maxIter = opts.maxIterations ?? 10;
  // Identity passed to every tool handler so build-assist tools create/configure
  // items OWNED by this user (not the broken tenantId:'default' shells).
  const toolCtx: ToolContext = { userOid, session: { claims: { oid: userOid, upn: userOid } } };

  let target: AoaiTarget;
  try {
    target = await resolveAoaiTarget(opts.tenantConfig ?? null);
  } catch (e: any) {
    const step: OrchestratorStep = {
      kind: 'error',
      error: e instanceof NoAoaiDeploymentError
        ? e.message
        : `AOAI resolution failed: ${e?.message || e}`,
    };
    yield step;
    return;
  }

  const reg = getRegistry();
  // Register any connected external MCP tool servers (Build 2026 "Connect MCP
  // tools") so agent-loom can call them alongside the built-in Loom tools.
  // Best-effort: a missing/unreachable MCP server never breaks the chat.
  try {
    const { buildMcpShim } = await import('./mcp-shim');
    await buildMcpShim(reg, userOid);
  } catch { /* MCP shim optional — continue with built-in tools */ }
  const tools = reg.toAoaiTools();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  await persistStep(sessionId, userOid, { kind: 'thought', content: `User prompt: ${prompt}` }, prompt);

  // --- Content-safety INPUT check: Prompt Shields (jailbreak/injection) +
  // harm-category moderation on the user prompt. Runs on every persona. When
  // Content Safety is not configured (LOOM_CONTENT_SAFETY_ENDPOINT unset) the
  // helpers fail open and isSafetyConfigured() is false, so we skip silently —
  // the UI surfaces the honest "not configured" warning separately. ---
  if (isSafetyConfigured()) {
    const [shieldResult, inputResult] = await Promise.all([
      shieldPrompt(prompt),
      moderateContent(prompt),
    ]);
    const blocked = shieldResult.blocked ? shieldResult : inputResult.blocked ? inputResult : null;
    if (blocked) {
      const errStep: OrchestratorStep = {
        kind: 'error',
        error: blocked.reason,
        code: 'content_safety_input',
      };
      await persistStep(sessionId, userOid, errStep);
      yield errStep;
      return;
    }
  }

  // Accumulate token/context usage across every AOAI round-trip in the loop so
  // the final step can report total cost (parity with the data-agent chat).
  const usage: OrchestratorUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, aoaiCalls: 0, toolCalls: 0 };

  for (let i = 0; i < maxIter; i++) {
    let resp: any;
    try {
      resp = await callAoai(target, messages, tools);
    } catch (e: any) {
      const step: OrchestratorStep = { kind: 'error', error: e?.message || String(e) };
      await persistStep(sessionId, userOid, step);
      yield step;
      return;
    }
    const u = resp?.usage || {};
    usage.aoaiCalls += 1;
    usage.promptTokens += u.prompt_tokens ?? 0;
    usage.completionTokens += u.completion_tokens ?? 0;
    usage.totalTokens += u.total_tokens ?? 0;

    const choice = resp?.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      const step: OrchestratorStep = { kind: 'error', error: 'AOAI returned no choices' };
      await persistStep(sessionId, userOid, step);
      yield step;
      return;
    }

    // Push assistant turn back into history (with any tool_calls)
    messages.push({
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    const toolCalls = msg.tool_calls as ChatMessage['tool_calls'];
    if (!toolCalls || toolCalls.length === 0) {
      // --- Content-safety OUTPUT check: moderate the LLM completion before
      // surfacing it. Blocks high-severity harm in generated text. ---
      if (isSafetyConfigured()) {
        const outputResult = await moderateContent(msg.content || '');
        if (outputResult.blocked) {
          const errStep: OrchestratorStep = {
            kind: 'error',
            error: outputResult.reason,
            code: 'content_safety_output',
          };
          await persistStep(sessionId, userOid, errStep);
          yield errStep;
          return;
        }
      }
      const finalStep: OrchestratorStep = { kind: 'final', content: msg.content || '', usage, model: target.deployment };
      await persistStep(sessionId, userOid, finalStep);
      yield finalStep;
      return;
    }
    usage.toolCalls += toolCalls.length;

    for (const tc of toolCalls) {
      let parsedArgs: unknown = {};
      try { parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}

      const callStep: OrchestratorStep = {
        kind: 'tool_call',
        name: tc.function.name,
        args: parsedArgs,
        callId: tc.id,
      };
      await persistStep(sessionId, userOid, callStep);
      yield callStep;

      const tool = reg.get(tc.function.name);
      const started = Date.now();
      let resultStep: OrchestratorStep;

      if (!tool) {
        resultStep = {
          kind: 'tool_result',
          name: tc.function.name,
          callId: tc.id,
          durationMs: 0,
          error: `Unknown tool: ${tc.function.name}`,
        };
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }),
        });
      } else {
        try {
          const result = await tool.handler(parsedArgs as any, toolCtx);
          // Cap result size fed back to the model so we don't blow context
          const serialized = JSON.stringify(result);
          const truncated = serialized.length > 16_000
            ? serialized.slice(0, 16_000) + '...[truncated]'
            : serialized;
          resultStep = {
            kind: 'tool_result',
            name: tc.function.name,
            callId: tc.id,
            durationMs: Date.now() - started,
            result,
          };
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: truncated,
          });
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          resultStep = {
            kind: 'tool_result',
            name: tc.function.name,
            callId: tc.id,
            durationMs: Date.now() - started,
            error: errMsg,
          };
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify({ error: errMsg }),
          });
        }
      }

      await persistStep(sessionId, userOid, resultStep);
      yield resultStep;
    }
  }

  const maxedStep: OrchestratorStep = {
    kind: 'error',
    error: `Max iterations (${maxIter}) reached without a final answer.`,
  };
  await persistStep(sessionId, userOid, maxedStep);
  yield maxedStep;
}

// ---------- Session helpers ----------

export interface SessionSummary {
  id: string;
  sessionId: string;
  userOid: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
}

export async function listSessions(userOid: string, limit = 50): Promise<SessionSummary[]> {
  const c = await copilotSessionsContainer();
  const q = {
    query: 'SELECT TOP @n c.id, c.sessionId, c.userOid, c.prompt, c.createdAt, c.updatedAt, ARRAY_LENGTH(c.steps) AS stepCount FROM c WHERE c.userOid = @u ORDER BY c.updatedAt DESC',
    parameters: [
      { name: '@n', value: limit },
      { name: '@u', value: userOid },
    ],
  };
  const { resources } = await c.items.query<SessionSummary>(q).fetchAll();
  return resources;
}

export async function getSession(sessionId: string): Promise<any | null> {
  const c = await copilotSessionsContainer();
  const r = await c.item(sessionId, sessionId).read<any>().catch(() => ({ resource: null }));
  return r.resource;
}
