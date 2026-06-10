/**
 * CSA Loom v3 — Cross-item Copilot orchestrator.
 *
 * Calls the AOAI deployment hanging off the Foundry hub (auto-discovered
 * via foundry-client.listConnections() with override LOOM_AOAI_ENDPOINT /
 * LOOM_AOAI_DEPLOYMENT). Exposes 38+ built-in tools spanning every wired Loom
 * service: Synapse SQL, Lakehouse/ADLS, Databricks, APIM, ADX, ADF,
 * Power BI, Fabric, Foundry, Activator, Cosmos, Workspaces, Tabular
 * (semantic-model read — Semantic Link parity, no Power BI on the default
 * path) — plus any runtime-connected MCP shim tools. (Keep this count in
 * sync with buildDefaultRegistry(); /api/copilot/status reports the live
 * number.)
 *
 * Sovereign clouds: the Fabric / Power BI / Activator tools hit
 * api.fabric.microsoft.com / api.powerbi.com, which have NO GCC-High / IL5 /
 * DoD endpoint (Fabric) or a separate sovereign host (Power BI →
 * api.powerbigov.us). In those boundaries those tools throw an honest gate
 * (assertFabricFamilyAvailable) naming the Azure-native equivalent instead of
 * silently calling a Commercial host. Every other tool is sovereign-aware via
 * cloud-endpoints.
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
import {
  cogScope,
  getOpenAiSuffix,
  isGovCloud,
  detectLoomCloud,
  assertFabricFamilyAvailable,
} from './cloud-endpoints';
import { getPanePersona, type PersonaContextPayload } from './copilot-personas';
import type { TenantCopilotConfig } from '../types/copilot-config';
import {
  isFabricCopilotEnabled,
  resolveCopilotFabricWorkspace,
} from '../types/copilot-config';
import {
  executeQuery as synapseExecute,
  dedicatedTarget,
  serverlessTarget,
} from './synapse-sql-client';
import * as synapseDev from './synapse-dev-client';
import * as synapsePool from './synapse-pool-arm';
import { registerWarehouseTools } from '../copilot/sql-tools';
import * as databricks from './databricks-client';
import * as apim from './apim-client';
import * as adf from './adf-client';
import * as kusto from './kusto-client';
import * as adls from './adls-client';
import * as powerbi from './powerbi-client';
import * as fabric from './fabric-client';
import * as activator from './activator-client';
import { copilotSessionsContainer } from './cosmos-client';
// KQL Copilot tools (schema + execute — richer grounding than the bare adx_*
// tools below). Safe despite the kql-tools → orchestrator import cycle:
// LoomToolRegistry is only referenced at call time inside buildKqlToolRegistry.
import { buildKqlToolRegistry } from '@/lib/copilot/kql-tools';
import { runSelfAudit, applyFix } from '@/lib/admin/self-audit';
import type { AuditReport } from '@/lib/admin/self-audit';
import { FABRIC_ITEM_TYPES } from '@/lib/catalog/fabric-item-types';
import { buildTabularReadTools } from '@/lib/copilot/tabular-read-tool';
import { asTable, asSummary } from '@/lib/components/copilot-result-tagger';
import { buildActivatorTools } from '@/lib/copilot/activator-tools';
import { resolvePersona, type CopilotPersonaDef } from './copilot-personas';
import { registerDaxTools } from '@/lib/copilot/dax-tools';

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
 * Cross-check a resolved AOAI endpoint host against the active sovereign cloud.
 *
 * The AOAI bearer token is minted with `cogScope()` — `cognitiveservices.azure.us`
 * in Gov, `cognitiveservices.azure.com` in Commercial/GCC. If an operator points
 * `LOOM_AOAI_ENDPOINT` (or a tenant cfg) at the wrong sovereign host (e.g. a
 * `*.openai.azure.com` Commercial endpoint inside a GCC-High deployment), the
 * data-plane call will 401 with an opaque auth error. Catch the mismatch here
 * and surface a precise, actionable honest-gate instead.
 *
 * A bare host with neither known suffix (custom DNS / private endpoint CNAME)
 * is allowed through — we only reject a host that explicitly carries the OTHER
 * boundary's suffix.
 */
function validateEndpointCloud(endpoint: string): void {
  const host = endpoint.toLowerCase();
  const expectedSuffix = getOpenAiSuffix(); // openai.azure.us | openai.azure.com
  const gov = isGovCloud();
  const cloud = detectLoomCloud();
  const govHost = host.includes('openai.azure.us');
  const comHost = host.includes('openai.azure.com');
  if (gov && comHost && !govHost) {
    throw new NoAoaiDeploymentError(
      `LOOM_AOAI_ENDPOINT points to a Commercial Azure OpenAI host (openai.azure.com) ` +
        `but the active cloud (${cloud}) requires *.${expectedSuffix}. ` +
        `Update LOOM_AOAI_ENDPOINT to your Gov endpoint, or set LOOM_CLOUD to match the endpoint.`,
    );
  }
  if (!gov && govHost && !comHost) {
    throw new NoAoaiDeploymentError(
      `LOOM_AOAI_ENDPOINT points to an Azure Government Azure OpenAI host (openai.azure.us) ` +
        `but the active cloud (${cloud}) requires *.${expectedSuffix}. ` +
        `Update LOOM_AOAI_ENDPOINT to your Commercial endpoint, or set LOOM_CLOUD=GCC-High to match.`,
    );
  }
}

/** The endpoint-suffix hint appended to "no deployment" gates so the operator
 *  knows which sovereign host pattern to provision (openai.azure.us vs .com). */
