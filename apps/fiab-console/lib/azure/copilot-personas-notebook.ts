/**
 * copilot-personas-notebook.ts — declarative persona shape for the item-scoped
 * CSA Loom Notebook Copilot pane.
 *
 * A persona bundles three things:
 *   1. a system-prompt factory (built from REAL call-time context — attached
 *      lakehouse schema, notebook structure, last-run Spark telemetry),
 *   2. a fixed slash-command allowlist (no free-form config per
 *      loom-no-freeform-config.md — the chat input only ever offers these),
 *   3. the names of the server-side tools the persona may call (implemented in
 *      lib/copilot/notebook-tools.ts).
 *
 * The Notebook persona is the Loom parity surface for the Fabric Notebook
 * Copilot sidebar — but Azure-native: schema + table profiling read straight
 * from the ADLS Gen2 Delta transaction log (delta-schema.ts /
 * synapse-catalog-client.ts) and Spark telemetry from the Synapse Livy API
 * (synapse-livy-client.ts). NO Fabric / OneLake / Power BI dependency on any
 * code path (per no-fabric-dependency.md): everything works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 *
 * Lives in its own module (separate from copilot-personas.ts) so its
 * CopilotPersona / PERSONAS / getPersona symbols don't collide with the chips
 * + activator + agent-config persona registries in copilot-personas.ts.
 *
 * Pure module — no Azure I/O, no React. Safe to import from a BFF route (the
 * notebook-assist streaming handler builds its system prompt from
 * NOTEBOOK_PERSONA.systemPrompt) and from a unit test.
 */
export type PersonaId = 'notebook';

/** Real, call-time context the system-prompt factory substitutes in. */
export interface PersonaSystemCtx {
  /** Notebook display name. */
  notebookName: string;
  /** Number of cells currently open in the editor. */
  cellCount: number;
  /** Default cell language (pyspark | spark | sparksql | …). */
  defaultLang: string;
  /** Compact, multi-line list of attached sources (lakehouse/warehouse/kql). */
  attachedSources: string;
  /** buildDatastoreSchema() output — real Delta column names + types ('' when none). */
  schema: string;
  /** Last-run Spark telemetry (Livy session receipt + last cell output text). */
  lastRunTelemetry?: string;
  /** Sovereign boundary from detectLoomCloud(): Commercial | GCC | GCC-High | DoD. */
  cloud: string;
  /**
   * Cluster runtime grounding sentence (from assistRuntimeDirective) so the
   * persona generates / fixes code with the correct cluster's APIs. '' when the
   * caller has no runtime to declare (back-compat → Synapse Spark default).
   */
  runtimeDirective?: string;
}

export interface SlashCommand {
  cmd: string;
  label: string;
  help: string;
  /** When true the active cell's last error output is auto-attached to the turn. */
  passesError?: boolean;
}

export interface CopilotPersona {
  id: PersonaId;
  /** Header label in the chat pane. */
  label: string;
  /** System-prompt factory — receives REAL context at call time. */
  systemPrompt: (ctx: PersonaSystemCtx) => string;
  /** Fixed slash-command allowlist (no free-form config). */
  slashCommands: readonly SlashCommand[];
  /** Names of the tools (from notebook-tools.ts) this persona may invoke. */
  tools: readonly string[];
}

const LANG_LABEL: Record<string, string> = {
  pyspark: 'PySpark (Python)',
  spark: 'Spark (Scala)',
  sparksql: 'Spark SQL',
  sparkr: 'SparkR (R)',
  python: 'Python',
  tsql: 'T-SQL',
};

// ---- Notebook persona slash commands (fixed allowlist) ----
export const NOTEBOOK_SLASH_COMMANDS: readonly SlashCommand[] = [
  { cmd: '/fix', label: '/fix', help: 'Fix the error in the current cell', passesError: true },
  { cmd: '/explain', label: '/explain', help: 'Explain what the current cell does' },
  { cmd: '/comments', label: '/comments', help: 'Add inline comments to the current cell' },
  { cmd: '/optimize', label: '/optimize', help: 'Rewrite the current cell for Spark performance' },
  { cmd: '/summarize', label: '/summarize', help: 'Summarize this notebook — every cell, inputs & outputs' },
  { cmd: '/generate', label: '/generate', help: '/generate <description> — runnable PySpark using the real schema' },
  { cmd: '/refactor', label: '/refactor', help: 'Refactor across cells — split, merge, extract patterns' },
  { cmd: '/profile', label: '/profile', help: '/profile <table> — real table stats from the attached lakehouse' },
  { cmd: '/perf', label: '/perf', help: 'Analyse last-run telemetry and suggest Spark tuning' },
];

