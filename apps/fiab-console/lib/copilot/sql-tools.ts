/**
 * sql-tools — Warehouse Copilot tooling shared by the assist BFF route and the
 * cross-item Copilot orchestrator. All three tools hit the REAL Synapse
 * Dedicated SQL pool over TDS (per no-vaporware.md): schema grounding reads the
 * live `sys.*` catalog, EXPLAIN runs the real `EXPLAIN WITH_RECOMMENDATIONS`
 * distributed planner, and run executes real T-SQL. No mock data, no Fabric
 * dependency (per no-fabric-dependency.md) — the backend is Azure Synapse.
 */

import type { LoomToolRegistry } from '../azure/copilot-orchestrator';
import {
  dedicatedTarget,
  executeQuery,
  explainQuery,
} from '../azure/synapse-sql-client';

/**
 * Schema-grounding query: one DMV round-trip returns the columns of every user
 * table. Shared with the assist route so both surfaces ground NL2SQL in the
 * exact same live schema.
 */
export const SYNAPSE_SCHEMA_SQL = `SELECT TOP 400
  s.name + '.' + t.name AS table_name,
  c.name                AS column_name,
  tp.name               AS type_name,
  c.max_length          AS max_length,
  c.is_nullable         AS is_nullable
FROM sys.columns c
JOIN sys.tables  t  ON t.object_id = c.object_id
JOIN sys.schemas s  ON s.schema_id = t.schema_id
JOIN sys.types   tp ON tp.user_type_id = c.user_type_id
WHERE t.is_ms_shipped = 0
ORDER BY s.name, t.name, c.column_id`;

/**
 * Read the Dedicated SQL pool schema as compact `schema.table(col type, …)`
 * lines for NL2SQL grounding. Soft-fails to '' when the pool is paused / the
 * database is empty — grounding is optional, never a blocker.
 */
export async function fetchSynapseSchemaContext(): Promise<string> {
  try {
    const res = await executeQuery(dedicatedTarget(), SYNAPSE_SCHEMA_SQL, 30_000);
    if (!res.rows.length) return '';
    const byTable = new Map<string, string[]>();
    for (const row of res.rows) {
      const [table, col, type] = row as [string, string, string];
      const cols = byTable.get(table) || [];
      cols.push(`${col} ${type}`);
      byTable.set(table, cols);
    }
    const lines = [...byTable.entries()].map(([t, cols]) => `${t}(${cols.join(', ')})`);
    const str = lines.join('\n');
    return str.length > 8000 ? `${str.slice(0, 8000)}\n…(schema truncated)` : str;
  } catch {
    return '';
  }
}

/** Data-movement operations EXPLAIN surfaces for an MPP plan (the costly ones). */
const MOVEMENT_OPS = [
  'BroadcastMoveOperation',
  'ShuffleMoveOperation',
  'TrimMoveOperation',
  'PartitionMoveOperation',
  'MoveOperation',
  'HadoopRoundRobinOperation',
];

/**
 * Summarize an `EXPLAIN WITH_RECOMMENDATIONS` distributed-plan XML into a short
 * human-readable string the AOAI optimizer can reason over: which data-movement
 * operations the plan performs, how many of each, and the total step count.
 * Pure string parsing (no XML dependency) — empty input yields ''.
 */
export function summarizeExplainXml(xml: string): string {
  if (!xml || !xml.trim()) return '';
  const opCounts: Record<string, number> = {};
  for (const m of xml.matchAll(/<operation_type>([^<]+)<\/operation_type>/g)) {
    const op = m[1].trim();
    opCounts[op] = (opCounts[op] || 0) + 1;
  }
  const totalSteps = Object.values(opCounts).reduce((a, b) => a + b, 0);
  const movement = MOVEMENT_OPS.filter((op) => opCounts[op]).map(
    (op) => `${opCounts[op]}x ${op}`,
  );
  // Surface the cost estimate the planner emits, when present.
  const costMatch = xml.match(/<cost[^>]*>([^<]+)<\/cost>/);
  const rowsMatch = xml.match(/<dsql_operations[^>]*total_cost="([^"]+)"/);
  const parts: string[] = [];
  if (movement.length) {
    parts.push(`Data movement: ${movement.join(', ')}.`);
  } else if (totalSteps) {
    parts.push('No broadcast/shuffle data-movement steps detected.');
  }
  if (totalSteps) parts.push(`Total plan operations: ${totalSteps}.`);
  if (costMatch) parts.push(`Planner cost: ${costMatch[1].trim()}.`);
  if (rowsMatch) parts.push(`Estimated total cost: ${rowsMatch[1].trim()}.`);
  return parts.join(' ').trim();
}

/**
 * Register the Warehouse Copilot tools into a LoomToolRegistry so the cross-item
 * Copilot agent can read the warehouse schema, run EXPLAIN, and execute T-SQL
 * against the real Synapse Dedicated SQL pool. Idempotent (register overwrites
 * by name).
 */
export function registerWarehouseTools(registry: LoomToolRegistry): void {
  registry.register({
    name: 'warehouse_schema_read',
    service: 'Warehouse',
    description:
      'Read the Synapse Dedicated SQL pool schema (every user table and its columns) for NL2SQL grounding. Returns compact schema.table(col type, …) lines, or empty when the pool is paused.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ schema: await fetchSynapseSchemaContext() }),
  });
  registry.register({
    name: 'warehouse_explain_plan',
    service: 'Warehouse',
    description:
      'Run EXPLAIN WITH_RECOMMENDATIONS on a T-SQL query against the Synapse Dedicated SQL pool. Returns the distributed-query-plan XML (compiled, not executed) plus a human-readable summary of its data-movement steps. Use this before suggesting query optimizations.',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
    handler: async ({ sql }: { sql: string }) => {
      const xml = await explainQuery(dedicatedTarget(), String(sql), true);
      return { xml: xml.slice(0, 8000), summary: summarizeExplainXml(xml) };
    },
  });
  registry.register({
    name: 'warehouse_run_query',
    service: 'Warehouse',
    description:
      'Execute a T-SQL statement on the Synapse Dedicated SQL pool and return real rows (capped at 100 for Copilot use). The pool must be Online.',
    parameters: {
      type: 'object',
      properties: { sql: { type: 'string' } },
      required: ['sql'],
      additionalProperties: false,
    },
    handler: async ({ sql }: { sql: string }) => {
      const r = await executeQuery(dedicatedTarget(), String(sql), 30_000);
      return {
        columns: r.columns,
        rows: r.rows.slice(0, 100),
        rowCount: r.rowCount,
        executionMs: r.executionMs,
      };
    },
  });
}
