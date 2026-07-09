/**
 * Activator trigger-model (FGC-13) — Fabric Data Activator parity, Azure-native.
 *
 * Fabric's Activator distinguishes three rule kinds and evaluates them with
 * per-object (per `device_id` / `asset_id`) state, not a flat per-message
 * comparison:
 *   - Event Rule       one comparison against every incoming event.
 *   - Split-Event Rule the same comparison, but evaluated INDEPENDENTLY per
 *                      object (grouped by an object-key column).
 *   - Property Rule    a stateful change-detection over an object's property
 *                      history — Becomes / Increases-by / Decreases-by /
 *                      Exits-range / No-data-for (heartbeat / absence).
 * Source: https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-trigger-model
 *
 * This module is the PURE compiler (no Azure I/O): it turns a typed trigger
 * model into the KQL that runs on the RTI DEFAULT backend — Azure Data Explorer
 * / Eventhouse (per .claude/rules/no-fabric-dependency.md; no Fabric required).
 * The same KQL constructs (`prev()` over a serialized per-object partition,
 * `summarize arg_max` for heartbeat, `series_decompose_anomalies` for trend
 * anomalies) are valid on both ADX and a Log Analytics scheduledQueryRule, so a
 * single compiler serves both source kinds. The object key becomes the query's
 * grouping column (the LA/metric "dimension"); a per-object row in the result
 * is what makes the alert fire for that object.
 *
 * Contract (same as the rest of the Activator runtime): the rule FIRES when the
 * compiled query returns ≥ 1 row — each row identifies an object whose state
 * met the condition.
 */

export type ActivatorRuleKind = 'event' | 'split-event' | 'property';

export type PropertyConditionType =
  | 'becomes'
  | 'increases-by'
  | 'decreases-by'
  | 'exits-range'
  | 'no-data-for';

export interface TriggerModelInput {
  /** Rule kind. Absent ⇒ 'event' (the flat per-message comparison — today). */
  ruleKind?: ActivatorRuleKind;
  /** Object-key column to group by (e.g. device_id / asset_id). Required for a
   *  Split-Event rule and any Property rule; ignored for a plain Event rule. */
  objectKey?: string;
  /** The measured property column the condition inspects. */
  property?: string;
  /** Property-rule condition type. Absent ⇒ 'becomes'. */
  propertyConditionType?: PropertyConditionType;
  /** Event / Split-Event comparison operator (GreaterThan…Equals). */
  operator?: string;
  /** Comparison RHS for Event/Split-Event, and the target for Property 'becomes'. */
  value?: unknown;
  /** Percent threshold for 'increases-by' / 'decreases-by' (e.g. 10 = 10%). */
  changePercent?: number;
  /** Inclusive lower/upper bound for 'exits-range'. */
  rangeMin?: number;
  rangeMax?: number;
  /** Minutes of silence that fire a 'no-data-for' (heartbeat / absence) rule. */
  noDataMinutes?: number;
  /** Table the query targets. */
  table?: string;
  /** Event-time column used for per-object ordering + heartbeat. Default 'timestamp'. */
  timestampColumn?: string;
}

const RULE_KINDS: readonly ActivatorRuleKind[] = ['event', 'split-event', 'property'];
const PROPERTY_CONDITIONS: readonly PropertyConditionType[] = [
  'becomes', 'increases-by', 'decreases-by', 'exits-range', 'no-data-for',
];

export function isActivatorRuleKind(v: unknown): v is ActivatorRuleKind {
  return typeof v === 'string' && (RULE_KINDS as readonly string[]).includes(v);
}
export function isPropertyConditionType(v: unknown): v is PropertyConditionType {
  return typeof v === 'string' && (PROPERTY_CONDITIONS as readonly string[]).includes(v);
}

/** Coerce a stored rule-kind string (from Cosmos / the wizard) to a known kind. */
export function coerceRuleKind(v: unknown): ActivatorRuleKind {
  return isActivatorRuleKind(v) ? v : 'event';
}
export function coercePropertyCondition(v: unknown): PropertyConditionType {
  return isPropertyConditionType(v) ? v : 'becomes';
}

/** KQL operator for the Event / Split-Event comparison (mirrors activator-monitor). */
function kqlOperator(op?: string): string {
  switch ((op || '').toLowerCase()) {
    case 'gt': case 'greaterthan': case '>': return '>';
    case 'lt': case 'lessthan': case '<': return '<';
    case 'gte': case 'greaterthanorequal': case '>=': return '>=';
    case 'lte': case 'lessthanorequal': case '<=': return '<=';
    case 'ne': case 'notequals': case 'notequal': case '!=': return '!=';
    case 'contains': return 'contains';
    case 'eq': case 'equals': case 'equal': case '==': default: return '==';
  }
}

