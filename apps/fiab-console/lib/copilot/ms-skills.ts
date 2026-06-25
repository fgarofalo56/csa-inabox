/**
 * ms-skills.ts — the ~30 open-source Microsoft "agent skills"
 * (github.com/microsoft/skills) expressed as CSA Loom-native Copilot skill
 * descriptors, EXTENDING the Power BI skill plumbing (lib/copilot/powerbi-skills.ts)
 * rather than building a parallel system.
 *
 * WHAT THIS IS
 * ------------
 * Microsoft ships an open-source library of agent skills — markdown skill folders
 * that teach an agent HOW to do a task well (provision Azure infra, deploy, audit
 * RBAC, work with Foundry models, author KQL, build an MCP server, etc.). This
 * module distills the relevant ones into pure, client-safe descriptors that the
 * CSA Loom Copilot loads ON DEMAND, keyed off the active pane / persona — exactly
 * like POWERBI_AUTHORING_SKILLS.
 *
 * WHY IT REUSES THE POWER BI PLUMBING (no parallel system)
 * -------------------------------------------------------
 *   - The descriptor contract is the SAME {@link LoomCopilotSkill} imported from
 *     lib/copilot/powerbi-skills.ts, widened additively with two OPTIONAL fields
 *     ({@link MsAgentSkill.mcpToolPrefix} + {@link MsAgentSkill.attribution}). No
 *     fork of the shape.
 *   - Each skill's `guidance` is injected as an extra system message via the SAME
 *     per-pane persona path the Power BI skills use (copilot-personas.ts →
 *     systemPrompt + the orchestrate panePersona step).
 *   - Each skill's `toolNames` map ONE-FOR-ONE to tools ALREADY registered in the
 *     LoomToolRegistry (loom_self_audit/loom_heal, item_*, lakehouse_*, adx_/kql_,
 *     apim_*, synapse_*, foundry_list_connections, iq_*, …). No new tools minted.
 *   - The OPT-IN Microsoft MCP servers are the SAME remote-builtin family in
 *     lib/mcp/catalog.ts (REMOTE_BUILTIN_MCP_CATALOG). buildMcpShim registers each
 *     enabled server's tools as `mcp_<slug>_<tool>`; this module advertises that
 *     prefix via {@link MsAgentSkill.mcpToolPrefix} so the relevant skill surfaces
 *     the live MS MCP tools ONLY when the server is connected — identical to how
 *     `pbiMcpToolPrefix` surfaces the Power BI remote MCP.
 * So this file has no Azure SDK, no network, no React — safe in any bundle and
 * unit-testable on its own. It imports only the pure catalog module (zero-import,
 * client-safe) for single-sourced honest-gate text + the per-server configured()
 * state, so the gate copy can never drift from lib/mcp/catalog.ts.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md)
 * -----------------------------------------------------------
 * Every skill's `defaultTarget` is `'azure-native'`. The DEFAULT path is Loom's
 * own Azure-native tools — they need NO Fabric/Power BI tenant and work day-one.
 * The ONLY default-on MS MCP is Microsoft Learn (`mcp_mslearn_*`, auth 'none', no
 * config); every other MS MCP (ARM, Foundry, Graph, Sentinel, GitHub, Dataverse, …)
 * is STRICTLY OPT-IN and surfaced only via `mcpToolPrefix` once connected. No
 * `api.fabric.microsoft.com` / `api.powerbi.com` host is ever reached on a default
 * path — the Fabric/RTI family stays out of these Azure-native skills entirely.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md)
 * --------------------------------------------
 * Advertised `toolNames` are REAL registered tools. The opt-in MS MCP tools only
 * appear once the server is actually connected; until then {@link msSkillSystemBlock}
 * emits the HONEST gate (sourced verbatim from the catalog entry's `gate`) naming
 * the exact env var / Key Vault secret / scope / consent required. No mock data,
 * no dead advertisement.
 */

import {
  REMOTE_BUILTIN_MCP_CATALOG,
  type RemoteBuiltinMcpEntry,
} from '@/lib/mcp/catalog';
import type { LoomCopilotSkill } from '@/lib/copilot/powerbi-skills';

// ---------------------------------------------------------------------------
// The descriptor contract — REUSE LoomCopilotSkill, widened additively.
// ---------------------------------------------------------------------------

/**
 * A Microsoft agent-skill descriptor. It IS a {@link LoomCopilotSkill} (same
 * shape the orchestrator + persona path already consume) with two additive,
 * backward-compatible optional fields:
 *  - {@link mcpToolPrefix} generalizes `pbiMcpToolPrefix`: the `mcp_<slug>_` prefix
 *    of the OPT-IN Microsoft MCP server whose live tools augment this skill once
 *    connected (buildMcpShim derives the same prefix from the catalog id).
 *  - {@link attribution} credits the upstream open-source skill + the MS MCP it maps to.
 */
export interface MsAgentSkill extends LoomCopilotSkill {
  /**
   * `mcp_<slug>_` prefix of the OPT-IN Microsoft MCP server backing this skill.
   * Surfaced ONLY when that server is connected (mirrors `pbiMcpToolPrefix`).
   * For `mcp_mslearn_` the server is DEFAULT-ON (live day-one, no config).
   */
  mcpToolPrefix?: string;
  /** Upstream attribution (github.com/microsoft/skills + the mapped MS MCP). */
  attribution?: string;
}

// ---------------------------------------------------------------------------
// MS MCP tool-name prefixes — derived EXACTLY as buildMcpShim's mcpToolPrefixSlug
// derives them for remote-builtin rows (catalog id, non-alphanumerics stripped,
// lowercased). Keep these in lock-step with REMOTE_BUILTIN_MCP_CATALOG ids.
// ---------------------------------------------------------------------------

/** Build the `mcp_<slug>_` prefix for a remote-builtin catalog id (== mcpToolPrefixSlug). */
export function msMcpPrefix(catalogId: string): string {
  return `mcp_${catalogId.replace(/[^a-z0-9]/gi, '').toLowerCase()}_`;
}

