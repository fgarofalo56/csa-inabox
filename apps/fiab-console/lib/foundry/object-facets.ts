/**
 * Object Explorer facets + histograms (WS-4.7, Foundry-parity row 4.7) — pure
 * aggregate compute + property-type-aware filter predicates over REAL
 * Apache-AGE instance rows (the ones `weave-explore.searchObjects` returns).
 *
 * No React, no Node I/O — the client Object Explorer imports it, and it is
 * fully vitest-coverable without a DOM. Per .claude/rules/no-vaporware.md the
 * numbers are computed from the live AGE instances the BFF already fetched; per
 * .claude/rules/csa_loom_foundry_object_explorer_checkpoints AGE openCypher can
 * not run the "any property" aggregate/predicate we need, so we aggregate +
 * filter in JS over the fetched rows (the same reason searchObjects filters in
 * JS). No mock data, no Fabric — Apache AGE / PostgreSQL only.
 *
 * Facet shapes are chosen from the object-type model's PROPERTY TYPES:
 *   - string / other       → category facet counts (top-N distinct values)
 *   - number               → equal-width histogram buckets
 *   - date / timestamp      → time buckets (auto day/month/year granularity)
 *   - boolean               → 2-way true/false facet
 * When a property's declared base type is unknown, the kind is inferred from
 * the instances' own values so brownfield / free-form graphs still chart.
 */
import type { OntoBaseType } from '@/lib/editors/ontology-model';
import { parseTimeMs } from '@/lib/components/adx/time-series-model';

/** A graph instance as returned by weave-explore (searchObjects). */
export interface ExplorerObject {
  id: string;
  objectType: string;
  properties: Record<string, unknown>;
}

/** Lite property descriptor the explore route ships alongside instances. */
export interface ExplorerProperty {
  apiName: string;
  displayName?: string;
  baseType?: string;
  arrayOf?: boolean;
}

/** Which chart a property's values are aggregated into. */
export type FacetKind = 'category' | 'histogram' | 'timebucket' | 'boolean';

const NUMERIC_BASE_TYPES: ReadonlySet<string> = new Set<OntoBaseType>([
  'byte', 'short', 'integer', 'long', 'float', 'double', 'decimal',
]);
const TIME_BASE_TYPES: ReadonlySet<string> = new Set<OntoBaseType>(['date', 'timestamp']);

const DAY_MS = 86_400_000;

// ── value coercion (token-free, no fabrication) ──────────────────────────────

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

/** Normalise a property value to the list of scalar occurrences it contributes. */
function occurrences(raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter((x) => x !== null && x !== undefined && x !== '');
  if (raw === '') return [];
  return [raw];
}

// ── kind resolution ──────────────────────────────────────────────────────────

/** The facet kind implied by a declared property base type (undefined ⇒ infer). */
export function facetKindForBaseType(baseType?: string): FacetKind | undefined {
  if (!baseType) return undefined;
  if (baseType === 'boolean') return 'boolean';
  if (NUMERIC_BASE_TYPES.has(baseType)) return 'histogram';
  if (TIME_BASE_TYPES.has(baseType)) return 'timebucket';
  return 'category';
}

/** Infer a facet kind from a property's actual instance values. */
export function inferFacetKind(values: readonly unknown[]): FacetKind {
  let n = 0, bools = 0, nums = 0, times = 0;
  for (const v of values) {
    n++;
    if (toBool(v) !== null) bools++;
    if (parseTimeMs(v) !== null) times++;
    else if (toNum(v) !== null) nums++;
  }
  if (n === 0) return 'category';
  if (bools === n) return 'boolean';
  if (times >= Math.ceil(n * 0.6)) return 'timebucket';
  if (nums >= Math.ceil(n * 0.6)) return 'histogram';
  return 'category';
}

function resolveKind(prop: ExplorerProperty, values: readonly unknown[]): FacetKind {
  // Arrays of a scalar are always browsed as a category of their elements.
  if (prop.arrayOf) return 'category';
  return facetKindForBaseType(prop.baseType) ?? inferFacetKind(values);
}

