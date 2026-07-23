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
 * Power BI agentic (opt-in remote MCP): the Power BI remote MCP server
 * (api.fabric.microsoft.com/v1/mcp/powerbi) is NOT a new default-path Fabric
 * host. Its schema-aware semantic-model query + Copilot-DAX tools auto-register
 * through buildMcpShim as `mcp_powerbiremote_*` ONLY when opted into
 * (LOOM_POWERBI_MCP_CLIENT_ID + the PBI-admin tenant setting), and run under a
 * per-USER Entra OBO bearer (pbi-user-token-store) — never the Console UAMI,
 * never on the default path. The lightweight `powerbi_mcp_status` meta-tool
 * reports that opt-in/connection state honestly (config + cached-token) so the
 * Copilot can answer "connect Power BI" conversationally without contacting any
 * Fabric host. Loom's Azure-native semantic-model/report authoring (dax_* /
 * tabular_* / report_*) stays the day-one DEFAULT — see
 * .claude/rules/no-fabric-dependency.md.
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

import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

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
import { resolveTierForTurn, type ModelTier, type TaskClass } from '@/lib/foundry/model-tier-router';
import { recordCopilotTurn, recentFullTurnBurn } from '@/lib/perf/copilot-latency-tracker';
import { resolveAoaiCallTarget, aoaiApimHeaders, type AoaiCallTarget } from './aoai-apim-gateway';
import { applyAvailabilityFallback } from '@/lib/foundry/model-availability-runtime';
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
import { FACTORY_OBJECT_KINDS } from './adf-resource-ops';
import * as pipelineTools from '../copilot/pipeline-tools';
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
import { registerKnowledgeTools } from '@/lib/copilot/knowledge-tools';
// Opt-in Power BI remote MCP (no-fabric-dependency): config state + per-user
// delegated token. Used ONLY by the powerbi_mcp_status meta-tool below — never
// to reach a Fabric/Power BI host on a default path. The remote MCP's tools
// auto-register through buildMcpShim (entra-obo) when opted into.
import {
  isPbiMcpConfigured,
  REMOTE_BUILTIN_MCP,
  REMOTE_BUILTIN_MCP_CATALOG,
  msRemoteMcpConfigured,
} from '@/lib/mcp/catalog';
import { getPbiUserToken } from './pbi-user-token-store';
import { POWERBI_REMOTE_MCP_GATE_TEXT } from '@/lib/copilot/powerbi-skills';
// Microsoft agent-skill descriptors (github.com/microsoft/skills). They REUSE the
// Power BI skill plumbing (the same LoomCopilotSkill contract + selector shape),
// extended additively for the curated Microsoft MCP servers (github.com/microsoft/mcp).
// Injected below as connection-aware, per-pane guidance — NO new tool loop, no
// parallel system. Microsoft Learn is the sole default-on MCP; every other server
// is opt-in and emits an honest catalog gate until connected (no-fabric-dependency,
// no-vaporware).
import { msSkillSystemBlocksForPane, msMcpPrefix, msSkillsForPane } from '@/lib/copilot/ms-skills';
import { renderSkillInjectionForUser } from '@/lib/azure/skill-store';
import { recordSkillUsage } from '@/lib/azure/skill-usage';
// rel-T85 list-price estimator (CTS-01) — pure, shared with the admin usage
// dashboard so the per-turn $ figure uses one source of truth.
import { estCostUsd } from '@/lib/copilot/cost-estimate';
// Pure segmented context-window builder + token estimator (CTS-05).
import { buildContextUsagePayload, estimateTokens } from '@/lib/copilot/context-usage';
// CTS-03: per-turn phase timer for the admin deep-trace Timeline tab.
import { PhaseTimer, type PhaseTiming } from '@/lib/copilot/phase-timer';
// CTS-08: layered long-term memory recall injected into the prompt (default-ON,
// user-scoped; degrades to a Cosmos keyword scan when the vector mirror is absent).
import { getLayeredContext, memoriesToCitations } from '@/lib/azure/memory-recall';
// Tool-provenance → grounding citation mapper (CTS-04). Pure; maps a tool
// result's known provenance shapes into the Citation[] the transcript renders.
import { extractCitationsFromToolResult, mergeCitations } from '@/lib/copilot/tool-citations';
// N10 — Answer-receipt assembler (pure) + best-effort Cosmos persistence. Every
// agentic answer's final step assembles a receipt (exact SQL/KQL/Cypher + row
// counts, sources, tier, cost, verdict) and persists it to loom-answer-receipts;
// the persisted doc id is threaded back onto the final step as `receiptId`.
import { assembleAnswerReceipt } from '@/lib/copilot/answer-receipt';
import { persistAnswerReceipt } from '@/lib/azure/answer-receipts-store';

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
      new AcaManagedIdentityCredential(),
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
 *
 * Model-strategy M5: the resolved target is passed through
 * {@link applyAvailabilityFallback}, which degrades a configured-but-undeployed
 * model down to a supported one (the Gov-lag 404 class) using the per-cloud
 * availability matrix + the account's live deployment list. That step is cached,
 * synchronous, and non-fatal — it never blocks or fails a chat.
 */
export async function resolveAoaiTarget(
  forceOrCfg: boolean | TenantCopilotConfig | null = false,
  maybeCfg?: TenantCopilotConfig | null,
): Promise<AoaiTarget> {
  return applyAvailabilityFallback(await resolveAoaiTargetRaw(forceOrCfg, maybeCfg));
}

/** The pre-M5 resolution (tenant cfg → env → Foundry discovery → floor). Kept as
 *  a separate function so {@link resolveAoaiTarget} can layer the availability
 *  fallback over every return path uniformly without touching the cache logic. */