/** Microsoft Learn — the SOLE default-on MS MCP (no auth, no config, live day-one). */
export const MS_LEARN_TOOL_PREFIX = msMcpPrefix('ms-learn'); //      mcp_mslearn_
/** Azure Resources (ARM) — opt-in, OBO against management.azure.com. */
export const AZURE_ARM_TOOL_PREFIX = msMcpPrefix('azure-arm'); //    mcp_azurearm_
/** Microsoft Foundry — opt-in (preview), OBO against ai.azure.com. */
export const MS_FOUNDRY_TOOL_PREFIX = msMcpPrefix('ms-foundry'); //  mcp_msfoundry_
/** Microsoft Graph (Enterprise) — opt-in (preview), OBO against graph.microsoft.com. */
export const MS_GRAPH_TOOL_PREFIX = msMcpPrefix('ms-graph'); //      mcp_msgraph_
/** Microsoft Sentinel — opt-in (preview), OBO against sentinel.microsoft.com. */
export const MS_SENTINEL_TOOL_PREFIX = msMcpPrefix('ms-sentinel'); // mcp_mssentinel_
/** GitHub — opt-in, GitHub PAT via Key Vault (NOT Entra). */
export const GITHUB_TOOL_PREFIX = msMcpPrefix('github'); //          mcp_github_
/** Microsoft Dataverse — opt-in (preview), per-org OBO. */
export const DATAVERSE_TOOL_PREFIX = msMcpPrefix('dataverse'); //    mcp_dataverse_

/** Reverse-lookup: the remote-builtin catalog entry backing a `mcp_<slug>_` prefix. */
function entryForPrefix(prefix?: string): RemoteBuiltinMcpEntry | undefined {
  if (!prefix) return undefined;
  const slug = prefix.replace(/^mcp_/, '').replace(/_+$/, '');
  return REMOTE_BUILTIN_MCP_CATALOG.find(
    (e) => e.id.replace(/[^a-z0-9]/gi, '').toLowerCase() === slug,
  );
}

/** Credit line for the upstream open-source skills. */
const MS_SKILLS_ATTRIBUTION =
  'Adapted from the open-source Microsoft agent skills (github.com/microsoft/skills), ' +
  "grounded for CSA Loom's Azure-native default path.";

/** Compose a per-skill attribution string (upstream skills + the mapped MS MCP). */
function attribution(mcpName?: string): string {
  return mcpName
    ? `${MS_SKILLS_ATTRIBUTION} Live operations via the OPT-IN ${mcpName} MCP when connected.`
    : MS_SKILLS_ATTRIBUTION;
}

// ---------------------------------------------------------------------------
// The skills (~30), grouped. defaultTarget is ALWAYS 'azure-native'; toolNames
// are REAL registered Loom tools; mcpToolPrefix names the OPT-IN MS MCP that
// augments the skill once connected (Learn is default-on).
// ---------------------------------------------------------------------------

