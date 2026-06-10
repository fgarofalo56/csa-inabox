/**
 * copilot-personas.ts — pure, side-effect-free definitions of the per-persona
 * suggested-prompt chips rendered above the Copilot composer (CopilotPersona,
 * CopilotContext, SuggestedPrompt, STATIC_PROMPTS, computeDynamicPrompts,
 * getPersonaPrompts, extractSqlTableNames).
 *
 * Parity target: the starter / suggested prompts the Microsoft Fabric Copilot
 * chat pane shows before a session begins. In a Notebook the chips are
 * notebook-flavoured ("/explain", "Show schema"); in a Warehouse they are
 * T-SQL-flavoured ("Preview data", "Row counts"). The dynamic prompts here
 * embed REAL symbols pulled from the live editor context (attached lakehouse
 * names, real table names from the SQL draft). No placeholder `<your_table>`
 * text — per no-vaporware.md.
 *
 * This module imports no Azure SDK and touches no network — it is safe to use
 * client-side. The server-only Pipeline Copilot registry lives in
 * copilot-personas-pipeline.ts (it imports the ADF / Synapse data-plane
 * clients) to keep this file out of the client bundle's server graph.
 *
 * It also hosts the (client-safe, type-only) Copilot PERSONA registry —
 * CopilotPersonaDef + resolvePersona() + ACTIVATOR_PERSONA — that narrows the
 * cross-item Copilot to a specific surface (e.g. the Activator editor) with a
 * tighter system prompt and a curated `allowedTools` subset. Personas add no
 * new backend; the activator persona drives the real Azure Monitor
 * scheduled-query-alert tools registered in the main LoomToolRegistry (see
 * lib/copilot/activator-tools.ts) — no Microsoft Fabric dependency.
 */

import type { ToolDef } from './copilot-orchestrator';

export type CopilotPersona =
  | 'notebook'
  | 'warehouse'
  | 'pipeline'
  | 'lakehouse'
  | 'default';

export interface CopilotContext {
  persona: CopilotPersona;
  /** notebook: display names from the editor's attachedSources[] */
  attachedSourceNames?: string[];
  /** notebook: the active default language (NotebookCellLang) */
  defaultLang?: string;
  /** warehouse: table names parsed from the live SQL editor state */
  tableNames?: string[];
  /** warehouse: first ~200 chars of the current SQL draft */
  currentSqlSnippet?: string;
  /** lakehouse: lakehouse displayName from the editor context */
  lakehouseName?: string;
}

export interface SuggestedPrompt {
  id: string;
  label: string;
  prompt: string;
}

/** True when a NotebookCellLang represents a SQL dialect. */
function isSqlLang(lang?: string): boolean {
  return lang === 'sparksql' || lang === 'tsql' || lang === 'sql';
}