async function resolveAoaiTargetRaw(
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

// Exported so the unified aoai-chat-client (LOOM_AOAI_CLIENT_V2) can reuse the
// EXACT same credential + cogScope() token acquisition — no new credential code.
export async function aoaiToken(): Promise<string> {
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
  /**
   * Optional one-line "when to use" hint surfaced in the Copilot console
   * right-rail tool catalog (self-explanatory tools, audit-T121). Falls back to
   * `description` in the UI when absent — no tool ever renders blank.
   */
  whenToUse?: string;
  /**
   * True when the tool reads the active editor context (query / schema) — the
   * console badges these so the user knows the tool grounds on what's open.
   */
  readsContext?: boolean;
  /**
   * Display name of the MCP server backing this tool (CTS-02/09). Set by
   * buildMcpShim for external MCP tools; absent for always-on native Loom tools
   * (which the detail panel labels "built-in").
   */
  serverName?: string;
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
  r.register({
    name: 'adf_delete_pipeline',
    service: 'ADF',
    description:
      'Permanently delete a named Azure Data Factory pipeline. DESTRUCTIVE and irreversible. Call with confirm:false ' +
      '(default) FIRST — it returns a confirmation prompt WITHOUT deleting; only call again with confirm:true after the ' +
      'user explicitly confirms.',
    parameters: obj({ name: S_STRING, confirm: { type: 'boolean' } }, ['name']),
    handler: async ({ name, confirm }) =>
      pipelineTools.handlePipelineDeletePipeline({ name, backend: 'adf', confirm: confirm === true }),
  });
  r.register({
    name: 'adf_remove_factory_object',
    service: 'ADF',
    description:
      'Permanently remove an Azure Data Factory object by type + name — dataset, linked-service, trigger, ' +
      'integration-runtime, dataflow, cdc, or managed-private-endpoint. DESTRUCTIVE and irreversible. Call with ' +
      'confirm:false (default) FIRST to get the confirmation prompt; only call confirm:true after the user confirms.',
    parameters: obj(
      { objectType: { type: 'string', enum: [...FACTORY_OBJECT_KINDS] }, name: S_STRING, confirm: { type: 'boolean' } },
      ['objectType', 'name'],
    ),
    handler: async ({ objectType, name, confirm }) =>
      pipelineTools.handlePipelineRemoveFactoryObject({ objectType, name, backend: 'adf', confirm: confirm === true }),
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
  // powerbi_mcp_status — connection-state reporter for the OPT-IN Power BI remote
  // MCP server (api.fabric.microsoft.com/v1/mcp/powerbi). Unlike the powerbi_*
  // tools above it does NOT call assertFabricFamilyAvailable and never contacts a
  // Fabric host: it only reads config (LOOM_POWERBI_MCP_CLIENT_ID via
  // isPbiMcpConfigured) and whether THIS user has a still-valid cached delegated
  // Power BI token (pbi-user-token-store). So it answers "connect Power BI / why
  // isn't the Power BI MCP available" honestly on any cloud — surfacing the exact
  // remediation (env var + Entra app reg + tenant setting) when not ready, with
  // the Azure-native authoring tools still the default (no-fabric-dependency,
  // no-vaporware).
  r.register({
    name: 'powerbi_mcp_status',
    service: 'Power BI',
    description:
      'Report whether the OPT-IN Power BI remote MCP server is connectable for the current user. ' +
      'Returns { configured, endpoint, tenantSetting, hasUserToken, ready, remediation } — `configured` ' +
      'reflects whether the Entra app reg env var LOOM_POWERBI_MCP_CLIENT_ID is set, `hasUserToken` ' +
      'whether the signed-in user has a still-valid cached delegated Power BI token, and `ready` when ' +
      'both hold (its mcp_powerbiremote_* query + Copilot-DAX tools are then live). Use this to answer ' +
      '"can I connect Power BI" / "why is the Power BI MCP unavailable"; when not ready, relay the ' +
      'returned remediation. The Azure-native semantic-model/report authoring tools (dax_* / tabular_* / ' +
      'report_*) work WITHOUT this — never claim a Power BI capability unless ready is true.',
    whenToUse: 'Check if the opt-in Power BI remote MCP is connected for this user ("connect Power BI").',
    parameters: obj({}),
    handler: async (_args, ctx) => {
      const configured = isPbiMcpConfigured();
      // Real Cosmos read — null when the user never consented the PBI scopes or
      // the cached token expired. No Fabric host is contacted here.
      const hasUserToken = configured && !!(await getPbiUserToken(ctx.userOid));
      const ready = configured && hasUserToken;
      let remediation: string | undefined;
      if (!configured) {
        remediation = POWERBI_REMOTE_MCP_GATE_TEXT;
      } else if (!hasUserToken) {
        remediation =
          'The Power BI remote MCP is configured, but you have no valid cached Power BI token. ' +
          'Sign out and sign back in so Loom can mint a delegated token on your behalf (consent the ' +
          'Power BI scopes Dataset.Read.All, MLModel.Execute.All, Workspace.Read.All). A Power BI admin ' +
          `must also have enabled the tenant setting "${REMOTE_BUILTIN_MCP.tenantSetting}".`;
      }
      return {
        configured,
        endpoint: REMOTE_BUILTIN_MCP.endpoint,
        tenantSetting: REMOTE_BUILTIN_MCP.tenantSetting,
        hasUserToken,
        ready,
        ...(remediation ? { remediation } : {}),
      };
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

  // -------- Gate registry (G2) — discover / explain / resolve config gates ----
  // The complete registry of every configuration gate (lib/gates/registry.ts,
  // derived from self-audit ENV_CHECKS). resolve goes through EXACTLY the same
  // whitelisted, capability-gated env-config write path as /admin/env-config
  // and the Fix-it wizard — never a side channel.
  r.register({
    name: 'loom_list_gates',
    service: 'Loom',
    description:
      'List EVERY configuration gate in the CSA Loom deployment with live status (configured / blocked), the missing env vars, and the owning surfaces. Use when asked what is not configured, what gates exist, why a feature shows a warning banner, or what setup remains. Follow up with loom_explain_gate / loom_resolve_gate.',
    whenToUse: 'Ask “what is blocked / not configured / what gates remain?”',
    parameters: obj({ status: { type: 'string', enum: ['all', 'blocked', 'configured'] } }),
    handler: async ({ status }) => {
      const { GATES, allGateStatuses } = await import('@/lib/gates/registry');
      const statuses = new Map(allGateStatuses().map((s) => [s.id, s]));
      const filter = String(status || 'all');
      const lines: string[] = [];
      let blocked = 0;
      for (const g of GATES) {
        const st = statuses.get(g.id);
        const stat = st?.status ?? 'blocked';
        if (stat === 'blocked') blocked += 1;
        if (filter !== 'all' && stat !== filter) continue;
        const miss = st?.missing?.length ? ` — missing: ${st.missing.join(', ')}` : '';
        const auto = g.canAutoResolve ? ' (auto-resolves on a push-button deploy)' : '';
        lines.push(`- ${stat === 'configured' ? '✅' : '⚠️'} **${g.title}** (\`${g.id}\`, ${g.severity})${miss}${auto}`);
      }
      const md = [
        `## Gate registry — ${GATES.length} gates, ${GATES.length - blocked} configured · ${blocked} blocked`,
        '',
        ...lines,
        '',
        'Use loom_explain_gate for the exact remediation of one gate, or loom_resolve_gate (tenant admin) to set its values. Full UI: /admin/gates.',
      ].join('\n');
      return asSummary(md, `Gates · ${GATES.length - blocked}/${GATES.length} configured`);
    },
  });
  r.register({
    name: 'loom_explain_gate',
    service: 'Loom',
    description:
      'Explain ONE configuration gate by id (from loom_list_gates): what it gates, live status, every required env var (with example value), the RBAC role, the bicep module that provisions it, the owning surfaces, and the exact pre-filled fix script. Use before resolving a gate or when a user asks why a specific surface is gated.',
    whenToUse: 'Ask “why is X gated / what does gate Y need?”',
    parameters: obj({ gateId: S_STRING }, ['gateId']),
    handler: async ({ gateId }) => {
      const { getGate, gateStatus } = await import('@/lib/gates/registry');
      const g = getGate(String(gateId));
      if (!g) return { ok: false, error: `unknown gate id '${gateId}' — call loom_list_gates for valid ids.` };
      const st = gateStatus(g.id);
      const md = [
        `## ${g.title} (\`${g.id}\`)`,
        `**Status:** ${st?.status ?? 'blocked'}${st?.missing?.length ? ` — missing: ${st.missing.join(', ')}` : ''}`,
        `**Severity:** ${g.severity} · **Category:** ${g.category}${g.canAutoResolve ? ' · **auto-resolves on a push-button deploy**' : ''}`,
        '',
        `**Remediation:** ${g.remediation}`,
        g.role ? `**Role required:** ${g.role}` : '',
        g.provisionedBy ? `**Provisioned by:** \`${g.provisionedBy}\`` : '',
        '',
        '**Required settings:**',
        ...g.requiredSettings.map((s) =>
          `- \`${s.envVar}\`${s.valueHint ? ` — e.g. \`${s.valueHint}\`` : ''}${s.aliasOf ? ` (any one of ${s.aliasOf.join(' / ')})` : ''}`),
        '',
        g.surfaces.length ? `**Surfaces:** ${g.surfaces.map((s) => s.label).join(' · ')}` : '',
        st?.check.fixScript ? `\n**Fix script (pre-filled):**\n\`\`\`powershell\n${st.check.fixScript}\n\`\`\`` : '',
        '',
        `A tenant admin can apply values with loom_resolve_gate (gateId \`${g.id}\`) or the Fix-it wizard on /admin/gates.`,
      ].filter(Boolean).join('\n');
      return asSummary(md, `Gate · ${g.title}`);
    },
  });
  r.register({
    name: 'loom_resolve_gate',
    service: 'Loom',
    description:
      "Resolve a configuration gate by setting its required env values (WRITE — tenant admin only; the same capability-gated env-config path as /admin/env-config, with audit + SIEM trail). Pass the gateId and a values object mapping the gate's env vars to the values the user confirmed (get valid vars from loom_explain_gate). The change rolls a new container revision (~1–2 min) — report that honestly; the gate flips to configured once the revision is live. NEVER invent values: ask the user or read them from loom_explain_gate's discovered options.",
    whenToUse: 'The user (a tenant admin) asked to fix/set a gate\'s configuration.',
    parameters: obj({ gateId: S_STRING, values: S_OBJECT }, ['gateId', 'values']),
    handler: async ({ gateId, values }, ctx) => {
      const { getGate, gateStatus } = await import('@/lib/gates/registry');
      const g = getGate(String(gateId));
      if (!g) return { ok: false, error: `unknown gate id '${gateId}' — call loom_list_gates for valid ids.` };
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return { ok: false, error: 'values must be an object mapping env var → value.' };
      }
      // WRITE gate — same capability as PUT /api/admin/env-config. The tool
      // context carries the caller's oid; group-based admins may not resolve
      // here (no group claims in tool context) — they get an honest pointer to
      // the UI instead of a bypass.
      const { checkCapability } = await import('@/lib/auth/feature-gate');
      const cap = await checkCapability(ctx.session as any, 'admin.env-config', 'Admin');
      if (!cap.allow) {
        return {
          ok: false,
          error: 'forbidden — resolving a gate writes deployment config and needs the admin.env-config Admin capability.',
          remediation: 'Ask a tenant admin to run this, or use the Fix-it wizard on /admin/gates (which honors group-based admin membership).',
        };
      }
      const allowed = new Set<string>();
      for (const s of g.requiredSettings) {
        allowed.add(s.envVar);
        for (const a of s.aliasOf || []) allowed.add(a);
      }
      const unknown = Object.keys(values).filter((k) => !allowed.has(k));
      if (unknown.length > 0) {
        return { ok: false, error: `key(s) not part of gate '${g.id}': ${unknown.join(', ')}. Allowed: ${Array.from(allowed).join(', ')}.` };
      }
      const { applyEnvChanges } = await import('@/lib/admin/env-apply');
      const who = ctx.session.claims.upn || ctx.session.claims.email || ctx.userOid;
      const result = await applyEnvChanges({
        tenantId: ctx.session.claims.oid,
        who,
        actorOid: ctx.userOid,
        values: values as Record<string, unknown>,
        action: 'gate.resolve',
        auditDetail: { gateId: g.id, via: 'copilot' },
      });
      if (!result.ok) return { ok: false, error: result.error };
      const st = gateStatus(g.id);
      return {
        ok: true,
        gateId: g.id,
        changed: result.changed,
        secretsChanged: result.secretsChanged,
        rejected: result.rejected,
        platform: result.platform,
        statusAfterApply: st?.status ?? 'blocked',
        message: result.changedCount === 0
          ? (result.message || 'No changes to apply.')
          : `Applied ${result.changedCount} value(s) — a new revision is rolling (~1–2 min); the gate reports configured once it is live. ${result.driftWarning || ''}`,
      };
    },
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
  // -------- Agentic retrieval (Foundry IQ): knowledge_base_retrieve / _list --------
  // Grounds RAG answers on Loom's own indexed estate via Azure AI Search
  // agentic retrieval (query decomposition + semantic rerank). Real AI Search
  // REST; honest message when unconfigured. No Fabric dependency.
  registerKnowledgeTools(r);

  // -------- Browser automation (AIF-18) --------
  // Drives a real web page via a Loom-owned Playwright runner (Azure Container
  // Apps — HTTP runner or scale-to-zero Job). Honest-gated: when no runner is
  // wired the tool returns the exact env var / bicep module to provision instead
  // of a mock. No external browser service — Gov-portable. (agent-tool-kinds.ts)
  r.register({
    name: 'browser_automation',
    service: 'Browser',
    description:
      'Drive a headless web browser: open a URL and run ordered actions ' +
      '(click / type / read / screenshot), returning the page text. Backed by a ' +
      'Loom-owned Playwright runner (Azure Container Apps). Returns an honest ' +
      'config gate when no runner is deployed — never fabricated page content.',
    whenToUse: 'Navigate/scrape a live web page or drive a web UI as a tool.',
    parameters: obj(
      {
        url: S_STRING,
        actions: { type: 'array', description: 'Ordered actions: {op:"click"|"type"|"read"|"screenshot", selector?, text?}.', items: S_OBJECT },
      },
      ['url'],
    ),
    handler: async ({ url, actions }) => {
      const { runBrowserTask, BrowserToolNotConfiguredError } = await import('./browser-tool-client');
      try {
        return await runBrowserTask({ url: String(url), actions: Array.isArray(actions) ? actions : [] });
      } catch (e: any) {
        if (e instanceof BrowserToolNotConfiguredError) {
          return { ok: false, gated: true, missing: e.missing, hint: e.hint };
        }
        throw e;
      }
    },
  });

  return r;
}

export interface OrchestratorUsage { promptTokens: number; completionTokens: number; totalTokens: number; aoaiCalls: number; toolCalls: number; }

// Per-turn transparency shapes (CTS-01/02/05). Mirror the client-side
// definitions in lib/components/copilot/types.ts (kept in sync by hand — the
// client module can't import the server orchestrator, which pulls in the Azure
// SDK). All additive/optional so older clients render unchanged.
export interface TurnToolDetail {
  name: string;
  serverName?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}
export interface TurnDetail {
  tools: TurnToolDetail[];
  routedAgentName?: string;
  routedReason?: string;
}
/** Grounding citation shape the transcript renders (CTS-04). Mirrors the UI
 *  `Citation` in lib/components/help-copilot/citations + copilot/types. */
export interface Citation {
  id: string;
  path: string;
  kind: string;
  heading?: string;
  url?: string;
  preview: string;
}
export interface ContextUsage {
  contextWindow: number;
  systemPromptTokens: number;
  personaContextTokens: number;
  skills: { count: number; tokens: number; names: string[] };
  tools: { count: number; tokens: number; names: string[] };
  memory: { tokens: number };
  knowledge: { tokens: number };
  conversationHistory: { messages: number; tokens: number };
  totalInputTokens: number;
  remainingTokens: number;
  utilizationPct: number;
  segmentSum: number;
  segmentsConsistent: boolean;
  systemPromptPreview: string;
}

export type OrchestratorStep =
  | { kind: 'thought'; content: string }
  | { kind: 'tool_call'; name: string; args: unknown; callId: string }
  | { kind: 'tool_result'; name: string; callId: string; durationMs: number; result?: unknown; error?: string }
  | {
      kind: 'final';
      content: string;
      usage?: OrchestratorUsage;
      model?: string;
      // CTS-01 status-bar metadata.
      provider?: string;
      promptTokens?: number;
      completionTokens?: number;
      turnLatencyMs?: number;
      costUsd?: number;
      // CTS-16: which tier the AIF-12 tier router chose for this turn (surfaced
      // in the CTS-01 metadata bar). Present only when routing actively swapped
      // the deployment away from the resolved default.
      routedTier?: ModelTier;
      // WS-1.1: the honestly-ridden model tier + classified task class for THIS
      // turn — ALWAYS present (unlike routedTier, which is swap-only). This is
      // the durable tier-attribution trace attribute a browser E2E reads on
      // every copilot turn, and the admin deep-trace / debug panel surfaces.
      modelTier?: ModelTier;
      taskClass?: TaskClass;
      // CTS-02 per-message detail roll-up.
      turnDetail?: TurnDetail;
      // CTS-04 grounding citations mapped from tool provenance.
      citations?: Citation[];
      // CTS-05 context-window breakdown (also emitted standalone below).
      contextUsage?: ContextUsage;
      // CTS-03 per-turn phase timings (classify / prompt-build / llm / tools) for
      // the admin deep-trace panel's Timeline tab. Best-effort; omitted on error.
      phaseTimings?: PhaseTiming[];
      // N10: the persisted loom-answer-receipts doc id for this answer's receipt.
      // Best-effort — omitted when receipt assembly/persistence is unavailable.
      // The ReceiptPanel re-assembles the receipt from the transcript and surfaces
      // this id as the persisted governance-audit reference.
      receiptId?: string;
    }
  | { kind: 'error'; error: string; code?: string }
  // CTS-05: emitted once per turn at message-build time, before the AOAI loop.
  | { kind: 'context_usage'; usage: ContextUsage }
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
  /** Caller's Entra tenant id (session.claims.tid). Optional — when supplied it
   *  lets the CTS-07 skill registry surface TENANT custom skills + the tenant
   *  default overlay in the skill injection; when absent the per-user overrides
   *  (keyed by userOid) + built-ins still resolve, so behavior is unchanged. */
  tenantId?: string | null;
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
export function isUnsupportedSamplingParam(body: string): boolean {
  return /unsupported_value|does not support|Only the default \(1\) value is supported/i.test(body)
    && /temperature|top_p/i.test(body);
}

/**
 * Unwrap a thrown fetch/network error into a human-readable cause chain. Node's
 * `fetch` surfaces only `"fetch failed"` as the message and hides the real
 * reason (ENOTFOUND / ECONNREFUSED / ETIMEDOUT / cert errors) in `.cause`. This
 * walks the chain so server logs name the actual failure instead of the opaque
 * wrapper that was being streamed to the chat widget.
 */
export function describeFetchError(e: any): string {
  const parts: string[] = [];
  let cur: any = e;
  let depth = 0;
  while (cur && depth < 5) {
    const code = cur.code ? `[${cur.code}]` : '';
    const m = cur.message || String(cur);
    parts.push(`${cur.name || 'Error'}${code}: ${m}`);
    if (cur.errno !== undefined || cur.syscall || cur.hostname) {
      parts.push(`(syscall=${cur.syscall || '?'} errno=${cur.errno ?? '?'} host=${cur.hostname || '?'})`);
    }
    cur = cur.cause;
    depth++;
  }
  return parts.join(' ← ');
}

/** AOAI host for logging without leaking the full URL/keys. */
function aoaiHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return endpoint; }
}

/**
 * M4 — HTTP-status error from an inline AOAI attempt (body already read). Marks a
 * real API error (400/404/5xx from the model) so the APIM→direct fallback below
 * does NOT retry it — only a genuine transport outage ("gateway unreachable")
 * triggers the direct-with-managed-identity fallback. Mirrors the unified
 * client's AoaiResponseError; kept local to avoid an orchestrator↔client cycle.
 */
class AoaiApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AoaiApiError';
  }
}

async function callAoai(
  target: AoaiTarget,
  messages: ChatMessage[],
  tools: unknown[],
): Promise<any> {
  // LOOM_AOAI_CLIENT_V2 cut-over: delegate to the unified aoai-chat-client. Its
  // aoaiChatRaw reproduces this body/retry/error path byte-for-byte (same
  // pre-resolved target, same { messages, tools, tool_choice } body with NO cap,
  // same sampling-param retry, same error text). Flag OFF → the inline path below
  // runs unchanged (migration-safe / reversible). Dynamic import keeps the static
  // dependency edge one-way (client → orchestrator), avoiding a load-time cycle.
  if (process.env.LOOM_AOAI_CLIENT_V2 === 'true') {
    const { aoaiChatRaw } = await import('./aoai-chat-client');
    return aoaiChatRaw({ target, messages, tools, toolChoice: 'auto', temperature: 0.2 });
  }
  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  let token: string;
  try {
    token = await aoaiToken();
  } catch (e: any) {
    console.error(
      `[copilot] AOAI token acquisition FAILED for host=${aoaiHost(target.endpoint)}: ${describeFetchError(e)}`,
    );
    throw new Error(`AOAI auth failed (could not acquire a managed-identity token): ${e?.message || e}`);
  }
  const body: Record<string, unknown> = { messages, tools, tool_choice: 'auto' };

  // M4 — one attempt against a resolved call target (direct AOAI by DEFAULT, or
  // the APIM gateway when LOOM_AOAI_VIA_APIM=true + LOOM_AOAI_APIM_URL). First
  // attempt sends temperature for determinism; if the model rejects it, retry
  // once with the default sampling (no temperature). Works across classic chat
  // models and the newer reasoning models.
  const attempt = async (call: AoaiCallTarget): Promise<any> => {
    const attemptUrl = call.viaApim
      ? `${call.endpoint}/openai/deployments/${encodeURIComponent(call.deployment)}/chat/completions?api-version=${call.apiVersion}`
      : url;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = async (withTemperature: boolean) =>
      fetchWithTimeout(attemptUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(withTemperature ? { ...body, temperature: 0.2 } : body),
      }, LLM_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await send(true);
    } catch (e: any) {
      console.error(
        `[copilot] AOAI chat-completions fetch THREW for host=${aoaiHost(call.endpoint)} deployment=${call.deployment}: ${describeFetchError(e)}`,
      );
      throw new Error(
        `AOAI chat endpoint unreachable (${aoaiHost(call.endpoint)}): ${describeFetchError(e)}`,
      );
    }
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) {
        res = await send(false);
      } else {
        throw new AoaiApiError(`AOAI chat-completions failed 400: ${t.slice(0, 400)}`);
      }
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiApiError(`AOAI chat-completions failed ${res.status}: ${t.slice(0, 400)}`);
    }
    return res.json();
  };

  // Direct path (flag off) → single attempt, byte-identical to pre-M4. APIM path
  // → on a transport outage (Gov gateway down / LLM policies absent) fall back to
  // direct-with-managed-identity automatically.
  const primary = resolveAoaiCallTarget(target);
  if (!primary.viaApim) return attempt(primary);
  try {
    return await attempt(primary);
  } catch (e) {
    if (e instanceof AoaiApiError) throw e; // real API error — not a gateway outage
    return attempt(resolveAoaiCallTarget(target, { apimAvailable: false }));
  }
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
  // LOOM_AOAI_CLIENT_V2 cut-over → unified client (byte-for-byte: no-cfg target
  // resolution, temperature 0.2, max_completion_tokens 2048, same retry/parse).
  if (process.env.LOOM_AOAI_CLIENT_V2 === 'true') {
    const { aoaiChat } = await import('./aoai-chat-client');
    return aoaiChat({ messages, maxCompletionTokens: 2048, temperature: 0.2 });
  }
  const target = await resolveAoaiTarget();
  const token = await aoaiToken();
  const attempt = async (call: AoaiCallTarget): Promise<string> => {
    const url = `${call.endpoint}/openai/deployments/${encodeURIComponent(call.deployment)}/chat/completions?api-version=${call.apiVersion}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          // Newer AOAI models (o-series / gpt-5 / reasoning) reject `max_tokens` and
          // require `max_completion_tokens`; it is also accepted by gpt-4o/4o-mini on
          // current api-versions, so it is the forward-compatible cap for all deployments.
          withTemperature ? { messages, temperature: 0.2, max_completion_tokens: 2048 } : { messages, max_completion_tokens: 2048 },
        ),
      }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) res = await send(false);
      else throw new AoaiApiError(`AOAI 400: ${t.slice(0, 300)}`);
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiApiError(`AOAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    return String(j?.choices?.[0]?.message?.content ?? '');
  };
  const primary = resolveAoaiCallTarget(target);
  if (!primary.viaApim) return attempt(primary);
  try {
    return await attempt(primary);
  } catch (e) {
    if (e instanceof AoaiApiError) throw e;
    return attempt(resolveAoaiCallTarget(target, { apimAvailable: false }));
  }
}