/** The tool names implemented in lib/copilot/notebook-tools.ts. */
export const NOTEBOOK_TOOL_NAMES: readonly string[] = [
  'notebook_summarize',
  'notebook_generate_code',
  'notebook_profile_table',
  'notebook_perf_insights',
  'notebook_refactor_cells',
];

/**
 * Notebook persona system prompt. References real symbols supplied by the
 * caller: `attachedSources` from NotebookEditor, `schema` from
 * buildDatastoreSchema(), `lastRunTelemetry` from the Livy session receipt.
 * Never asks the model to invent table/column/workspace names.
 */
export function notebookSystemPrompt(ctx: PersonaSystemCtx): string {
  const langName = LANG_LABEL[ctx.defaultLang] || ctx.defaultLang;
  const sourceSection = ctx.attachedSources.trim()
    ? `\n\nAttached data sources:\n${ctx.attachedSources.trim()}`
    : '';
  const schemaSection = ctx.schema.trim()
    ? `\n\nLakehouse schema (REAL — ground every table & column reference here; never invent names):\n${ctx.schema.trim()}`
    : '';
  const telemetrySection = ctx.lastRunTelemetry?.trim()
    ? `\n\nLast-run Spark telemetry (use this for /perf analysis):\n${ctx.lastRunTelemetry.trim()}`
    : '';
  const govNote =
    ctx.cloud === 'GCC-High' || ctx.cloud === 'DoD'
      ? '\n\nIMPORTANT: This deployment runs in a US Government boundary (GCC-High / IL5 / DoD). ' +
        'Do not reference commercial-only Azure endpoints; the AOAI endpoint is *.openai.azure.us ' +
        'and Synapse is *.dev.azuresynapse.us.'
      : '';

  const runtimeSection = ctx.runtimeDirective?.trim() ? `\n\n${ctx.runtimeDirective.trim()}` : '';

  return (
    `You are the CSA Loom Notebook Copilot — a context-aware AI assistant docked beside the notebook ` +
    `"${ctx.notebookName}" (${ctx.cellCount} cell${ctx.cellCount === 1 ? '' : 's'}, default language: ${langName}). ` +
    `You are the Azure-native parity surface for the Fabric Notebook Copilot — there is no Fabric or ` +
    `OneLake dependency. Schema reads and table profiling come straight from the ADLS Gen2 Delta ` +
    `transaction log, so NO interactive Spark session is required for those.` +
    runtimeSection +
    `\n\nCapabilities:` +
    `\n  /summarize  — describe every cell in the notebook, referencing the user's ACTUAL variable & column names.` +
    `\n  /generate   — produce runnable ${langName} that loads and joins real tables BY NAME from the schema below.` +
    `\n  /refactor   — refactor across multiple cells; emit one fenced code block per output cell, in notebook order.` +
    `\n  /profile    — report real table stats (size in bytes, file/commit version, last-modified, row count when available).` +
    `\n  /perf       — interpret the last-run Livy telemetry and recommend executor sizing, caching, broadcast joins, partition pruning, and skew fixes.` +
    `\n  /fix /explain /comments /optimize — single-cell helpers on the current cell.` +
    `\n\nFor any multi-cell answer, emit ONE fenced code block per cell in notebook order. The user must ` +
    `explicitly click "Apply N cells" to write them back into the notebook (an approval-diff step) — ` +
    `never claim the cells were applied.` +
    `\n\nNever invent table names, column names, file paths, or workspace IDs. If the schema below is ` +
    `empty, say so and ask the user to attach a lakehouse rather than guessing.` +
    sourceSection +
    schemaSection +
    telemetrySection +
    govNote
  );
}

export const NOTEBOOK_PERSONA: CopilotPersona = {
  id: 'notebook',
  label: 'Notebook',
  systemPrompt: notebookSystemPrompt,
  slashCommands: NOTEBOOK_SLASH_COMMANDS,
  tools: NOTEBOOK_TOOL_NAMES,
};

export const PERSONAS: Record<PersonaId, CopilotPersona> = {
  notebook: NOTEBOOK_PERSONA,
};

export function getPersona(id: PersonaId): CopilotPersona {
  return PERSONAS[id] || NOTEBOOK_PERSONA;
}