export const STATIC_PROMPTS: Record<CopilotPersona, SuggestedPrompt[]> = {
  notebook: [
    { id: 'nb-explain', label: '/explain cell', prompt: '/explain' },
    { id: 'nb-optimize', label: '/optimize', prompt: '/optimize' },
    { id: 'nb-fix', label: '/fix error', prompt: '/fix' },
    { id: 'nb-comments', label: 'Add comments', prompt: '/comments' },
    {
      id: 'nb-schema',
      label: 'Show schema',
      prompt: 'Show me the schema of the attached lakehouse',
    },
  ],
  warehouse: [
    {
      id: 'wh-top10',
      label: 'Preview data',
      prompt:
        'Write a T-SQL query to preview the top 10 rows of the most recently modified table',
    },
    {
      id: 'wh-rowcounts',
      label: 'Row counts',
      prompt: 'Write T-SQL to show the row count for every table in the current schema',
    },
    {
      id: 'wh-explain',
      label: 'Explain query',
      prompt: 'Explain what the current SQL query does',
    },
    {
      id: 'wh-optimize',
      label: 'Optimize query',
      prompt:
        'Rewrite the current SQL query for better Synapse performance using predicate pushdown and column pruning',
    },
  ],
  pipeline: [
    {
      id: 'pl-list',
      label: 'List pipelines',
      prompt: 'List all pipelines in this workspace and their last run status',
    },
    {
      id: 'pl-trigger',
      label: 'Trigger pipeline',
      prompt: 'Help me trigger a pipeline run with parameters',
    },
    {
      id: 'pl-debug',
      label: 'Debug failure',
      prompt: 'The last pipeline run failed — help me diagnose the error',
    },
  ],
  lakehouse: [
    {
      id: 'lh-tables',
      label: 'List tables',
      prompt: 'List all Delta tables in the default lakehouse with their row counts',
    },
    {
      id: 'lh-profile',
      label: 'Profile data',
      prompt:
        'Profile the data in the default lakehouse — show row counts, null rates, and column types',
    },
    {
      id: 'lh-explore',
      label: 'Explore schema',
      prompt: 'Show me the schema of every Delta table in the attached lakehouse',
    },
  ],
  default: [
    {
      id: 'df-build',
      label: 'Build pipeline',
      prompt:
        'Help me build a data pipeline that reads from a lakehouse and writes to a warehouse',
    },
    {
      id: 'df-kql',
      label: 'Write KQL',
      prompt: 'Write a KQL query to show the top 10 events by count in the last hour',
    },
    {
      id: 'df-tsql',
      label: 'Write T-SQL',
      prompt: 'Write a T-SQL query to aggregate sales by region for the last 3 months',
    },
    {
      id: 'df-audit',
      label: 'Audit deployment',
      prompt: 'Run loom_self_audit and summarize the results',
    },
  ],
};

/**
 * Dynamic prompts grounded in REAL values from the live context payload —
 * attached lakehouse names, real table names from the open SQL draft, etc.
 */
export function computeDynamicPrompts(ctx: CopilotContext): SuggestedPrompt[] {
  const out: SuggestedPrompt[] = [];

  if (ctx.persona === 'notebook') {
    const srcs = (ctx.attachedSourceNames ?? []).filter(Boolean);
    const lang = ctx.defaultLang;
    if (srcs.length > 0) {
      const first = srcs[0];
      out.push({
        id: `nb-dyn-read-${first}`,
        label: `Read "${first}"`,
        prompt:
          `Write ${isSqlLang(lang) ? 'Spark SQL' : 'PySpark'} to read the default table ` +
          `from lakehouse "${first}" into a DataFrame and display the schema`,
      });
    }
    if (srcs.length >= 2) {
      out.push({
        id: `nb-dyn-join-${srcs[0]}-${srcs[1]}`,
        label: `Join "${srcs[0]}" + "${srcs[1]}"`,
        prompt:
          `Write PySpark to join data from lakehouse "${srcs[0]}" and lakehouse "${srcs[1]}" ` +
          `on their common key columns and return the top 100 rows`,
      });
    }
    if (isSqlLang(lang)) {
      out.push({
        id: 'nb-dyn-sql-agg',
        label: 'Aggregate query',
        prompt:
          'Write a Spark SQL query to aggregate the data referenced in the active cell and show the top 10 groups',
      });
    }
  }

  if (ctx.persona === 'warehouse') {
    const tables = (ctx.tableNames ?? []).filter(Boolean);
    if (tables.length > 0) {
      out.push({
        id: `wh-dyn-preview-${tables[0]}`,
        label: `Preview ${tables[0]}`,
        prompt: `SELECT TOP 10 * FROM ${tables[0]}`,
      });
    }
    if (tables.length >= 2) {
      out.push({
        id: 'wh-dyn-join',
        label: `Join ${tables[0]} + ${tables[1]}`,
        prompt:
          `Write T-SQL to join ${tables[0]} and ${tables[1]} on their common key columns ` +
          'and return the top 50 rows',
      });
    }
    if (ctx.currentSqlSnippet && ctx.currentSqlSnippet.trim()) {
      out.push({
        id: 'wh-dyn-explain-current',
        label: 'Explain current query',
        prompt: `Explain what this T-SQL query does:\n\n${ctx.currentSqlSnippet.slice(0, 200)}`,
      });
    }
  }

  if (ctx.persona === 'lakehouse' && ctx.lakehouseName) {
    out.push({
      id: `lh-dyn-tables-${ctx.lakehouseName}`,
      label: `List ${ctx.lakehouseName} tables`,
      prompt: `List all Delta tables in lakehouse "${ctx.lakehouseName}" with their row counts`,
    });
  }

  return out;
}

