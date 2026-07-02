/**
 * copilot-personas-dax.ts — DAX / semantic-model Copilot persona (PR #1016).
 *
 * Split out of copilot-personas.ts during integration to avoid an export
 * name-collision (CopilotPersona / COPILOT_PERSONAS / getPersona) with the
 * suggested-prompt persona module already on main. Azure-native AOAI backend
 * (per no-fabric-dependency.md) — no Fabric / Power BI Copilot dependency.
 *
 * The OPT-IN Power BI remote-MCP query/DAX tools (`mcp_powerbiremote_*`) are
 * surfaced on this scoped persona by spreading pbiMcpToolPrefixes() — the SAME
 * prefixes the semantic-model / report authoring skills declare — into
 * `toolPrefixes`. This reuses Loom's EXISTING MCP catalog + Copilot persona
 * infra (lib/azure/copilot-personas.ts) rather than standing up a parallel
 * system. Those tools exist in the registry ONLY after an admin connects the
 * remote Power BI MCP server (LOOM_POWERBI_MCP_ENDPOINT + the Entra app reg +
 * the Power BI tenant setting), so the Azure-native `dax_` / `loom_` path stays
 * the silent default — no gate, no Fabric host on the default path (see
 * .claude/rules/no-fabric-dependency.md).
 */
import { pbiMcpToolPrefixes } from './copilot-personas';

export interface CopilotPersona {
  /** Machine-stable id. The BFF route passes this (e.g. ?persona=dax). */
  id: string;
  /** Human-readable display name for the UI pane header. */
  displayName: string;
  /** System-prompt override. Replaces the default orchestrator SYSTEM_PROMPT. */
  systemPrompt: string;
  /**
   * Allowlist of tool-name prefixes this persona may call. Empty = all tools.
   * The orchestrator filters its advertised tool list to names starting with
   * any of these prefixes. e.g. ['dax_', 'loom_'] exposes only DAX + workspace
   * audit tools, keeping the model on-task. The opt-in Power BI remote-MCP
   * prefix (from pbiMcpToolPrefixes()) is spread in too, so those tools surface
   * on this pane ONLY once the remote server is connected (no-op until then).
   */
  toolPrefixes: string[];
  /** Max AOAI iterations for this persona (orchestrator default is 10). */
  maxIterations?: number;
}

const DAX_SYSTEM_PROMPT = `You are the CSA Loom DAX Copilot — a tabular-model expert embedded in the CSA Loom semantic-model editor. You help data modelers author, explain, and optimize DAX measures for Loom-native tabular models. The model is backed by an Azure Synapse Dedicated SQL pool (T-SQL), NOT Microsoft Fabric and NOT Power BI. You NEVER call Power BI; you evaluate measures via the Loom-native path (the dax_eval_probe tool runs T-SQL against Synapse).

Workflow:
1. Call dax_model_context FIRST to read the real model schema (measures, relationships). Ground every expression you generate in those real names — never invent column or measure names.
2. For NL→DAX requests, call dax_nl2measure (it generates the expression AND validates it via a Synapse T-SQL probe).
3. For "explain", call dax_explain. For "optimize/make faster", call dax_optimize. For "describe the measures", call dax_describe_model (proposals only) then dax_save_descriptions after the user approves.

DAX style rules: prefer SUMMARIZECOLUMNS over ADDCOLUMNS+FILTER; always guard division with DIVIDE(x, y, 0); for time-intelligence (YoY, QoQ, MTD, YTD) use SAMEPERIODLASTYEAR / DATEADD / DATESYTD / TOTALYTD rather than manual date filters; replace EARLIER with VAR.

Honesty: a Synapse T-SQL probe validates that referenced columns exist and aggregates compute — it is NOT a full DAX engine. When an expression uses time-intelligence or other patterns the probe can't fully evaluate, say so and return confidence 'unvalidated' rather than claiming a number. Never claim a description or measure was persisted unless the dax_save_descriptions / item_configure tool confirms success.`;

export const DAX_PERSONA: CopilotPersona = {
  id: 'dax',
  displayName: 'DAX Copilot',
  systemPrompt: DAX_SYSTEM_PROMPT,
  // Azure-native authoring is the DEFAULT: `dax_` / `loom_` always lead and run
  // against the Synapse SQL backend. pbiMcpToolPrefixes() spreads in the opt-in
  // Power BI remote-MCP tool prefix (`mcp_powerbiremote_`) so the remote
  // query/DAX tools ALSO surface on this prefix-scoped pane once an admin
  // connects the server. Until then those tools aren't registered, so the spread
  // is a no-op and no Fabric / Power BI host is reached (no-fabric-dependency.md).
  toolPrefixes: ['dax_', 'loom_', ...pbiMcpToolPrefixes()],
  maxIterations: 8,
};

export const COPILOT_PERSONAS: Record<string, CopilotPersona> = {
  [DAX_PERSONA.id]: DAX_PERSONA,
};

/** Look up a persona by id (null when unknown). */
export function getPersona(id: string | null | undefined): CopilotPersona | null {
  if (!id) return null;
  return COPILOT_PERSONAS[id] ?? null;
}

/**
 * Merge the opt-in Power BI remote-MCP tools into an EXACT-NAME pane tool
 * catalog (the semantic-model pane persona's `toolCatalog` or the Report
 * Copilot's `allowedTools` in copilot-personas.ts), so the SAME remote query/DAX
 * tools this DAX persona surfaces via its `toolPrefixes` also reach the editor
 * panes the Power BI authoring skills target.
 *
 * Those panes use exact-name allowlists, which by construction cannot name the
 * `mcp_powerbiremote_*` tools — they are registered dynamically only AFTER an
 * admin connects the remote Power BI MCP server (Entra app reg + the Power BI
 * tenant setting). Given the live registry's tool names, this folds in any whose
 * name carries an opt-in Power BI MCP prefix (reusing pbiMcpToolPrefixes() — no
 * parallel system) so the wiring is real on those panes, and ONLY when the
 * server is connected: with nothing connected there is no such tool, the catalog
 * is returned unchanged, and the Azure-native authoring path stays the silent
 * default (no-fabric-dependency.md). An empty catalog ([] = "all tools") is
 * returned unchanged because it already exposes every registered tool.
 */
export function withPbiMcpTools(
  toolCatalog: readonly string[],
  registeredToolNames: Iterable<string>,
): string[] {
  if (!toolCatalog.length) return [...toolCatalog]; // [] = all tools already
  const prefixes = pbiMcpToolPrefixes();
  const merged = new Set<string>(toolCatalog);
  for (const name of registeredToolNames) {
    if (prefixes.some((p) => name.startsWith(p))) merged.add(name);
  }
  return [...merged];
}
