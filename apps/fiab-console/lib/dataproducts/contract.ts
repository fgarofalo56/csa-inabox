/**
 * Data contract model — the formal, machine-checkable agreement a data product
 * publishes to its consumers. Framework-neutral (NO 'use client') so both the
 * BFF routes (app/api/data-products/[id]/route.ts + app/api/data-products/route.ts)
 * and the editor component (lib/editors/components/data-contract-designer.tsx)
 * import the SAME enums + sanitizer — front end and back end can never drift.
 *
 * This is the data-mesh / Microsoft Fabric "data contract" concept and the
 * structured form of the SLA the Purview Unified Catalog data-product page only
 * shows as free text: an output-port SCHEMA (typed columns + semantics + PII
 * classification), quantified SERVICE-LEVEL OBJECTIVES (freshness, availability,
 * latency, completeness, retention, support response), and a set of data-quality
 * EXPECTATIONS (not-null / unique / range / accepted-values / regex …) the
 * product commits to. Persisted to the data-product WorkspaceItem's
 * `state.contract` (Cosmos) — Azure-native, no Fabric/Power BI dependency.
 *
 * Grounding: Open Data Contract Standard (ODCS) schema + SLA/quality sections,
 * and Microsoft Fabric data-type families. Everything is picked from the enums
 * below (no free-typed JSON — see .claude/rules/loom_no_freeform_config.md).
 */

/** Physical/logical column data types — Fabric/Delta + SQL type families. */
export const CONTRACT_COLUMN_TYPES = [
  'string',
  'integer',
  'bigint',
  'double',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'binary',
  'array',
  'map',
  'struct',
  'geography',
  'variant',
] as const;
export type ContractColumnType = (typeof CONTRACT_COLUMN_TYPES)[number];

/** Sensitivity / governance classification for a column (drives DLP + policy). */
export const CONTRACT_CLASSIFICATIONS = [
  'None',
  'Public',
  'Internal',
  'Confidential',
  'Highly Confidential',
  'PII',
  'PHI',
  'PCI',
  'Financial',
] as const;
export type ContractClassification = (typeof CONTRACT_CLASSIFICATIONS)[number];

/** Data freshness / update cadence the product commits to. */
export const SLO_FRESHNESS = [
  'Real-time',
  'Every 5 minutes',
  'Every 15 minutes',
  'Hourly',
  'Daily',
  'Weekly',
  'Monthly',
  'Quarterly',
] as const;

/** Availability targets (uptime of the serving surface). */
export const SLO_AVAILABILITY = ['99%', '99.5%', '99.9%', '99.95%', '99.99%'] as const;

/** Support / incident response commitment. */
export const SLO_SUPPORT_RESPONSE = [
  '1 hour',
  '4 hours',
  '8 business hours',
  '1 business day',
  '3 business days',
  'Best effort',
] as const;

/** Retention window for the underlying data. */
export const SLO_RETENTION = [
  '7 days',
  '30 days',
  '90 days',
  '1 year',
  '3 years',
  '7 years',
  'Indefinite',
] as const;

/** Data-quality expectation kinds the product commits to enforce. */
export const QUALITY_RULES = [
  { value: 'not_null', label: 'Not null', needsValue: false },
  { value: 'unique', label: 'Unique', needsValue: false },
  { value: 'primary_key', label: 'Primary key (unique + not null)', needsValue: false },
  { value: 'accepted_values', label: 'Accepted values (comma-separated)', needsValue: true },
  { value: 'min', label: 'Minimum value', needsValue: true },
  { value: 'max', label: 'Maximum value', needsValue: true },
  { value: 'range', label: 'In range (min..max)', needsValue: true },
  { value: 'regex', label: 'Matches pattern (regex)', needsValue: true },
  { value: 'freshness', label: 'Freshness (max age, e.g. 24h)', needsValue: true },
  { value: 'row_count', label: 'Row count (min rows)', needsValue: true },
] as const;
export const QUALITY_RULE_VALUES: readonly string[] = QUALITY_RULES.map((r) => r.value);
export const QUALITY_SEVERITIES = ['error', 'warning'] as const;
export type QualitySeverity = (typeof QUALITY_SEVERITIES)[number];

// ---- Model ----------------------------------------------------------------

export interface ContractColumn {
  name: string;
  type: ContractColumnType;
  description?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  classification?: ContractClassification;
}

export interface ContractSlo {
  freshness?: string;
  availability?: string;
  latencyP95?: string;
  completeness?: string;
  retention?: string;
  supportResponse?: string;
}

export interface QualityExpectation {
  id: string;
  /** '' / undefined = a table-level expectation; else the column name. */
  column?: string;
  rule: string;
  value?: string;
  severity: QualitySeverity;
}

export interface DataContract {
  /** Semantic version of the contract (e.g. "1.0.0"). */
  version?: string;
  schema?: ContractColumn[];
  slo?: ContractSlo;
  quality?: QualityExpectation[];
  /** Stamped by the sanitizer on every successful save. */
  updatedAt?: string;
}