function expectedSuffixHint(): string {
  return `For ${detectLoomCloud()}, the expected endpoint suffix is ${getOpenAiSuffix()}.`;
}

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
      validateEndpointCloud(endpoint);
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
    const ep = envEndpoint.replace(/\/$/, '');
    validateEndpointCloud(ep);
    const t = { endpoint: ep, deployment: envDeployment, apiVersion };
    if (!cfg) _aoaiTarget = t;
    return t;
  }

  // 3. Discover via Foundry hub connections
  let conns: Awaited<ReturnType<typeof listConnections>> = [];
  try {
    conns = await listConnections();
  } catch (e: any) {
    throw new NoAoaiDeploymentError(
      `No AOAI deployment on Foundry hub. Deploy a gpt-4o / gpt-4.1-class model first. ` +
        `${expectedSuffixHint()} (Foundry connection lookup failed: ${e?.message || e})`,
    );
  }

  const aoai = conns.find(
    (c) => (c.category || '').toLowerCase().includes('openai') ||
           (c.category || '').toLowerCase() === 'azureopenai',
  );
  if (!aoai || !aoai.target) {
    throw new NoAoaiDeploymentError(
      `No AOAI deployment on Foundry hub. Deploy a gpt-4o / gpt-4.1-class model first. ${expectedSuffixHint()}`,
    );
  }

  const deployment =
    cfg?.copilotChatDeployment || envDeployment || (aoai.metadata?.['DeploymentApiVersion'] as string) || 'gpt-4o';
  const discoveredEndpoint = aoai.target.replace(/\/$/, '');
  validateEndpointCloud(discoveredEndpoint);
  const discovered: AoaiTarget = {
    endpoint: discoveredEndpoint,
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

  /** Tools whose name starts with any of the given prefixes (empty = all). Used
   *  to scope a persona to a subset of the registry (e.g. ['dax_','loom_']). */
  filterByPrefixes(prefixes?: string[]): ToolDef[] {
    if (!prefixes || prefixes.length === 0) return this.list();
    return this.list().filter((t) => prefixes.some((p) => t.name.startsWith(p)));
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }

  /** OpenAI-compatible tools array for the AOAI chat-completions call. When
   *  `prefixes` is supplied, only tools matching a prefix are advertised
   *  (persona scoping); execution still resolves against the full registry. */
  toAoaiTools(prefixes?: string[]): unknown[] {
    return this.filterByPrefixes(prefixes).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** OpenAI-compatible tools array filtered to an EXACT-name allowlist — the
   *  per-pane persona tool catalog (copilot-personas.ts PersonaEntry.toolCatalog).
   *  A non-empty `allow` restricts the advertised set to those tool names; an
   *  empty/undefined allowlist returns every tool (the default persona). Unlike
   *  toAoaiTools(prefixes) this matches whole names, not name prefixes. */
  toAoaiToolsByName(allow?: readonly string[]): unknown[] {
    const list = allow && allow.length > 0
      ? this.list().filter((t) => allow.includes(t.name))
      : this.list();
    return list.map((t) => ({
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

/** Render a self-audit report as readable markdown for the summary renderer. */
function auditToMarkdown(report: AuditReport): string {
  const { score, summary } = report;
  const icon = (st: string) => (st === 'pass' ? '✅' : st === 'warn' ? '⚠️' : '❌');
  const lines: string[] = [];
  lines.push(`## CSA Loom self-audit — score ${score}/100`);
  lines.push(`**${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail** (${summary.total} checks, ${summary.fixable} runtime-fixable)`);
  const issues = report.results.filter((r) => r.status !== 'pass');
  if (issues.length === 0) {
    lines.push('');
    lines.push('All checks passed. The deployment is healthy.');
  } else {
    lines.push('');
    lines.push('### Findings');
    for (const r of issues) {
      lines.push(`- ${icon(r.status)} **${r.title}** — ${r.detail}`);
      if (r.remediation) lines.push(`  - Remediation: ${r.remediation.replace(/\n/g, ' ').trim()}`);
      if (r.fixId) lines.push(`  - Runtime-fixable via loom_heal — fixId: \`${r.fixId}\``);
    }
  }
  return lines.join('\n');
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
    handler: async ({ sql, database }) => asTable(await synapseExecute(serverlessTarget(database || 'master'), sql), 'synapse_serverless'),
  });
  r.register({
    name: 'synapse_dedicated_query',
    service: 'Synapse',
    description: 'Run a T-SQL query against the Synapse dedicated SQL pool (provisioned MPP warehouse).',
    parameters: obj({ sql: S_STRING }, ['sql']),
    handler: async ({ sql }) => asTable(await synapseExecute(dedicatedTarget(), sql), 'synapse_dedicated'),
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
      asTable(await databricks.executeStatement(warehouseId, sql, catalog, schema), 'databricks_warehouse'),
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
    handler: async ({ database, kql }) => asTable(await kusto.executeQuery(database, kql), 'adx'),
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

  // -------- KQL Copilot tools (kql_get_schema + kql_execute grounding) --------
  // Register the four kql_* tools so the cross-item Copilot can call
  // kql_get_schema then kql_execute without the user leaving the chat. These
  // sit alongside the legacy adx_* tools (kept for backward compat with
  // sessions that reference them by name).
  for (const t of buildKqlToolRegistry().list()) r.register(t);

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
    handler: async () => { assertFabricFamilyAvailable('powerbi'); return powerbi.listWorkspaces(); },
  });
  r.register({
    name: 'powerbi_list_reports',
    service: 'Power BI',
    description: 'List reports in a Power BI workspace.',
    parameters: obj({ workspaceId: S_STRING }, ['workspaceId']),
    handler: async ({ workspaceId }) => { assertFabricFamilyAvailable('powerbi'); return powerbi.listReports(workspaceId); },
  });
  r.register({
    name: 'powerbi_refresh_dataset',
    service: 'Power BI',
    description: 'Trigger a refresh of a Power BI dataset.',
    parameters: obj(
      { workspaceId: S_STRING, datasetId: S_STRING, notifyOption: S_STRING },
      ['workspaceId', 'datasetId'],
    ),
    handler: async ({ workspaceId, datasetId, notifyOption }) => {
      assertFabricFamilyAvailable('powerbi');
      return powerbi.refreshDataset(workspaceId, datasetId, { notifyOption: notifyOption || 'NoNotification' });
    },
  });

  // -------- Fabric --------
  r.register({
    name: 'fabric_list_workspaces',
    service: 'Fabric',
    description: 'List Microsoft Fabric workspaces.',
    parameters: obj({}),
    handler: async () => { assertFabricFamilyAvailable('fabric'); return fabric.listFabricWorkspaces(); },
  });
  r.register({
    name: 'fabric_create_notebook',
    service: 'Fabric',
    description: 'Create a Fabric notebook with the supplied .ipynb / .py source.',
    parameters: obj(
      { workspaceId: S_STRING, displayName: S_STRING, description: S_STRING, code: S_STRING },
      ['workspaceId', 'displayName', 'code'],
    ),
    handler: async ({ workspaceId, displayName, description, code }) => {
      assertFabricFamilyAvailable('fabric');
      return fabric.createNotebook(workspaceId, {
        displayName,
        description: description || '',
        definition: {
          format: 'ipynb',
          parts: [
            { path: 'notebook-content.py', payload: Buffer.from(code, 'utf-8').toString('base64'), payloadType: 'InlineBase64' },
          ],
        },
      });
    },
  });
  r.register({
    name: 'fabric_run_notebook',
    service: 'Fabric',
    description: 'Submit a Fabric notebook run. Returns { _accepted, location } — the run is async; poll with fabric_poll_job using the returned location to get the terminal status.',
    parameters: obj({ workspaceId: S_STRING, notebookId: S_STRING }, ['workspaceId', 'notebookId']),
    handler: async ({ workspaceId, notebookId }) => { assertFabricFamilyAvailable('fabric'); return fabric.runNotebook(workspaceId, notebookId); },
  });
  r.register({
    name: 'fabric_poll_job',
    service: 'Fabric',
    description:
      'Poll a Fabric long-running operation by its location URL (the `location` returned by ' +
      'fabric_create_notebook / fabric_run_notebook and other async Fabric tools, or a bare operation id). ' +
      'Returns { status: NotStarted|Running|Succeeded|Failed, percentComplete, error, result }. ' +
      'Call repeatedly (respecting retryAfter) until status is Succeeded or Failed to close the async loop.',
    parameters: obj({ location: S_STRING }, ['location']),
    handler: async ({ location }) => { assertFabricFamilyAvailable('fabric'); return fabric.getOperationState(String(location)); },
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
    handler: async ({ workspaceId }) => { assertFabricFamilyAvailable('activator'); return activator.listActivators(workspaceId); },
  });
  r.register({
    name: 'activator_trigger_rule',
    service: 'Activator',
    description: 'Manually trigger an Activator rule.',
    parameters: obj({ workspaceId: S_STRING, activatorId: S_STRING, ruleId: S_STRING }, ['workspaceId', 'activatorId', 'ruleId']),
    handler: async ({ workspaceId, activatorId, ruleId }) => {
      assertFabricFamilyAvailable('activator');
      return activator.triggerRule(workspaceId, activatorId, ruleId);
    },
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
    handler: async () => {
      const report = await runSelfAudit(new Date().toISOString());
      return asSummary(auditToMarkdown(report), `Self-audit · ${report.score}/100`);
    },
  });
  r.register({
    name: 'loom_heal',
    service: 'Loom',
    description: "Apply a runtime-safe healer fix by its fixId (from loom_self_audit results, e.g. 'ensure-cosmos'). Only fixes the Console identity can safely apply at runtime are executed; deploy-time issues (env vars / RBAC grants) return guidance to apply + redeploy instead of pretending to fix. Requires tenant-admin approval at the UI layer.",
    parameters: obj({ fixId: S_STRING }, ['fixId']),
    handler: async ({ fixId }) => applyFix(String(fixId)),
  });

  // -------- Tabular model reading (Semantic Link parity, no Power BI) --------
  // Four tools: tabular_list_models / tabular_list_tables / tabular_list_measures
  // / tabular_eval_dax. Default backend is loom-native (Cosmos metadata +
  // Synapse SQL); AAS XMLA only when LOOM_SEMANTIC_BACKEND=analysis-services +
  // LOOM_AAS_SERVER. The Power BI REST host is NEVER called on the default path.
  for (const t of buildTabularReadTools()) r.register(t);

  // -------- Approval-gated edits (Keep / Undo) --------
  // Tools that propose a change to an OPEN editor surface return a result with a
  // `__proposedChange__` sentinel. The orchestrator strips the sentinel and
  // emits a `proposed_change` step; the pane renders a Monaco DiffEditor and
  // mutates the editor ONLY on explicit Keep. The change is NEVER applied here.
  r.register({
    name: 'notebook_propose_refactor',
    service: 'Loom',
    description:
      'Propose a refactored version of a notebook code cell. Returns a before/after diff that the USER must approve (Keep) before any change is applied — you do NOT apply it yourself. Use this whenever the user asks to refactor, optimize, clean up, comment, or rewrite a cell, instead of returning the edited code as prose. Pass the cellId, the cell\'s current source verbatim, the language, and your improved source.',
    parameters: obj({
      cellId: S_STRING,
      currentSource: S_STRING,
      refactoredSource: S_STRING,
      lang: S_STRING,
      rationale: S_STRING,
    }, ['cellId', 'currentSource', 'refactoredSource']),
    handler: async ({ cellId, currentSource, refactoredSource, lang, rationale }) => {
      const summary = rationale ? String(rationale) : 'Proposed cell refactor.';
      return {
        ok: true,
        message: 'Proposed a cell refactor. Awaiting the user\'s Keep/Undo decision; the change is not yet applied.',
        rationale: summary,
        [PROPOSED_CHANGE_KEY]: {
          target: `notebook-cell:${String(cellId)}`,
          before: String(currentSource ?? ''),
          after: String(refactoredSource ?? ''),
          lang: String(lang || 'pyspark'),
          summary,
        },
      };
    },
  });

  // -------- Activator Copilot (persona tools) --------
  // Real Azure Monitor scheduled-query-alert authoring (author → suggest
  // threshold from real historical data → create after confirm → list →
  // history). Registered in the MAIN registry so cross-cutting tools (e.g.
  // loom_self_audit) remain available when the activator persona is active.
  // ACTIVATOR_PERSONA.allowedTools (copilot-personas.ts) gates which tools the
  // model sees per turn. No Fabric dependency — see activator-tools.ts.
  for (const t of buildActivatorTools()) r.register(t);

  // -------- SQL slash-command tools (explain / fix / comments / optimize) --------
  // The cross-item Copilot exposure of the Loom slash commands: when the user
  // says "explain this query" / "fix this" / "comment this" / "make this faster"
  // the model can call these directly. Each grounds in the live warehouse schema
  // and calls the SAME AOAI deployment the chat loop uses (no Fabric Copilot).
  // See lib/copilot/slash-commands.ts + lib/azure/copilot-personas.ts.
  r.register({
    name: 'sql_explain',
    service: 'SQL Copilot',
    description:
      'Explain a T-SQL or Spark SQL query in plain language, grounded in the live warehouse schema. Use when the user asks what a query does. Returns { explanation }.',
    parameters: obj({ sql: S_STRING, engine: S_STRING, db: S_STRING }, ['sql']),
    handler: async ({ sql, engine, db }) => {
      const dialect = dialectForToolEngine(engine);
      const schema = await toolSqlSchemaContext(engine, db);
      const schemaSection = schema ? `\n\nWarehouse schema:\n${schema}` : '';
      const explanation = await aoaiCompleteText([
        {
          role: 'system',
          content:
            `You are a SQL assistant for CSA Loom. Explain what the following ${dialect} query does ` +
            `in 3-5 concise sentences, referencing the actual tables, columns, filters, joins and ` +
            `aggregations and the business intent. Plain prose, no code fences.` +
            schemaSection,
        },
        { role: 'user', content: `${dialect} query:\n\`\`\`\n${sql}\n\`\`\`` },
      ]);
      return { explanation: explanation.trim() };
    },
  });
  r.register({
    name: 'sql_fix',
    service: 'SQL Copilot',
    description:
      'Fix a T-SQL or Spark SQL query that produced an error, using the real error text. Returns { sql } with the corrected query.',
    parameters: obj({ sql: S_STRING, errorText: S_STRING, engine: S_STRING, db: S_STRING }, ['sql', 'errorText']),
    handler: async ({ sql, errorText, engine, db }) => {
      const dialect = dialectForToolEngine(engine);
      const schema = await toolSqlSchemaContext(engine, db);
      const schemaSection = schema ? `\n\nWarehouse schema:\n${schema}` : '';
      const raw = await aoaiCompleteText([
        {
          role: 'system',
          content:
            `You are a SQL debugger for CSA Loom. Fix the following ${dialect} query that produced an ` +
            `error. Return ONLY the corrected, runnable ${dialect} — no fences, no explanation.` +
            schemaSection,
        },
        { role: 'user', content: `${dialect} query:\n\`\`\`\n${sql}\n\`\`\`\n\nError:\n${String(errorText || '')}` },
      ]);
      return { sql: stripSqlFences(raw) };
    },
  });
  r.register({
    name: 'sql_comments',
    service: 'SQL Copilot',
    description:
      'Add inline comments to a T-SQL or Spark SQL query, preserving the exact table/column names and logic. Returns { sql } with the commented query.',
    parameters: obj({ sql: S_STRING, engine: S_STRING, db: S_STRING }, ['sql']),
    handler: async ({ sql, engine, db }) => {
      const dialect = dialectForToolEngine(engine);
      const schema = await toolSqlSchemaContext(engine, db);
      const schemaSection = schema ? `\n\nWarehouse schema:\n${schema}` : '';
      const raw = await aoaiCompleteText([
        {
          role: 'system',
          content:
            `You are a SQL documentation assistant for CSA Loom. Return the SAME ${dialect} query, ` +
            `unchanged in logic, with a concise inline comment (-- syntax) above every non-trivial ` +
            `clause. Preserve the EXACT table/column names. Return ONLY the commented SQL — no fences.` +
            schemaSection,
        },
        { role: 'user', content: `${dialect} query:\n\`\`\`\n${sql}\n\`\`\`` },
      ]);
      return { sql: stripSqlFences(raw) };
    },
  });
  r.register({
    name: 'sql_optimize',
    service: 'SQL Copilot',
    description:
      'Rewrite a T-SQL or Spark SQL query for better performance with engine-specific hints (Synapse OPTION()/columnstore, Databricks AQE/Z-ordering/broadcast). Pass explainPlan when a real query plan is available. Returns { sql } with the optimized query.',
    parameters: obj({ sql: S_STRING, engine: S_STRING, db: S_STRING, explainPlan: S_STRING }, ['sql']),
    handler: async ({ sql, engine, db, explainPlan }) => {
      const dialect = dialectForToolEngine(engine);
      const schema = await toolSqlSchemaContext(engine, db);
      const schemaSection = schema ? `\n\nWarehouse schema:\n${schema}` : '';
      const planSection = String(explainPlan || '').trim()
        ? `\n\nActual query plan (target these operators):\n${String(explainPlan).slice(0, 4000)}`
        : '';
      const raw = await aoaiCompleteText([
        {
          role: 'system',
          content:
            `You are a SQL performance engineer for CSA Loom. Rewrite the ${dialect} query to run ` +
            `faster, keeping the result set identical and preserving exact table/column names. ` +
            `For T-SQL/Synapse: sargable predicates, JOIN order, OPTION() hints, columnstore-friendly ` +
            `projections, no scalar UDFs/cursors. For Spark SQL/Databricks: AQE, predicate/projection ` +
            `pushdown, Delta Z-ordering/partition pruning, broadcast-join hints, no collect()/Python UDFs. ` +
            `Return ONLY the rewritten SQL — no fences, no commentary.` +
            schemaSection +
            planSection,
        },
        { role: 'user', content: `${dialect} query to optimize:\n\`\`\`\n${sql}\n\`\`\`` },
      ]);
      return { sql: stripSqlFences(raw) };
    },
  });
  // -------- Warehouse Copilot (schema read / EXPLAIN plan / run) --------
  registerWarehouseTools(r);
  // -------- DAX Copilot (Loom-native tabular layer; no Power BI) --------
  // NL2DAX, explain, optimize, auto-describe over item.state.model. Evaluates
  // via Synapse SQL — zero api.powerbi.com on this path. Surfaced on the `dax`
  // persona (toolPrefixes ['dax_','loom_']).
  registerDaxTools(r);

  return r;
}

export interface OrchestratorUsage { promptTokens: number; completionTokens: number; totalTokens: number; aoaiCalls: number; toolCalls: number; }

export type OrchestratorStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | { kind: 'final'; content: string; usage?: OrchestratorUsage; model?: string }
  | { kind: 'error'; error: string; code?: string }
  // A tool proposed a code/query/transform change. The pane renders a Monaco
  // DiffEditor (before|after) and applies it ONLY on explicit Keep — never
  // automatically. `target` is a deterministic editor-bridge key
  // (e.g. "notebook-cell:<id>") routed by lib/copilot/apply-change.ts.
  | { kind: 'proposed_change'; target: string; before: string; after: string; lang?: string; callId?: string; summary?: string };

/** Sentinel a tool handler attaches to its result to surface an approval-gated
 *  diff. The orchestrator strips it before feeding the result back to AOAI (so
 *  the model never sees the plumbing) and emits a `proposed_change` step.
 *  Re-exported from lib/copilot/proposed-change (kept there so the pure
 *  sentinel logic is unit-testable without the Azure SDK graph). */
export { PROPOSED_CHANGE_KEY, extractProposedChange } from '@/lib/copilot/proposed-change';
export type { ProposedChangePayload } from '@/lib/copilot/proposed-change';
import { PROPOSED_CHANGE_KEY, extractProposedChange, type ProposedChangePayload } from '@/lib/copilot/proposed-change';

export interface OrchestrateOptions {
  prompt: string;
  sessionId: string;
  userOid: string;
  maxIterations?: number;
  /** Tenant admin-selected Copilot config (account + chat deployment). When
   *  supplied it takes priority over env / discovery. */
  tenantConfig?: TenantCopilotConfig | null;
  /** Per-surface persona registry (e.g. the Pipeline Copilot). When supplied,
   *  the loop uses THIS tool set instead of the global cross-item registry and
   *  skips the MCP shim (the persona is intentionally scoped). */
  registryOverride?: LoomToolRegistry;
  /** Per-surface system prompt (paired with registryOverride). */
  systemPromptOverride?: string;
  /** Optional persona id (e.g. 'activator') — narrows the system prompt + the
   *  exposed tool set to the matching CopilotPersonaDef (copilot-personas.ts).
   *  When unset/unknown the full cross-item Copilot is used. */
  persona?: string | null;
  /** Per-surface context injected as an extra system message (e.g. the
   *  activator id + existing rule names the user is working with). */
  personaContext?: Record<string, unknown> | null;
  /** Persona system-prompt override. Replaces the default SYSTEM_PROMPT — used
   *  by focused surfaces (e.g. the DAX Copilot) to narrow the assistant. */
  personaSystemPrompt?: string;
  /** Persona tool allowlist (name prefixes). When set, only matching tools are
   *  advertised to the model — execution still resolves against the full
   *  registry. e.g. ['dax_','loom_'] for the DAX persona. */
  toolPrefixes?: string[];
  /** Alias of systemPromptOverride — used by persona-scoped surfaces (e.g. the
   *  Report Copilot). Honored as a fallback in the system-message build. */
  systemPrompt?: string;
  /** Alias of registryOverride — a persona-scoped tool registry (MCP shim NOT
   *  applied). Used by the Report Copilot. */
  registry?: LoomToolRegistry;
  /** Pane context slug (e.g. 'warehouse', 'notebook'). Selects the per-pane
   *  persona (system prompt + tool catalog + title) server-side via the persona
   *  registry (copilot-personas.ts getPanePersona). Unknown / undefined → the
   *  cross-item 'default' persona. Distinct from `persona` (the CopilotPersonaDef
   *  id like 'activator'); an explicit `persona`/override takes priority. */
  contextSlug?: string;
  /** Raw editor state the per-pane persona's system prompt is composed from
   *  server-side (active query, schema, workspace id, item id). The persona
   *  template interpolates these into named slots — no free-form client string is
   *  concatenated into the system prompt. */
  contextPayload?: PersonaContextPayload;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Legacy default system prompt. The cross-item ('default') persona in
 * copilot-personas.ts carries this exact text. Kept exported for backward
 * compatibility / direct callers; live orchestration now resolves the prompt
 * per-pane via getPersona(opts.contextSlug).systemPrompt(opts.contextPayload).
 */
export const SYSTEM_PROMPT = getPanePersona('default').systemPrompt({});


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

/**
 * Plain single-shot AOAI completion (NO tools) — the engine behind the
 * SQL slash-command tools (sql_explain / sql_fix / sql_comments / sql_optimize).
 * Resolves the AOAI target the same way the orchestrator does, gets an AAD
 * bearer (cognitiveservices scope), and retries once without temperature for
 * reasoning-model deployments. Returns the assistant message text.
 */
async function aoaiCompleteText(
  messages: { role: 'system' | 'user'; content: string }[],
): Promise<string> {
  const target = await resolveAoaiTarget();
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const token = await aoaiToken();
  const send = (withTemperature: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        withTemperature ? { messages, temperature: 0.2, max_tokens: 2048 } : { messages, max_tokens: 2048 },
      ),
    });
  let res = await send(true);
  if (res.status === 400) {
    const t = await res.text();
    if (isUnsupportedSamplingParam(t)) res = await send(false);
    else throw new Error(`AOAI 400: ${t.slice(0, 300)}`);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AOAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  return String(j?.choices?.[0]?.message?.content ?? '');
}

/** Strip stray ```lang fences a model may add despite ONLY-SQL instructions. */
function stripSqlFences(raw: string): string {
  return raw
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** Human dialect label for the SQL slash-command tools' prompts. */
function dialectForToolEngine(engine?: string): string {
  const e = String(engine || '').toLowerCase();
  if (e.includes('databricks') || e.includes('spark')) return 'Spark SQL (Databricks)';
  if (e.includes('serverless')) return 'T-SQL (Synapse Serverless)';
  return 'T-SQL';
}

// Best-effort schema grounding for the SQL slash-command tools — one DMV
// round-trip returns the columns of every user table (soft-fail to '' on a
// paused pool / cold warehouse / no grant so the tool still answers).
const TOOL_SCHEMA_SQL = `SELECT TOP 400 s.name + '.' + t.name AS table_name, c.name AS column_name, tp.name AS type_name
FROM sys.columns c
JOIN sys.tables t ON t.object_id = c.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.types tp ON tp.user_type_id = c.user_type_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id`;

async function toolSqlSchemaContext(engine?: string, db?: string): Promise<string> {
  const e = String(engine || '').toLowerCase();
  try {
    if (e.includes('databricks') || e.includes('spark')) return '';
    const serverless = e.includes('serverless');
    const target = serverless ? serverlessTarget(db || 'master') : dedicatedTarget();
    const res = await synapseExecute(target, TOOL_SCHEMA_SQL, 20_000);
    if (!res.rows.length) return '';
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      const [table, col, type] = row as [string, string, string];
      const cols = byTable.get(table) || [];
      cols.push(`${col} ${type}`);
      byTable.set(table, cols);
    }
    const str = [...byTable.entries()].map(([t, cols]) => `${t}(${cols.join(', ')})`).join('\n');
    return str.length > 6000 ? `${str.slice(0, 6000)}\n…(schema truncated)` : str;
  } catch {
    return '';
  }
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

// ── App Insights usage telemetry (write path) ────────────────────────────────
// Emits one `copilot.usage` custom event per completed orchestration carrying
// the REAL prompt/completion token counts from the AOAI `usage` field. Parses
// APPLICATIONINSIGHTS_CONNECTION_STRING directly and POSTs the App Insights
// track envelope to its ingestion endpoint — no SDK dependency for one call.
//
// The connection string already contains the correct sovereign ingestion host
// (Bicep provisions the right regional App Insights per boundary), so this
// write path is cloud-agnostic. When the connection string is unset (App
// Insights not configured) the helper no-ops — honest gate, never throws.
//
// Connection-string format:
//   InstrumentationKey=<guid>;IngestionEndpoint=https://<region>.in.applicationinsights.azure.com/;...
function _parseAiConnStr(s: string): { iKey: string; endpoint: string } | null {
  const kv: Record<string, string> = {};
  for (const seg of s.split(';')) {
    const eq = seg.indexOf('=');
    if (eq > 0) kv[seg.slice(0, eq).trim().toLowerCase()] = seg.slice(eq + 1).trim();
  }
  const iKey = kv['instrumentationkey'];
  const endpoint = (kv['ingestionendpoint'] || '').replace(/\/+$/, '');
  return iKey && endpoint ? { iKey, endpoint } : null;
}

/**
 * Fire-and-forget App Insights receipt for a completed Copilot turn. `persona`
 * identifies the Copilot surface (e.g. `cross-item`, `notebook`) so the admin
 * panel can break token consumption out per persona. Never awaited on the hot
 * path; never throws.
 */
export async function emitCopilotUsage(
  usage: OrchestratorUsage,
  model: string,
  sessionId: string,
  userOid: string,
  persona: string,
): Promise<void> {
  const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connStr) return; // honest gate — App Insights unconfigured → no-op
  const ai = _parseAiConnStr(connStr);
  if (!ai) return;
  // Don't emit empty receipts (e.g. AOAI resolution failed before any call).
  if (usage.totalTokens <= 0 && usage.aoaiCalls <= 0) return;
  try {
    const { createHash } = await import('crypto');
    const userHash = createHash('sha256').update(String(userOid)).digest('hex').slice(0, 16);
    await fetch(`${ai.endpoint}/v2/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Microsoft.ApplicationInsights.Event',
        time: new Date().toISOString(),
        iKey: ai.iKey,
        tags: {
          'ai.cloud.role': 'loom-console',
          'ai.cloud.roleInstance': 'copilot-orchestrator',
        },
        data: {
          baseType: 'EventData',
          baseData: {
            ver: 2,
            name: 'copilot.usage',
            properties: {
              persona,
              model,
              prompt_tokens: String(usage.promptTokens),
              completion_tokens: String(usage.completionTokens),
              total_tokens: String(usage.totalTokens),
              aoai_calls: String(usage.aoaiCalls),
              tool_calls: String(usage.toolCalls),
              user_oid_hash: userHash,
              session_id: sessionId,
              boundary: process.env.CSA_LOOM_BOUNDARY || 'Commercial',
            },
          },
        },
      }),
    });
  } catch {
    // Telemetry must never break the orchestrator stream.
  }
}

/**
 * MAF tier client — proxies orchestration to the `loom-copilot-maf` Container
 * App and re-yields its `OrchestratorStep` SSE stream verbatim, persisting each
 * step into the SAME shared Cosmos `copilot-sessions` container the Foundry tier
 * uses. Auto-engaged from {@link orchestrate} when `isGovCloud()` and
 * `LOOM_MAF_ENDPOINT` is set.
 *
 * The MAF app is VNet-internal (Container Apps internal ingress). The Console
 * passes the signed-in user's `oid` as the trusted `x-user-oid` header — the MAF
 * app uses that to call the Console's token-gated internal tool endpoints
 * (`/api/internal/copilot/tools/*`), so tool dispatch + OBO + per-user ownership
 * remain in the Console. The MAF app authenticates that callback with the shared
 * `LOOM_INTERNAL_TOKEN`; the AOAI completion itself is done by the MAF app's UAMI
 * against Gov AOAI (`*.openai.azure.us`).
 */
async function* orchestrateViaMaf(
  opts: OrchestrateOptions,
  mafEndpoint: string,
): AsyncIterable<OrchestratorStep> {
  const { prompt, sessionId, userOid } = opts;
  const url = `${mafEndpoint.replace(/\/$/, '')}/orchestrate`;

  // Mirror the Foundry tier's opening thought + prompt persistence so the stored
  // transcript shape is identical regardless of which tier served the turn.
  await persistStep(sessionId, userOid, { kind: 'thought', content: `User prompt: ${prompt}` }, prompt);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-oid': userOid },
      body: JSON.stringify({ prompt, sessionId, maxIterations: opts.maxIterations }),
    });
  } catch (e: any) {
    const step: OrchestratorStep = {
      kind: 'error',
      error: `MAF orchestration tier unreachable at ${mafEndpoint}: ${e?.message || e}`,
    };
    await persistStep(sessionId, userOid, step);
    yield step;
    return;
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    const step: OrchestratorStep = {
      kind: 'error',
      error: `MAF orchestration tier returned ${res.status}: ${body.slice(0, 300)}`,
    };
    await persistStep(sessionId, userOid, step);
    yield step;
    return;
  }

  // Parse the SSE stream from the MAF app and re-yield each OrchestratorStep.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5).trimStart();
        if (currentEvent === 'step') {
          let step: OrchestratorStep | null = null;
          try { step = JSON.parse(raw) as OrchestratorStep; } catch { step = null; }
          if (step) {
            await persistStep(sessionId, userOid, step);
            yield step;
            if (step.kind === 'final' || step.kind === 'error') return;
          }
        }
        currentEvent = '';
      } else if (line.trim() === '') {
        currentEvent = '';
      }
    }
  }
}

export async function* orchestrate(opts: OrchestrateOptions): AsyncIterable<OrchestratorStep> {
  const { prompt, sessionId, userOid } = opts;
  // Copilot surface tag for per-persona usage metering (string, defaults to
  // `cross-item`). Distinct from the resolved CopilotPersonaDef below.
  const personaTag = opts.persona || 'cross-item';
  const maxIter = opts.maxIterations ?? 10;
  // Identity passed to every tool handler so build-assist tools create/configure
  // items OWNED by this user (not the broken tenantId:'default' shells).
  const toolCtx: ToolContext = { userOid, session: { claims: { oid: userOid, upn: userOid } } };

  // ── MAF orchestration tier (GCC-High / IL5) ────────────────────────────────
  // When the active cloud is an Azure Government boundary (isGovCloud()) AND
  // LOOM_MAF_ENDPOINT is wired (the loom-copilot-maf Container App is deployed),
  // proxy the whole orchestration to that app. The MAF tier calls Gov AOAI
  // (cognitiveservices.azure.us) DIRECTLY — bypassing the two Gov-broken Foundry
  // paths this function would otherwise use: the Foundry hub listConnections()
  // discovery (unreliable on a kind=Default workspace) and the
  // services.ai.azure.com Agent Service endpoint (no confirmed Gov host).
  //
  // Tool DISPATCH + OBO stay HERE: the MAF app calls back into the Console's
  // token-gated internal tool endpoints, so the exact same handlers, the exact
  // same Cosmos containers, and the exact same per-user ownership apply. Step
  // PERSISTENCE is also done on this side (persistStep → shared copilot-sessions
  // container) as each proxied step is re-yielded, so a MAF-tier transcript is
  // byte-identical in shape + storage to a Foundry-tier transcript.
  const mafEndpoint = process.env.LOOM_MAF_ENDPOINT;
  if (isGovCloud() && mafEndpoint) {
    yield* orchestrateViaMaf(opts, mafEndpoint);
    return;
  }
  // ── End MAF tier ────────────────────────────────────────────────────────────

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

  const reg = opts.registryOverride ?? opts.registry ?? getRegistry();
  // Register any connected external MCP tool servers (Build 2026 "Connect MCP
  // tools") so agent-loom can call them alongside the built-in Loom tools.
  // Best-effort: a missing/unreachable MCP server never breaks the chat. Skip
  // entirely for a scoped persona registry (registryOverride / registry) —
  // those expose a deliberately tight tool set.
  if (!opts.registryOverride && !opts.registry) {
    try {
      const { buildMcpShim } = await import('./mcp-shim');
      await buildMcpShim(reg, userOid);
    } catch { /* MCP shim optional — continue with built-in tools */ }
  }



  // Persona switch: when a known persona id is supplied, override the system
  // prompt and narrow the exposed tool set to the persona's allowedTools (+ any
  // persona-local extraTools). Unknown/absent persona → full cross-item Copilot.
  const persona: CopilotPersonaDef | null = resolvePersona(opts.persona);
  if (persona?.extraTools?.length) for (const t of persona.extraTools) reg.register(t);

  // Per-pane persona (contextSlug → PersonaEntry). Resolves the editor pane's
  // system prompt (composed server-side from opts.contextPayload) + its
  // tool catalog + title. Unknown/undefined slug → the 'default' pane persona
  // (empty toolCatalog = all tools, legacy SYSTEM_PROMPT text). The explicit
  // CopilotPersonaDef (opts.persona, e.g. 'activator') still takes priority for
  // both the tool set and the system prompt.
  const panePersona = getPanePersona(opts.contextSlug);

  let tools: unknown[];
  if (persona?.allowedTools?.length) {
    const allow = new Set(persona.allowedTools);
    if (persona.extraTools) for (const t of persona.extraTools) allow.add(t.name);
    tools = reg.list()
      .filter((t) => allow.has(t.name))
      .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  } else if (opts.toolPrefixes && opts.toolPrefixes.length) {
    tools = reg.toAoaiTools(opts.toolPrefixes);
  } else {
    // Default path: scope to the pane persona's tool catalog (exact names).
    // An empty catalog (the 'default' pane) returns every tool, incl. any
    // MCP-shim tools registered above — identical to the legacy behaviour.
    tools = reg.toAoaiToolsByName(panePersona.toolCatalog);
  }

  // System-prompt precedence: explicit overrides win; then the CopilotPersonaDef
  // (activator/etc.); then the per-pane persona composed from the context payload
  // (which for the 'default' pane equals the legacy SYSTEM_PROMPT text).
  const paneSystemPrompt = panePersona.systemPrompt(opts.contextPayload ?? {});
  const systemPrompt = persona?.systemPrompt || paneSystemPrompt;
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPromptOverride ?? opts.personaSystemPrompt ?? opts.systemPrompt ?? systemPrompt },
  ];
  // Inject per-surface context (e.g. the activator id + existing rule names) as
  // a second system message so the model grounds its draft in the live editor.
  if (opts.personaContext && Object.keys(opts.personaContext).length) {
    messages.push({
      role: 'system',
      content: `Current editor context (JSON): ${JSON.stringify(opts.personaContext).slice(0, 4000)}`,
    });
  }
  messages.push({ role: 'user', content: prompt });

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

  // -- Fabric / Power BI Copilot opt-in branch -----------------------------
  // ONLY entered when LOOM_COPILOT_BACKEND=fabric (or cfg.fabricCopilotBackend)
  // AND a Fabric workspace id resolves AND this is NOT a Gov boundary. The
  // Azure-native AOAI path below is the SILENT DEFAULT — when this block is
  // skipped NOTHING is emitted and NO Fabric/Power BI host is contacted. This
  // is the ONLY place the orchestrator reaches api.fabric.microsoft.com at the
  // system level (per .claude/rules/no-fabric-dependency.md).
  if (isFabricCopilotEnabled(opts.tenantConfig ?? null, isGovCloud)) {
    const fabricWsId = resolveCopilotFabricWorkspace(opts.tenantConfig ?? null);
    try {
      // Real api.fabric.microsoft.com call — validates the bound workspace is
      // reachable and the Console UAMI has the required role.
      const workspaces = await fabric.listFabricWorkspaces();
      const ws = workspaces.find((w) => w.id === fabricWsId || w.displayName === fabricWsId);
      const wsLabel = ws ? `${ws.displayName} (${ws.id})` : fabricWsId;
      await persistStep(sessionId, userOid, {
        kind: 'thought',
        content:
          `Fabric Copilot opt-in active: validated workspace ${wsLabel} via api.fabric.microsoft.com. ` +
          `LLM inference runs on Azure OpenAI (Fabric Copilot exposes no public programmatic invocation API). ` +
          `Fabric tools (fabric_list_workspaces, fabric_create_notebook, fabric_run_notebook) are preferred for items in this workspace.`,
      });
      // Enrich the system prompt with Fabric workspace context so the model
      // prefers Fabric-native operations for items in the bound workspace.
      messages[0] = {
        role: 'system',
        content:
          SYSTEM_PROMPT +
          `\n\nFABRIC CAPACITY OPT-IN: A Microsoft Fabric workspace is bound for this session: ${wsLabel}. ` +
          `When the user's request maps to a Fabric item (notebook, pipeline, lakehouse) in this workspace, prefer the ` +
          `fabric_* tools and operate against this workspace id (${ws?.id || fabricWsId}).`,
      };
    } catch (e: any) {
      // Honest fall-through: surface the precise remediation, then continue on
      // the Azure-native AOAI path (do NOT abort the chat).
      await persistStep(sessionId, userOid, {
        kind: 'error',
        error:
          `Fabric Copilot opt-in: workspace ${fabricWsId} is not reachable via api.fabric.microsoft.com — ` +
          `verify (1) the Console UAMI has Member/Contributor on the workspace, ` +
          `(2) "Service principals can use Fabric APIs" is enabled in the Fabric admin portal, ` +
          `(3) the workspace is on F2+ / P1+ capacity. Continuing on the Azure-native Copilot path. ` +
          `(${e instanceof fabric.FabricError ? `${e.status} ${e.message}` : e?.message || e})`,
      });
    }
  }
  // -- END opt-in branch — Azure-native AOAI loop follows (default path) ----

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
      // Fire-and-forget App Insights receipt — real token counts, never awaited.
      emitCopilotUsage(usage, target.deployment, sessionId, userOid, personaTag).catch(() => {});
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
          // If the tool attached an approval-gated change, peel the sentinel off
          // BEFORE serializing — the model must never see internal plumbing, and
          // the diff must be gated behind explicit Keep, not described as done.
          const { publicResult, proposed } = extractProposedChange(result);
          // Cap result size fed back to the model so we don't blow context
          const serialized = JSON.stringify(publicResult);
          const truncated = serialized.length > 16_000
            ? serialized.slice(0, 16_000) + '...[truncated]'
            : serialized;
          resultStep = {
            kind: 'tool_result',
            name: tc.function.name,
            callId: tc.id,
            durationMs: Date.now() - started,
            result: publicResult,
          };
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: truncated,
          });
          await persistStep(sessionId, userOid, resultStep);
          yield resultStep;
          // Surface the approval-gated diff as its own step right after the
          // tool_result so the pane can open the Keep/Undo modal. Nothing is
          // mutated server-side — the client applies only on Keep.
          if (proposed) {
            const pcStep: OrchestratorStep = {
              kind: 'proposed_change',
              target: proposed.target,
              before: proposed.before,
              after: proposed.after,
              lang: proposed.lang,
              summary: proposed.summary,
              callId: tc.id,
            };
            await persistStep(sessionId, userOid, pcStep);
            yield pcStep;
          }
          continue;
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
  // Fire-and-forget App Insights receipt — real token counts, never awaited.
  emitCopilotUsage(usage, target.deployment, sessionId, userOid, personaTag).catch(() => {});
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
