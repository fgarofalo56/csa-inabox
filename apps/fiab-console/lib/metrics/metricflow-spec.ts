/**
 * metricflow-spec.ts — MetricFlow-compatible semantic-model / metric / dimension
 * / entity spec types + a lossless YAML import/export for the supported subset
 * (N15, headless metrics layer).
 *
 * WHY (the "one governed metric, everywhere" contract): a metric must be defined
 * ONCE and serve BI + NL2SQL + the REST endpoint — so a report, a Copilot answer,
 * and an API call return the SAME number. This module is the INTEROP surface: it
 * imports/exports the dbt-Semantic-Layer / MetricFlow YAML shape (so a customer's
 * existing MetricFlow definitions load, and Loom's governed metrics export back)
 * and maps each MetricFlow metric onto N9's governed {@link MetricInput} registry
 * (lib/azure/semantic-contract.ts) — N15 EXTENDS that store, it does NOT fork it.
 *
 * OSI INTEROP ONLY — there is NO runtime MetricFlow/dbt engine here: Loom's own
 * native compiler (metric-compiler.ts) emits the SQL. This file is pure string /
 * data transformation (no Azure, no Cosmos), so it is unit-testable in isolation
 * and the round-trip (`specToYaml` → `yamlToSpec`) is byte-lossless for the
 * supported subset.
 *
 * The compilable substrate (a measure's aggregation + expression, a dimension's
 * expression + grain, the model's base relation) lives on the SEMANTIC MODEL
 * here; N9's `MetricDoc` remains the governed registry entry (owner, synonyms,
 * grain, sourceRef `<model>::<measure>`). importSpec returns BOTH: the parsed
 * spec (persisted whole via the contract store) and the `MetricInput[]` to
 * register into N9 so synonym-matching + the registry keep working.
 *
 * Per-cloud: identical all clouds (pure metadata; no Fabric). IL5: fully
 * disconnected — import/export is in-process string work with zero egress.
 *
 * Grounded in the MetricFlow / dbt Semantic Layer spec:
 *   https://docs.getdbt.com/docs/build/semantic-models
 *   https://docs.getdbt.com/docs/build/metrics-overview
 */

import type { MetricInput } from '@/lib/azure/semantic-contract';

// ── Spec types (the supported MetricFlow subset) ─────────────────────────────

/** Aggregation kinds a measure can declare (the folded subset). */
export const MF_AGGS = ['sum', 'count', 'count_distinct', 'average', 'min', 'max'] as const;
export type MfAgg = (typeof MF_AGGS)[number];

/** True when `v` is a supported aggregation. */
export function isMfAgg(v: unknown): v is MfAgg {
  return typeof v === 'string' && (MF_AGGS as readonly string[]).includes(v);
}

/** A measure: an aggregation over a column/expression on the model's relation. */
export interface MfMeasure {
  name: string;
  agg: MfAgg;
  /** The column/SQL expression the aggregation is applied to (a column name in the subset). */
  expr: string;
}

/** Dimension type — categorical (group-by) or time (bucketable by grain). */
export type MfDimensionType = 'categorical' | 'time';

/** A dimension: a group-by attribute. Time dimensions carry a default grain. */
export interface MfDimension {
  name: string;
  type: MfDimensionType;
  /** The column/expression the dimension reads (defaults to `name`). */
  expr: string;
  /** For time dimensions: the default grain (day | week | month | quarter | year). */
  grain?: string;
}

/** An entity (join key) — primary / foreign / unique, per MetricFlow. */
export interface MfEntity {
  name: string;
  type: string;
  /** The key column/expression (defaults to `name`). */
  expr: string;
}

/** A semantic model: a base relation + its entities, dimensions, and measures. */
export interface MfSemanticModel {
  name: string;
  /** The physical base relation: `schema.table` or `table` (or a serverless view). */
  relation: string;
  entities: MfEntity[];
  dimensions: MfDimension[];
  measures: MfMeasure[];
}

