/**
 * lib/azure/synthetic-data-gen.ts — W12 (synthetic-data item type) generator.
 *
 * A self-contained, deterministic (seedable) synthetic-row generator: given a
 * per-column generation strategy (faker-style names / dates / categoricals /
 * numeric distributions), it produces N real rows to be written to a target
 * Delta table (via the Databricks createUcTableFromFile write path). Pure — no
 * Azure SDK, no network — so it is fully unit-testable and shared by the
 * preview + generate routes.
 *
 * PII posture (documented, per the W12 brief): every value is SYNTHESIZED FROM
 * SCRATCH — no source row is ever copied — so no real PII can be emitted by
 * construction. For a column classified PII/PHI/PCI the generator picks a
 * synthetic strategy (fake name / email / phone / address) or, when you want no
 * value at all, the `redacted` strategy emits a constant mask token. Real
 * personal data never enters the output.
 */

// ── Strategies ──────────────────────────────────────────────────────────────

export type GenStrategy =
  | 'sequence'
  | 'uuid'
  | 'integer'
  | 'decimal'
  | 'normal'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'categorical'
  | 'constant'
  | 'full_name'
  | 'first_name'
  | 'last_name'
  | 'email'
  | 'phone'
  | 'company'
  | 'city'
  | 'country'
  | 'street_address'
  | 'redacted';

export interface GenStrategyMeta {
  value: GenStrategy;
  label: string;
  /** Which typed option inputs the strategy uses. */
  needs: Array<'range' | 'precision' | 'distribution' | 'values' | 'dateRange' | 'constant' | 'startAt'>;
  /** True for strategies that synthesize person/PII-shaped values (fake, never real). */
  synthesizesPii?: boolean;
}

export const GEN_STRATEGIES: readonly GenStrategyMeta[] = [
  { value: 'sequence', label: 'Sequence (auto-increment)', needs: ['startAt'] },
  { value: 'uuid', label: 'UUID', needs: [] },
  { value: 'integer', label: 'Integer (uniform range)', needs: ['range'] },
  { value: 'decimal', label: 'Decimal (uniform range)', needs: ['range', 'precision'] },
  { value: 'normal', label: 'Number (normal distribution)', needs: ['distribution', 'precision'] },
  { value: 'boolean', label: 'Boolean', needs: [] },
  { value: 'date', label: 'Date (range)', needs: ['dateRange'] },
  { value: 'timestamp', label: 'Timestamp (range)', needs: ['dateRange'] },
  { value: 'categorical', label: 'Categorical (from values)', needs: ['values'] },
  { value: 'constant', label: 'Constant', needs: ['constant'] },
  { value: 'full_name', label: 'Full name (synthetic)', needs: [], synthesizesPii: true },
  { value: 'first_name', label: 'First name (synthetic)', needs: [], synthesizesPii: true },
  { value: 'last_name', label: 'Last name (synthetic)', needs: [], synthesizesPii: true },
  { value: 'email', label: 'Email (synthetic)', needs: [], synthesizesPii: true },
  { value: 'phone', label: 'Phone (synthetic)', needs: [], synthesizesPii: true },
  { value: 'company', label: 'Company (synthetic)', needs: [] },
  { value: 'city', label: 'City (synthetic)', needs: [] },
  { value: 'country', label: 'Country (synthetic)', needs: [] },
  { value: 'street_address', label: 'Street address (synthetic)', needs: [], synthesizesPii: true },
  { value: 'redacted', label: 'Redacted (mask token)', needs: [] },
];

export interface ColumnGenOptions {
  min?: number;
  max?: number;
  precision?: number;
  mean?: number;
  stddev?: number;
  values?: string[];
  start?: string;
  end?: string;
  constant?: string;
  /** Fraction (0..1) of NULLs to inject. */
  nullRate?: number;
  /** Sequence start (default 1). */
  startAt?: number;
}

export interface ColumnGenSpec {
  name: string;
  /** Logical/contract type — kept for downstream typing (informational). */
  type?: string;
  strategy: GenStrategy;
  /** True when the source column is classified as personal data. */
  pii?: boolean;
  options?: ColumnGenOptions;
}

