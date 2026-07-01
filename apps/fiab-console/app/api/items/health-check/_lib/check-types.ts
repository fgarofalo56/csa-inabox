/**
 * Health-check check-type library (Palantir Foundry Health Checks parity).
 *
 * A pure, serializable catalog of data-quality / SLA check types across five
 * families (Time / Size / Content / Schema / Status), each with a typed field
 * set + a deterministic KQL template that compiles to a REAL Azure Monitor
 * scheduled-query condition ("fires when it returns rows"). Consumed by:
 *   • the health-check editor gallery + typed wizard (client), and
 *   • POST /rule + POST /rule/preview (server) — one source of truth so the
 *     KQL preview matches exactly what the created scheduledQueryRule evaluates.
 *
 * No functions leak over the wire: the client renders `CHECK_TYPE_LIBRARY`
 * (data only) and both sides call `buildCheckQuery(id, params)` locally. Pure —
 * no server imports, safe to import from a client component.
 */

export type CheckFamily = 'time' | 'size' | 'content' | 'schema' | 'status';

export type CheckFieldKind =
  | 'table' | 'column' | 'number' | 'operator' | 'aggregation' | 'text' | 'valuelist' | 'kql' | 'minutes';

export interface CheckField {
  id: string;
  label: string;
  kind: CheckFieldKind;
  hint?: string;
  placeholder?: string;
  default?: string;
  required?: boolean;
}

export interface CheckTypeDef {
  id: string;
  family: CheckFamily;
  label: string;
  /** One-line description shown on the gallery tile. */
  description: string;
  /** Fluent icon name (mapped to a component in the client). */
  icon: string;
  fields: CheckField[];
}

/** Comparison operators offered by threshold fields (KQL symbol per op). */
export const COMPARISON_OPERATORS: Array<{ id: string; label: string; symbol: string }> = [
  { id: 'gt', label: 'greater than', symbol: '>' },
  { id: 'gte', label: 'greater than or equal', symbol: '>=' },
  { id: 'lt', label: 'less than', symbol: '<' },
  { id: 'lte', label: 'less than or equal', symbol: '<=' },
  { id: 'eq', label: 'equal to', symbol: '==' },
  { id: 'ne', label: 'not equal to', symbol: '!=' },
];

export const AGGREGATIONS: Array<{ id: string; label: string }> = [
  { id: 'sum', label: 'sum' },
  { id: 'avg', label: 'average' },
  { id: 'min', label: 'minimum' },
  { id: 'max', label: 'maximum' },
];

export const CHECK_FAMILY_META: Record<CheckFamily, { label: string; description: string; icon: string }> = {
  time: { label: 'Time & freshness', description: 'Data recency, latency and clock-skew checks.', icon: 'Clock' },
  size: { label: 'Size & volume', description: 'Row-count, cardinality and volume-drift checks.', icon: 'DataHistogram' },
  content: { label: 'Content & values', description: 'Nulls, duplicates, ranges and allowed-value checks.', icon: 'TextGrammarCheckmark' },
  schema: { label: 'Schema', description: 'Column presence, type and column-count drift.', icon: 'TableSettings' },
  status: { label: 'Status & custom', description: 'Liveness heartbeats and custom KQL conditions.', icon: 'Pulse' },
};

// ───────────────────────── field helpers ─────────────────────────
const F = {
  table: (): CheckField => ({ id: 'table', label: 'Table (Log Analytics)', kind: 'table', placeholder: 'AppEvents', required: true }),
  column: (label = 'Column'): CheckField => ({ id: 'column', label, kind: 'column', placeholder: 'Status', required: true }),
  operator: (id = 'operator', label = 'Fires when count is', def = 'gt'): CheckField => ({ id, label, kind: 'operator', default: def }),
  number: (id: string, label: string, def: string, hint?: string): CheckField => ({ id, label, kind: 'number', default: def, hint }),
  minutes: (id: string, label: string, def: string): CheckField => ({ id, label, kind: 'minutes', default: def }),
  text: (id: string, label: string, placeholder?: string, hint?: string): CheckField => ({ id, label, kind: 'text', placeholder, hint }),
};

