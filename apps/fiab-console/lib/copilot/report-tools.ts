/**
 * Report Copilot tools.
 *
 * Two real, Azure-native ToolDefs wired to the CSA Loom tabular semantic layer
 * (Synapse Dedicated SQL pool). No Power BI / Microsoft Fabric dependency
 * (no-fabric-dependency.md):
 *
 *   - report_query_model   — run a read-only SELECT against the bound model to
 *                            compute REAL aggregates that ground the narrative.
 *   - report_suggest_visual — validate + return a single structured visual
 *                            suggestion the UI surfaces for the user to approve.
 *
 * The narrative is produced by the orchestrator (AOAI) using the rows
 * report_query_model returns; the approved visual is written to the report
 * item's `state.content.pages[].visuals[]` by the apply-visual BFF route, where
 * the Loom-native report viewer renders it (no live PBI required).
 */

import type { ToolDef } from '@/lib/azure/copilot-orchestrator';
import { executeQuery, dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

const S_STRING = { type: 'string' } as const;

function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

// Read-only guard: only SELECT / WITH (CTE) statements; reject any write/DDL keyword.
const SQL_WRITE = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|sp_|xp_)\b/i;

export function assertReadonly(sql: string): void {
  const t = String(sql || '').trim();
  if (!/^(select|with)\b/i.test(t)) {
    throw new Error('report_query_model only runs read-only SELECT / WITH queries.');
  }
  if (SQL_WRITE.test(t)) {
    throw new Error('report_query_model rejected a write/DDL keyword — read-only queries only.');
  }
}

/** Cap an un-bounded SELECT to TOP n rows so a narrative query can't pull a huge table. */
export function capSql(sql: string, n = 500): string {
  const t = String(sql || '').trim().replace(/;+\s*$/, '');
  // Leave queries that already constrain their row count alone.
  if (/\b(top|offset|fetch|count|sum|avg|min|max|group\s+by)\b/i.test(t)) return t;
  return t.replace(/^(select)\b/i, `SELECT TOP ${n}`);
}

/** Visual types the Loom-native report renderer (and the powerbi-client visual API) support. */
export const VALID_REPORT_VIZ_TYPES = new Set([
  'barChart', 'columnChart', 'lineChart', 'pieChart', 'tableEx', 'card', 'areaChart',
]);

export interface ReportVisualSuggestion {
  visualType: string; // one of VALID_REPORT_VIZ_TYPES
  title: string;
  field: string; // primary measure/column from the query result
  sql: string; // the grounding query
  position: { x: number; y: number; width: number; height: number };
}

/**
 * Build the two report-copilot tools.
 *
 * `boundItem` is the Loom Cosmos item for the report being edited. It is used to
 * enrich the tool description with the report name (grounding context); the
 * handlers query the Synapse Dedicated SQL pool directly so the tools work even
 * when the report is brand-new (empty `state.content`).
 */
