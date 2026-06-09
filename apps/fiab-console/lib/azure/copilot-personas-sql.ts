/**
 * copilot-personas-sql.ts — Warehouse SQL Copilot persona (PR #1010).
 *
 * Split out of copilot-personas.ts during integration to avoid an export
 * name-collision (CopilotPersona / COPILOT_PERSONAS / getPersona) with the
 * suggested-prompt persona module already on main. Runs on the Azure-native
 * AOAI deployment (per no-fabric-dependency.md) — no Fabric Copilot dep.
 */

export type CopilotMode = 'generate' | 'explain' | 'fix' | 'optimize';

export interface QuickAction {
  /** Short menu label. */
  label: string;
  /** Natural-language prompt sent to the `generate` mode verbatim. */
  prompt: string;
}

export interface CopilotPersona {
  /** Stable id (matches the assist-route engine where 1:1). */
  id: string;
  /** Human name shown in the UI. */
  name: string;
  /** Dialect label used in UI copy and the system prompt (e.g. 'T-SQL'). */
  dialect: string;
  /** Modes this persona exposes in its editor. */
  supportedModes: ReadonlyArray<CopilotMode>;
  /** One-click NL intents surfaced in the Quick actions menu. */
  quickActions: ReadonlyArray<QuickAction>;
  /** Extra system-prompt guidance appended for this backend. */
  systemPromptAddendum: string;
}

/**
 * Warehouse Copilot — Synapse Dedicated SQL pool (MPP / columnar). Supports the
 * full mode set including `optimize`, which grounds in a real EXPLAIN
 * WITH_RECOMMENDATIONS distributed plan.
 */
export const WAREHOUSE_PERSONA: CopilotPersona = {
  id: 'warehouse',
  name: 'Warehouse Copilot',
  dialect: 'T-SQL',
  supportedModes: ['generate', 'explain', 'fix', 'optimize'],
  quickActions: [
    {
      label: 'Top 10 customers by revenue',
      prompt: 'Show the top 10 customers by total revenue, highest first.',
    },
    {
      label: 'Monthly sales trend',
      prompt:
        'Show monthly sales totals for the last 12 months as a time series, ordered by month.',
    },
    {
      label: 'Slow-moving inventory',
      prompt:
        'List products with no orders in the last 90 days, including the current stock count.',
    },
    {
      label: 'Row counts — all tables',
      prompt:
        'Return the row count for every user table in the database, sorted descending by row count.',
    },
    {
      label: 'Distribution skew check',
      prompt:
        'Check hash-distribution skew: show the number of rows per distribution for each user table, highlighting any uneven distributions.',
    },
    {
      label: 'Columnstore health',
      prompt:
        'Show clustered columnstore index health per table: compressed row groups versus open delta-store rows.',
    },
    {
      label: 'Long-running queries',
      prompt:
        'Show the 20 longest-running queries from sys.dm_pdw_exec_requests, most recent first.',
    },
    {
      label: 'Data-movement queries',
      prompt:
        'Show recent queries whose plans triggered ShuffleMoveOperation or BroadcastMoveOperation data-movement steps.',
    },
  ],
  systemPromptAddendum: [
    'This is a Synapse Dedicated SQL pool (massively-parallel / columnstore).',
    'Prefer joins aligned on HASH distribution columns to avoid data movement;',
    'use CTAS for large materializations; avoid SELECT *; add OPTION (LABEL = ...)',
    'for DMV tracing. EXPLAIN WITH_RECOMMENDATIONS reveals BroadcastMoveOperation',
    'and ShuffleMoveOperation steps — minimize them by aligning join keys with',
    'the distribution column.',
  ].join(' '),
};

/** Registry of all Copilot personas, keyed by id. */
export const COPILOT_PERSONAS: Record<string, CopilotPersona> = {
  [WAREHOUSE_PERSONA.id]: WAREHOUSE_PERSONA,
};

/** Lookup a persona by id (or undefined if none registered). */
export function getPersona(id: string): CopilotPersona | undefined {
  return COPILOT_PERSONAS[id];
}