const MAX_CHIPS = 6;

/**
 * Merge dynamic (context-grounded) + static prompts for the persona, dedupe by
 * id, and cap at MAX_CHIPS. Dynamic prompts always come first so real symbols
 * are the most prominent.
 */
export function getPersonaPrompts(ctx: CopilotContext): SuggestedPrompt[] {
  const dynamic = computeDynamicPrompts(ctx);
  const statics = STATIC_PROMPTS[ctx.persona] ?? STATIC_PROMPTS.default;
  const dynamicIds = new Set(dynamic.map((p) => p.id));
  return [...dynamic, ...statics.filter((p) => !dynamicIds.has(p.id))].slice(0, MAX_CHIPS);
}

/**
 * Extract table / view names from a T-SQL snippet by reading FROM / JOIN
 * clauses. Handles `schema.table`, `[schema].[table]`, and bare `table`.
 * Returns up to 5 distinct names in first-seen order.
 */
export function extractSqlTableNames(sql: string): string[] {
  const seen = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+(\[?[\w]+\]?(?:\.\[?[\w]+\]?)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].replace(/[[\]]/g, '');
    const upper = name.toUpperCase();
    if (name && upper !== 'SELECT' && !upper.startsWith('(')) seen.add(name);
    if (seen.size >= 5) break;
  }
  return [...seen];
}

export interface CopilotPersonaDef {
  /** Stable id matched against the `persona` field in the orchestrate body. */
  id: string;
  name: string;
  /** Replaces the default SYSTEM_PROMPT for this persona's AOAI calls. */
  systemPrompt: string;
  /**
   * Names of tools from the main LoomToolRegistry to INCLUDE. When omitted the
   * full registry is exposed (default Copilot behaviour). Unknown names are
   * ignored. Persona-local `extraTools` are always appended.
   */
  allowedTools?: string[];
  /** Additional persona-local tools beyond the main registry. */
  extraTools?: ToolDef[];
}

export const ACTIVATOR_PERSONA_ID = 'activator';

// System prompt drives the strict two-phase "author + suggest, then confirm,
// then create" flow. The model NEVER provisions a real Azure Monitor alert
// rule speculatively — activator_create_rule is only called after the user
// approves the draft (no-vaporware: a created rule is a REAL ARM resource).
export const ACTIVATOR_COPILOT_SYSTEM_PROMPT = `You are the CSA Loom Activator Copilot — a specialist assistant for authoring Azure Monitor scheduled-query alert rules inside the CSA Loom Activator (Reflex) editor.

CSA Loom is its OWN product running on Azure. The DEFAULT Activator backend is Azure Monitor (Microsoft.Insights/scheduledQueryRules over a Log Analytics workspace) — no Microsoft Fabric workspace is ever required.

Your workflow for EVERY "alert when…" request is STRICTLY:
1. Call activator_author_rule to turn the natural-language description into a structured draft: the source Log Analytics table, an optional filter (whereClause), the metric expression (summarizeExpr, e.g. count()), the metric column name, the comparison operator, and sensible severity / evaluationFrequency / windowSize.
2. Call activator_suggest_threshold with the sourceTable, whereClause, summarizeExpr and binMinutes from step 1. It runs a REAL KQL query against the Log Analytics workspace and returns p50/p95/p99 of the historical per-window distribution. Propose threshold = the suggestedThreshold it returns (p95 by default) UNLESS the user named an explicit number.
3. Present the complete draft to the user for review: the table, the metric, the operator + threshold (and that it is the p95 of the last N days of real data), severity, evaluationFrequency, windowSize, and the notification action. Do NOT call activator_create_rule until the user explicitly approves ("create it", "yes", "confirm", "go ahead").
4. On approval: call activator_create_rule with confirm=true. It provisions a REAL scheduledQueryRule via ARM and returns the resource id + an Azure Portal deep-link. Surface both so the user can verify the rule is live. A rule that is NOT visible in Azure is a failure — never claim success without the returned ruleId.

Other rules:
- If a tool reports Monitor is not configured (e.g. LOOM_LOG_ANALYTICS_RESOURCE_ID / LOOM_LOG_ANALYTICS_WORKSPACE_ID / LOOM_ALERT_RG unset), relay that honest gate verbatim — name the exact env var to set. Never fabricate a rule.
- If the historical query returns no windows (new/empty table), say so plainly and propose a conservative starting threshold, flagging it as an estimate to tune later.
- Use activator_list_rules to check for a duplicate rule name before creating.
- Use activator_describe_history to report the real fired/resolved history of existing rules.
- Use loom_self_audit when the user asks "is Monitor configured?".`;