/** A metric — the governed number. `simple` references one measure (the subset). */
export interface MfMetric {
  name: string;
  /** Display label (defaults to `name`). */
  label: string;
  /** Governed definition text. */
  description: string;
  type: 'simple';
  /** The measure this metric aggregates (`<model>.<measure>` or bare `<measure>`). */
  measure: string;
  /** Alternate phrasings (flow into N9's synonym index). */
  synonyms: string[];
  /** The grain the metric is defined at (governed text, e.g. "per order"). */
  grain: string;
  /**
   * An optional structured filter narrowing the metric, as `<column> <op> <value>`
   * (e.g. `is_refund = 0`). Parsed structurally by the compiler — NEVER spliced
   * raw — so it is injection-safe. `''` when absent.
   */
  filter: string;
}

/** The full MetricFlow-compatible spec for a tenant. */
export interface MetricFlowSpec {
  semantic_models: MfSemanticModel[];
  metrics: MfMetric[];
}

/** Thrown for a malformed / unsupported spec on import. */
export class MetricSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricSpecError';
  }
}

// ── Minimal, symmetric YAML for the supported subset ─────────────────────────
//
// The repo carries no js-yaml dependency (dbt-codegen hand-rolls an emitter for
// the same reason). We implement a small indentation parser + emitter that are
// SYMMETRIC over exactly the shapes this file produces (nested maps, lists of
// maps, and string-array lists), so `yamlToSpec(specToYaml(spec))` is lossless.

type YamlValue = string | YamlValue[] | { [k: string]: YamlValue };

interface YamlLine {
  indent: number;
  content: string;
}

function tokenizeYaml(text: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (/^\s*#/.test(raw)) continue; // whole-line comment
    const indent = raw.length - raw.replace(/^ +/, '').length;
    out.push({ indent, content: raw.slice(indent) });
  }
  return out;
}

/** Parse a scalar token: a double-quoted JSON string, or a bare trimmed value. */
function parseScalar(token: string): string {
  const t = token.trim();
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t;
    }
  }
  return t;
}

/** Emit a scalar: quote (JSON) when it is empty or carries YAML-significant chars. */
function emitScalar(value: string): string {
  const s = String(value ?? '');
  if (s === '' || /[:#"'\n]|^\s|\s$|^[-?&*!|>%@`]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** Split a map line `key: value` / `key:` into its key + inline value (or null). */
function splitKeyLine(content: string): { key: string; inline: string | null } | null {
  // A map key is `word:` optionally followed by a space + value.
  const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(content);
  if (!m) return null;
  return { key: m[1], inline: m[2] === undefined ? null : m[2] };
}

function parseYamlNode(lines: YamlLine[], start: number, end: number, depth = 0): YamlValue {
  if (depth > 32) throw new MetricSpecError('YAML nesting too deep');
  if (start >= end) return '';
  const base = lines[start].indent;

  // List?
  if (lines[start].content === '-' || lines[start].content.startsWith('- ')) {
    const arr: YamlValue[] = [];
    let i = start;
    while (i < end) {
      if (lines[i].indent !== base) {
        i++;
        continue;
      }
      // Find this item's block: [i, j) — j is the next line at `base` starting a new '-'.
      let j = i + 1;
      while (j < end && !(lines[j].indent === base && (lines[j].content === '-' || lines[j].content.startsWith('- ')))) {
        j++;
      }
      const afterDash = lines[i].content.replace(/^-\s?/, '');
      const sub: YamlLine[] = [];
      if (afterDash !== '') sub.push({ indent: base + 2, content: afterDash });
      for (let k = i + 1; k < j; k++) sub.push(lines[k]);
      if (sub.length === 0) {
        arr.push('');
      } else if (sub.length === 1 && !splitKeyLine(sub[0].content)) {
        arr.push(parseScalar(sub[0].content));
      } else {
        arr.push(parseYamlNode(sub, 0, sub.length, depth + 1));
      }
      i = j;
    }
    return arr;
  }

  // Bare scalar (single line, not a map key).
  if (end - start === 1 && !splitKeyLine(lines[start].content)) {
    return parseScalar(lines[start].content);
  }

  // Map.
  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < end) {
    if (lines[i].indent !== base) {
      i++;
      continue;
    }
    const kv = splitKeyLine(lines[i].content);
    if (!kv) throw new MetricSpecError(`Unparseable YAML line: ${lines[i].content}`);
    if (kv.inline !== null && kv.inline !== '') {
      // Inline empty-collection markers decode to empty containers (they are how
      // the emitter renders `synonyms: []` / `entities: []`); a real string "[]"
      // arrives JSON-quoted (`"[]"`) and is handled by parseScalar.
      map[kv.key] = kv.inline === '[]' ? [] : kv.inline === '{}' ? {} : parseScalar(kv.inline);
      i++;
    } else {
      let j = i + 1;
      while (j < end && lines[j].indent > base) j++;
      map[kv.key] = j > i + 1 ? parseYamlNode(lines, i + 1, j, depth + 1) : '';
      i = j;
    }
  }
  return map;
}

/** Parse the supported YAML subset into a plain data value. */
export function parseYamlSubset(text: string): YamlValue {
  const lines = tokenizeYaml(text);
  if (lines.length === 0) return {};
  return parseYamlNode(lines, 0, lines.length);
}

/** Emit a plain data value as canonical YAML for the supported subset. */
export function emitYamlSubset(value: YamlValue, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        // First key on the dash line, remaining keys indented under it.
        const body = emitYamlSubset(item as YamlValue, indent + 2);
        const bodyLines = body.replace(/\n$/, '').split('\n');
        out += `${pad}- ${bodyLines[0].slice(indent + 2)}\n`;
        for (let k = 1; k < bodyLines.length; k++) out += `${bodyLines[k]}\n`;
      } else {
        out += `${pad}- ${emitScalar(String(item))}\n`;
      }
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    let out = '';
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) || (v !== null && typeof v === 'object')) {
        if (Array.isArray(v) && v.length === 0) {
          out += `${pad}${k}: []\n`;
        } else {
          out += `${pad}${k}:\n${emitYamlSubset(v as YamlValue, indent + 2)}`;
        }
      } else {
        out += `${pad}${k}: ${emitScalar(String(v))}\n`;
      }
    }
    return out;
  }
  return `${pad}${emitScalar(String(value))}\n`;
}