export function buildReportTools(boundItem: WorkspaceItem | null): ToolDef[] {
  const reportName = boundItem?.displayName ? ` (report: "${boundItem.displayName}")` : '';

  const queryTool: ToolDef = {
    name: 'report_query_model',
    service: 'Report',
    description:
      'Run a READ-ONLY SELECT against the CSA Loom tabular semantic model (Synapse Dedicated SQL pool) ' +
      `that backs this report${reportName}. Returns real aggregate rows to ground the narrative. ` +
      'Prefer GROUP BY / SUM / COUNT / AVG. You may query INFORMATION_SCHEMA.TABLES / ' +
      'INFORMATION_SCHEMA.COLUMNS first to discover the schema. Results are capped at 500 rows.',
    parameters: obj(
      {
        sql: {
          ...S_STRING,
          description:
            'A read-only T-SQL SELECT (or WITH/CTE) statement. GROUP BY aggregates preferred. Max 500 rows returned.',
        },
      },
      ['sql'],
    ),
    handler: async ({ sql }) => {
      assertReadonly(String(sql));
      const capped = capSql(String(sql));
      const res = await executeQuery(dedicatedTarget(), capped);
      return {
        columns: res.columns,
        rows: res.rows,
        rowCount: res.rowCount,
        truncated: res.truncated,
      };
    },
  };

  const suggestTool: ToolDef = {
    name: 'report_suggest_visual',
    service: 'Report',
    description:
      'Propose a single visual to add to the report. Returns a structured visual config the user can ' +
      'approve. Only call after report_query_model has returned real rows; the field MUST be one of the ' +
      'columns from that result.',
    parameters: obj(
      {
        visualType: {
          ...S_STRING,
          enum: [...VALID_REPORT_VIZ_TYPES],
          description: 'The visual type (one of the allowed CSA Loom report visual types).',
        },
        title: { ...S_STRING, description: 'Human-readable title for the visual (shown in the report).' },
        field: { ...S_STRING, description: 'Primary measure or column name from the query result.' },
        sql: { ...S_STRING, description: 'The grounding SELECT that drives this visual.' },
        x: { type: 'number', description: 'Left offset in report canvas units (optional).' },
        y: { type: 'number', description: 'Top offset in report canvas units (optional).' },
        width: { type: 'number', description: 'Width (optional, default 400).' },
        height: { type: 'number', description: 'Height (optional, default 280).' },
      },
      ['visualType', 'title', 'field', 'sql'],
    ),
    handler: async ({ visualType, title, field, sql, x, y, width, height }) => {
      const vt = String(visualType);
      if (!VALID_REPORT_VIZ_TYPES.has(vt)) {
        throw new Error(
          `Invalid visualType "${vt}". Allowed: ${[...VALID_REPORT_VIZ_TYPES].join(', ')}.`,
        );
      }
      const ttl = String(title || '').trim();
      const fld = String(field || '').trim();
      const grounding = String(sql || '').trim();
      if (!ttl) throw new Error('report_suggest_visual requires a non-empty title.');
      if (!fld) throw new Error('report_suggest_visual requires a non-empty field.');
      if (!grounding) throw new Error('report_suggest_visual requires the grounding sql.');
      const suggestion: ReportVisualSuggestion = {
        visualType: vt,
        title: ttl,
        field: fld,
        sql: grounding,
        position: {
          x: Number.isFinite(Number(x)) ? Number(x) : 0,
          y: Number.isFinite(Number(y)) ? Number(y) : 0,
          width: Number(width) > 0 ? Number(width) : 400,
          height: Number(height) > 0 ? Number(height) : 280,
        },
      };
      return { ok: true, suggestion };
    },
  };

  return [queryTool, suggestTool];
}

/**
 * Normalize an arbitrary suggestion payload (e.g. from the apply-visual BFF
 * body) into a valid ReportVisualSuggestion, throwing on anything invalid. Used
 * by the apply route so a malformed client body never writes garbage into the
 * report content.
 */
export function coerceVisualSuggestion(raw: unknown): ReportVisualSuggestion {
  const s = (raw || {}) as Record<string, unknown>;
  const vt = String(s.visualType || '');
  if (!VALID_REPORT_VIZ_TYPES.has(vt)) {
    throw new Error(`Invalid visualType "${vt}". Allowed: ${[...VALID_REPORT_VIZ_TYPES].join(', ')}.`);
  }
  const title = String(s.title || '').trim();
  const field = String(s.field || '').trim();
  const sql = String(s.sql || '').trim();
  if (!title) throw new Error('visual.title is required.');
  if (!field) throw new Error('visual.field is required.');
  const pos = (s.position || {}) as Record<string, unknown>;
  return {
    visualType: vt,
    title,
    field,
    sql,
    position: {
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      width: Number(pos.width) > 0 ? Number(pos.width) : 400,
      height: Number(pos.height) > 0 ? Number(pos.height) : 280,
    },
  };
}