export const ACTIVATOR_PERSONA: CopilotPersonaDef = {
  id: ACTIVATOR_PERSONA_ID,
  name: 'Activator Copilot',
  systemPrompt: ACTIVATOR_COPILOT_SYSTEM_PROMPT,
  // Restrict to the activator-specific tools + a small set of cross-cutting
  // tools. The model doesn't need Databricks / ADLS / APIM / Power BI here.
  allowedTools: [
    'activator_author_rule',
    'activator_suggest_threshold',
    'activator_create_rule',
    'activator_list_rules',
    'activator_describe_history',
    'loom_self_audit',
  ],
};

/** Registry of all Copilot personas, keyed by id. */
export const COPILOT_PERSONAS: Record<string, CopilotPersonaDef> = {
  [ACTIVATOR_PERSONA.id]: ACTIVATOR_PERSONA,
};

/** Look up a persona by id (case-insensitive). Returns null when unknown. */
export function resolvePersona(id?: string | null): CopilotPersonaDef | null {
  if (!id) return null;
  return COPILOT_PERSONAS[String(id).trim().toLowerCase()] ?? null;
}

/**
 * CSA Loom Copilot persona registry (single-purpose authoring system prompts).
 *
 * A "persona" here is a named, single-purpose system prompt the Loom copilot
 * family uses for a focused authoring task (distinct from the general
 * cross-item orchestrator in `copilot-orchestrator.ts`). Each persona ships its
 * system prompt + a short tooling description so editors can surface a labelled
 * "copilot" action that produces a structured, reviewable result.
 *
 * The first persona — AGENT_CONFIG_COPILOT — generates example natural-language
 * → query pairs and per-field semantic descriptions for a CSA Loom data agent,
 * grounded ONLY on the REAL schema of the agent's bound Azure-native source
 * (Synapse SQL / ADX / AI Search). It never invents tables or columns; the
 * generated examples run against the live backend on the next test-chat turn.
 */

export interface PersonaDef {
  /** Stable id used in tooling / telemetry. */
  name: string;
  /** One-line description (shown in registries / build-assist). */
  description: string;
  /** The system prompt that grounds this persona's single task. */
  systemPrompt: string;
}

/**
 * Data-agent config copilot. Given a `## Source` block (type + selected tables)
 * and a `## Schema` block (REAL column names + types pulled from the live
 * backend), it emits realistic example question→query pairs in the source's
 * native query language + a 1-sentence description per field.
 */
