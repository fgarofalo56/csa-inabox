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

import { listConnections } from './foundry-client';
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

// ---------- Credential ----------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
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
  const t = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire AOAI token');
  return t.token;
}

// ---------- Tool registry ----------

export interface ToolDef {
  name: string;
  description: string;
  service: string;
  parameters: Record<string, unknown>; // JSON Schema object
  handler: (args: any) => Promise<unknown>;
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
    description: 'Create a new Loom workspace (Cosmos-backed metadata only).',
    parameters: obj({ name: S_STRING, description: S_STRING }, ['name']),
    handler: async ({ name, description }) => {
      const { workspacesContainer } = await import('./cosmos-client');
      const c = await workspacesContainer();
      const id = `ws-${Date.now()}`;
      const doc = { id, name, description: description || '', tenantId: 'default', createdAt: new Date().toISOString() };
      await c.items.create(doc);
      return doc;
    },
  });
  r.register({
    name: 'item_create',
    service: 'Loom',
    description: 'Create a new Loom item (Cosmos metadata) of a given type inside a workspace.',
    parameters: obj({ workspaceId: S_STRING, type: S_STRING, displayName: S_STRING }, ['workspaceId', 'type', 'displayName']),
    handler: async ({ workspaceId, type, displayName }) => {
      const { itemsContainer } = await import('./cosmos-client');
      const c = await itemsContainer();
      const id = `item-${Date.now()}`;
      const doc = { id, workspaceId, type, displayName, createdAt: new Date().toISOString() };
      await c.items.create(doc);
      return doc;
    },
  });

  return r;
}

// ---------- Orchestrator ----------

export type OrchestratorStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string }
  | { kind: 'error'; error: string };

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

const SYSTEM_PROMPT = `You are CSA Loom Copilot, a cross-item orchestrator for Microsoft Fabric, Synapse, Databricks, ADF, APIM, ADX, Power BI, AI Foundry, and ADLS.

You decompose user requests into concrete tool calls against the registered Loom tools. Always prefer real tool calls over describing what you would do. Chain results: feed output of one call into the next. Be concise in your final summary; the user already sees the step trace.

If a tool errors, surface the error clearly and either retry with corrected inputs or abandon that branch and explain why.`;

async function callAoai(
  target: AoaiTarget,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<any> {
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
    }),
  });
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

async function persistStep(sessionId: string, userOid: string, step: OrchestratorStep, prompt?: string) {
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
  const tools = reg.toAoaiTools();

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  await persistStep(sessionId, userOid, { kind: 'thought', content: `User prompt: ${prompt}` }, prompt);

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
      const finalStep: OrchestratorStep = { kind: 'final', content: msg.content || '' };
      await persistStep(sessionId, userOid, finalStep);
      yield finalStep;
      return;
    }

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
          const result = await tool.handler(parsedArgs as any);
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