// ── Normalisation (canonical spec ⇒ lossless round-trip) ─────────────────────

function asString(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((s) => s !== '');
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

function normEntity(v: YamlValue): MfEntity {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, YamlValue>;
  const name = asString(o.name);
  return { name, type: asString(o.type) || 'foreign', expr: asString(o.expr) || name };
}

function normDimension(v: YamlValue): MfDimension {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, YamlValue>;
  const name = asString(o.name);
  const type: MfDimensionType = asString(o.type) === 'time' ? 'time' : 'categorical';
  const dim: MfDimension = { name, type, expr: asString(o.expr) || name };
  if (type === 'time') dim.grain = asString(o.grain) || 'day';
  return dim;
}

function normMeasure(v: YamlValue): MfMeasure {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, YamlValue>;
  const name = asString(o.name);
  const aggRaw = asString(o.agg).toLowerCase();
  if (!isMfAgg(aggRaw)) {
    throw new MetricSpecError(`Measure "${name}" has unsupported agg "${aggRaw}" (allowed: ${MF_AGGS.join(', ')}).`);
  }
  return { name, agg: aggRaw, expr: asString(o.expr) || name };
}

function normSemanticModel(v: YamlValue): MfSemanticModel {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, YamlValue>;
  const name = asString(o.name);
  if (!name) throw new MetricSpecError('Every semantic_model needs a name.');
  const relation = asString(o.relation);
  if (!relation) throw new MetricSpecError(`Semantic model "${name}" needs a relation (schema.table).`);
  return {
    name,
    relation,
    entities: (Array.isArray(o.entities) ? o.entities : []).map(normEntity).filter((e) => e.name),
    dimensions: (Array.isArray(o.dimensions) ? o.dimensions : []).map(normDimension).filter((d) => d.name),
    measures: (Array.isArray(o.measures) ? o.measures : []).map(normMeasure).filter((m) => m.name),
  };
}

function normMetric(v: YamlValue): MfMetric {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, YamlValue>;
  const name = asString(o.name);
  if (!name) throw new MetricSpecError('Every metric needs a name.');
  const measure = asString(o.measure);
  if (!measure) throw new MetricSpecError(`Metric "${name}" needs a measure reference.`);
  return {
    name,
    label: asString(o.label) || name,
    description: asString(o.description),
    type: 'simple',
    measure,
    synonyms: asStringArray(o.synonyms),
    grain: asString(o.grain),
    filter: asString(o.filter),
  };
}

/**
 * Normalise a raw parsed value into a canonical {@link MetricFlowSpec}. Every
 * optional field is materialised to its canonical empty form, so
 * `specToYaml(normalizeSpec(x))` round-trips through `yamlToSpec` byte-losslessly.
 */
export function normalizeSpec(raw: unknown): MetricFlowSpec {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, YamlValue>;
  return {
    semantic_models: (Array.isArray(o.semantic_models) ? o.semantic_models : []).map(normSemanticModel),
    metrics: (Array.isArray(o.metrics) ? o.metrics : []).map(normMetric),
  };
}

// ── Public import / export ───────────────────────────────────────────────────

/** Serialise a spec back to canonical MetricFlow YAML. Field order is fixed. */
export function specToYaml(spec: MetricFlowSpec): string {
  const canonical = normalizeSpec(spec);
  // Re-key into a fixed field order so export is deterministic + parity-stable.
  const ordered = {
    semantic_models: canonical.semantic_models.map((m) => ({
      name: m.name,
      relation: m.relation,
      entities: m.entities.map((e) => ({ name: e.name, type: e.type, expr: e.expr })),
      dimensions: m.dimensions.map((d) =>
        d.type === 'time'
          ? { name: d.name, type: d.type, expr: d.expr, grain: d.grain ?? 'day' }
          : { name: d.name, type: d.type, expr: d.expr },
      ),
      measures: m.measures.map((me) => ({ name: me.name, agg: me.agg, expr: me.expr })),
    })),
    metrics: canonical.metrics.map((mt) => ({
      name: mt.name,
      label: mt.label,
      description: mt.description,
      type: mt.type,
      measure: mt.measure,
      synonyms: mt.synonyms,
      grain: mt.grain,
      filter: mt.filter,
    })),
  };
  return emitYamlSubset(ordered as unknown as YamlValue);
}

/** Parse MetricFlow YAML → a canonical {@link MetricFlowSpec}. */
export function yamlToSpec(yaml: string): MetricFlowSpec {
  return normalizeSpec(parseYamlSubset(yaml));
}

/**
 * Resolve the semantic-model + measure a metric's `measure` reference points at.
 * Accepts `<model>.<measure>` or a bare `<measure>` (unique across models).
 * Returns null when unresolved.
 */
export function resolveMetricMeasure(
  spec: MetricFlowSpec,
  metric: MfMetric,
): { model: MfSemanticModel; measure: MfMeasure } | null {
  const ref = metric.measure.includes('.') ? metric.measure.split('.') : [null, metric.measure];
  const modelName = ref[0];
  const measureName = ref[1] ?? metric.measure;
  for (const model of spec.semantic_models) {
    if (modelName && model.name !== modelName) continue;
    const measure = model.measures.find((m) => m.name === measureName);
    if (measure) return { model, measure };
  }
  return null;
}

/**
 * Import a MetricFlow spec: parse + validate, then map each metric onto N9's
 * governed {@link MetricInput} registry shape (sourceKind `measure`, sourceRef
 * `<model>::<measure>`). Returns the canonical spec (persist it whole via the
 * contract store) AND the `MetricInput[]` to register into N9 so synonym-matching
 * + the registry keep working. Throws {@link MetricSpecError} on a bad spec.
 */
export function importSpec(yaml: string): { spec: MetricFlowSpec; metricInputs: MetricInput[] } {
  const spec = yamlToSpec(yaml);
  const metricInputs: MetricInput[] = [];
  for (const metric of spec.metrics) {
    const resolved = resolveMetricMeasure(spec, metric);
    if (!resolved) {
      throw new MetricSpecError(
        `Metric "${metric.name}" references measure "${metric.measure}", which no semantic_model defines.`,
      );
    }
    metricInputs.push({
      metricId: metric.name,
      label: metric.label,
      owner: '',
      description: metric.description,
      synonyms: metric.synonyms,
      grain: metric.grain,
      sourceKind: 'measure',
      sourceRef: `${resolved.model.name}::${resolved.measure.name}`,
    });
  }
  return { spec, metricInputs };
}

/**
 * Export N9-governed metrics (already loaded) back to MetricFlow YAML by joining
 * them onto the tenant's stored semantic models. `exportSpec` is the inverse of
 * {@link importSpec} for the supported subset — round-trip lossless.
 */
export function exportSpec(spec: MetricFlowSpec): string {
  return specToYaml(spec);
}