const INFRA_OPS_SKILLS: MsAgentSkill[] = [
  {
    id: 'azure-prepare',
    name: 'Azure — prepare for deployment',
    whenToUse:
      'Before provisioning: confirm the target subscription/region, required resource providers, ' +
      'identities, and naming are ready so a deploy will succeed first try.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['deploy-planner', 'health', 'default'],
    toolNames: ['loom_self_audit', 'item_list', 'workspace_list'],
    guidance: [
      'SKILL: Prepare for an Azure deployment.',
      'Run loom_self_audit first to read the live posture (existing items, identities, gaps). ' +
        'Enumerate what a deploy needs — subscription + region, resource-provider registration, the ' +
        'Console UAMI role assignments, and any required env vars — and report what is MISSING before ' +
        'provisioning, never after. Use item_list / workspace_list to see what already exists so you ' +
        'do not duplicate resources.',
      'Live ARM reads (resource groups, providers, quotas) require the OPT-IN Azure Resources (ARM) MCP; ' +
        'until it is connected, ground the checklist in loom_self_audit + the Deploy Planner.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-deploy',
    name: 'Azure — deploy resources',
    whenToUse:
      'Provisioning or updating Loom items / Azure resources — choosing the Azure-native backend, ' +
      'creating the item, and wiring its configuration.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['deploy-planner', 'default'],
    toolNames: ['item_create', 'item_configure', 'workspace_create', 'loom_self_audit'],
    guidance: [
      'SKILL: Deploy Azure resources (Azure-native by default).',
      'Create resources as Loom items with item_create and configure them with item_configure — each ' +
        'item provisions its Azure-native backend (e.g. lakehouse → ADLS Gen2 + Delta; warehouse → ' +
        'Synapse dedicated SQL pool; eventstream → Azure Event Hubs). NEVER gate a deploy on a Fabric ' +
        'workspace; the Azure-native path is the default and is fully functional on its own.',
      'Idempotency: check item_list / loom_self_audit before creating to avoid duplicates; configure ' +
        'least-privilege identity and diagnostics as part of the deploy, not afterwards.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-validate',
    name: 'Azure — validate deployment',
    whenToUse:
      'After a deploy (or on a schedule): confirm every item is healthy, reachable, and correctly ' +
      'configured; surface and optionally remediate drift.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['deploy-planner', 'health', 'default'],
    toolNames: ['loom_self_audit', 'loom_heal', 'item_list'],
    guidance: [
      'SKILL: Validate an Azure deployment.',
      'Use loom_self_audit to run the live health/RBAC/env probes across the estate, then loom_heal to ' +
        'apply a SAFE, explicitly-listed remediation (role grant, env wiring, scale) — describe exactly ' +
        'what will change and why before healing. Treat a real Azure backend response (not a placeholder) ' +
        'as the only proof of "done".',
      'Each finding must name the precise remediation (env var, role, resource); never report a vague ' +
        '"looks fine" without the underlying probe result.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-rbac',
    name: 'Azure — RBAC & access',
    whenToUse:
      'Reviewing or designing role assignments — who can do what, least-privilege scoping, and the ' +
      'exact role + scope an action requires.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['rbac', 'default'],
    toolNames: ['loom_self_audit', 'item_list', 'item_configure'],
    guidance: [
      'SKILL: Azure RBAC & access.',
      'Recommend LEAST-PRIVILEGE built-in roles scoped as narrowly as possible (resource > resource ' +
        'group > subscription). For any blocked action, name the EXACT role + scope required (e.g. ' +
        '"Storage Blob Data Contributor on <account>") rather than suggesting Owner. loom_self_audit ' +
        'reports the Console UAMI assignments and the gaps.',
      'Live role-assignment writes require the OPT-IN Azure Resources (ARM) MCP under the signed-in ' +
        "user's delegated identity; absent it, produce the precise grant the operator can apply.",
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-cost',
    name: 'Azure — cost analysis',
    whenToUse:
      'Understanding or reducing spend — what is driving cost, scale-to-zero opportunities, and SKU ' +
      'right-sizing.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['cost', 'default'],
    toolNames: ['loom_self_audit', 'item_list', 'ops_scale_sql_pool', 'ops_scale_adx'],
    guidance: [
      'SKILL: Azure cost analysis.',
      'Identify the biggest cost drivers and concrete savings: pause/scale idle Synapse dedicated pools ' +
        '(ops_scale_sql_pool / synapse_pool_state), scale ADX down off-hours (ops_scale_adx), prefer ' +
        'serverless / scale-to-zero where the workload allows, and right-size SKUs. Ground every claim ' +
        'in the Cost dashboard + item_list, not estimates pulled from the air.',
      'Live billing/usage queries require the OPT-IN Azure Resources (ARM) MCP; until it is connected, ' +
        'use the Loom Cost dashboard figures and state assumptions explicitly.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-diagnostics',
    name: 'Azure — diagnostics & troubleshooting',
    whenToUse:
      'Diagnosing a failing or degraded resource — reading logs/metrics, correlating errors, and ' +
      'proposing a fix.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['health', 'monitor', 'default'],
    toolNames: ['loom_self_audit', 'loom_heal', 'adx_query', 'kql_execute'],
    guidance: [
      'SKILL: Azure diagnostics & troubleshooting.',
      'Work the problem from evidence: loom_self_audit for posture, then query the diagnostic data — ' +
        'KQL over the Log Analytics / ADX backing (kql_execute / adx_query) — to find the actual error ' +
        'before proposing a fix. Apply only a SAFE, named remediation via loom_heal.',
      'Form a hypothesis, confirm it against a real query result, then remediate — never guess-and-restart.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-compliance',
    name: 'Azure — compliance & governance posture',
    whenToUse:
      'Checking governance posture — encryption, network isolation, diagnostics-on, data classification, ' +
      'and policy alignment.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['rbac', 'health', 'default'],
    toolNames: ['loom_self_audit', 'item_list', 'item_configure'],
    guidance: [
      'SKILL: Compliance & governance posture.',
      'Assess the controls that matter for a sovereign/federal estate: customer-managed-key encryption, ' +
        'private endpoints / no public network, diagnostics enabled, Purview classification + lineage, ' +
        'and least-privilege RBAC. loom_self_audit surfaces the live gaps; item_configure tightens a ' +
        'specific item. Report each gap with the exact control to enable.',
      'Live policy/compliance evaluation across the subscription uses the OPT-IN Azure Resources (ARM) MCP ' +
        'when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-resource-lookup',
    name: 'Azure — resource lookup',
    whenToUse:
      'Finding a resource or item across the estate by name, type, or workspace, and reporting its ' +
      'current configuration.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['default', 'deploy-planner'],
    toolNames: ['item_list', 'workspace_list', 'loom_self_audit'],
    guidance: [
      'SKILL: Azure resource lookup.',
      'Locate items with item_list (filter by type/workspace) and workspaces with workspace_list, then ' +
        'report the real configuration. Resolve resources by NAME via Loom (the estate is wired through ' +
        'the Console env / Resource Graph) rather than assuming an ARM path that may live in a different ' +
        'plane.',
      'Cross-subscription Azure Resource Graph queries are augmented by the OPT-IN Azure Resources (ARM) ' +
        'MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-resource-visualizer',
    name: 'Azure — resource & topology visualizer',
    whenToUse:
      'Explaining or diagramming how resources relate — the deployment topology, dependencies, and ' +
      'data flow between items.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['default', 'health', 'deploy-planner'],
    toolNames: ['item_list', 'workspace_list', 'loom_self_audit'],
    guidance: [
      'SKILL: Resource & topology visualizer.',
      'Describe the estate as a graph: group items by workspace/landing zone, draw the dependency + ' +
        'data-flow edges (source → pipeline → lakehouse → warehouse → semantic model → report), and ' +
        'highlight single points of failure or missing links. Ground the nodes/edges in item_list + ' +
        "workspace_list, mirroring Loom's topology map — invent no resources.",
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-storage',
    name: 'Azure — storage & data lake',
    whenToUse:
      'Working with ADLS Gen2 / Delta lakehouse storage — listing paths, reading/previewing data, and ' +
      'writing/organizing the medallion layout.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['lakehouse', 'default'],
    toolNames: ['lakehouse_list', 'lakehouse_read', 'lakehouse_write', 'item_create'],
    guidance: [
      'SKILL: Azure storage & data lake (ADLS Gen2 + Delta).',
      'A Loom lakehouse is ADLS Gen2 + Delta (no Fabric/OneLake). Explore with lakehouse_list, preview ' +
        'real rows with lakehouse_read, and persist with lakehouse_write. Follow a medallion layout ' +
        '(bronze → silver → gold), Delta table conventions, and AAD-only (no account-key) access.',
      'Use container/path naming that reflects the layer + domain; never preview placeholder data — ' +
        'read the actual table.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-messaging',
    name: 'Azure — messaging & streaming',
    whenToUse:
      'Designing event/stream ingestion — Event Hubs (eventstream), Stream Analytics processing, and ' +
      'routing to a lakehouse/ADX sink.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['eventstream', 'event-schema-set', 'default'],
    toolNames: ['item_create', 'item_configure', 'item_list'],
    guidance: [
      'SKILL: Azure messaging & streaming.',
      'A Loom eventstream is Azure Event Hubs (+ Stream Analytics for processing) — the Azure-native ' +
        'equivalent of a Fabric eventstream, with NO Fabric dependency. Model the source → processing → ' +
        'sink topology, partition for throughput, and route to a Delta/ADX sink. Create/configure with ' +
        'item_create / item_configure on the eventstream item.',
      'Pick consumer groups + capture settings deliberately; document the schema on the event-schema-set.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-quotas',
    name: 'Azure — quotas & limits',
    whenToUse:
      'Checking subscription/region quotas and service limits before scaling or deploying so you do ' +
      'not hit a hard cap mid-operation.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['deploy-planner', 'default'],
    toolNames: ['loom_self_audit', 'item_list'],
    guidance: [
      'SKILL: Azure quotas & limits.',
      'Before scaling or deploying, confirm the relevant quota headroom (vCPU per family/region, ADX ' +
        'instances, Synapse DWU, public IPs). Call out a likely cap with the exact quota name + the ' +
        'region, and recommend a quota increase request when needed — a common cause of a silent deploy ' +
        'failure is a region vCPU quota of 0.',
      'Live quota/usage figures come from the OPT-IN Azure Resources (ARM) MCP when connected; otherwise ' +
        'flag the quotas to verify in the portal before proceeding.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-aigateway',
    name: 'Azure — AI gateway (APIM)',
    whenToUse:
      'Putting an Azure API Management AI gateway in front of model endpoints — token rate-limiting, ' +
      'load-balancing, and publishing APIs/products.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['apim-api', 'apim-product', 'apim-policy', 'default'],
    toolNames: ['apim_list_apis', 'apim_list_products', 'apim_publish_api', 'item_configure'],
    guidance: [
      'SKILL: AI gateway with Azure API Management.',
      'Front model/back-end APIs with APIM: apply the AI-gateway policies (token-based rate limit, ' +
        'semantic caching, backend load-balancing across AOAI deployments, managed-identity auth), then ' +
        'publish via apim_publish_api and package into products. Inspect the live surface with ' +
        'apim_list_apis / apim_list_products.',
      'Keep policy in the policy item; never embed keys in policy — use managed identity / named values ' +
        'backed by Key Vault.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

const FOUNDRY_AI_SKILLS: MsAgentSkill[] = [
  {
    id: 'microsoft-foundry',
    name: 'Microsoft Foundry — projects & agents',
    whenToUse:
      'Working with Microsoft Foundry projects, connections, and agents — listing connections and ' +
      'wiring an agent/project for a Loom AI item.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'ai-foundry-hub', 'data-agent', 'default'],
    toolNames: ['foundry_list_connections', 'item_create', 'item_configure'],
    guidance: [
      'SKILL: Microsoft Foundry projects & agents.',
      'Inspect the real Foundry project connections with foundry_list_connections, then create/configure ' +
        'the Loom AI item (item_create / item_configure) bound to that project. Keep model + data ' +
        'connections least-privilege and managed-identity based.',
      'Live Foundry project/agent operations come from the OPT-IN Microsoft Foundry MCP when connected; ' +
        'until then ground in the listed connections + the AI editor.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'foundry-models',
    name: 'Foundry — model catalog & deployment',
    whenToUse:
      'Choosing and deploying a model from the Foundry catalog — matching capability, region/SKU ' +
      'availability, and cost to the use case.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'ml-model', 'automl', 'data-agent'],
    toolNames: ['foundry_list_connections', 'item_create', 'item_configure'],
    guidance: [
      'SKILL: Foundry model catalog & deployment.',
      'Match the model to the task: reasoning vs. cost vs. latency vs. context window; confirm regional ' +
        'availability + quota before deploying. Bind the deployment to the Loom AI item and record the ' +
        'deployment name + version. Prefer a managed-identity connection over keys.',
      'The live model catalog + deployment actions come from the OPT-IN Microsoft Foundry MCP when ' +
        'connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'foundry-iq-knowledge-bases',
    name: 'Foundry IQ — knowledge bases & grounding',
    whenToUse:
      'Building a grounded knowledge base / retrieval source for an agent — ontologies, semantic ' +
      'models, and indexed signals.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['data-agent', 'ai-search-index', 'ai-foundry-project'],
    toolNames: [
      'iq_list_ontologies',
      'iq_get_ontology',
      'iq_search',
      'iq_list_semantic_models',
      'foundry_list_connections',
    ],
    guidance: [
      'SKILL: Foundry IQ knowledge bases & grounding.',
      "Ground the agent in Loom's real knowledge layer: discover ontologies (iq_list_ontologies / " +
        'iq_get_ontology), semantic models (iq_list_semantic_models), and search the indexed signals ' +
        '(iq_search). Build a retrieval source over a real index — never let the agent answer from an ' +
        'ungrounded prompt.',
      'Chunk + describe sources for retrieval quality; add synonyms so natural-language questions resolve.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'foundry-observability',
    name: 'Foundry — AI observability',
    whenToUse:
      'Tracing and evaluating an AI app — capturing traces, running evaluations, and watching quality/ ' +
      'cost/latency over time.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'tracing', 'evaluation', 'monitor'],
    toolNames: ['foundry_list_connections', 'loom_self_audit'],
    guidance: [
      'SKILL: Foundry AI observability.',
      'Instrument the AI app for traces + evaluations: capture prompt/response/tool spans, define ' +
        'evaluation sets (groundedness, relevance, safety), and track quality + token cost + latency on ' +
        'the tracing/evaluation surfaces. loom_self_audit confirms the diagnostics wiring.',
      'Live trace + evaluation runs come from the OPT-IN Microsoft Foundry MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'foundry-governance',
    name: 'Foundry — AI governance',
    whenToUse:
      'Applying AI governance — content-safety policy, responsible-AI controls, and access scoping for ' +
      'a Foundry project.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'content-safety', 'rbac'],
    toolNames: ['foundry_list_connections', 'item_configure', 'loom_self_audit'],
    guidance: [
      'SKILL: Foundry AI governance.',
      'Apply responsible-AI controls: attach a content-safety policy (jailbreak/harm filters), scope ' +
        'project access least-privilege, log prompts/responses for audit, and document the data the ' +
        'model may see. item_configure sets the policy on the AI item; loom_self_audit verifies the ' +
        'controls are live.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-ai',
    name: 'Azure AI — app patterns',
    whenToUse:
      'Designing an AI feature on Azure — RAG, agents/tools, structured output — choosing the pattern ' +
      'and wiring it to Loom data.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'data-agent', 'default'],
    toolNames: ['foundry_list_connections', 'item_create', 'item_configure'],
    guidance: [
      'SKILL: Azure AI app patterns.',
      'Pick the right pattern: retrieval-augmented generation when answers must be grounded in your ' +
        'data; a tool/agent loop when the task needs actions; structured output when a downstream system ' +
        'consumes the result. Ground retrieval on real Loom data (lakehouse/ADX/semantic model) and keep ' +
        'auth managed-identity based.',
      'Live model calls + agent runs come from the OPT-IN Microsoft Foundry MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-ai-contentsafety',
    name: 'Azure AI — Content Safety',
    whenToUse:
      'Adding content-safety moderation — text/image harm categories, jailbreak/prompt-shield, and ' +
      'blocklists for an AI feature.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['content-safety', 'ai-foundry-project'],
    toolNames: ['foundry_list_connections', 'item_configure'],
    guidance: [
      'SKILL: Azure AI Content Safety.',
      'Moderate inputs AND outputs: configure harm categories (hate/sexual/violence/self-harm) with ' +
        'appropriate severity thresholds, enable prompt-shield/jailbreak detection, and add custom ' +
        'blocklists for domain terms. item_configure binds the content-safety item to the AI feature.',
      'Tune thresholds against real sample traffic; log blocked events for review.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-ai-document-intelligence',
    name: 'Azure AI — Document Intelligence',
    whenToUse:
      'Extracting structured data from documents — choosing prebuilt vs. custom models and landing the ' +
      'output in a Loom data store.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_FOUNDRY_TOOL_PREFIX,
    attribution: attribution('Microsoft Foundry'),
    panes: ['ai-foundry-project', 'data-agent', 'default'],
    toolNames: ['foundry_list_connections', 'item_create'],
    guidance: [
      'SKILL: Azure AI Document Intelligence.',
      'Extract structure from documents: use a prebuilt model (invoice/receipt/ID/layout) when it fits, ' +
        'or train a custom extraction model for bespoke forms. Land the extracted fields in a lakehouse/ ' +
        'SQL store as a real table for downstream use, and capture confidence scores for human review.',
      'Live analyze/train operations come from the OPT-IN Microsoft Foundry MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

const DATA_MESSAGING_SKILLS: MsAgentSkill[] = [
  {
    id: 'azure-cosmos',
    name: 'Azure Cosmos DB',
    whenToUse:
      'Modeling and querying Cosmos DB — partition-key design, consistency level, indexing, and (NoSQL/ ' +
      'Gremlin/vector) access patterns.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['azure-cosmos-account', 'cosmos-gremlin-graph', 'vector-store', 'default'],
    toolNames: ['item_create', 'item_configure', 'item_list'],
    guidance: [
      'SKILL: Azure Cosmos DB.',
      'Design for the access pattern FIRST: choose a partition key with high cardinality + even ' +
        'write/read distribution to avoid hot partitions; pick the weakest consistency the app tolerates ' +
        '(session is the usual default); tune the indexing policy to the queries; size RU/s (or use ' +
        'autoscale/serverless). For vector search, configure the vector index + distance function.',
      'Create/configure the Cosmos item with item_create / item_configure; live data-plane queries are ' +
        'augmented by the OPT-IN Azure Resources (ARM) MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-postgres',
    name: 'Azure Database for PostgreSQL',
    whenToUse:
      'Designing or tuning a PostgreSQL flexible server — schema, indexing, query plans, and ' +
      'extensions (pgvector, etc.).',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['postgres-flexible-server', 'postgres', 'sql-database', 'default'],
    toolNames: ['item_create', 'item_configure', 'sql_explain', 'sql_optimize'],
    guidance: [
      'SKILL: Azure Database for PostgreSQL (flexible server).',
      'Design normalized schemas; index for the real query shapes and verify with EXPLAIN (sql_explain) ' +
        'before adding indexes; rewrite slow queries (sql_optimize). Enable extensions deliberately ' +
        '(pgvector for embeddings, pg_stat_statements for tuning). Use Entra auth + private networking, ' +
        'not password-only public access.',
      'Provision/configure with item_create / item_configure; live server admin is augmented by the ' +
        'OPT-IN Azure Resources (ARM) MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-eventhub',
    name: 'Azure Event Hubs',
    whenToUse:
      'Designing high-throughput event ingestion — partitions, consumer groups, capture to a lake, and ' +
      'throughput/scale settings.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['eventstream', 'event-schema-set', 'default'],
    toolNames: ['item_create', 'item_configure', 'item_list'],
    guidance: [
      'SKILL: Azure Event Hubs.',
      'Size partitions for the peak ingress + the parallelism of downstream consumers (a partition is ' +
        'the unit of ordering AND scale). Use distinct consumer groups per independent reader, enable ' +
        'Capture to land raw events as Delta/Avro in the lake, and choose throughput units / Premium ' +
        'per the load. This is the Azure-native backend for a Loom eventstream — no Fabric needed.',
      'Create/configure via item_create / item_configure on the eventstream item.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-servicebus',
    name: 'Azure Service Bus',
    whenToUse:
      'Designing reliable messaging — queues vs. topics/subscriptions, sessions/ordering, dead-letter ' +
      'handling, and delivery guarantees.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['eventstream', 'default'],
    toolNames: ['item_create', 'item_configure', 'item_list'],
    guidance: [
      'SKILL: Azure Service Bus.',
      'Choose queues for point-to-point work and topics/subscriptions for publish-subscribe fan-out. ' +
        'Use sessions when ordering matters, configure dead-letter + max-delivery-count for poison ' +
        'messages, and prefer peek-lock for at-least-once processing. Authenticate with managed identity, ' +
        'not SAS keys, where possible.',
      'Provision/configure with item_create / item_configure; live namespace admin is augmented by the ' +
        'OPT-IN Azure Resources (ARM) MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-eventgrid',
    name: 'Azure Event Grid',
    whenToUse:
      'Designing event-driven routing — topics, subscriptions, event schemas, filtering, and ' +
      'dead-letter/retry policy.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['eventstream', 'event-schema-set', 'default'],
    toolNames: ['item_create', 'item_configure', 'item_list'],
    guidance: [
      'SKILL: Azure Event Grid.',
      'Route discrete events with subject/event-type filters to the right handlers; use the CloudEvents ' +
        'schema for interop; configure retry + dead-letter to a storage container for undeliverable ' +
        'events. Event Grid is for reactive routing (vs. Event Hubs for high-throughput streams) — pick ' +
        'the right one for the workload.',
      'Document event types on the event-schema-set; create/configure via item_create / item_configure.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

const IDENTITY_MONITORING_SKILLS: MsAgentSkill[] = [
  {
    id: 'entra-app-registration',
    name: 'Entra — app registration',
    whenToUse:
      'Creating or reviewing an Entra app registration — redirect URIs, API permissions/scopes, ' +
      'consent, and client-secret/cert hygiene.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_GRAPH_TOOL_PREFIX,
    attribution: attribution('Microsoft Graph (Enterprise)'),
    panes: ['rbac', 'default'],
    toolNames: ['loom_self_audit', 'item_configure'],
    guidance: [
      'SKILL: Entra app registration.',
      'Register apps least-privilege: request only the delegated/application scopes actually used, set ' +
        'exact redirect URIs (no wildcards), prefer certificate credentials over secrets, and document ' +
        'required admin consent. For Loom OBO servers, REUSE the existing confidential client ' +
        '(LOOM_MSAL_CLIENT_ID) — do not mint parallel secrets. loom_self_audit reports the live app + ' +
        'role posture.',
      'Live Entra directory reads/writes come from the OPT-IN Microsoft Graph MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-keyvault',
    name: 'Azure Key Vault',
    whenToUse:
      'Managing secrets/keys/certs — secret naming + rotation, access policy vs. RBAC, and referencing ' +
      'secrets without ever exposing literals.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['rbac', 'default'],
    toolNames: ['loom_self_audit', 'item_configure'],
    guidance: [
      'SKILL: Azure Key Vault.',
      'NEVER place a secret literal in config/code — store it in Key Vault and reference it by NAME ' +
        '(secretRef / managed-identity read). Use RBAC data-plane roles over legacy access policies, ' +
        'enable purge protection + soft delete, and rotate on a schedule. This is exactly how Loom ' +
        "resolves the GitHub MCP PAT and every other server secret.",
      'Live vault operations are augmented by the OPT-IN Azure Resources (ARM) MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-kusto',
    name: 'Azure Data Explorer (Kusto)',
    whenToUse:
      'Working with ADX/Eventhouse — exploring databases/tables, writing performant KQL, and modeling ' +
      'ingestion + retention.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['kql-database', 'eventhouse', 'kql-dashboard', 'default'],
    toolNames: ['adx_list_databases', 'adx_list_tables', 'adx_query', 'kql_get_schema', 'kql_execute'],
    guidance: [
      'SKILL: Azure Data Explorer (Kusto).',
      'A Loom eventhouse/kql-database is an ADX cluster (the Azure-native RTI Eventhouse equivalent — no ' +
        'Fabric). Explore with adx_list_databases / adx_list_tables, read the schema (kql_get_schema), ' +
        'and run KQL with adx_query / kql_execute against the real cluster. Model update policies, ' +
        'materialized views, and retention/caching policies for cost + speed.',
      'Filter EARLY and project only needed columns; ground every query on the real schema.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'kql',
    name: 'KQL authoring',
    whenToUse:
      'Writing or optimizing KQL — for ADX, Log Analytics/Monitor, or Sentinel hunting — grounded in ' +
      'the real table schema.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_SENTINEL_TOOL_PREFIX,
    attribution: attribution('Microsoft Sentinel'),
    panes: ['kql-database', 'kql-queryset', 'kql-dashboard', 'monitor'],
    toolNames: ['kql_execute', 'kql_get_schema', 'kql_list_databases', 'kql_list_tables', 'adx_query'],
    guidance: [
      'SKILL: KQL authoring.',
      'Read the schema first (kql_get_schema / kql_list_tables), then write KQL that filters early ' +
        '(where before project/summarize), avoids unbounded time ranges, and uses summarize/ join keys ' +
        'efficiently. Validate against the real data with kql_execute / adx_query — never hand back an ' +
        'unverified query.',
      'For Sentinel threat-hunting KQL, the OPT-IN Microsoft Sentinel MCP runs hunts over the data lake ' +
        'when connected; the same authoring rules apply.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'azure-monitor-query',
    name: 'Azure Monitor — query logs & metrics',
    whenToUse:
      'Querying Azure Monitor / Log Analytics for diagnostics — building log queries, metric ' +
      'aggregations, and alert-worthy signals.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['monitor', 'health', 'default'],
    toolNames: ['kql_execute', 'adx_query', 'loom_self_audit'],
    guidance: [
      'SKILL: Azure Monitor — query logs & metrics.',
      'Query the Log Analytics workspace with KQL (kql_execute / adx_query) for diagnostics: error ' +
        'rates, latency percentiles, failed dependencies. Pair logs with metric aggregations and define ' +
        'the threshold that should become a scheduled-query alert (the Azure-native Activator backend). ' +
        'loom_self_audit confirms diagnostics are enabled on the source resources.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'appinsights-instrumentation',
    name: 'Application Insights — instrumentation',
    whenToUse:
      'Instrumenting an app with Application Insights — distributed tracing, custom metrics/events, ' +
      'sampling, and connecting telemetry to dashboards.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: AZURE_ARM_TOOL_PREFIX,
    attribution: attribution('Azure Resources (ARM)'),
    panes: ['monitor', 'tracing', 'default'],
    toolNames: ['loom_self_audit', 'item_configure'],
    guidance: [
      'SKILL: Application Insights instrumentation.',
      'Instrument with OpenTelemetry / the App Insights SDK: enable distributed tracing across services, ' +
        'emit custom metrics + events for business signals, set sampling to control cost, and use ' +
        'managed-identity-based ingestion (connection string from Key Vault, never a hard-coded key). ' +
        'loom_self_audit verifies the telemetry is flowing.',
      'Live telemetry queries are augmented by the OPT-IN Azure Resources (ARM) MCP when connected.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

const DEV_SKILLS: MsAgentSkill[] = [
  {
    id: 'cloud-solution-architect',
    name: 'Cloud solution architect',
    whenToUse:
      'Designing an end-to-end Azure solution — choosing services, the reference architecture, ' +
      'trade-offs, and a WAF-aligned design.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_LEARN_TOOL_PREFIX,
    attribution: attribution('Microsoft Learn'),
    panes: ['default', 'copilot', 'deploy-planner'],
    toolNames: ['item_list', 'workspace_list', 'loom_self_audit'],
    guidance: [
      'SKILL: Cloud solution architect.',
      'Design to the Well-Architected Framework pillars (reliability, security, cost, operational ' +
        'excellence, performance). Pick the simplest services that meet the requirement, prefer ' +
        'Azure-native + managed-identity + private-networking, and state the trade-offs explicitly. ' +
        'Ground the design in what already exists (item_list / workspace_list).',
      'The Microsoft Learn MCP (mcp_mslearn_*) is DEFAULT-ON — use it to ground recommendations in ' +
        'current official guidance + reference architectures (it works day-one, no config).',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'mcp-builder',
    name: 'MCP server builder',
    whenToUse:
      'Building or registering an MCP server — designing tools/resources, choosing transport + auth, ' +
      'and wiring it into the Loom MCP catalog.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_LEARN_TOOL_PREFIX,
    attribution: attribution('Microsoft Learn'),
    panes: ['default', 'copilot'],
    toolNames: ['item_create', 'item_configure'],
    guidance: [
      'SKILL: MCP server builder.',
      'Design tools with crisp names + JSON-schema inputs, return structured results, and keep each tool ' +
        'single-purpose. Choose the transport (stdio for local, Streamable-HTTP for remote) and the auth ' +
        'model (none / Entra-OBO / Key-Vault PAT) that matches the backend. In Loom, register a remote ' +
        "server as the SAME McpServerConfig shape the built-ins use (source 'remote-builtin' / 'external' " +
        '/ catalog) — do not build a parallel client; secrets go via Key Vault secretRef, never literals.',
      'The Microsoft Learn MCP (mcp_mslearn_*, default-on) grounds the MCP spec + SDK guidance day-one.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'microsoft-docs',
    name: 'Microsoft Learn docs',
    whenToUse:
      'Looking up current, authoritative Microsoft/Azure documentation, code samples, or service ' +
      'limits — instead of answering from memory.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_LEARN_TOOL_PREFIX,
    attribution: attribution('Microsoft Learn'),
    panes: ['default', 'copilot'],
    toolNames: [],
    guidance: [
      'SKILL: Microsoft Learn docs.',
      'For any Azure/Microsoft API, limit, or how-to question, ground the answer in official docs rather ' +
        'than memory. The Microsoft Learn MCP server is DEFAULT-ON in Loom (auth none, zero config, live ' +
        'day-one): use its mcp_mslearn_* tools (microsoft_docs_search → microsoft_docs_fetch → ' +
        'microsoft_code_sample_search) to retrieve the current guidance, then cite the source URL.',
      'Search for breadth, fetch a specific page for depth, and prefer recent docs over assumptions.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'react-flow-node-ts',
    name: 'React Flow node (TypeScript)',
    whenToUse:
      'Authoring a custom React Flow canvas node for a Loom studio editor — typed node/edge data, ' +
      'handles, and the shared canvas-node-kit conventions.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_LEARN_TOOL_PREFIX,
    attribution: attribution('Microsoft Learn'),
    panes: ['default', 'copilot'],
    toolNames: [],
    guidance: [
      'SKILL: React Flow node (TypeScript).',
      "Build canvas nodes against Loom's shared canvas-node-kit: strongly-typed node + edge data, " +
        'explicit source/target handles, memoized node components, and Fluent v9 + Loom design tokens ' +
        '(never hard-coded px/hex) so the node matches the rest of the studio chrome. Keep node data ' +
        'serializable and the editor reducer the single source of truth.',
      'This is authoring guidance (it produces code you edit) — pair it with the Microsoft Learn MCP ' +
        '(default-on) for current @xyflow/react API details.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
  {
    id: 'skill-creator',
    name: 'Skill creator',
    whenToUse:
      'Authoring a NEW Copilot/agent skill descriptor — when to use it, the grounding guidance, the ' +
      'real tools it drives, and the panes it surfaces on.',
    defaultTarget: 'azure-native',
    mcpToolPrefix: MS_LEARN_TOOL_PREFIX,
    attribution: attribution('Microsoft Learn'),
    panes: ['default', 'copilot'],
    toolNames: [],
    guidance: [
      'SKILL: Skill creator.',
      'Author a new skill as a LoomCopilotSkill / MsAgentSkill descriptor: a precise whenToUse, ' +
        'best-practice guidance that grounds REAL registered tools (no vaporware), defaultTarget ' +
        "'azure-native', the toolNames it drives, an optional mcpToolPrefix for an opt-in MS MCP, and the " +
        'panes it belongs to. Keep it pure data + selectors (no SDK/network) so it loads on demand — ' +
        'mirror lib/copilot/powerbi-skills.ts and this module. Never invent a tool that is not registered.',
      'The Microsoft Learn MCP (default-on) helps research the source skill being adapted.',
      MS_SKILLS_ATTRIBUTION,
    ].join('\n'),
  },
];

/**
 * The full set of Microsoft agent-skill descriptors (~30). All Azure-native by
 * default; each optionally augmented by an OPT-IN Microsoft MCP server (Learn is
 * default-on). Attributed to github.com/microsoft/skills.
 */
export const MS_AGENT_SKILLS: MsAgentSkill[] = [
  ...INFRA_OPS_SKILLS,
  ...FOUNDRY_AI_SKILLS,
  ...DATA_MESSAGING_SKILLS,
  ...IDENTITY_MONITORING_SKILLS,
  ...DEV_SKILLS,
];

// ---------------------------------------------------------------------------
// Selectors (mirror powerbi-skills.ts: getPowerBiSkill / skillsForPane /
// skillSystemBlock / skillSystemBlocksForPane), namespaced `ms*`.
// ---------------------------------------------------------------------------

/** Look an MS skill up by its stable id (case-insensitive). undefined when unknown. */
export function getMsSkill(id: string | null | undefined): MsAgentSkill | undefined {
  if (!id) return undefined;
  const k = String(id).trim().toLowerCase();
  return MS_AGENT_SKILLS.find((s) => s.id.toLowerCase() === k);
}

/**
 * MS skills relevant to a given pane / persona slug (case-insensitive). The
 * orchestrator passes the active editor's slug (item-type slug like 'lakehouse' /
 * 'kql-database', or a page slug like 'cost' / 'rbac' / 'monitor', or 'default').
 * Unknown / empty slug → [].
 */
export function msSkillsForPane(slug: string | null | undefined): MsAgentSkill[] {
  if (!slug) return [];
  const s = String(slug).trim().toLowerCase();
  if (!s) return [];
  return MS_AGENT_SKILLS.filter((skill) => skill.panes.some((p) => p.toLowerCase() === s));
}

/** Distinct MS MCP tool-name prefixes across the given skills (defaults to all). */
export function msSkillMcpPrefixes(skills: MsAgentSkill[] = MS_AGENT_SKILLS): string[] {
  return [...new Set(skills.map((s) => s.mcpToolPrefix).filter((p): p is string => Boolean(p)))];
}

/**
 * Render an MS skill as the extra system-message block the orchestrator injects
 * when the skill is active. Always frames the Azure-native default and advertises
 * the skill's REAL Loom tools. For the OPT-IN MS MCP behind `mcpToolPrefix`:
 *  - when connected, additionally advertises its `mcp_<slug>_*` tools;
 *  - when NOT connected, emits the HONEST gate (verbatim from the catalog entry's
 *    `gate`) naming the exact env var / Key Vault secret / scope / consent.
 *
 * `opts.connected` overrides the per-server state; when omitted it falls back to
 * the catalog entry's live `configured()` (so the default-on Microsoft Learn MCP
 * is advertised as live day-one and opt-in servers show their gate until enabled).
 */
export function msSkillSystemBlock(
  skill: MsAgentSkill,
  opts?: { connected?: boolean },
): string {
  const lines: string[] = [];
  lines.push(`# Active skill: ${skill.name}`);
  lines.push(`When to use: ${skill.whenToUse}`);
  lines.push('');
  lines.push(skill.guidance);
  lines.push('');

  if (skill.toolNames.length) {
    lines.push(
      `Default tools for this skill (Azure-native, always available): ${skill.toolNames.join(', ')}.`,
    );
  }

  if (skill.mcpToolPrefix) {
    const entry = entryForPrefix(skill.mcpToolPrefix);
    const connected = opts?.connected ?? entry?.configured() ?? false;
    const serverName = entry?.name ?? 'the Microsoft MCP server';
    if (connected) {
      lines.push(
        `The ${serverName} MCP is connected: you may ALSO use its tools (names beginning ` +
          `"${skill.mcpToolPrefix}"). They run under the signed-in user's delegated identity / its ` +
          `configured credential.`,
      );
    } else if (entry?.gate) {
      // HONEST gate, single-sourced from the catalog entry (no-vaporware).
      lines.push(entry.gate);
    } else {
      lines.push(
        `${serverName} is OPT-IN and not connected; the Azure-native tools above are fully functional ` +
          `on their own.`,
      );
    }
  }

  return lines.join('\n').trim();
}

/**
 * Convenience: the combined system blocks for every MS skill active in a pane.
 * `opts.connectedPrefixes` (the `mcp_<slug>_` prefixes the live MCP shim actually
 * registered) is authoritative when supplied; otherwise each skill falls back to
 * its catalog entry's live `configured()`. Returns '' when no MS skill applies.
 */
export function msSkillSystemBlocksForPane(
  slug: string | null | undefined,
  opts?: { connectedPrefixes?: string[] },
): string {
  const prefixes = opts?.connectedPrefixes;
  return msSkillsForPane(slug)
    .map((skill) => {
      if (prefixes && skill.mcpToolPrefix) {
        return msSkillSystemBlock(skill, { connected: prefixes.includes(skill.mcpToolPrefix) });
      }
      return msSkillSystemBlock(skill);
    })
    .join('\n\n')
    .trim();
}