/** An empty, well-formed contract the designer starts from. */
export const EMPTY_CONTRACT: DataContract = { version: '1.0.0', schema: [], slo: {}, quality: [] };

// Bounded to keep a single Cosmos doc reasonable (defensive, not user-facing).
const MAX_COLUMNS = 500;
const MAX_RULES = 500;
const STR_MAX = 4000;

function cleanStr(v: unknown, max = 400): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

/**
 * Validate + normalise an inbound data contract. Returns the cleaned contract,
 * or null when the top-level shape is invalid (so the route can 400). Unknown
 * column types / classifications / quality rules are dropped to their nearest
 * safe default rather than rejected wholesale, so a partially-built contract
 * from the wizard still round-trips.
 */
export function sanitizeContract(input: unknown): DataContract | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;

  const out: DataContract = {};

  const version = cleanStr(o.version, 40);
  if (version) out.version = version;

  // ---- schema ----
  if (o.schema !== undefined) {
    if (!Array.isArray(o.schema)) return null;
    const cols: ContractColumn[] = [];
    for (const raw of o.schema.slice(0, MAX_COLUMNS)) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      const name = cleanStr(c.name, 200);
      if (!name) continue; // a column MUST have a name
      const typeIn = typeof c.type === 'string' ? c.type : '';
      const type = (CONTRACT_COLUMN_TYPES as readonly string[]).includes(typeIn)
        ? (typeIn as ContractColumnType)
        : 'string';
      const col: ContractColumn = { name, type };
      const description = cleanStr(c.description, STR_MAX);
      if (description) col.description = description;
      if (c.nullable === true) col.nullable = true;
      if (c.primaryKey === true) col.primaryKey = true;
      const cls = typeof c.classification === 'string' ? c.classification : '';
      if ((CONTRACT_CLASSIFICATIONS as readonly string[]).includes(cls) && cls !== 'None') {
        col.classification = cls as ContractClassification;
      }
      cols.push(col);
    }
    out.schema = cols;
  }

  // ---- slo ----
  if (o.slo !== undefined) {
    if (o.slo === null || typeof o.slo !== 'object' || Array.isArray(o.slo)) return null;
    const si = o.slo as Record<string, unknown>;
    const slo: ContractSlo = {};
    const freshness = cleanStr(si.freshness, 80);
    if (freshness) slo.freshness = freshness;
    const availability = cleanStr(si.availability, 40);
    if (availability) slo.availability = availability;
    const latencyP95 = cleanStr(si.latencyP95, 80);
    if (latencyP95) slo.latencyP95 = latencyP95;
    const completeness = cleanStr(si.completeness, 40);
    if (completeness) slo.completeness = completeness;
    const retention = cleanStr(si.retention, 80);
    if (retention) slo.retention = retention;
    const supportResponse = cleanStr(si.supportResponse, 80);
    if (supportResponse) slo.supportResponse = supportResponse;
    out.slo = slo;
  }

  // ---- quality ----
  if (o.quality !== undefined) {
    if (!Array.isArray(o.quality)) return null;
    const rules: QualityExpectation[] = [];
    for (const raw of o.quality.slice(0, MAX_RULES)) {
      if (!raw || typeof raw !== 'object') continue;
      const q = raw as Record<string, unknown>;
      const ruleIn = typeof q.rule === 'string' ? q.rule : '';
      if (!QUALITY_RULE_VALUES.includes(ruleIn)) continue; // rule MUST be known
      const severityIn = typeof q.severity === 'string' ? q.severity : '';
      const severity: QualitySeverity = (QUALITY_SEVERITIES as readonly string[]).includes(severityIn)
        ? (severityIn as QualitySeverity)
        : 'error';
      const expectation: QualityExpectation = {
        id: cleanStr(q.id, 60) || crypto.randomUUID(),
        rule: ruleIn,
        severity,
      };
      const column = cleanStr(q.column, 200);
      if (column) expectation.column = column;
      const value = cleanStr(q.value, 400);
      if (value) expectation.value = value;
      rules.push(expectation);
    }
    out.quality = rules;
  }

  out.updatedAt = new Date().toISOString();
  return out;
}

/**
 * A tiny readiness summary of a contract — used by the studio + detail badges.
 * `defined` is true once the contract carries any real content (schema/SLO/DQ).
 */
export function contractStats(contract: DataContract | undefined | null): {
  defined: boolean;
  columns: number;
  slos: number;
  expectations: number;
} {
  const c = contract ?? {};
  const columns = Array.isArray(c.schema) ? c.schema.length : 0;
  const slos = c.slo ? Object.values(c.slo).filter((v) => !!v).length : 0;
  const expectations = Array.isArray(c.quality) ? c.quality.length : 0;
  return { defined: columns > 0 || slos > 0 || expectations > 0, columns, slos, expectations };
}