export const AGENT_CONFIG_COPILOT: PersonaDef = {
  name: 'agent-config-copilot',
  description:
    'Generates example NL→query pairs and per-field descriptions for a CSA Loom data agent, grounded on the bound source\'s real schema.',
  systemPrompt: [
    'You are the CSA Loom data-agent config assistant. CSA Loom is its own Azure-based data + AI platform (not Microsoft Fabric).',
    'You help an author configure ONE attached data source on a data agent by proposing (a) example question → query pairs and (b) a short description for each field, grounded ONLY in the REAL schema provided.',
    '',
    'You receive a "## Source" block (the source type + selected tables) and a "## Schema" block listing the ACTUAL tables and columns (with data types) discovered from the live backend.',
    '',
    'Rules:',
    '- Generate 3 to 5 realistic example pairs. Each pair is a business question a user might ask and the EXACT query that answers it.',
    '- Write each query in the language appropriate to the source type:',
    '    warehouse → T-SQL (SELECT only).',
    '    lakehouse → Spark SQL / T-SQL-compatible SELECT (runs via Synapse serverless over the delta tables).',
    '    kql       → KQL (read-only; no "." management commands).',
    '    ai-search → a plain Azure AI Search query string (keywords / Lucene), NOT SQL.',
    '- Every query MUST be read-only (SELECT / WITH for SQL; a query expression for KQL; a search string for AI Search). NEVER emit INSERT/UPDATE/DELETE/DDL or ADX control commands.',
    '- Reference ONLY table and column names that appear verbatim in the ## Schema block. NEVER invent a table or column that is not listed.',
    '- For descriptions: write a single concise sentence per column explaining what it holds, in business terms.',
    '',
    'Output EXACTLY ONE fenced ```json code block and NOTHING else, in this shape:',
    '```json',
    '{"examples":[{"question":"...","query":"..."}],"descriptions":{"<tableName>":{"<columnName>":"<one-sentence description>"}}}',
    '```',
    'If the ## Schema block is empty or says no schema is available, return ```json {"gate":"<reason>"} ``` and nothing else — do NOT fabricate a schema.',
  ].join('\n'),
};

/** All registered personas (extend as more focused copilots land). */
export const PERSONAS: PersonaDef[] = [AGENT_CONFIG_COPILOT];

/** Look a persona up by its `name`. */
export function getPersona(name: string): PersonaDef | undefined {
  return PERSONAS.find((p) => p.name === name);
}

/**
 * Ops Admin Copilot persona (operational infra actions on the Azure-native
 * backend CSA Loom runs on). Kept under dedicated `Ops*` symbol names so it
 * coexists with the cross-item Copilot persona registry above without colliding
 * on `CopilotPersona` / `COPILOT_PERSONAS`. Consumed by the
 * /api/admin/ops-copilot BFF routes; pure data/types (no Azure calls) so it is
 * safe to import from both the route and the client pane.
 */
export interface OpsCopilotPersona {
  id: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  /** Tool names the persona may use. 'all' = the full default registry. */
  toolFilter: string[] | 'all';
  /** When set, the caller must be a member of the Entra group whose OID is in
   *  this env var. Empty/unset env → any signed-in admin (same default as the
   *  rest of the admin pane). */
  requiredGroupEnvVar?: string;
  /** Azure RBAC actions the executing UAMI needs for this persona's writes —
   *  surfaced verbatim in the honest-gate when ARM returns 403. */
  requiredArmActions?: string[];
}

export const OPS_PERSONA_ID = 'ops-admin';

export const OPS_COPILOT_PERSONAS: Record<string, OpsCopilotPersona> = {
  [OPS_PERSONA_ID]: {
    id: OPS_PERSONA_ID,
    displayName: 'Ops Admin Copilot',
    description:
      'Scale capacity, toggle the Synapse outbound-access policy, and create workspaces from natural language — each behind an approval diff and an RBAC gate.',
    systemPrompt: `You are CSA Loom Ops Admin Copilot. You help tenant admins perform operational actions on the Azure-native infrastructure CSA Loom runs on. You ONLY classify a request into exactly one ops_* tool call. You NEVER claim an action was executed — execution happens only after the admin approves the diff in the UI.

Rules:
- Always include the resource name and the target value. Do not invent current values; the tool reads those.
- Valid Synapse dedicated SQL pool SKUs look like DW100c, DW200c, DW500c, DW1000c … DW30000c. Pass the SKU exactly as the user said it (normalize "DW 200 c" → "DW200c").
- For the outbound-access policy (OAP), enable=true means "allow trusted Azure services to access the workspace"; enable=false disables it.
- For workspace creation, pass the literal name the user gave.
- If the user's request is ambiguous or names a resource that isn't configured, ask a brief clarifying question via ops_clarify instead of guessing.

CSA Loom is Azure-native. NEVER mention Microsoft Fabric or Power BI. Use the terms "Synapse dedicated SQL pool", "Azure Data Explorer cluster", "Synapse workspace outbound-access policy", and "Loom workspace".`,
    toolFilter: ['ops_scale_sql_pool', 'ops_scale_adx', 'ops_toggle_oap', 'ops_workspace_create', 'ops_clarify'],
    requiredGroupEnvVar: 'LOOM_OPS_ADMIN_ENTRA_GROUP',
    requiredArmActions: [
      'Microsoft.Synapse/workspaces/sqlPools/write',
      'Microsoft.Synapse/workspaces/write',
      'Microsoft.Kusto/clusters/write',
    ],
  },
};