// ── Curated synthetic word lists (small, non-identifying) ────────────────────

const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Barbara', 'Dennis', 'Radia', 'Ken', 'Margaret', 'Tim', 'Shafi', 'Vint', 'Anita', 'Guido', 'Frances'];
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Liskov', 'Ritchie', 'Perlman', 'Thompson', 'Hamilton', 'Berners-Lee', 'Goldwasser', 'Cerf', 'Borg', 'van Rossum', 'Allen'];
const COMPANIES = ['Northwind', 'Contoso', 'Fabrikam', 'Adventure Works', 'Tailwind', 'Wide World', 'Proseware', 'Litware', 'Coho', 'Fourth Coffee', 'Graphic Design', 'Wingtip'];
const CITIES = ['Redmond', 'Austin', 'Boston', 'Denver', 'Seattle', 'Chicago', 'Atlanta', 'Portland', 'Dublin', 'Toronto', 'Sydney', 'Berlin'];
const COUNTRIES = ['United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Australia', 'Ireland', 'Japan', 'Brazil', 'India'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Pine Rd', 'Elm Blvd', 'Lake View', 'Park Way', 'River Rd', 'Hill Ct'];
const REDACTED_TOKEN = '***';

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;
const intBetween = (rng: () => number, lo: number, hi: number): number => Math.floor(rng() * (hi - lo + 1)) + lo;

/** Box-Muller normal sample. */
function normalSample(rng: () => number, mean: number, stddev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(n: number, precision: number): number {
  const p = Math.max(0, Math.min(12, precision | 0));
  const f = Math.pow(10, p);
  return Math.round(n * f) / f;
}

const uuid = (rng: () => number): string => {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.floor(rng() * 4) + 8)];
    else out += hex[Math.floor(rng() * 16)];
  }
  return out;
};

// ── Per-column value ─────────────────────────────────────────────────────────

function valueFor(spec: ColumnGenSpec, rng: () => number, rowIndex: number): unknown {
  const o = spec.options || {};
  switch (spec.strategy) {
    case 'sequence': return (o.startAt ?? 1) + rowIndex;
    case 'uuid': return uuid(rng);
    case 'integer': return intBetween(rng, o.min ?? 0, o.max ?? 1000);
    case 'decimal': {
      const lo = o.min ?? 0, hi = o.max ?? 1000;
      return round(lo + rng() * (hi - lo), o.precision ?? 2);
    }
    case 'normal': return round(normalSample(rng, o.mean ?? 0, o.stddev ?? 1), o.precision ?? 2);
    case 'boolean': return rng() < 0.5;
    case 'date': {
      const start = Date.parse(o.start || '2020-01-01');
      const end = Date.parse(o.end || '2025-12-31');
      const t = start + Math.floor(rng() * Math.max(1, end - start));
      return new Date(t).toISOString().slice(0, 10);
    }
    case 'timestamp': {
      const start = Date.parse(o.start || '2020-01-01T00:00:00Z');
      const end = Date.parse(o.end || '2025-12-31T23:59:59Z');
      const t = start + Math.floor(rng() * Math.max(1, end - start));
      return new Date(t).toISOString();
    }
    case 'categorical': {
      const vals = o.values && o.values.length ? o.values : ['A', 'B', 'C'];
      return pick(rng, vals);
    }
    case 'constant': return o.constant ?? '';
    case 'first_name': return pick(rng, FIRST_NAMES);
    case 'last_name': return pick(rng, LAST_NAMES);
    case 'full_name': return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    case 'email': return `${pick(rng, FIRST_NAMES).toLowerCase()}.${pick(rng, LAST_NAMES).toLowerCase().replace(/[^a-z]/g, '')}${intBetween(rng, 1, 999)}@example.com`;
    case 'phone': return `+1-${intBetween(rng, 200, 989)}-${String(intBetween(rng, 0, 999)).padStart(3, '0')}-${String(intBetween(rng, 0, 9999)).padStart(4, '0')}`;
    case 'company': return pick(rng, COMPANIES);
    case 'city': return pick(rng, CITIES);
    case 'country': return pick(rng, COUNTRIES);
    case 'street_address': return `${intBetween(rng, 1, 9999)} ${pick(rng, STREETS)}`;
    case 'redacted': return REDACTED_TOKEN;
    default: return null;
  }
}

