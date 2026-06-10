/**
 * copilot-personas-kql.ts — KQL/ADX Copilot persona definitions (PR #1009).
 *
 * Split out of copilot-personas.ts during integration to avoid an export
 * name-collision with the suggested-prompt persona module (both files defined
 * CopilotPersona / COPILOT_PERSONAS / getPersona with different shapes).
 */

// ============================================================
// CopilotPersona — typed Copilot persona definitions.
//
// A "persona" bundles the per-mode system prompts, the set of tool
// names the persona may invoke, the AOAI sampling temperature, and a
// display name. Personas are pure data — NO Azure SDK imports — so they
// are unit-testable without credentials and reusable across surfaces.
//
// Consumed by:
//   - lib/copilot/kql-tools.ts         (KQL_COPILOT_PERSONA.allowedTools)
//   - app/api/items/kql-database/[id]/assist  (system-prompt source)
//   - app/api/items/kql-queryset/[id]/assist  (system-prompt source)
//
// Azure-native by default (per no-fabric-dependency.md): the KQL persona
// targets Azure Data Explorer + Azure OpenAI. No Fabric / Power BI host
// is ever referenced.
// ============================================================

export interface CopilotPersona {
  /** Unique machine ID (e.g. 'kql-copilot'). */
  id: string;
  displayName: string;
  description: string;
  /**
   * AOAI system prompt for NL2KQL / generate mode. May contain the
   * placeholder `{{schema}}`, which the assist routes replace with the
   * live ADX schema string via `injectSchema`.
   */
  generateSystemPrompt: string;
  /** AOAI system prompt for the explain mode (markdown output). */
  explainSystemPrompt: string;
  /** AOAI system prompt for the fix mode (corrected KQL output). */
  fixSystemPrompt: string;
  /** AOAI sampling temperature (0–1). */
  temperature: number;
  /**
   * Allowlist of tool names this persona may invoke in the orchestration
   * loop. Empty array = no tool restriction (all registry tools allowed).
   */
  allowedTools: string[];
}

/** The `{{schema}}` placeholder personas use for live-schema injection. */
export const SCHEMA_PLACEHOLDER = '{{schema}}';

export const KQL_COPILOT_PERSONA: CopilotPersona = {
  id: 'kql-copilot',
  displayName: 'KQL Copilot',
  description:
    'NL2KQL assistant for Azure Data Explorer. Grounds generated queries in the ' +
    'real ADX table/column schema (kql_get_schema) before generating any KQL, ' +
    'runs them against the live cluster (kql_execute), and explains existing ' +
    'queries in Markdown. Azure-native — no Microsoft Fabric dependency.',
  generateSystemPrompt:
    `You are a KQL (Kusto Query Language) query generator for the CSA Loom platform ` +
    `(Azure Data Explorer). Given a natural-language description and the live ADX ` +
    `database schema, write idiomatic, runnable KQL for a SINGLE query. ` +
    `Rules: (1) Reference ONLY tables and columns that appear in the schema below. ` +
    `(2) Return ONLY the KQL — no markdown fences, no commentary, no leading language tag. ` +
    `(3) For time-bucketing requests prefer the summarize operator with ` +
    `bin(TimeColumn, <interval>) over a real datetime column from the schema.` +
    `\n\nDatabase schema (ground all KQL in these real names):\n${SCHEMA_PLACEHOLDER}`,
  explainSystemPrompt:
    `You are a KQL query assistant for the CSA Loom platform (Azure Data Explorer). ` +
    `Explain what the following KQL query does. Format your answer as Markdown: a ` +
    `one-sentence summary, then bullet points covering the table(s) accessed, the ` +
    `filters / aggregations applied, the time range, and the expected output shape. ` +
    `Reference the actual table and column names from the query. Do not restate the ` +
    `query verbatim.`,
  fixSystemPrompt:
    `You are a KQL debugger for the CSA Loom platform (Azure Data Explorer). Fix the ` +
    `KQL query that produced the error shown. Return ONLY the corrected, runnable KQL ` +
    `— no markdown fences, no explanation, no leading language tag.` +
    `\n\nDatabase schema:\n${SCHEMA_PLACEHOLDER}`,
  temperature: 0.2,
  allowedTools: [
    'kql_list_databases',
    'kql_list_tables',
    'kql_get_schema',
    'kql_execute',
  ],
};

/**
 * The default cross-item Copilot persona (general assistant, all tools).
 * Empty `allowedTools` = unrestricted; the system prompts come from
 * copilot-orchestrator's SYSTEM_PROMPT rather than this persona.
 */
export const LOOM_COPILOT_PERSONA: CopilotPersona = {
  id: 'loom-copilot',
  displayName: 'CSA Loom Copilot',
  description: 'General-purpose assistant for all Loom Azure services.',
  generateSystemPrompt: '',
  explainSystemPrompt: '',
  fixSystemPrompt: '',
  temperature: 0.2,
  allowedTools: [],
};

/** All built-in personas keyed by id. */
export const COPILOT_PERSONAS: Record<string, CopilotPersona> = {
  [KQL_COPILOT_PERSONA.id]: KQL_COPILOT_PERSONA,
  [LOOM_COPILOT_PERSONA.id]: LOOM_COPILOT_PERSONA,
};

/** Look up a persona by id; returns undefined when unknown. */
export function getPersona(id: string): CopilotPersona | undefined {
  return COPILOT_PERSONAS[id];
}

/**
 * Replace the `{{schema}}` placeholder in a persona system prompt with the
 * real schema string. When the schema is empty (cluster cold / database not
 * granted) the whole "Database schema …" section is removed so the model is
 * not handed a dangling, empty grounding block. Prompts that do not contain
 * the placeholder are returned unchanged.
 */
export function injectSchema(template: string, schema: string): string {
  const idx = template.indexOf(SCHEMA_PLACEHOLDER);
  if (idx < 0) return template;
  if (schema.trim()) return template.replace(SCHEMA_PLACEHOLDER, schema);
  // Strip the blank-line-separated "Database schema:" preamble immediately
  // preceding the placeholder (plus any trailing newlines) so the model is
  // not handed a dangling, empty grounding block.
  const before = template.slice(0, idx).replace(/\n+[^\n]*\n*$/, '');
  const after = template.slice(idx + SCHEMA_PLACEHOLDER.length);
  return `${before}${after}`.trimEnd();
}