/**
 * Report Copilot persona type + definition (Loom-native report builder).
 * Kept under a dedicated `ReportCopilotPersona` type so it coexists with the
 * cross-item persona registry above without colliding on `CopilotPersona`.
 * Consumed by /api/items/report/copilot; pure data/types (no Azure calls).
 */
export interface ReportCopilotPersona {
  id: string;
  displayName: string;
  systemPrompt: string;
  /** When set, only tools whose `name` is in this set are exposed to AOAI.
   *  When undefined, the full default registry is used. */
  allowedTools?: ReadonlySet<string>;
}

/**
 * Report Copilot — narrative-summary + suggest-visuals persona for the
 * Loom-native report builder. Grounds every claim on real aggregates returned
 * by `report_query_model` (Synapse Dedicated SQL pool) and proposes a visual
 * the user approves before it is written to the report. No Power BI dependency.
 */
export const REPORT_COPILOT_PERSONA: ReportCopilotPersona = {
  id: 'report-copilot',
  displayName: 'Report Copilot',
  systemPrompt: `You are CSA Loom Report Copilot — a specialist assistant embedded in the CSA Loom report builder.
You have exactly two tools:
  - report_query_model   : run a READ-ONLY SELECT against the report's bound CSA Loom tabular semantic
                           model (a Synapse Dedicated SQL pool). Use this to compute REAL aggregates that
                           ground your narrative. You may first query INFORMATION_SCHEMA.TABLES /
                           INFORMATION_SCHEMA.COLUMNS to discover the schema before aggregating.
  - report_suggest_visual: propose a single rendered visual (type + title + field + the grounding SQL)
                           that should be added to the report. The user approves before it is written.

Workflow for every request:
1. If you do not yet know the schema, call report_query_model with an INFORMATION_SCHEMA query to discover
   the available tables and columns.
2. Call report_query_model with a focused aggregate query (GROUP BY, SUM, COUNT, AVG, MIN, MAX) to get real numbers.
3. Write a concise narrative paragraph (2-4 sentences) grounded on the returned rows.
4. Call report_suggest_visual with a visual config derived from those same rows.
5. In your final answer: produce the narrative first, then one sentence describing the suggested visual.

Rules:
- Your narrative MUST cite the real aggregate values returned by report_query_model (e.g. "$4.2M total revenue
  across 1,204 orders"). NEVER invent numbers — if a query returns no rows, say so honestly.
- report_suggest_visual.visualType MUST be one of: barChart, columnChart, lineChart, pieChart, tableEx, card, areaChart.
- Never suggest a visual whose field does not appear in the query result columns.
- You are inside CSA Loom — NEVER say "in Power BI" or "in Microsoft Fabric". Name the Azure backend
  (Synapse Dedicated SQL pool) when relevant.
- Keep tool arguments as concrete strings (real SQL, real column names), never freeform JSON config.`,
  allowedTools: new Set(['report_query_model', 'report_suggest_visual']),
};


// =============================================================================
// Per-pane Copilot persona registry (additive — #1006).
//
// Coexists with the getPersona()/PERSONAS/COPILOT_PERSONAS/resolvePersona
// ecosystem above. The pane resolver is exported as getPanePersona() so it
// does NOT collide with this module's existing getPersona(name): PersonaDef.
// The orchestrator selects a pane PersonaEntry from the editor contextSlug and
// composes its system message from the injected contextPayload.
// =============================================================================

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
export function getPanePersona(slug: string | undefined | null): PersonaEntry {
  if (slug && Object.prototype.hasOwnProperty.call(PERSONA_REGISTRY, slug)) {
    return PERSONA_REGISTRY[slug as ContextSlug];
  }
  return PERSONA_REGISTRY.default;
}