/**
 * Generate `rowCount` synthetic rows for the given column specs. Deterministic
 * for a fixed `seed` (same seed ⇒ identical rows), so a preview and the full
 * run reproduce the same head rows.
 */
export function generateRows(
  specs: ColumnGenSpec[],
  rowCount: number,
  seed = 1,
): Array<Record<string, unknown>> {
  const n = Math.max(0, Math.min(1_000_000, Math.floor(rowCount) || 0));
  const rng = mulberry32(seed);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (const spec of specs) {
      const nullRate = spec.options?.nullRate ?? 0;
      // Draw the null coin FIRST (before the value) so the stream stays stable.
      const isNull = nullRate > 0 && rng() < nullRate;
      const v = valueFor(spec, rng, i);
      row[spec.name] = isNull ? null : v;
    }
    rows.push(row);
  }
  return rows;
}

// ── Serialization ────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize rows to CSV (header + rows) for the createUcTableFromFile csv path. */
export function rowsToCsv(rows: Array<Record<string, unknown>>, specs: ColumnGenSpec[]): string {
  const header = specs.map((s) => csvCell(s.name)).join(',');
  const body = rows.map((r) => specs.map((s) => csvCell(r[s.name])).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}

// ── Strategy inference from a source schema (contract / table) ────────────────

/**
 * Suggest a generation strategy for a source column, from its name + type +
 * PII classification. A column classified PII/PHI/PCI is mapped to a SYNTHETIC
 * strategy (a fake name/email/phone/address) so no real PII can ever be
 * produced; a name-heuristic picks the closest synthetic shape.
 */
export function inferStrategy(col: { name: string; type?: string; classification?: string }): ColumnGenSpec {
  const name = (col.name || '').toLowerCase();
  const type = (col.type || 'string').toLowerCase();
  const cls = (col.classification || '').toLowerCase();
  const pii = cls === 'pii' || cls === 'phi' || cls === 'pci';

  const heuristic = (): GenStrategy | '' => {
    if (/e-?mail/.test(name)) return 'email';
    if (/phone|mobile|tel/.test(name)) return 'phone';
    if (/first.?name|given/.test(name)) return 'first_name';
    if (/last.?name|surname|family/.test(name)) return 'last_name';
    if (/full.?name|(^|_)name$/.test(name)) return 'full_name';
    if (/company|employer|org/.test(name)) return 'company';
    if (/city|town/.test(name)) return 'city';
    if (/country|nation/.test(name)) return 'country';
    if (/street|address|addr/.test(name)) return 'street_address';
    return '';
  };

  // PII → synthetic person-shape (or redacted if no shape matches).
  if (pii) {
    const h = heuristic();
    return { name: col.name, type: col.type, pii: true, strategy: (h || 'redacted') as GenStrategy };
  }

  // Non-PII → name heuristic first, then type-based default.
  const h = heuristic();
  if (h) return { name: col.name, type: col.type, strategy: h };

  let strategy: GenStrategy = 'constant';
  const options: ColumnGenOptions = {};
  if (/^id$|(_id)$/.test(name)) { strategy = 'sequence'; options.startAt = 1; }
  else if (type.includes('int') || type === 'bigint') { strategy = 'integer'; options.min = 0; options.max = 100000; }
  else if (type.includes('double') || type.includes('decimal') || type.includes('float')) { strategy = 'decimal'; options.min = 0; options.max = 10000; options.precision = 2; }
  else if (type === 'boolean') strategy = 'boolean';
  else if (type === 'date') { strategy = 'date'; options.start = '2020-01-01'; options.end = '2025-12-31'; }
  else if (type === 'timestamp') { strategy = 'timestamp'; options.start = '2020-01-01T00:00:00Z'; options.end = '2025-12-31T23:59:59Z'; }
  else { strategy = 'categorical'; options.values = ['alpha', 'beta', 'gamma']; }

  return { name: col.name, type: col.type, strategy, options };
}
