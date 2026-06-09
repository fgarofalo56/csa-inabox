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
 */

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
