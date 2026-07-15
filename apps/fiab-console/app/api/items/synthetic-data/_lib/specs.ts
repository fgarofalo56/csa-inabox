/**
 * Server-side sanitizer for synthetic-data column generation specs (W12).
 * Underscore-prefixed folder — Next.js does not treat this as a route.
 *
 * Coerces an untrusted `specs` payload into a clean `ColumnGenSpec[]`: only
 * known strategies survive, column names are trimmed + bounded, numeric options
 * are clamped, and value lists are capped. Keeps the preview + generate routes
 * tiny and consistent.
 */
import { GEN_STRATEGIES, type ColumnGenSpec, type GenStrategy, type ColumnGenOptions } from '@/lib/azure/synthetic-data-gen';

const STRATEGY_SET = new Set<string>(GEN_STRATEGIES.map((s) => s.value));
const MAX_COLUMNS = 200;
const MAX_VALUES = 200;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function sanitizeOptions(raw: unknown): ColumnGenOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: ColumnGenOptions = {};
  if (num(o.min) !== undefined) out.min = num(o.min);
  if (num(o.max) !== undefined) out.max = num(o.max);
  if (num(o.precision) !== undefined) out.precision = Math.max(0, Math.min(12, Math.floor(num(o.precision)!)));
  if (num(o.mean) !== undefined) out.mean = num(o.mean);
  if (num(o.stddev) !== undefined) out.stddev = num(o.stddev);
  if (num(o.startAt) !== undefined) out.startAt = Math.floor(num(o.startAt)!);
  if (num(o.nullRate) !== undefined) out.nullRate = Math.max(0, Math.min(1, num(o.nullRate)!));
  if (typeof o.start === 'string') out.start = o.start.slice(0, 40);
  if (typeof o.end === 'string') out.end = o.end.slice(0, 40);
  if (typeof o.constant === 'string') out.constant = o.constant.slice(0, 4000);
  if (Array.isArray(o.values)) {
    out.values = o.values.filter((v) => typeof v === 'string').slice(0, MAX_VALUES).map((v) => (v as string).slice(0, 400));
  }
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeSpecs(raw: unknown): ColumnGenSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ColumnGenSpec[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, MAX_COLUMNS)) {
    if (!r || typeof r !== 'object') continue;
    const c = r as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 200) : '';
    if (!name || seen.has(name)) continue;
    const strategy = typeof c.strategy === 'string' && STRATEGY_SET.has(c.strategy) ? (c.strategy as GenStrategy) : undefined;
    if (!strategy) continue;
    seen.add(name);
    const spec: ColumnGenSpec = { name, strategy };
    if (typeof c.type === 'string') spec.type = c.type.slice(0, 60);
    if (c.pii === true) spec.pii = true;
    const options = sanitizeOptions(c.options);
    if (options) spec.options = options;
    out.push(spec);
  }
  return out;
}