/** Render a scalar for KQL — numeric literal verbatim, else a quoted string. */
function kqlValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '""';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return v.trim();
  // Escape backslashes FIRST, then double-quotes, so a trailing backslash in
  // the input can't escape the closing quote and break out of the KQL literal.
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Column reference that tolerates a missing column at query time (won't error). */
function safeCol(name: string): string {
  return `column_ifexists("${name}", dynamic(null))`;
}

/** Is the object-key column meaningfully set? */
export function hasObjectKey(input: TriggerModelInput): boolean {
  return typeof input.objectKey === 'string' && input.objectKey.trim().length > 0;
}

/**
 * Validate a trigger model. Returns a precise, user-facing message when the
 * required fields for the chosen kind/condition are missing, else null.
 */
export function validateTriggerModel(input: TriggerModelInput): string | null {
  const kind = coerceRuleKind(input.ruleKind);
  if (kind === 'split-event' && !hasObjectKey(input)) {
    return 'A Split-Event rule needs an object key (e.g. device_id) to group by.';
  }
  if (kind === 'property') {
    if (!hasObjectKey(input)) return 'A Property rule needs an object key (e.g. device_id) to track per object.';
    const cond = coercePropertyCondition(input.propertyConditionType);
    if (cond !== 'no-data-for' && !(input.property || '').trim()) {
      return 'A Property rule needs the property column to inspect.';
    }
    if ((cond === 'increases-by' || cond === 'decreases-by') && !(Number(input.changePercent) > 0)) {
      return 'Increases-by / Decreases-by needs a percent greater than 0.';
    }
    if (cond === 'exits-range') {
      const lo = Number(input.rangeMin); const hi = Number(input.rangeMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        return 'Exits-range needs a numeric min and max with max greater than min.';
      }
    }
    if (cond === 'no-data-for' && !(Number(input.noDataMinutes) > 0)) {
      return 'No-data-for needs a number of minutes greater than 0.';
    }
  }
  return null;
}

/** Human-readable one-line summary for the wizard preview line. */
export function describeTriggerModel(input: TriggerModelInput): string {
  const kind = coerceRuleKind(input.ruleKind);
  const key = (input.objectKey || '').trim();
  const prop = (input.property || 'value').trim();
  if (kind === 'event') {
    return `Every event where ${prop} ${kqlOperator(input.operator)} ${kqlValue(input.value)}`;
  }
  if (kind === 'split-event') {
    return `Per ${key || 'object'}: event where ${prop} ${kqlOperator(input.operator)} ${kqlValue(input.value)}`;
  }
  const cond = coercePropertyCondition(input.propertyConditionType);
  const per = `per ${key || 'object'}`;
  switch (cond) {
    case 'becomes': return `${prop} becomes ${kqlValue(input.value)} (${per})`;
    case 'increases-by': return `${prop} increases by ≥ ${Number(input.changePercent) || 0}% (${per})`;
    case 'decreases-by': return `${prop} decreases by ≥ ${Number(input.changePercent) || 0}% (${per})`;
    case 'exits-range': return `${prop} exits [${Number(input.rangeMin)}, ${Number(input.rangeMax)}] (${per})`;
    case 'no-data-for': return `no data for ${Number(input.noDataMinutes) || 0} min (${per})`;
    default: return `${prop} rule (${per})`;
  }
}

/**
 * The object-key alerting dimension descriptor. On a Log Analytics
 * scheduledQueryRule (and equivalently an Azure Monitor metric alert) the
 * object key is the alert DIMENSION — each distinct key value is an independent
 * alert instance. The compiled query already returns one row per firing object
 * (grouped by this column), so the dimension name is the object-key column.
 */
export function objectKeyDimension(input: TriggerModelInput): { name: string } | null {
  return hasObjectKey(input) ? { name: input.objectKey!.trim() } : null;
}

/**
 * Compile the trigger model to KQL. FIRES when the query returns ≥ 1 row; each
 * row is an object (identified by the object key) whose state met the condition.
 *
 *  - 'event'        flat per-message predicate (today's behaviour).
 *  - 'split-event'  same predicate, projected with the object key so each
 *                   firing object is a distinct row / alert dimension.
 *  - 'property'     stateful per-object change detection:
 *      becomes       property transitions INTO the target value for an object
 *                    (prev() over the per-object serialized partition).
 *      increases-by  (cur-prev)/prev*100 ≥ +percent for an object.
 *      decreases-by  (cur-prev)/prev*100 ≤ -percent for an object.
 *      exits-range   property leaves [min,max] for an object.
 *      no-data-for   an object's newest event is older than N minutes
 *                    (heartbeat / absence-of-data), via summarize arg_max.
 */
export function compileTriggerModelKql(input: TriggerModelInput): string {
  const table = (input.table || '').trim() || 'Events';
  const kind = coerceRuleKind(input.ruleKind);
  const keyCol = (input.objectKey || '').trim();
  const tsCol = (input.timestampColumn || '').trim() || 'timestamp';
  const propCol = (input.property || 'value').trim();

  // ── Event rule: flat predicate over every message. ──
  if (kind === 'event') {
    const op = kqlOperator(input.operator);
    const numeric = ['>', '>=', '<', '<=', '==', '!='].includes(op);
    const lhs = numeric && typeof input.value === 'number' ? `todouble(${safeCol(propCol)})` : safeCol(propCol);
    return `${table}\n| extend _v = ${lhs}\n| where _v ${op} ${kqlValue(input.value)}`;
  }

  // ── Split-Event rule: same predicate, projected per object. ──
  if (kind === 'split-event') {
    const op = kqlOperator(input.operator);
    const numeric = ['>', '>=', '<', '<=', '==', '!='].includes(op);
    const lhs = numeric && typeof input.value === 'number' ? `todouble(${safeCol(propCol)})` : safeCol(propCol);
    return [
      table,
      `| extend _key = ${safeCol(keyCol)}`,
      `| where isnotempty(_key)`,
      `| extend _v = ${lhs}`,
      `| where _v ${op} ${kqlValue(input.value)}`,
      `| project _key, ${propCol}, ${tsCol}`,
    ].join('\n');
  }

  // ── Property rule: stateful per-object change detection. ──
  const cond = coercePropertyCondition(input.propertyConditionType);

  if (cond === 'no-data-for') {
    // Heartbeat / absence: an object is silent when its newest event is older
    // than N minutes. summarize arg_max gives each object's last-seen time.
    const mins = Number(input.noDataMinutes) > 0 ? Number(input.noDataMinutes) : 5;
    return [
      table,
      `| extend _key = ${safeCol(keyCol)}, _ts = todatetime(${safeCol(tsCol)})`,
      `| where isnotempty(_key)`,
      `| summarize _lastSeen = max(_ts) by tostring(_key)`,
      `| where now() - _lastSeen > ${mins}m`,
      `| project _key, _lastSeen, _silentFor = now() - _lastSeen`,
    ].join('\n');
  }

  if (cond === 'exits-range') {
    const lo = Number(input.rangeMin);
    const hi = Number(input.rangeMax);
    return [
      table,
      `| extend _key = ${safeCol(keyCol)}, _v = todouble(${safeCol(propCol)})`,
      `| where isnotempty(_key) and isnotnull(_v)`,
      `| where _v < ${Number.isFinite(lo) ? lo : 0} or _v > ${Number.isFinite(hi) ? hi : 0}`,
      `| project _key, ${propCol} = _v, ${tsCol}`,
    ].join('\n');
  }

  // becomes / increases-by / decreases-by all need the object's PREVIOUS sample.
  // Serialize per object in event-time order, then prev() reads the prior row;
  // guard the partition boundary by comparing the previous row's key.
  const head = [
    table,
    `| extend _key = ${safeCol(keyCol)}, _v = todouble(${safeCol(propCol)}), _ts = todatetime(${safeCol(tsCol)})`,
    `| where isnotempty(_key)`,
    `| order by tostring(_key) asc, _ts asc`,
    `| extend _prevV = prev(_v), _prevKey = prev(_key)`,
    `| where tostring(_key) == tostring(_prevKey)`,
  ];

  if (cond === 'becomes') {
    // Transition INTO the target value: current row matches, previous did not.
    const numeric = typeof input.value === 'number';
    const cur = numeric ? '_v' : `tostring(${safeCol(propCol)})`;
    const prevExpr = numeric ? '_prevV' : `tostring(prev(${safeCol(propCol)}))`;
    return [
      table,
      `| extend _key = ${safeCol(keyCol)}, _v = todouble(${safeCol(propCol)}), _ts = todatetime(${safeCol(tsCol)})`,
      `| where isnotempty(_key)`,
      `| order by tostring(_key) asc, _ts asc`,
      `| extend _prevV = prev(_v), _prevKey = prev(_key), _prevRaw = prev(tostring(${safeCol(propCol)}))`,
      `| where tostring(_key) == tostring(_prevKey)`,
      `| where ${cur} == ${kqlValue(input.value)} and ${prevExpr} != ${kqlValue(input.value)}`,
      `| project _key, ${propCol} = ${numeric ? '_v' : `tostring(${safeCol(propCol)})`}, ${tsCol} = _ts`,
    ].join('\n');
  }

  // increases-by / decreases-by: percent change vs the object's previous sample.
  const pct = Number(input.changePercent) > 0 ? Number(input.changePercent) : 0;
  const pctExpr = `((_v - _prevV) / _prevV) * 100`;
  const predicate = cond === 'increases-by'
    ? `_pctChange >= ${pct}`
    : `_pctChange <= ${-pct}`;
  return [
    ...head,
    `| where _prevV != 0`,
    `| extend _pctChange = ${pctExpr}`,
    `| where ${predicate}`,
    `| project _key, ${propCol} = _v, _prev = _prevV, _pctChange, ${tsCol} = _ts`,
  ].join('\n');
}