/**
 * Single-shot AOAI completion that returns a parsed JSON object.
 *
 * Used by purpose-built generators that need a STRUCTURED result rather than a
 * chat stream — e.g. the Real-Time Dashboard "AI tile" generator turns a
 * natural-language ask into `{ title, kql, viz }`. Resolves the AOAI target via
 * the same precedence the orchestrator uses (tenant cfg → env → Foundry
 * discovery), so a missing deployment throws `NoAoaiDeploymentError` and the
 * caller can surface the honest 503 gate.
 *
 * Requests `response_format: { type: 'json_object' }` so the model returns a
 * single JSON object; falls back to extracting the first `{...}` block if a
 * deployment / api-version doesn't honor json_object mode. Retries once without
 * temperature for reasoning-model deployments (same logic as aoaiCompleteText).
 */
export async function aoaiCompleteJson<T = Record<string, unknown>>(
  messages: { role: 'system' | 'user'; content: string }[],
  cfg?: TenantCopilotConfig | null,
  maxTokens = 2048,
): Promise<T> {
  // LOOM_AOAI_CLIENT_V2 cut-over → unified client (byte-for-byte: cfg-honoring
  // target resolution, temperature 0.1, max_completion_tokens=maxTokens,
  // response_format json_object, same retry + parseJsonObject fallback).
  if (process.env.LOOM_AOAI_CLIENT_V2 === 'true') {
    const { aoaiChatJson } = await import('./aoai-chat-client');
    return aoaiChatJson<T>({
      messages,
      cfg: cfg ?? null,
      maxCompletionTokens: maxTokens,
      temperature: 0.1,
      responseFormat: 'json_object',
    });
  }
  const target = await resolveAoaiTarget(cfg ?? null);
  const token = await aoaiToken();
  const attempt = async (call: AoaiCallTarget): Promise<T> => {
    const url = `${call.endpoint}/openai/deployments/${encodeURIComponent(call.deployment)}/chat/completions?api-version=${call.apiVersion}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...aoaiApimHeaders(call) };
    const send = (withTemperature: boolean) =>
      fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(
          // max_completion_tokens (not max_tokens) — required by newer AOAI models,
          // accepted by gpt-4o/4o-mini on current api-versions (forward-compatible).
          withTemperature
            ? { messages, temperature: 0.1, max_completion_tokens: maxTokens, response_format: { type: 'json_object' } }
            : { messages, max_completion_tokens: maxTokens, response_format: { type: 'json_object' } },
        ),
      }, LLM_FETCH_TIMEOUT_MS);
    let res = await send(true);
    if (res.status === 400) {
      const t = await res.text();
      if (isUnsupportedSamplingParam(t)) res = await send(false);
      else throw new AoaiApiError(`AOAI 400: ${t.slice(0, 300)}`);
    }
    if (!res.ok) {
      const t = await res.text();
      throw new AoaiApiError(`AOAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    const raw = String(j?.choices?.[0]?.message?.content ?? '').trim();
    return parseJsonObject<T>(raw);
  };
  const primary = resolveAoaiCallTarget(target);
  if (!primary.viaApim) return attempt(primary);
  try {
    return await attempt(primary);
  } catch (e) {
    if (e instanceof AoaiApiError) throw e;
    return attempt(resolveAoaiCallTarget(target, { apimAvailable: false }));
  }
}