// ───────────────────────── the library (21 types across 5 families) ─────────────────────────
export const CHECK_TYPE_LIBRARY: CheckTypeDef[] = [
  // ── Time & freshness ──
  {
    id: 'freshness', family: 'time', label: 'Data freshness', icon: 'ClockAlarm',
    description: 'Fires when no rows have arrived within the last N minutes.',
    fields: [F.table(), F.minutes('thresholdMinutes', 'Stale after (minutes)', '60')],
  },
  {
    id: 'max-age', family: 'time', label: 'Maximum age', icon: 'History',
    description: 'Fires when the newest row is older than the threshold.',
    fields: [F.table(), F.operator('operator', 'Fires when age (minutes) is', 'gt'), F.minutes('thresholdMinutes', 'Age threshold (minutes)', '120')],
  },
  {
    id: 'future-timestamp', family: 'time', label: 'Future timestamps', icon: 'CalendarError',
    description: 'Fires when rows are dated in the future (clock skew / bad ingestion).',
    fields: [F.table(), F.operator('operator', 'Fires when future-dated rows are', 'gt'), F.number('threshold', 'Row threshold', '0')],
  },

  // ── Size & volume ──
  {
    id: 'rowcount', family: 'size', label: 'Minimum row count', icon: 'NumberSymbol',
    description: 'Fires when the table produced fewer than N rows in the window.',
    fields: [F.table(), F.number('minRows', 'Minimum rows', '1')],
  },
  {
    id: 'rowcount-max', family: 'size', label: 'Maximum row count', icon: 'ArrowTrendingLines',
    description: 'Fires when row volume spikes above a ceiling in the window.',
    fields: [F.table(), F.number('maxRows', 'Maximum rows', '100000')],
  },
  {
    id: 'rowcount-compare', family: 'size', label: 'Row count threshold', icon: 'DataBarVertical',
    description: 'Fires when the row count meets an operator/threshold you choose.',
    fields: [F.table(), F.operator('operator', 'Fires when row count is', 'lt'), F.number('threshold', 'Threshold', '1')],
  },
  {
    id: 'distinct-count', family: 'size', label: 'Distinct value count', icon: 'Fingerprint',
    description: 'Fires when the number of distinct values of a column crosses a threshold.',
    fields: [F.table(), F.column('Column'), F.operator('operator', 'Fires when distinct count is', 'lt'), F.number('threshold', 'Threshold', '1')],
  },
  {
    id: 'volume-drop', family: 'size', label: 'Volume drop', icon: 'ArrowTrendingDown',
    description: 'Fires when this window’s volume drops vs the prior window by more than X%.',
    fields: [F.table(), F.minutes('windowMinutes', 'Window (minutes)', '60'), F.operator('operator', 'Fires when drop % is', 'gt'), F.number('threshold', 'Drop percent', '50')],
  },

  // ── Content & values ──
  {
    id: 'null-values', family: 'content', label: 'Null / empty values', icon: 'Prohibited',
    description: 'Fires when a column has null / empty values above a threshold.',
    fields: [F.table(), F.column('Column'), F.operator('operator', 'Fires when null count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'blank-values', family: 'content', label: 'Blank string values', icon: 'TextClearFormatting',
    description: 'Fires when a column has empty-string values above a threshold.',
    fields: [F.table(), F.column('Column'), F.operator('operator', 'Fires when blank count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'duplicate-values', family: 'content', label: 'Duplicate values', icon: 'DocumentCopy',
    description: 'Fires when a key column has duplicate groups above a threshold.',
    fields: [F.table(), F.column('Key column'), F.operator('operator', 'Fires when duplicate groups are', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'value-threshold', family: 'content', label: 'Aggregate threshold', icon: 'Calculator',
    description: 'Fires when an aggregate (sum/avg/min/max) of a numeric column crosses a threshold.',
    fields: [F.table(), { id: 'aggregation', label: 'Aggregation', kind: 'aggregation', default: 'sum' }, F.column('Numeric column'), F.operator('operator', 'Fires when value is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'range-violation', family: 'content', label: 'Out-of-range values', icon: 'RulerHand',
    description: 'Fires when numeric values fall outside a [min, max] range.',
    fields: [F.table(), F.column('Numeric column'), F.number('min', 'Minimum', '0'), F.number('max', 'Maximum', '100'), F.operator('operator', 'Fires when violation count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'allowed-values', family: 'content', label: 'Allowed values', icon: 'CheckmarkStarburst',
    description: 'Fires when a column contains values outside an allowed set.',
    fields: [F.table(), F.column('Column'), { id: 'values', label: 'Allowed values (comma-separated)', kind: 'valuelist', placeholder: 'active, pending, closed', required: true }, F.operator('operator', 'Fires when violation count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'pattern-match', family: 'content', label: 'Pattern mismatch', icon: 'TextAsterisk',
    description: 'Fires when a string column has values that don’t match a regex.',
    fields: [F.table(), F.column('Column'), F.text('pattern', 'Regex the value must match', '^[A-Z]{3}-\\d+$'), F.operator('operator', 'Fires when mismatch count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },
  {
    id: 'error-events', family: 'content', label: 'Error / status events', icon: 'ErrorCircle',
    description: 'Fires when rows whose column equals a value (e.g. Level == "Error") cross a threshold.',
    fields: [F.table(), F.column('Column'), F.text('value', 'Value to match', 'Error'), F.minutes('windowMinutes', 'Window (minutes)', '60'), F.operator('operator', 'Fires when match count is', 'gt'), F.number('threshold', 'Threshold', '0')],
  },

  // ── Schema ──
  {
    id: 'column-exists', family: 'schema', label: 'Column present', icon: 'Column',
    description: 'Fires when an expected column is missing from the table schema.',
    fields: [F.table(), F.column('Expected column')],
  },
  {
    id: 'column-type', family: 'schema', label: 'Column type', icon: 'TextField',
    description: 'Fires when a column’s KQL type differs from what you expect.',
    fields: [F.table(), F.column('Column'), F.text('expectedType', 'Expected KQL type', 'string', 'e.g. string, int, long, real, datetime, bool')],
  },
  {
    id: 'schema-column-count', family: 'schema', label: 'Column count drift', icon: 'TableSettings',
    description: 'Fires when the table’s column count differs from the expected count.',
    fields: [F.table(), F.operator('operator', 'Fires when column count is', 'ne'), F.number('expectedColumns', 'Expected column count', '10')],
  },

  // ── Status & custom ──
  {
    id: 'heartbeat', family: 'status', label: 'Liveness heartbeat', icon: 'HeartPulse',
    description: 'Fires when no heartbeat signal has arrived within the window.',
    fields: [F.table(), F.minutes('thresholdMinutes', 'No signal after (minutes)', '15')],
  },
  {
    id: 'custom', family: 'status', label: 'Custom KQL', icon: 'Code',
    description: 'Fires when your own KQL condition returns rows.',
    fields: [{ id: 'customKql', label: 'KQL condition (fires when it returns rows)', kind: 'kql', required: true, placeholder: 'MyTable\n| where TimeGenerated > ago(1h)\n| summarize n=count()\n| where n == 0' }],
  },
];

export const CHECK_TYPE_BY_ID: Record<string, CheckTypeDef> =
  Object.fromEntries(CHECK_TYPE_LIBRARY.map((t) => [t.id, t]));

// ───────────────────────── KQL emitters (injection-safe) ─────────────────────────

/** A safe KQL identifier (table / column). Strips anything but [A-Za-z0-9_]. */
function ident(v: unknown, fallback = ''): string {
  return String(v ?? '').replace(/[^A-Za-z0-9_]/g, '') || fallback;
}
/** A finite number literal (else the provided default). */
function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
/** A double-quoted KQL string literal with quotes/backslashes escaped. */
function strLit(v: unknown): string {
  return `"${String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** Resolve an operator id → KQL symbol (defaults to the given id). */
function opSym(v: unknown, def = 'gt'): string {
  const found = COMPARISON_OPERATORS.find((o) => o.id === String(v || def));
  return (found || COMPARISON_OPERATORS.find((o) => o.id === def) || COMPARISON_OPERATORS[0]).symbol;
}
function aggFn(v: unknown): string {
  const id = String(v || 'sum');
  return AGGREGATIONS.some((a) => a.id === id) ? id : 'sum';
}

/**
 * Compile a check type + params → a real KQL condition string, or null when a
 * required input is missing. "Fires when it returns rows" is preserved by every
 * template (the final `| where …` yields a row only when unhealthy).
 */
export function buildCheckQuery(checkTypeId: string, params: Record<string, unknown>): string | null {
  const p = params || {};
  const table = ident(p.table, 'AppEvents');
  const col = ident(p.column);
  const op = opSym(p.operator);

  switch (checkTypeId) {
    // ── Time ──
    case 'freshness': {
      const mins = num(p.thresholdMinutes, 60);
      return `${table}\n| where TimeGenerated > ago(${mins}m)\n| summarize n = count()\n| where n == 0`;
    }
    case 'max-age': {
      const mins = num(p.thresholdMinutes, 120);
      return `${table}\n| summarize LatestUtc = max(TimeGenerated)\n| extend AgeMinutes = datetime_diff('minute', now(), LatestUtc)\n| where AgeMinutes ${op} ${mins}`;
    }
    case 'future-timestamp': {
      const t = num(p.threshold, 0);
      return `${table}\n| where TimeGenerated > now()\n| summarize n = count()\n| where n ${op} ${t}`;
    }

    // ── Size ──
    case 'rowcount': {
      const minRows = num(p.minRows, 1);
      return `${table}\n| summarize n = count()\n| where n < ${minRows}`;
    }
    case 'rowcount-max': {
      const maxRows = num(p.maxRows, 100000);
      return `${table}\n| summarize n = count()\n| where n > ${maxRows}`;
    }
    case 'rowcount-compare': {
      const t = num(p.threshold, 1);
      return `${table}\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'distinct-count': {
      if (!col) return null;
      const t = num(p.threshold, 1);
      return `${table}\n| summarize n = dcount(${col})\n| where n ${op} ${t}`;
    }
    case 'volume-drop': {
      const win = num(p.windowMinutes, 60);
      const win2 = win * 2;
      const t = num(p.threshold, 50);
      return [
        `let cur = toscalar(${table} | where TimeGenerated > ago(${win}m) | count);`,
        `let prev = toscalar(${table} | where TimeGenerated between (ago(${win2}m) .. ago(${win}m)) | count);`,
        `print cur = cur, prev = prev, dropPct = iff(prev == 0, 0.0, (todouble(prev) - todouble(cur)) * 100.0 / todouble(prev))`,
        `| where dropPct ${op} ${t}`,
      ].join('\n');
    }

    // ── Content ──
    case 'null-values': {
      if (!col) return null;
      const t = num(p.threshold, 0);
      return `${table}\n| where isnull(${col}) or isempty(tostring(${col}))\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'blank-values': {
      if (!col) return null;
      const t = num(p.threshold, 0);
      return `${table}\n| where tostring(${col}) == ""\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'duplicate-values': {
      if (!col) return null;
      const t = num(p.threshold, 0);
      return `${table}\n| summarize c = count() by ${col}\n| where c > 1\n| summarize dups = count()\n| where dups ${op} ${t}`;
    }
    case 'value-threshold': {
      if (!col) return null;
      const agg = aggFn(p.aggregation);
      const t = num(p.threshold, 0);
      return `${table}\n| summarize v = ${agg}(todouble(${col}))\n| where v ${op} ${t}`;
    }
    case 'range-violation': {
      if (!col) return null;
      const lo = num(p.min, 0), hi = num(p.max, 100), t = num(p.threshold, 0);
      return `${table}\n| where todouble(${col}) < ${lo} or todouble(${col}) > ${hi}\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'allowed-values': {
      if (!col) return null;
      const list = String(p.values || '').split(',').map((v) => v.trim()).filter(Boolean);
      if (list.length === 0) return null;
      const t = num(p.threshold, 0);
      const inList = list.map((v) => strLit(v)).join(', ');
      return `${table}\n| where tostring(${col}) !in (${inList})\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'pattern-match': {
      if (!col) return null;
      const pattern = String(p.pattern || '').trim();
      if (!pattern) return null;
      const t = num(p.threshold, 0);
      return `${table}\n| where isnotempty(tostring(${col})) and not(tostring(${col}) matches regex ${strLit(pattern)})\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'error-events': {
      if (!col) return null;
      const win = num(p.windowMinutes, 60), t = num(p.threshold, 0);
      return `${table}\n| where TimeGenerated > ago(${win}m)\n| where tostring(${col}) == ${strLit(String(p.value ?? 'Error'))}\n| summarize n = count()\n| where n ${op} ${t}`;
    }

    // ── Schema ──
    case 'column-exists': {
      if (!col) return null;
      return `${table}\n| getschema\n| where ColumnName == ${strLit(col)}\n| summarize n = count()\n| where n == 0`;
    }
    case 'column-type': {
      if (!col) return null;
      const t = num(p.threshold, 0);
      const expected = String(p.expectedType || 'string');
      return `${table}\n| getschema\n| where ColumnName == ${strLit(col)} and ColumnType != ${strLit(expected)}\n| summarize n = count()\n| where n ${op} ${t}`;
    }
    case 'schema-column-count': {
      const expected = num(p.expectedColumns, 10);
      return `${table}\n| getschema\n| summarize n = count()\n| where n ${op} ${expected}`;
    }

    // ── Status ──
    case 'heartbeat': {
      const mins = num(p.thresholdMinutes, 15);
      return `${table}\n| where TimeGenerated > ago(${mins}m)\n| summarize n = count()\n| where n == 0`;
    }
    case 'custom': {
      const kql = String(p.customKql || '').trim();
      return kql || null;
    }
    default:
      return null;
  }
}