// ── bins + chart shape ───────────────────────────────────────────────────────

export interface FacetBin {
  /** Display label for the bin. */
  label: string;
  /** Instances (or occurrences, for arrays) in this bin. */
  count: number;
  /** category / boolean — the concrete value to filter on. */
  value?: string;
  /** histogram / timebucket — inclusive-lower bound (numeric or epoch-ms). */
  lo?: number;
  /** histogram / timebucket — exclusive-upper bound (numeric or epoch-ms). */
  hi?: number;
}

export interface FacetChart {
  apiName: string;
  displayName: string;
  kind: FacetKind;
  bins: FacetBin[];
  /** Instances that carry a usable value for this property. */
  total: number;
  /** Distinct value count (category / boolean). */
  distinct?: number;
  /** True when more distinct values existed than the shown top-N. */
  truncated?: boolean;
}

/** Default number of category bars shown before the tail is folded away. */
export const CATEGORY_TOP_N = 12;
/** Default number of equal-width histogram buckets. */
export const HISTOGRAM_BINS = 10;

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const rounded = Number(n.toPrecision(6));
  if (Number.isInteger(rounded)) return rounded.toLocaleString();
  // Trim to at most 2 fractional digits for compact bucket labels.
  return (Math.round(rounded * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Category facet: top-N distinct stringified values, sorted by count desc. */
export function computeCategoryFacet(
  objects: readonly ExplorerObject[], apiName: string, topN = CATEGORY_TOP_N,
): FacetChart {
  const counts = new Map<string, number>();
  let withValue = 0;
  for (const o of objects) {
    const occ = occurrences(o.properties?.[apiName]);
    if (occ.length) withValue++;
    for (const v of occ) {
      const key = String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const bins = sorted.slice(0, topN).map(([value, count]) => ({ label: value === '' ? '(blank)' : value, count, value }));
  return {
    apiName, displayName: apiName, kind: 'category', bins,
    total: withValue, distinct: counts.size, truncated: counts.size > bins.length,
  };
}

/** Boolean facet: true / false counts (2-way). */
export function computeBooleanFacet(objects: readonly ExplorerObject[], apiName: string): FacetChart {
  let t = 0, f = 0;
  for (const o of objects) {
    const b = toBool(o.properties?.[apiName]);
    if (b === true) t++;
    else if (b === false) f++;
  }
  const bins: FacetBin[] = [];
  if (t || (!t && !f)) bins.push({ label: 'true', value: 'true', count: t });
  if (f || (!t && !f)) bins.push({ label: 'false', value: 'false', count: f });
  return { apiName, displayName: apiName, kind: 'boolean', bins, total: t + f, distinct: (t ? 1 : 0) + (f ? 1 : 0) };
}

/** Numeric histogram: equal-width buckets between the observed min and max. */
export function computeHistogram(
  objects: readonly ExplorerObject[], apiName: string, binCount = HISTOGRAM_BINS,
): FacetChart {
  const values: number[] = [];
  for (const o of objects) {
    for (const v of occurrences(o.properties?.[apiName])) {
      const n = toNum(v);
      if (n !== null) values.push(n);
    }
  }
  const base: FacetChart = { apiName, displayName: apiName, kind: 'histogram', bins: [], total: values.length };
  if (values.length === 0) return base;

  let min = values[0], max = values[0];
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }

  if (min === max) {
    return { ...base, bins: [{ label: fmtNum(min), count: values.length, lo: min, hi: min }] };
  }
  const bins = Math.max(1, Math.min(Math.trunc(binCount) || HISTOGRAM_BINS, 50));
  const width = (max - min) / bins;
  const out: FacetBin[] = Array.from({ length: bins }, (_, i) => {
    const lo = min + i * width;
    const hi = i === bins - 1 ? max : min + (i + 1) * width;
    return { label: `${fmtNum(lo)}–${fmtNum(hi)}`, count: 0, lo, hi };
  });
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx].count++;
  }
  return { ...base, bins: out };
}

type Granularity = 'day' | 'month' | 'year';

function pickGranularity(spanMs: number): Granularity {
  const days = spanMs / DAY_MS;
  if (days <= 62) return 'day';
  if (days <= 366 * 3) return 'month';
  return 'year';
}

/** Truncate an epoch-ms to the start of its bucket (UTC); returns [startMs, endMs). */
function bucketBounds(ms: number, g: Granularity): { start: number; end: number; key: string } {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (g === 'year') {
    const start = Date.UTC(y, 0, 1);
    return { start, end: Date.UTC(y + 1, 0, 1), key: String(y) };
  }
  if (g === 'month') {
    const m = d.getUTCMonth();
    const start = Date.UTC(y, m, 1);
    return { start, end: Date.UTC(y, m + 1, 1), key: `${y}-${String(m + 1).padStart(2, '0')}` };
  }
  const start = Date.UTC(y, d.getUTCMonth(), d.getUTCDate());
  return { start, end: start + DAY_MS, key: new Date(start).toISOString().slice(0, 10) };
}

/** Time buckets: non-empty (auto-granularity) buckets sorted chronologically. */
export function computeTimeBuckets(objects: readonly ExplorerObject[], apiName: string): FacetChart {
  const times: number[] = [];
  for (const o of objects) {
    for (const v of occurrences(o.properties?.[apiName])) {
      const t = parseTimeMs(v);
      if (t !== null) times.push(t);
    }
  }
  const base: FacetChart = { apiName, displayName: apiName, kind: 'timebucket', bins: [], total: times.length };
  if (times.length === 0) return base;

  let min = times[0], max = times[0];
  for (const t of times) { if (t < min) min = t; if (t > max) max = t; }
  const g = pickGranularity(max - min);

  const byKey = new Map<string, FacetBin>();
  for (const t of times) {
    const { start, end, key } = bucketBounds(t, g);
    const b = byKey.get(key);
    if (b) b.count++;
    else byKey.set(key, { label: key, count: 1, lo: start, hi: end });
  }
  const bins = [...byKey.values()].sort((a, b) => (a.lo ?? 0) - (b.lo ?? 0));
  return { ...base, bins };
}

/** Build the facet chart for one property, dispatching on its resolved kind. */
export function buildFacetChart(objects: readonly ExplorerObject[], prop: ExplorerProperty): FacetChart {
  const sample: unknown[] = [];
  for (const o of objects) {
    const occ = occurrences(o.properties?.[prop.apiName]);
    if (occ.length) sample.push(occ[0]);
    if (sample.length >= 50) break;
  }
  const kind = resolveKind(prop, sample);
  let chart: FacetChart;
  if (kind === 'boolean') chart = computeBooleanFacet(objects, prop.apiName);
  else if (kind === 'histogram') chart = computeHistogram(objects, prop.apiName);
  else if (kind === 'timebucket') chart = computeTimeBuckets(objects, prop.apiName);
  else chart = computeCategoryFacet(objects, prop.apiName);
  chart.displayName = prop.displayName || prop.apiName;
  return chart;
}

/**
 * Build a facet chart per property that actually has data in the fetched rows.
 * Charts with zero usable values are dropped (nothing to show), preserving the
 * "no fabricated bars" rule. Order follows the property list.
 */
export function buildFacetCharts(
  objects: readonly ExplorerObject[], props: readonly ExplorerProperty[],
): FacetChart[] {
  const out: FacetChart[] = [];
  for (const p of props) {
    if (!p?.apiName) continue;
    const chart = buildFacetChart(objects, p);
    if (chart.total > 0 && chart.bins.length > 0) out.push(chart);
  }
  return out;
}

// ── property-type-aware filters ──────────────────────────────────────────────

export type FacetFilter =
  | { apiName: string; kind: 'category'; values: string[] }
  | { apiName: string; kind: 'range'; lo?: number; hi?: number }
  | { apiName: string; kind: 'timerange'; fromMs?: number; toMs?: number }
  | { apiName: string; kind: 'boolean'; value: boolean };

/** A short human label for an active filter chip. */
export function filterLabel(f: FacetFilter): string {
  if (f.kind === 'category') return `${f.apiName}: ${f.values.map((v) => (v === '' ? '(blank)' : v)).join(', ')}`;
  if (f.kind === 'boolean') return `${f.apiName}: ${f.value}`;
  if (f.kind === 'range') {
    const lo = f.lo != null ? fmtNum(f.lo) : '−∞';
    const hi = f.hi != null ? fmtNum(f.hi) : '∞';
    return `${f.apiName}: ${lo}–${hi}`;
  }
  const from = f.fromMs != null ? new Date(f.fromMs).toISOString().slice(0, 10) : '…';
  const to = f.toMs != null ? new Date(f.toMs).toISOString().slice(0, 10) : '…';
  return `${f.apiName}: ${from} → ${to}`;
}

/** Derive the type-aware filter a bin represents (for click-to-filter). */
export function filterFromBin(chart: FacetChart, bin: FacetBin): FacetFilter | null {
  if (chart.kind === 'category') return { apiName: chart.apiName, kind: 'category', values: [bin.value ?? bin.label] };
  if (chart.kind === 'boolean') return { apiName: chart.apiName, kind: 'boolean', value: (bin.value ?? bin.label) === 'true' };
  if (chart.kind === 'histogram') return { apiName: chart.apiName, kind: 'range', lo: bin.lo, hi: bin.hi };
  if (chart.kind === 'timebucket') return { apiName: chart.apiName, kind: 'timerange', fromMs: bin.lo, toMs: bin.hi };
  return null;
}

/** Are two filters the same selection (used to toggle a bin on/off)? */
export function sameFilter(a: FacetFilter, b: FacetFilter): boolean {
  if (a.apiName !== b.apiName || a.kind !== b.kind) return false;
  if (a.kind === 'category' && b.kind === 'category') {
    return a.values.length === b.values.length && a.values.every((v) => b.values.includes(v));
  }
  if (a.kind === 'boolean' && b.kind === 'boolean') return a.value === b.value;
  if (a.kind === 'range' && b.kind === 'range') return a.lo === b.lo && a.hi === b.hi;
  if (a.kind === 'timerange' && b.kind === 'timerange') return a.fromMs === b.fromMs && a.toMs === b.toMs;
  return false;
}

function matchesOne(raw: unknown, f: FacetFilter): boolean {
  const occ = occurrences(raw);
  if (f.kind === 'category') {
    if (occ.length === 0) return false;
    const set = new Set(f.values);
    return occ.some((v) => set.has(String(v)));
  }
  if (f.kind === 'boolean') {
    const b = toBool(raw);
    return b !== null && b === f.value;
  }
  if (f.kind === 'range') {
    return occ.some((v) => {
      const n = toNum(v);
      if (n === null) return false;
      if (f.lo != null && n < f.lo) return false;
      if (f.hi != null && n > f.hi) return false;
      return true;
    });
  }
  // timerange — [fromMs, toMs) is a half-open bucket; treat toMs inclusive only
  // when it equals fromMs (single-instant edge case).
  return occ.some((v) => {
    const t = parseTimeMs(v);
    if (t === null) return false;
    if (f.fromMs != null && t < f.fromMs) return false;
    if (f.toMs != null && (f.toMs === f.fromMs ? t > f.toMs : t >= f.toMs)) return false;
    return true;
  });
}

/** Does an object satisfy a single filter (type-aware, array-aware)? */
export function objectMatchesFilter(obj: ExplorerObject, f: FacetFilter): boolean {
  return matchesOne(obj.properties?.[f.apiName], f);
}

/** AND all active filters over the fetched instance rows. */
export function applyFacetFilters(
  objects: readonly ExplorerObject[], filters: readonly FacetFilter[],
): ExplorerObject[] {
  if (!filters.length) return [...objects];
  return objects.filter((o) => filters.every((f) => objectMatchesFilter(o, f)));
}
