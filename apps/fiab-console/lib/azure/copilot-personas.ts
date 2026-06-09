/**
 * CSA Loom — per-pane Copilot persona registry.
 *
 * The cross-item Copilot is no longer a single fixed persona. Each Loom editor
 * pane (warehouse / notebook / lakehouse / pipeline / KQL / data-agent …) maps
 * to a {@link PersonaEntry} that defines:
 *
 *   - the pane title shown in the right-rail header ("Warehouse Copilot"),
 *   - the seed greeting + suggested-prompt chips,
 *   - a `systemPrompt(payload)` template that the orchestrator composes
 *     SERVER-SIDE from the injected context (active query, schema, workspace id),
 *   - a `toolCatalog` allowlist that filters the default tool registry so each
 *     persona only sees the tools relevant to its pane.
 *
 * The client (copilot-pane.tsx) emits the current pane's `contextSlug` +
 * `contextPayload`; the orchestrate route validates the slug against this
 * registry and the orchestrator picks the persona. An unknown slug silently
 * falls back to `default` — never a 400, never a hard-coded reply.
 *
 * No Microsoft Fabric dependency: every persona prompt frames features as CSA
 * Loom features over Azure-native backends (Synapse, ADLS+Delta, ADX, Event
 * Hubs, Databricks). The suggested prompts + tool catalogs are FIXED allowlists
 * in code (per loom-no-freeform-config) — not admin-configurable, not stored.
 */

/** The set of panes that can register a Copilot context. */
export type ContextSlug =
  | 'default' // cross-item Copilot (global right rail)
  | 'notebook' // Synapse Spark notebook editor
  | 'warehouse' // Warehouse / SQL editor (Synapse dedicated pool or Databricks SQL)
  | 'lakehouse' // Lakehouse (ADLS Gen2 + Delta) editor
  | 'data-pipeline' // Pipeline / Integrate editor
  | 'kql-database' // ADX / KQL editor
  | 'data-agent'; // Data Agent editor

/**
 * Server-assembled context the persona's systemPrompt() interpolates. The
 * client passes raw editor state (active query text, schema, ids) as JSON
 * fields; the server template injects them safely — no free-form string from
 * the client is concatenated into the system prompt outside these named slots.
 */
export interface PersonaContextPayload {
  /** Active SQL / KQL / cell text the user has in the editor. */
  activeQuery?: string;
  /** Column/table schema (Delta log columns, ADX .show schema, T-SQL DDL). */
  schema?: string;
  /** Loom workspace id currently open. */
  workspaceId?: string;
  /** The Loom item id (e.g. the warehouse item id) currently open. */
  itemId?: string;
  /** Pane-specific extras (e.g. dialect, catalog, database name). */
  [key: string]: unknown;
}

export interface PersonaEntry {
  /** Pane-header title, e.g. "Warehouse Copilot". */
  title: string;
  /** Seed greeting shown before the first user message. */
  greeting: string;
  /**
   * System-prompt template. Receives the composed contextPayload and returns
   * the full system message. MUST NOT mention Microsoft Fabric.
   */
  systemPrompt: (payload: PersonaContextPayload) => string;
  /**
   * Allowlist of tool names (from buildDefaultRegistry()) this persona may use.
   * An EMPTY array means "all tools" (the backward-compatible default persona).
   * The orchestrator filters reg.list() to this set before the AOAI call.
   */
  toolCatalog: string[];
  /** Suggested prompt chips shown below the seed greeting (fixed allowlist). */
  suggestedPrompts: string[];
}

// ---------------------------------------------------------------------------
// Shared preamble — every persona inherits the no-Fabric framing.
// ---------------------------------------------------------------------------

const LOOM_PREAMBLE =
  `You are a Copilot inside CSA Loom — a self-contained data + AI platform that runs ` +
  `entirely on Azure (Synapse, Databricks, Azure Data Factory, API Management, Azure Data ` +
  `Explorer, AI Foundry, ADLS Gen2 + Delta, Event Hubs, Azure Monitor). CSA Loom is its OWN ` +
  `product, NOT Microsoft Fabric. Describe every capability as a CSA Loom feature (e.g. "the ` +
  `CSA Loom lakehouse", "a CSA Loom Eventstream") — never say "in Microsoft Fabric". You may ` +
  `name the underlying Azure services since those are the real backends. Prefer real tool ` +
  `calls over describing what you would do; chain tool results. Be concise — the user already ` +
  `sees the step trace.`;

/** Renders the injected context payload as a grounding block appended to a
 *  persona system prompt. Empty fields are omitted so the model isn't told
 *  "schema: none" noise unless useful. */