/** Parse an LLM JSON reply, tolerating ```json fences and surrounding prose. */
function parseJsonObject<T>(raw: string): T {
  const cleaned = raw
    .replace(/^\s*```[a-zA-Z0-9_+-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1)) as T;
    }
    throw new Error(`Model did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
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
 * Optional data-dimension for a Copilot/agent turn — powers the DSPM-for-AI
 * posture report (which agent touched which sensitivity-labeled data). All
 * fields are optional; when present they are added to the `copilot.usage`
 * envelope as extra `customDimensions` (Properties) so KQL can summarize usage
 * `by agent_id` / `by sensitivity_label` without breaking the existing schema.
 */
export interface CopilotUsageExtra {
  /** The Loom item id of the agent that served the turn (data-agent etc.). */
  agentId?: string;
  /** Human-readable agent name (for display in the report). */
  agentName?: string;
  /** Highest-ranked sensitivity label across the data the agent touched. */
  sensitivityLabel?: string;
  /** Distinct sensitivity labels the agent's sources carry. */
  sensitivityLabels?: string[];
  /** Names of the data sources the agent is grounded on. */
  dataSources?: string[];
}

/**
 * Fire-and-forget App Insights receipt for a completed Copilot turn. `persona`
 * identifies the Copilot surface (e.g. `cross-item`, `notebook`, `data-agent`)
 * so the admin panel can break token consumption out per persona. The optional
 * `extra` adds the DSPM-for-AI data dimension (agent id + touched sensitivity
 * labels). Never awaited on the hot path; never throws.
 */
export async function emitCopilotUsage(
  usage: OrchestratorUsage,
  model: string,
  sessionId: string,
  userOid: string,
  persona: string,
  extra?: CopilotUsageExtra,
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
    const properties: Record<string, string> = {
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
    };
    // DSPM-for-AI data dimension (only added when supplied — keeps the base
    // schema intact for callers that don't ground on data sources).
    if (extra?.agentId) properties.agent_id = extra.agentId;
    if (extra?.agentName) properties.agent_name = extra.agentName;
    if (extra?.sensitivityLabel) properties.sensitivity_label = extra.sensitivityLabel;
    if (extra?.sensitivityLabels?.length) properties.sensitivity_labels = extra.sensitivityLabels.join(',');
    if (extra?.dataSources?.length) properties.data_sources = extra.dataSources.join(',');
    await fetchWithTimeout(`${ai.endpoint}/v2/track`, {
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
            properties,
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
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-oid': userOid },
      body: JSON.stringify({ prompt, sessionId, maxIterations: opts.maxIterations }),
    }, LLM_FETCH_TIMEOUT_MS);
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
  // N10: accumulate the proxied steps so the SOVEREIGN-MOAT receipt is assembled
  // + persisted on the IL5/Gov MAF tier too — identically to the Foundry tier.
  const mafSteps: Array<Record<string, unknown>> = [];

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
            mafSteps.push(step as unknown as Record<string, unknown>);
            // N10: assemble + persist the answer receipt for the MAF-tier final
            // step, threading the persisted id back onto it. Best-effort — the
            // receipt is the IL5 compliance artifact but must never block the
            // answer. Runs in-boundary (Gov Cosmos), so it holds air-gapped.
            if (step.kind === 'final') {
              try {
                const f = step as Record<string, unknown>;
                const receipt = assembleAnswerReceipt(
                  {
                    prompt,
                    steps: mafSteps,
                    model: f.model as string | undefined,
                    modelTier: f.modelTier as string | undefined,
                    taskClass: f.taskClass as string | undefined,
                    routedTier: f.routedTier as string | undefined,
                    usage: f.usage as Record<string, number> | undefined,
                    costUsd: f.costUsd as number | undefined,
                    turnLatencyMs: f.turnLatencyMs as number | undefined,
                    phaseTimings: f.phaseTimings as never,
                    citations: f.citations as Array<Record<string, unknown>> | undefined,
                    tools: (f.turnDetail as { tools?: never } | undefined)?.tools,
                  },
                  { createdAt: new Date().toISOString() },
                );
                const receiptId = await persistAnswerReceipt(receipt, {
                  sessionId,
                  userOid,
                  tenantId: opts.tenantId ?? undefined,
                  surface: opts.persona || 'cross-item',
                });
                (step as { receiptId?: string }).receiptId = receiptId;
              } catch { /* receipt is best-effort — never block the answer */ }
            }
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

/**
 * The set of Microsoft MCP `mcp_<slug>_` tool prefixes CONNECTED for this turn —
 * the authoritative input to {@link msSkillSystemBlocksForPane} so an MS skill
 * advertises its remote-MCP tools ONLY when they are genuinely live
 * (no-vaporware). A prefix counts as connected when EITHER:
 *   (a) buildMcpShim actually registered tools under it in `reg` (the strongest
 *       signal — and, for an entra-obo server, the only proof the signed-in user
 *       truly holds a delegated token for THIS turn); OR
 *   (b) its backing remote-builtin server is enabled/configured per the catalog
 *       (msRemoteMcpConfigured) — this is what surfaces the DEFAULT-ON, no-auth
 *       Microsoft Learn MCP as live day-one with zero config.
 * Anything not connected falls through to the honest, single-sourced catalog gate
 * inside the skill block. Mirrors how `pbiMcpToolPrefix` gates the Power BI
 * remote MCP — same plumbing, generalized.
 */
function msConnectedMcpPrefixes(reg: LoomToolRegistry): string[] {
  const prefixes = REMOTE_BUILTIN_MCP_CATALOG.map((e) => msMcpPrefix(e.id));
  const connected = new Set<string>();
  // (b) enabled/configured servers (covers the default-on Microsoft Learn MCP).
  REMOTE_BUILTIN_MCP_CATALOG.forEach((e, i) => {
    if (msRemoteMcpConfigured(e.id)) connected.add(prefixes[i]);
  });
  // (a) prefixes the per-user MCP shim actually registered tools under.
  const names = reg.list().map((t) => t.name);
  for (const p of prefixes) {
    if (names.some((n) => n.startsWith(p))) connected.add(p);
  }
  return [...connected];
}

/**
 * Approximate model context window (tokens) for a deployment name, for the
 * CTS-05 utilization gauge. Loose substring match; a conservative 128k default
 * covers the current AOAI chat models. Only affects the meter's denominator —
 * never gates a call.
 */
export function contextWindowForDeployment(deployment: string): number {
  const m = (deployment || '').toLowerCase();
  if (/o1|o3|o4|gpt-4\.1/.test(m)) return 200000;
  if (/gpt-4o|gpt-4-turbo|gpt-35-turbo-16k|gpt-3\.5-turbo-16k/.test(m)) return 128000;
  if (/gpt-4-32k/.test(m)) return 32768;
  if (/gpt-35-turbo|gpt-3\.5-turbo|gpt-4\b/.test(m)) return 16385;
  return 128000;
}

export async function* orchestrate(opts: OrchestrateOptions): AsyncIterable<OrchestratorStep> {
  const { prompt, sessionId, userOid } = opts;
  // CTS-01: turn wall-clock — measured from the first line of orchestration to
  // the `final` step so the status bar reports real end-to-end latency.
  const turnStart = Date.now();
  // CTS-03: accumulate per-phase ms (classify → prompt-build → llm → tools) for
  // the admin deep-trace Timeline tab. Best-effort; never affects the stream.
  const phaseTimer = new PhaseTimer();
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

  // ── AIF-12: Loom-native model tier router (default-ON, opt-out) ─────────────
  // Bucket the turn by complexity and, when the tenant admin has wired a mini /
  // strong deployment (Admin → Copilot & Agents → Model tiers), ride the tier's
  // deployment instead of the single resolved default — cheap turns → mini,
  // hard turns → strong. When no tiers are configured this is a silent no-op
  // (routed=false → the resolved default stands). The chosen tier is surfaced
  // on the final step for the CTS-01 metadata bar (CTS-16). A pre-resolved
  // deployment (Wave-4 model-tier override via tenantConfig) still wins because
  // it becomes the `standard`/base the selector falls back to.
  let routedTier: ModelTier | undefined;
  let modelTier: ModelTier | undefined;
  let taskClass: TaskClass | undefined;
  try {
    const sel = resolveTierForTurn(opts.tenantConfig ?? null, {
      prompt,
      hasTools: !opts.registryOverride && !opts.registry,
      baseDeployment: target.deployment,
      // PSR-8 — feed the live full-turn SLO burn so a breaching latency SLO
      // shaves a tier off a non-reasoning turn to answer faster.
      latencyBurn: recentFullTurnBurn(),
    });
    // WS-1.1: ALWAYS capture the honestly-ridden tier + task class as the trace
    // attribution (surfaced on the final step below), even when the router did
    // NOT swap the deployment — a standard-tier turn is still attributed so a
    // browser E2E can read `modelTier` on every copilot turn.
    modelTier = sel.tier;
    taskClass = sel.taskClass;
    if (sel.routed && sel.deployment) {
      target = { ...target, deployment: sel.deployment };
      routedTier = sel.tier; // present only on an ACTIVE swap (CTS-16 chip emphasis)
    }
  } catch { /* routing is best-effort — never block a turn */ }

  const reg = opts.registryOverride ?? opts.registry ?? getRegistry();
  // Register any connected external MCP tool servers (Build 2026 "Connect MCP
  // tools") so agent-loom can call them alongside the built-in Loom tools.
  // Best-effort: a missing/unreachable MCP server never breaks the chat. Skip
  // entirely for a scoped persona registry (registryOverride / registry) —
  // those expose a deliberately tight tool set.
  //
  // buildMcpShim is passed `userOid`: for the opt-in Power BI remote MCP (an
  // `entra-obo` server) it resolves getPbiUserToken(userOid) and threads that
  // per-USER delegated Power BI token through tools/list + tools/call, so its
  // mcp_powerbiremote_* tools auto-register and run under the signed-in user's
  // own Power BI RBAC — not the Console UAMI. When the user has no cached token
  // (never consented / expired) that server is silently skipped here; the
  // powerbi_mcp_status tool reports the honest remediation on demand. No Fabric
  // host is contacted unless this opt-in server is configured + consented
  // (no-fabric-dependency).
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

  // CTS-03: classify phase ends here — target/tier/persona/registry/tool-set are
  // resolved; prompt assembly begins next.
  phaseTimer.lap('classify');

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
  // Microsoft agent-skill guidance (github.com/microsoft/skills) for the active
  // pane, injected as an ADDITIONAL system message alongside the persona/context
  // above — additive, never replacing the pane system prompt. Each block frames
  // the Azure-native DEFAULT tools and, only when the backing Microsoft MCP
  // server is genuinely connected for this turn (msConnectedMcpPrefixes), also
  // advertises its mcp_<slug>_* tools; otherwise it emits the honest catalog gate
  // (naming the exact env/secret/scope/consent) and never claims an unconnected
  // capability. Pure guidance — the tool loop below is unchanged. Reuses the same
  // skill plumbing as the Power BI skills (no parallel system); empty string when
  // no MS skill applies to this pane, so nothing extra is injected.
  const connectedPrefixes = msConnectedMcpPrefixes(reg);
  // Baseline (hard-coded) MS skill blocks + names — the byte-for-byte previous
  // behavior, and the FAIL-OPEN fallback if the CTS-07 skill store is unreachable.
  let msSkillBlocks = msSkillSystemBlocksForPane(opts.contextSlug, { connectedPrefixes });
  // Names of the skills reflected in the CTS-05 meter — starts from the baseline
  // pane set and is REPLACED by the resolved (post-toggle) set when the store
  // answers, so the meter tracks what was actually injected.
  let resolvedSkillNames = msSkillsForPane(opts.contextSlug).map((sk) => sk.name);
  // CTS-07: consult the Cosmos-backed skill registry so per-user toggles (and any
  // tenant custom skills) shape the injection. Best-effort: on any store error
  // renderSkillInjectionForUser returns null and we keep the hard-coded baseline
  // above. With no user state + no custom skills the resolved block equals the
  // baseline, so the default-ON behavior is preserved.
  try {
    const resolved = await renderSkillInjectionForUser(
      userOid,
      opts.tenantId ?? undefined,
      opts.contextSlug,
      { connectedPrefixes },
    );
    if (resolved) {
      msSkillBlocks = resolved.block;
      resolvedSkillNames = resolved.names;
    }
  } catch {
    /* fail-open — keep the hard-coded baseline injection */
  }
  // CTS-11: fire-and-forget usage telemetry for the skill self-evolution learner.
  // NEVER awaited and internally best-effort (recordSkillUsage swallows all
  // errors) so it cannot affect or slow this turn. Records the redacted prompt +
  // the skills that were actually resolved as active for this pane/user.
  void recordSkillUsage({
    tenantId: opts.tenantId ?? undefined,
    userOid,
    pane: opts.contextSlug,
    prompt,
    activeSkillNames: resolvedSkillNames,
  });
  if (msSkillBlocks) {
    messages.push({ role: 'system', content: msSkillBlocks });
  }
  // ── CTS-08: long-term memory recall ────────────────────────────────────────
  // Recall durable user/workspace memories relevant to this prompt and inject
  // them as an ADDITIONAL system message (alongside persona/skill blocks). Fails
  // OPEN — an empty recall (disabled, cold brain, or a store hiccup) adds nothing
  // and never blocks the turn. The recalled set sizes the CTS-05 memory segment
  // and surfaces as CTS-04 memory citations on the final step.
  const recallWorkspaceId =
    (opts.contextPayload && typeof (opts.contextPayload as any).workspaceId === 'string'
      ? (opts.contextPayload as any).workspaceId
      : opts.personaContext && typeof (opts.personaContext as any).workspaceId === 'string'
        ? (opts.personaContext as any).workspaceId
        : undefined) as string | undefined;
  const memoryRecall = await getLayeredContext(userOid, recallWorkspaceId, prompt).catch(() => ({
    block: '', memories: [] as any[], tokens: 0, backend: 'none' as const,
  }));
  if (memoryRecall.block) {
    messages.push({ role: 'system', content: memoryRecall.block });
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

  // CTS-02: roll every tool call into a per-turn detail list ({name, serverName?,
  // durationMs, ok, error?}) attached to the final step so the collapsible detail
  // badge can render the full tool table with "via <server>" attribution.
  const turnTools: TurnToolDetail[] = [];
  // N10: accumulate the raw tool_call/tool_result steps for THIS turn so the
  // answer-receipt assembler can extract the exact SQL/KQL/Cypher executed + row
  // counts. Lightweight (references to args/results already computed); consumed
  // once at the final step. Never affects the stream.
  const turnReceiptSteps: Array<Record<string, unknown>> = [];
  // CTS-04: accumulate grounding citations mapped from tool provenance (docs RAG
  // hits, agentic knowledge-base retrieval, schema reads) across the turn. Seeded
  // with the CTS-08 recalled memories so the answer attributes what it grounded on.
  let turnCitations: Citation[] = memoryRecall.memories.length
    ? (memoriesToCitations(memoryRecall.memories) as Citation[])
    : [];

  // ── CTS-05: context-window meter ──────────────────────────────────────────
  // Tokenize each prompt contributor at message-build time (before the AOAI
  // call) and emit ONE `context_usage` step so the segmented meter renders with
  // real per-segment counts. memory/knowledge are 0 until CTS-08 / RAG
  // pre-injection land — first-class segments now so the meter needs no reshape.
  // CTS-07: reflect the RESOLVED (post-toggle) skill set — computed above with
  // the skill store — so the meter's "skills" segment matches what was injected.
  const skillNames = resolvedSkillNames;
  const toolNames = (tools as Array<{ function?: { name?: string } }>).map((t) => t?.function?.name || '').filter(Boolean);
  const systemMessagesText = messages.filter((m) => m.role === 'system').map((m) => m.content || '').join('\n\n');
  const contextUsage = buildContextUsagePayload({
    contextWindow: contextWindowForDeployment(target.deployment),
    // messages[0] is always the base system prompt (persona/pane).
    systemPromptTokens: estimateTokens(messages[0]?.content || ''),
    personaContextTokens: opts.personaContext && Object.keys(opts.personaContext).length
      ? estimateTokens(`Current editor context (JSON): ${JSON.stringify(opts.personaContext).slice(0, 4000)}`)
      : 0,
    skills: { count: skillNames.length, tokens: estimateTokens(msSkillBlocks), names: skillNames },
    tools: { count: toolNames.length, tokens: estimateTokens(JSON.stringify(tools)), names: toolNames },
    memoryTokens: memoryRecall.tokens,
    knowledgeTokens: 0,
    conversation: { messages: 1, tokens: estimateTokens(prompt) },
    systemPromptPreview: systemMessagesText,
  });
  const contextUsageStep: OrchestratorStep = { kind: 'context_usage', usage: contextUsage };
  await persistStep(sessionId, userOid, contextUsageStep);
  yield contextUsageStep;
  // CTS-03: prompt-build phase ends here — messages + tool schema + meter are
  // assembled; the AOAI/tool loop begins next.
  phaseTimer.lap('prompt-build');
  // ──────────────────────────────────────────────────────────────────────────

  for (let i = 0; i < maxIter; i++) {
    let resp: any;
    const _llmStart = Date.now();
    try {
      resp = await callAoai(target, messages, tools);
    } catch (e: any) {
      const step: OrchestratorStep = { kind: 'error', error: e?.message || String(e) };
      await persistStep(sessionId, userOid, step);
      yield step;
      return;
    }
    phaseTimer.add('llm', Date.now() - _llmStart); // CTS-03: AOAI round-trip span
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
      const turnLatencyMs = Date.now() - turnStart;
      // PSR-8 — feed the completed full-turn latency into the rolling SLO window
      // so the tier router's latency-pressure protection + the perf SLO badge
      // read a live burn. Best-effort; never affects the turn result.
      try { recordCopilotTurn(turnLatencyMs); } catch { /* telemetry only */ }
      // Compute once, reuse in the final step AND the N10 receipt.
      const turnCostUsd = estCostUsd(target.deployment, usage.promptTokens, usage.completionTokens);
      const turnPhaseTimings = phaseTimer.timings();

      // N10: assemble the answer receipt from this turn's real signals (exact
      // SQL/KQL/Cypher + row counts, grounding sources, tier, cost, verdict) and
      // persist it to loom-answer-receipts as the governance audit trail. Pure
      // assembly + a best-effort Cosmos upsert — a receipt hiccup NEVER blocks or
      // fails the answer. The persisted doc id is threaded back onto the final
      // step (`receiptId`) so the receipt surfaces its own audit reference.
      let receiptId: string | undefined;
      try {
        const receipt = assembleAnswerReceipt(
          {
            prompt,
            steps: turnReceiptSteps,
            model: target.deployment,
            modelTier,
            taskClass,
            routedTier,
            usage,
            costUsd: turnCostUsd,
            turnLatencyMs,
            phaseTimings: turnPhaseTimings,
            citations: turnCitations as Array<Record<string, unknown>>,
            tools: turnTools,
          },
          { createdAt: new Date().toISOString() },
        );
        receiptId = await persistAnswerReceipt(receipt, {
          sessionId,
          userOid,
          tenantId: opts.tenantId ?? undefined,
          surface: personaTag,
        });
      } catch { /* receipt is best-effort — never block the answer */ }

      const finalStep: OrchestratorStep = {
        kind: 'final',
        content: msg.content || '',
        usage,
        model: target.deployment,
        // CTS-01: split token counts, real turn latency, provider badge, and a
        // list-price $ estimate (rel-T85 table) over the REAL token counts.
        provider: 'Azure OpenAI',
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        turnLatencyMs,
        costUsd: turnCostUsd,
        // CTS-16: the AIF-12 tier the router chose (omitted when no active swap).
        ...(routedTier ? { routedTier } : {}),
        // WS-1.1: always-present tier attribution (the trace attribute), so a
        // standard-tier turn is attributed too — a browser E2E reads modelTier.
        ...(modelTier ? { modelTier } : {}),
        ...(taskClass ? { taskClass } : {}),
        // CTS-02: the per-turn tool roll-up (empty tools = a no-tool answer).
        turnDetail: { tools: turnTools },
        // CTS-04: grounding citations (omit the key entirely when none, so older
        // turns / no-grounding turns render exactly as before).
        ...(turnCitations.length ? { citations: turnCitations } : {}),
        // CTS-05: mirror the context-window breakdown onto the final step so a
        // replayed session restores the meter without a separate lookup.
        contextUsage,
        // CTS-03: per-phase ms for the admin deep-trace Timeline tab.
        phaseTimings: turnPhaseTimings,
        // N10: the persisted receipt's Cosmos doc id (best-effort).
        ...(receiptId ? { receiptId } : {}),
      };
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
          const okDurationMs = Date.now() - started;
          resultStep = {
            kind: 'tool_result',
            name: tc.function.name,
            callId: tc.id,
            durationMs: okDurationMs,
            result: publicResult,
          };
          turnTools.push({ name: tc.function.name, serverName: tool.serverName, durationMs: okDurationMs, ok: true });
          // N10: record the call+result so the receipt can surface the exact
          // query executed (from args) + its real row count (from the result).
          turnReceiptSteps.push({ kind: 'tool_call', name: tc.function.name, args: parsedArgs, callId: tc.id });
          turnReceiptSteps.push({ kind: 'tool_result', name: tc.function.name, callId: tc.id, durationMs: okDurationMs, result: publicResult });
          phaseTimer.add('tools', okDurationMs); // CTS-03: tool-execution span

          // CTS-04: map any grounding provenance the tool returned into citations.
          turnCitations = mergeCitations(turnCitations, extractCitationsFromToolResult(tc.function.name, publicResult));
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

      // CTS-02: record the unknown-tool / error tool_result (the success case is
      // recorded inline above before its early `continue`).
      turnTools.push({
        name: tc.function.name,
        serverName: tool?.serverName,
        durationMs: resultStep.kind === 'tool_result' ? resultStep.durationMs : 0,
        ok: false,
        error: resultStep.kind === 'tool_result' ? resultStep.error : undefined,
      });
      // N10: record the failed call+result so the receipt shows the attempted
      // query and its error (no row count).
      turnReceiptSteps.push({ kind: 'tool_call', name: tc.function.name, args: parsedArgs, callId: tc.id });
      turnReceiptSteps.push({
        kind: 'tool_result', name: tc.function.name, callId: tc.id,
        durationMs: resultStep.kind === 'tool_result' ? resultStep.durationMs : 0,
        error: resultStep.kind === 'tool_result' ? resultStep.error : undefined,
      });
      phaseTimer.add('tools', resultStep.kind === 'tool_result' ? resultStep.durationMs : 0); // CTS-03
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
  /** User-supplied session title (rename). Falls back to the prompt in the UI. */
  title?: string;
  /** Pinned/favorited — pinned sessions sort to the top of the left rail. */
  pinned?: boolean;
}

export async function listSessions(userOid: string, limit = 50): Promise<SessionSummary[]> {
  const c = await copilotSessionsContainer();
  const q = {
    query: 'SELECT TOP @n c.id, c.sessionId, c.userOid, c.prompt, c.title, c.pinned, c.createdAt, c.updatedAt, ARRAY_LENGTH(c.steps) AS stepCount FROM c WHERE c.userOid = @u ORDER BY c.updatedAt DESC',
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

/**
 * Update mutable session metadata (rename / pin) on the Cosmos session doc.
 * Real read-modify-write against `copilot-sessions` (PK /sessionId) with an
 * ownership check — never lets one user mutate another's session. Returns the
 * patched fields the UI cares about. Throws `not_found` / `forbidden` for the
 * route to map to 404 / 403.
 */
export async function updateSessionMeta(
  sessionId: string,
  userOid: string,
  patch: { title?: string; pinned?: boolean },
): Promise<{ title?: string; pinned?: boolean }> {
  const c = await copilotSessionsContainer();
  const existing = await c.item(sessionId, sessionId).read<any>().catch(() => ({ resource: null }));
  if (!existing.resource) throw new Error('not_found');
  const doc = existing.resource;
  if (doc.userOid && doc.userOid !== userOid) throw new Error('forbidden');
  if (typeof patch.title === 'string') doc.title = patch.title.slice(0, 200);
  if (typeof patch.pinned === 'boolean') doc.pinned = patch.pinned;
  doc.updatedAt = new Date().toISOString();
  await c.item(sessionId, sessionId).replace(doc);
  return { title: doc.title, pinned: doc.pinned };
}