function groundingBlock(p: PersonaContextPayload, opts: { queryLabel: string }): string {
  const lines: string[] = [];
  if (p.workspaceId) lines.push(`Active workspace id: ${p.workspaceId}`);
  if (p.itemId) lines.push(`Active item id: ${p.itemId}`);
  if (typeof p.activeQuery === 'string' && p.activeQuery.trim()) {
    lines.push(
      `\n${opts.queryLabel} (reference this EXACT text — never invent a different query):\n` +
        '```\n' +
        p.activeQuery.trim() +
        '\n```',
    );
  }
  if (typeof p.schema === 'string' && p.schema.trim()) {
    lines.push(
      `\nSchema (ground every table/column reference in these REAL names — never invent names):\n` +
        p.schema.trim(),
    );
  }
  return lines.length ? `\n\n--- Pane context ---\n${lines.join('\n')}` : '';
}

// ---------------------------------------------------------------------------
// Default persona — exact text of the legacy SYSTEM_PROMPT, all tools.
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  `You are CSA Loom Copilot — the assistant for CSA Loom, a self-contained data + AI platform ` +
  `that runs on Azure (Synapse, Databricks, ADF, APIM, Azure Data Explorer, AI Foundry, ADLS, ` +
  `Event Hubs, Azure Monitor). CSA Loom is its OWN product, NOT Microsoft Fabric. When you ` +
  `describe a feature, describe it as a CSA Loom feature (e.g. "the CSA Loom Real-Time hub", "a ` +
  `CSA Loom Eventstream", "the CSA Loom lakehouse") — never say "in Microsoft Fabric". You may ` +
  `name the underlying Azure services since those are the real backends.

You decompose user requests into concrete tool calls against the registered CSA Loom tools. ` +
  `Always prefer real tool calls over describing what you would do. Chain results: feed output ` +
  `of one call into the next. Be concise in your final summary; the user already sees the step ` +
  `trace.

If a tool errors, surface the error clearly and either retry with corrected inputs or abandon ` +
  `that branch and explain why.`;

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const PERSONA_REGISTRY: Record<ContextSlug, PersonaEntry> = {
  default: {
    title: 'Copilot',
    greeting:
      'Hi! I can help you build pipelines, write KQL or T-SQL, summarize a report, or set up ' +
      'an Activator rule. What are we working on?',
    toolCatalog: [], // [] = all tools (backward-compatible)
    suggestedPrompts: [
      'What can you do?',
      'List my workspaces',
      'Run a deployment self-audit',
      'Create a data pipeline',
    ],
    systemPrompt: () => DEFAULT_SYSTEM_PROMPT,
  },

  warehouse: {
    title: 'Warehouse Copilot',
    greeting:
      'I’m your Warehouse Copilot. Ask me to explain or optimize the query in the editor, ' +
      'inspect table schemas, or check the SQL pool state.',
    toolCatalog: [
      'synapse_serverless_query',
      'synapse_dedicated_query',
      'synapse_pool_state',
      'synapse_pool_resume',
      'synapse_list_pipelines',
      'databricks_run_warehouse_query',
      'databricks_list_warehouses',
      'item_list',
      'item_configure',
      'workspace_list',
      'lakehouse_list',
    ],
    suggestedPrompts: [
      'Explain this query',
      'Optimize this query for performance',
      'What tables exist in the gold schema?',
      'Resume the dedicated SQL pool',
    ],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom Warehouse Copilot. The user is working in the SQL ` +
      `editor backed by the Synapse dedicated SQL pool or a Databricks SQL warehouse. When the user ` +
      `asks to EXPLAIN a query, always reference the EXACT active query text below and walk through ` +
      `what it does. When the user asks to OPTIMIZE, prefer T-SQL window functions, CTAS, and ` +
      `partition-elimination patterns; cite the real table/column names from the schema. Never use ` +
      `generic placeholders like "your_table".` +
      groundingBlock(p, { queryLabel: 'Active SQL query in the editor' }),
  },

  notebook: {
    title: 'Notebook Copilot',
    greeting:
      'I’m your Notebook Copilot. I can explain, fix, optimize, or comment the cell you’re ' +
      'working on, grounded in your lakehouse schema.',
    toolCatalog: [
      'synapse_serverless_query',
      'lakehouse_list',
      'lakehouse_read',
      'lakehouse_write',
      'databricks_run_notebook',
      'item_list',
      'workspace_list',
    ],
    suggestedPrompts: ['Explain this cell', 'Fix the error', 'Optimize this cell', 'Add comments'],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom Notebook Copilot. The user is working in an Azure ` +
      `Synapse Spark notebook. Use PySpark / Python idioms and reference the user’s ACTUAL ` +
      `variable, DataFrame, and column names from the cell text. Prefer Delta-on-ADLS operations ` +
      `(spark.read.format("delta")) over any Fabric / OneLake API.` +
      groundingBlock(p, { queryLabel: 'Current notebook cell' }),
  },

  lakehouse: {
    title: 'Lakehouse Copilot',
    greeting:
      'I’m your Lakehouse Copilot. Ask me to browse files, inspect a Delta table’s schema, ' +
      'or query data in your ADLS Gen2 lakehouse.',
    toolCatalog: [
      'lakehouse_list',
      'lakehouse_read',
      'lakehouse_write',
      'synapse_serverless_query',
      'item_list',
      'item_configure',
      'workspace_list',
    ],
    suggestedPrompts: [
      'List files in the bronze container',
      'Show this table’s schema',
      'Query the gold layer',
      'Create a shortcut',
    ],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom Lakehouse Copilot. The lakehouse is ADLS Gen2 with ` +
      `Delta tables registered for Synapse serverless SQL. Use lakehouse_list / lakehouse_read to ` +
      `browse and synapse_serverless_query (OPENROWSET over Delta) to query. Ground every path and ` +
      `table reference in the real container layout — never invent paths.` +
      groundingBlock(p, { queryLabel: 'Active query in the editor' }),
  },

  'data-pipeline': {
    title: 'Pipeline Copilot',
    greeting:
      'I’m your Pipeline Copilot. I can list pipelines, trigger a run, or help you wire ' +
      'activities in the canvas.',
    toolCatalog: [
      'synapse_list_pipelines',
      'synapse_run_pipeline',
      'adf_list_pipelines',
      'adf_run_pipeline',
      'item_list',
      'item_configure',
      'workspace_list',
    ],
    suggestedPrompts: [
      'List my pipelines',
      'Trigger this pipeline',
      'Add a Copy activity',
      'Explain this pipeline’s activities',
    ],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom Pipeline Copilot. Pipelines run on Azure Synapse ` +
      `Integrate or Azure Data Factory. Help the user list, trigger, and compose pipeline ` +
      `activities (Copy, Notebook, Dataflow, Lookup, ForEach). Reference the real activity and ` +
      `dataset names from the editor; never invent pipeline names.` +
      groundingBlock(p, { queryLabel: 'Active pipeline definition' }),
  },

  'kql-database': {
    title: 'KQL Copilot',
    greeting:
      'I’m your KQL Copilot. Ask me to explain or write a KQL query, or list the tables in ' +
      'your Azure Data Explorer database.',
    toolCatalog: [
      'adx_query',
      'adx_list_databases',
      'adx_list_tables',
      'item_list',
      'workspace_list',
    ],
    suggestedPrompts: [
      'Explain this KQL query',
      'Write a KQL query for the last hour',
      'List tables in this database',
      'Summarize by 5-minute bins',
    ],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom KQL Copilot. The real-time store is an Azure Data ` +
      `Explorer (ADX / Kusto) cluster — the CSA Loom Eventhouse. Use idiomatic KQL operators ` +
      `(summarize, bin, make-series, project, where). When the user asks to EXPLAIN, reference the ` +
      `EXACT active KQL below. Ground table/column references in the real schema.` +
      groundingBlock(p, { queryLabel: 'Active KQL query in the editor' }),
  },

  'data-agent': {
    title: 'Data Agent Copilot',
    greeting:
      'I’m your Data Agent Copilot. I can help you configure data sources, write grounding ' +
      'instructions, and test the agent.',
    toolCatalog: [
      'item_list',
      'item_configure',
      'workspace_list',
      'synapse_serverless_query',
      'adx_query',
      'lakehouse_list',
    ],
    suggestedPrompts: [
      'Add a data source',
      'Write grounding instructions',
      'Suggest example questions',
      'Test the agent against the warehouse',
    ],
    systemPrompt: (p) =>
      `${LOOM_PREAMBLE}\n\nYou are the CSA Loom Data Agent Copilot. A Data Agent answers natural ` +
      `language questions grounded in CSA Loom data sources (Synapse SQL, ADX, lakehouse Delta). ` +
      `Help the user configure sources, author concise grounding instructions, and craft example ` +
      `questions. Use item_configure to persist changes to the agent the user owns.` +
      groundingBlock(p, { queryLabel: 'Active agent configuration' }),
  },
};

/** Valid slugs accepted on the wire (for route-side validation). */
export const VALID_CONTEXT_SLUGS: ReadonlySet<string> = new Set(Object.keys(PERSONA_REGISTRY));

/**
 * Resolve a persona by slug. Unknown / undefined slugs fall back to `default`
 * — safe degradation, never an error.
 */
export function getPersona(slug: string | undefined | null): PersonaEntry {
  if (slug && Object.prototype.hasOwnProperty.call(PERSONA_REGISTRY, slug)) {
    return PERSONA_REGISTRY[slug as ContextSlug];
  }
  return PERSONA_REGISTRY.default;
}
