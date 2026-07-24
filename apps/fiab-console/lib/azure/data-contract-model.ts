/**
 * loom-data-contracts — ODCS v3.1 doc shape + PURE conversion/validation
 * helpers + MIG1 versioned migration registration for N6 (ODCS data contracts
 * ENFORCED at ingestion).
 *
 * ODCS (Open Data Contract Standard, Linux Foundation / Bitol) v3.1 is the
 * contract standard. The 2026 lesson is that winners **enforce**: a contract
 * that is only documentation is a wish. So one doc per registered
 * `data-contract` item carries THREE things:
 *
 *   1. `odcs` — the contract itself, stored as ODCS 3.1 JSON (the portable
 *      artifact; import/export round-trips through it byte-for-byte on the
 *      fields the standard defines).
 *   2. `enforcement` — HOW the contract behaves at ingestion. The DEFAULT
 *      (operator-confirmed) is **default-ON in `warn-quarantine` mode**: a
 *      violating row is diverted to a Bronze `_rejected` dead-letter path and
 *      an O1 alert fires, but the rest of the batch STILL LANDS. A bad
 *      contract can therefore never silently drop a production load on day
 *      one. `hard-reject` (fail the whole batch) is a per-contract OPT-IN.
 *   3. `bindings` — WHICH ingestion targets the contract governs (mirroring
 *      engine tables, pipeline/copy sinks, eventstream hubs).
 *
 * Plus `runs` — a bounded pass/fail trend the governance registry renders.
 *
 * This module is a LEAF: it imports ONLY `cosmos-migrations` and the pure,
 * import-free `@/lib/dataproducts/contract` enum module (no cosmos-client, no
 * Azure SDK, no next), so `cosmos-client` can import it at module scope to
 * register the migrator chain before any read materializes — the
 * lakehouse-interop-model / semantic-contract-model / prompt-registry-model
 * precedent. It is therefore also safe to import from a client component for
 * the shared types + validators (the editor's import dialog renders the SAME
 * per-field errors the BFF returns).
 *
 * CURRENT SCHEMA VERSION: 1 (every doc is stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps DATA_CONTRACT_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator in {@link registerDataContractMigrators}
 * (called at module scope). Per MIG1 there is deliberately NO v1 migrator today.
 *
 * Per-cloud: pure Loom + Azure — Commercial / GCC-High / IL5 identical. The doc
 * is metadata in the deployment's OWN Cosmos; enforcement writes dead-letter
 * files to the deployment's OWN ADLS Gen2 Bronze container and alerts through
 * the in-boundary O1 action group. SOVEREIGN MOAT / **IL5**: nothing here
 * reaches a public endpoint — the whole contract lifecycle (author, validate,
 * enforce, quarantine, alert, report) runs DISCONNECTED inside an IL5 / air-gap
 * enclave on in-boundary services only. No Microsoft Fabric, no Power BI
 * workspace, no Bitol/GitHub call at runtime (the ODCS shape is compiled in).
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';
import {
  CONTRACT_COLUMN_TYPES,
  CONTRACT_CLASSIFICATIONS,
  QUALITY_RULE_VALUES,
  QUALITY_SEVERITIES,
  type ContractColumn,
  type ContractColumnType,
  type ContractClassification,
  type ContractSlo,
  type DataContract,
  type QualityExpectation,
  type QualitySeverity,
} from '@/lib/dataproducts/contract';

export const DATA_CONTRACT_CONTAINER = 'loom-data-contracts';
export const DATA_CONTRACT_SCHEMA_VERSION = 1;

/** The ODCS release Loom emits and validates against. */
export const ODCS_API_VERSION = 'v3.1.0';
/** ODCS `kind` — the only legal value for a data contract document. */
export const ODCS_KIND = 'DataContract';

/** ODCS §fundamentals `status` enum. */
export const ODCS_STATUSES = ['proposed', 'draft', 'active', 'deprecated', 'retired'] as const;
export type OdcsStatus = (typeof ODCS_STATUSES)[number];

/** ODCS §schema `logicalType` enum (objects are always `object`). */
export const ODCS_LOGICAL_TYPES = ['string', 'date', 'number', 'integer', 'object', 'array', 'boolean'] as const;
export type OdcsLogicalType = (typeof ODCS_LOGICAL_TYPES)[number];

/** ODCS §quality `type` enum. */
export const ODCS_QUALITY_TYPES = ['text', 'library', 'sql', 'custom'] as const;
export type OdcsQualityType = (typeof ODCS_QUALITY_TYPES)[number];

/** ODCS §quality `dimension` enum (the six DAMA dimensions ODCS names). */
export const ODCS_QUALITY_DIMENSIONS = [
  'accuracy', 'completeness', 'conformity', 'consistency', 'coverage', 'timeliness', 'uniqueness',
] as const;
export type OdcsQualityDimension = (typeof ODCS_QUALITY_DIMENSIONS)[number];

/** ODCS §quality `severity` — Loom emits the two the designer offers. */
export const ODCS_SEVERITIES = ['info', 'warning', 'error'] as const;

/** ODCS v3.1 predefined library rules Loom emits. */
export const ODCS_LIBRARY_RULES = ['nullValues', 'duplicateValues', 'invalidValues', 'missingValues', 'rowCount'] as const;

// ── ODCS 3.1 document shape (the subset Loom authors + validates) ───────────

export interface OdcsCustomProperty { property: string; value: unknown }

export interface OdcsDescription {
  purpose?: string;
  limitations?: string;
  usage?: string;
}

export interface OdcsQualityRule {
  /** 'library' | 'text' | 'sql' | 'custom'. */
  type: OdcsQualityType;
  /** Library rule name — REQUIRED when `type` is 'library'. */
  rule?: string;
  name?: string;
  description?: string;
  dimension?: OdcsQualityDimension;
  severity?: string;
  unit?: string;
  validValues?: unknown[];
  query?: string;
  engine?: string;
  implementation?: string;
  mustBe?: number;
  mustBeGreaterThan?: number;
  mustBeLessThan?: number;
  mustBeGreaterOrEqualTo?: number;
  mustBeLessOrEqualTo?: number;
  customProperties?: OdcsCustomProperty[];
}

export interface OdcsProperty {
  name: string;
  logicalType: OdcsLogicalType;
  physicalType?: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  primaryKeyPosition?: number;
  partitioned?: boolean;
  classification?: string;
  criticalDataElement?: boolean;
  examples?: unknown[];
  quality?: OdcsQualityRule[];
  customProperties?: OdcsCustomProperty[];
}

export interface OdcsSchemaObject {
  name: string;
  physicalName?: string;
  logicalType: 'object';
  physicalType?: string;
  description?: string;
  dataGranularityDescription?: string;
  properties?: OdcsProperty[];
  /** Object-level (table-level) quality rules — Loom's table-scoped expectations. */
  quality?: OdcsQualityRule[];
  customProperties?: OdcsCustomProperty[];
}

export interface OdcsSlaProperty {
  property: string;
  value: string | number;
  valueExt?: string | number;
  unit?: string;
  element?: string;
  driver?: string;
}

export interface OdcsContract {
  apiVersion: string;
  kind: string;
  id: string;
  version: string;
  status: string;
  name?: string;
  tenant?: string;
  domain?: string;
  dataProduct?: string;
  description?: OdcsDescription;
  schema?: OdcsSchemaObject[];
  slaProperties?: OdcsSlaProperty[];
  tags?: string[];
  customProperties?: OdcsCustomProperty[];
  contractCreatedTs?: string;
}

// ── Enforcement ────────────────────────────────────────────────────────────

/**
 * How a contract behaves when a row violates it at ingestion.
 *
 * - `warn-quarantine` — **THE DEFAULT.** Conforming rows LAND; violating rows
 *   are written to the Bronze `_rejected` dead-letter path and an O1 alert
 *   fires. The load is never dropped.
 * - `hard-reject` — OPT-IN. A single error-severity violation fails the WHOLE
 *   batch: nothing lands, everything goes to the dead-letter path, the alert
 *   escalates to P1. Only enable this once the contract is proven.
 */
export const ENFORCEMENT_MODES = ['warn-quarantine', 'hard-reject'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/**
 * THE DEFAULT ENFORCEMENT MODE (operator-CONFIRMED, unit-tested).
 * Enforcement is default-ON (loom_default_on_opt_out) but in the SAFE mode:
 * warn + quarantine-to-dead-letter, NOT hard-reject-the-batch.
 */
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = 'warn-quarantine';

/** Ingestion paths a contract can be bound to. */
export const BINDING_KINDS = ['mirrored-database', 'data-pipeline', 'eventstream'] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

/** ONE governed ingestion target. */
export interface DataContractBinding {
  id: string;
  kind: BindingKind;
  /** The Loom item id of the mirror / pipeline / eventstream. */
  targetItemId: string;
  targetItemName?: string;
  /**
   * The dataset inside that target the contract governs: `schema.table` for a
   * mirror, the sink table for a pipeline, the hub/stream name for an
   * eventstream. `*` governs every dataset of the target.
   */
  dataset: string;
  enabled: boolean;
  boundAt: string;
  boundBy: string;
}

/** Per-batch enforcement outcome recorded for the pass/fail trend. */
export interface EnforcementRun {
  id: string;
  at: string;
  /** Which ingestion path produced this batch. */
  source: BindingKind;
  targetItemId: string;
  dataset: string;
  mode: EnforcementMode;
  evaluated: number;
  accepted: number;
  rejected: number;
  decision: EnforcementDecisionKind;
  deadLetterPath?: string;
  alerted: boolean;
  /** Top violated rules (bounded) — what the trend chart annotates. */
  topViolations?: Array<{ rule: string; column?: string; count: number }>;
}

/** The three terminal outcomes of an enforced batch. */
export type EnforcementDecisionKind = 'landed' | 'landed-with-quarantine' | 'rejected-batch';

/** Cap the run history carried on a single Cosmos doc. */
export const MAX_RUNS_PER_DOC = 50;

/** The `loom-data-contracts` doc. PK /tenantId; id `contract:<itemId>`. */
export interface DataContractDoc {
  id: string;
  /** Partition key — the owning principal's Entra oid (Loom tenant scope). */
  tenantId: string;
  docType: 'data-contract';
  /** The `data-contract` WorkspaceItem this registry row mirrors. */
  itemId: string;
  displayName: string;
  workspaceId?: string;
  odcs: OdcsContract;
  enforcement: { enabled: boolean; mode: EnforcementMode };
  bindings: DataContractBinding[];
  runs: EnforcementRun[];
  schemaVersion: number;
  updatedAt: string;
  updatedBy: string;
}

/** Cosmos id for an item's registry doc. */
export function dataContractDocId(itemId: string): string {
  return `contract:${String(itemId).trim()}`;
}

/** A fresh, well-formed registry doc (used when Cosmos has none yet). */
export function emptyDataContractDoc(
  tenantId: string,
  itemId: string,
  displayName: string,
  updatedBy: string,
): DataContractDoc {
  const now = new Date().toISOString();
  return {
    id: dataContractDocId(itemId),
    tenantId,
    docType: 'data-contract',
    itemId,
    displayName,
    odcs: emptyOdcsContract(itemId, displayName),
    // Default-ON in the SAFE mode — see DEFAULT_ENFORCEMENT_MODE.
    enforcement: { enabled: true, mode: DEFAULT_ENFORCEMENT_MODE },
    bindings: [],
    runs: [],
    schemaVersion: DATA_CONTRACT_SCHEMA_VERSION,
    updatedAt: now,
    updatedBy,
  };
}

/** A minimal, VALID ODCS 3.1 contract skeleton. */
export function emptyOdcsContract(id: string, name: string): OdcsContract {
  return {
    apiVersion: ODCS_API_VERSION,
    kind: ODCS_KIND,
    id: id || 'loom-data-contract',
    version: '1.0.0',
    status: 'draft',
    name: name || 'Data contract',
    schema: [],
    slaProperties: [],
  };
}

// ── Loom ⇄ ODCS type mapping ───────────────────────────────────────────────

interface OdcsTypePair { logicalType: OdcsLogicalType; physicalType: string }

/** Loom designer column type → ODCS logical + physical type. */
export const LOOM_TYPE_TO_ODCS: Record<ContractColumnType, OdcsTypePair> = {
  string: { logicalType: 'string', physicalType: 'string' },
  integer: { logicalType: 'integer', physicalType: 'int' },
  bigint: { logicalType: 'integer', physicalType: 'bigint' },
  double: { logicalType: 'number', physicalType: 'double' },
  decimal: { logicalType: 'number', physicalType: 'decimal' },
  boolean: { logicalType: 'boolean', physicalType: 'boolean' },
  date: { logicalType: 'date', physicalType: 'date' },
  timestamp: { logicalType: 'date', physicalType: 'timestamp' },
  binary: { logicalType: 'string', physicalType: 'binary' },
  array: { logicalType: 'array', physicalType: 'array' },
  map: { logicalType: 'object', physicalType: 'map' },
  struct: { logicalType: 'object', physicalType: 'struct' },
  geography: { logicalType: 'string', physicalType: 'geography' },
  variant: { logicalType: 'string', physicalType: 'variant' },
};

/** ODCS logical type → the Loom designer type used when no physicalType matches. */
const ODCS_LOGICAL_FALLBACK: Record<OdcsLogicalType, ContractColumnType> = {
  string: 'string',
  date: 'timestamp',
  number: 'double',
  integer: 'integer',
  object: 'struct',
  array: 'array',
  boolean: 'boolean',
};

/** ODCS (logicalType, physicalType) → the Loom designer column type. */
export function loomTypeFromOdcs(logicalType: string, physicalType?: string): ContractColumnType {
  const phys = String(physicalType || '').trim().toLowerCase();
  if (phys) {
    for (const t of CONTRACT_COLUMN_TYPES) {
      if (LOOM_TYPE_TO_ODCS[t].physicalType === phys) return t;
    }
  }
  const logical = String(logicalType || '').trim().toLowerCase() as OdcsLogicalType;
  return ODCS_LOGICAL_FALLBACK[logical] ?? 'string';
}

// ── Loom ⇄ ODCS quality mapping ────────────────────────────────────────────

/** Loom rule → the ODCS v3.1 library rule that expresses it exactly (if any). */
const LOOM_RULE_TO_LIBRARY: Record<string, { rule: string; dimension: OdcsQualityDimension }> = {
  not_null: { rule: 'nullValues', dimension: 'completeness' },
  unique: { rule: 'duplicateValues', dimension: 'uniqueness' },
  primary_key: { rule: 'duplicateValues', dimension: 'uniqueness' },
  accepted_values: { rule: 'invalidValues', dimension: 'conformity' },
  row_count: { rule: 'rowCount', dimension: 'completeness' },
};

/** Loom rules with no exact ODCS library equivalent → `custom` + engine 'loom'. */
const LOOM_CUSTOM_DIMENSION: Record<string, OdcsQualityDimension> = {
  min: 'accuracy',
  max: 'accuracy',
  range: 'accuracy',
  regex: 'conformity',
  freshness: 'timeliness',
};

const CP_RULE = 'loomRule';
const CP_VALUE = 'loomValue';
const CP_ID = 'loomExpectationId';

function customProp(list: OdcsCustomProperty[] | undefined, key: string): string | undefined {
  const hit = (list || []).find((c) => c && c.property === key);
  return hit && hit.value != null ? String(hit.value) : undefined;
}

/**
 * PURE — one Loom quality expectation → one ODCS 3.1 quality rule. Every rule
 * carries `customProperties` naming the originating Loom rule/value/id so an
 * export→import round-trip is LOSSLESS even for rules ODCS has no library
 * primitive for.
 */
export function odcsRuleFromExpectation(e: QualityExpectation): OdcsQualityRule {
  const cp: OdcsCustomProperty[] = [
    { property: CP_RULE, value: e.rule },
    { property: CP_ID, value: e.id },
  ];
  if (e.value != null && e.value !== '') cp.push({ property: CP_VALUE, value: e.value });

  const lib = LOOM_RULE_TO_LIBRARY[e.rule];
  if (lib) {
    const out: OdcsQualityRule = {
      type: 'library',
      rule: lib.rule,
      dimension: lib.dimension,
      severity: e.severity,
      customProperties: cp,
    };
    if (e.rule === 'accepted_values' && e.value) {
      out.validValues = e.value.split(',').map((v) => v.trim()).filter(Boolean);
      out.mustBe = 0;
    } else if (e.rule === 'row_count') {
      const n = Number(e.value);
      out.mustBeGreaterOrEqualTo = Number.isFinite(n) ? n : 1;
    } else {
      out.mustBe = 0;
    }
    return out;
  }
  return {
    type: 'custom',
    engine: 'loom',
    implementation: `${e.rule}:${e.value ?? ''}`,
    dimension: LOOM_CUSTOM_DIMENSION[e.rule] ?? 'accuracy',
    severity: e.severity,
    customProperties: cp,
  };
}

/**
 * PURE — one ODCS quality rule → the Loom expectation it came from.
 * `column` is supplied by the caller (property-level rules) or omitted
 * (object-level rules). Returns null when the rule names no Loom rule Loom can
 * evaluate — an imported third-party contract keeps its ODCS rule in `odcs`
 * but only Loom-evaluable rules become live expectations (honest: Loom never
 * claims to run a rule it cannot).
 */
export function expectationFromOdcsRule(
  r: OdcsQualityRule,
  column?: string,
): QualityExpectation | null {
  let rule = customProp(r.customProperties, CP_RULE);
  let value = customProp(r.customProperties, CP_VALUE);
  if (!rule) {
    // Third-party contract: recover the Loom rule from the ODCS primitive.
    if (r.type === 'library') {
      if (r.rule === 'nullValues') rule = 'not_null';
      else if (r.rule === 'duplicateValues') rule = 'unique';
      else if (r.rule === 'invalidValues' && Array.isArray(r.validValues)) {
        rule = 'accepted_values';
        value = r.validValues.map((v) => String(v)).join(',');
      } else if (r.rule === 'rowCount') {
        rule = 'row_count';
        const n = r.mustBeGreaterOrEqualTo ?? r.mustBeGreaterThan ?? r.mustBe;
        value = n != null ? String(n) : '1';
      }
    } else if (r.type === 'custom' && typeof r.implementation === 'string' && r.implementation.includes(':')) {
      const idx = r.implementation.indexOf(':');
      rule = r.implementation.slice(0, idx);
      value = r.implementation.slice(idx + 1);
    }
  }
  if (!rule || !QUALITY_RULE_VALUES.includes(rule)) return null;
  const sevIn = String(r.severity || '').toLowerCase();
  const severity: QualitySeverity = (QUALITY_SEVERITIES as readonly string[]).includes(sevIn)
    ? (sevIn as QualitySeverity)
    : 'error';
  const out: QualityExpectation = {
    id: customProp(r.customProperties, CP_ID) || `q-${rule}-${column || 'table'}`,
    rule,
    severity,
  };
  if (column) out.column = column;
  if (value != null && value !== '') out.value = value;
  return out;
}

// ── Loom ⇄ ODCS SLA mapping ────────────────────────────────────────────────

/** Loom SLO field → ODCS `slaProperties[].property` name. */
export const LOOM_SLO_TO_ODCS: Record<keyof ContractSlo, string> = {
  freshness: 'frequency',
  availability: 'availability',
  latencyP95: 'latency',
  completeness: 'completeness',
  retention: 'retention',
  supportResponse: 'supportResponse',
};

const ODCS_TO_LOOM_SLO: Record<string, keyof ContractSlo> = Object.entries(LOOM_SLO_TO_ODCS)
  .reduce((acc, [loom, odcs]) => { acc[odcs] = loom as keyof ContractSlo; return acc; }, {} as Record<string, keyof ContractSlo>);

// ── Conversion ─────────────────────────────────────────────────────────────

export interface OdcsMeta {
  /** Stable contract id (the Loom item id). */
  id: string;
  name: string;
  status?: OdcsStatus;
  domain?: string;
  dataProduct?: string;
  tenant?: string;
  /** The physical object the contract describes (`schema.table` / table name). */
  objectName?: string;
  description?: OdcsDescription;
}

/**
 * PURE — Loom `DataContract` (typed designer state) → ODCS 3.1 JSON.
 * Column-scoped expectations attach to their property's `quality[]`;
 * table-scoped expectations attach to the schema object's `quality[]`.
 */
export function toOdcs(contract: DataContract | null | undefined, meta: OdcsMeta): OdcsContract {
  const c = contract ?? {};
  const objectName = (meta.objectName || meta.name || 'dataset').trim() || 'dataset';
  const columns = Array.isArray(c.schema) ? c.schema : [];
  const expectations = Array.isArray(c.quality) ? c.quality : [];

  const byColumn = new Map<string, QualityExpectation[]>();
  const tableLevel: QualityExpectation[] = [];
  for (const e of expectations) {
    if (e.column) {
      const list = byColumn.get(e.column) || [];
      list.push(e);
      byColumn.set(e.column, list);
    } else {
      tableLevel.push(e);
    }
  }

  const properties: OdcsProperty[] = columns.map((col, i) => {
    const pair = LOOM_TYPE_TO_ODCS[col.type] ?? LOOM_TYPE_TO_ODCS.string;
    const rules = byColumn.get(col.name) || [];
    const p: OdcsProperty = {
      name: col.name,
      logicalType: pair.logicalType,
      physicalType: pair.physicalType,
      // ODCS `required` is the inverse of the designer's `nullable`.
      required: col.nullable !== true,
    };
    if (col.description) p.description = col.description;
    if (col.primaryKey) { p.primaryKey = true; p.primaryKeyPosition = i + 1; }
    if (col.classification) p.classification = col.classification;
    if (rules.some((r) => r.rule === 'unique' || r.rule === 'primary_key')) p.unique = true;
    if (rules.length) p.quality = rules.map(odcsRuleFromExpectation);
    return p;
  });

  const object: OdcsSchemaObject = {
    name: objectName,
    physicalName: objectName,
    logicalType: 'object',
    physicalType: 'table',
    properties,
  };
  if (tableLevel.length) object.quality = tableLevel.map(odcsRuleFromExpectation);

  const slaProperties: OdcsSlaProperty[] = [];
  const slo = c.slo || {};
  for (const key of Object.keys(LOOM_SLO_TO_ODCS) as Array<keyof ContractSlo>) {
    const v = slo[key];
    if (v) slaProperties.push({ property: LOOM_SLO_TO_ODCS[key], value: v, element: objectName });
  }

  const out: OdcsContract = {
    apiVersion: ODCS_API_VERSION,
    kind: ODCS_KIND,
    id: meta.id,
    version: c.version || '1.0.0',
    status: meta.status || 'draft',
    name: meta.name,
    schema: [object],
    slaProperties,
  };
  if (meta.domain) out.domain = meta.domain;
  if (meta.dataProduct) out.dataProduct = meta.dataProduct;
  if (meta.tenant) out.tenant = meta.tenant;
  if (meta.description) out.description = meta.description;
  if (c.updatedAt) out.contractCreatedTs = c.updatedAt;
  return out;
}

/**
 * PURE — ODCS 3.1 JSON → the Loom `DataContract` the typed designer renders.
 * Reads the FIRST schema object (Loom's designer is single-object today; extra
 * objects are preserved verbatim in the stored `odcs` and simply not surfaced
 * in the designer — import is never lossy at the storage layer).
 */
export function fromOdcs(odcs: OdcsContract): DataContract {
  const object = Array.isArray(odcs.schema) ? odcs.schema[0] : undefined;
  const props = object && Array.isArray(object.properties) ? object.properties : [];

  const schema: ContractColumn[] = props.map((p) => {
    const col: ContractColumn = { name: p.name, type: loomTypeFromOdcs(p.logicalType, p.physicalType) };
    if (p.description) col.description = p.description;
    if (p.required === false) col.nullable = true;
    if (p.primaryKey) col.primaryKey = true;
    const cls = String(p.classification || '');
    if ((CONTRACT_CLASSIFICATIONS as readonly string[]).includes(cls) && cls !== 'None') {
      col.classification = cls as ContractClassification;
    }
    return col;
  });

  const quality: QualityExpectation[] = [];
  for (const p of props) {
    for (const r of p.quality || []) {
      const e = expectationFromOdcsRule(r, p.name);
      if (e) quality.push(e);
    }
  }
  for (const r of (object && object.quality) || []) {
    const e = expectationFromOdcsRule(r);
    if (e) quality.push(e);
  }

  const slo: ContractSlo = {};
  for (const sla of odcs.slaProperties || []) {
    const key = ODCS_TO_LOOM_SLO[String(sla.property || '')];
    if (key && sla.value != null) slo[key] = String(sla.value);
  }

  return {
    version: odcs.version || '1.0.0',
    schema,
    slo,
    quality,
    updatedAt: odcs.contractCreatedTs || new Date().toISOString(),
  };
}

// ── Validation (precise, per-field) ────────────────────────────────────────

/** One precise validation failure — `path` is the exact offending field. */
export interface OdcsFieldError {
  path: string;
  message: string;
}

export interface OdcsValidationResult {
  ok: boolean;
  errors: OdcsFieldError[];
  /** The normalized contract — present ONLY when `ok` is true. */
  contract?: OdcsContract;
}

/** Bounded so one pasted document can't blow a Cosmos doc or the heap. */
const MAX_OBJECTS = 50;
const MAX_PROPERTIES = 1000;
const MAX_RULES = 200;
const MAX_SLA = 50;

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const API_VERSION_RE = /^v3\.\d+\.\d+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function validateQuality(
  raw: unknown, path: string, errors: OdcsFieldError[],
): OdcsQualityRule[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push({ path, message: 'must be an array of ODCS quality rules' });
    return undefined;
  }
  if (raw.length > MAX_RULES) {
    errors.push({ path, message: `too many quality rules (${raw.length}); the maximum is ${MAX_RULES}` });
    return undefined;
  }
  const out: OdcsQualityRule[] = [];
  raw.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) { errors.push({ path: p, message: 'must be an object' }); return; }
    const type = str(item.type) || 'library';
    if (!(ODCS_QUALITY_TYPES as readonly string[]).includes(type)) {
      errors.push({ path: `${p}.type`, message: `'${type}' is not a valid ODCS quality type — expected one of ${ODCS_QUALITY_TYPES.join(', ')}` });
      return;
    }
    const rule: OdcsQualityRule = { type: type as OdcsQualityType };
    if (type === 'library') {
      const r = str(item.rule);
      if (!r) { errors.push({ path: `${p}.rule`, message: "is required when type is 'library' (the predefined ODCS rule name)" }); return; }
      rule.rule = r;
    } else if (item.rule !== undefined) {
      rule.rule = str(item.rule);
    }
    if (item.dimension !== undefined) {
      const d = str(item.dimension).toLowerCase();
      if (!(ODCS_QUALITY_DIMENSIONS as readonly string[]).includes(d)) {
        errors.push({ path: `${p}.dimension`, message: `'${item.dimension}' is not a valid ODCS dimension — expected one of ${ODCS_QUALITY_DIMENSIONS.join(', ')}` });
        return;
      }
      rule.dimension = d as OdcsQualityDimension;
    }
    if (item.severity !== undefined) {
      const s = str(item.severity).toLowerCase();
      if (!(ODCS_SEVERITIES as readonly string[]).includes(s)) {
        errors.push({ path: `${p}.severity`, message: `'${item.severity}' is not a valid ODCS severity — expected one of ${ODCS_SEVERITIES.join(', ')}` });
        return;
      }
      rule.severity = s;
    }
    for (const k of ['name', 'description', 'unit', 'query', 'engine', 'implementation'] as const) {
      const v = str(item[k]);
      if (v) (rule as unknown as Record<string, unknown>)[k] = v;
    }
    for (const k of ['mustBe', 'mustBeGreaterThan', 'mustBeLessThan', 'mustBeGreaterOrEqualTo', 'mustBeLessOrEqualTo'] as const) {
      if (item[k] === undefined) continue;
      const n = Number(item[k]);
      if (!Number.isFinite(n)) { errors.push({ path: `${p}.${k}`, message: `must be a number (got ${JSON.stringify(item[k])})` }); return; }
      (rule as unknown as Record<string, unknown>)[k] = n;
    }
    if (item.validValues !== undefined) {
      if (!Array.isArray(item.validValues)) { errors.push({ path: `${p}.validValues`, message: 'must be an array' }); return; }
      rule.validValues = item.validValues;
    }
    if (Array.isArray(item.customProperties)) {
      rule.customProperties = item.customProperties
        .filter(isPlainObject)
        .map((c) => ({ property: str(c.property), value: c.value }))
        .filter((c) => !!c.property);
    }
    out.push(rule);
  });
  return out;
}

/**
 * Validate an inbound document against the ODCS 3.1 shape Loom supports.
 *
 * NEVER silently accepts: every problem is reported as a precise
 * `{ path, message }` naming the exact offending field and the allowed values.
 * Returns the NORMALIZED contract only when there are zero errors.
 */
export function validateOdcs(input: unknown): OdcsValidationResult {
  const errors: OdcsFieldError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'the document must be a JSON object (an ODCS v3.1 data contract)' }] };
  }

  // ── fundamentals (all five are REQUIRED by ODCS v3) ──
  const apiVersion = str(input.apiVersion);
  if (!apiVersion) errors.push({ path: 'apiVersion', message: 'is required — set it to "v3.1.0"' });
  else if (!API_VERSION_RE.test(apiVersion)) {
    errors.push({ path: 'apiVersion', message: `'${apiVersion}' is not a supported ODCS version — Loom reads the v3.x line (e.g. "${ODCS_API_VERSION}")` });
  }

  const kind = str(input.kind);
  if (!kind) errors.push({ path: 'kind', message: `is required — it must be "${ODCS_KIND}"` });
  else if (kind !== ODCS_KIND) errors.push({ path: 'kind', message: `'${kind}' is not valid — the only ODCS kind is "${ODCS_KIND}"` });

  const id = str(input.id);
  if (!id) errors.push({ path: 'id', message: 'is required — a unique identifier for this contract' });

  const version = str(input.version);
  if (!version) errors.push({ path: 'version', message: 'is required — the contract\'s semantic version (e.g. "1.0.0")' });
  else if (!SEMVER_RE.test(version)) errors.push({ path: 'version', message: `'${version}' is not a semantic version — use MAJOR.MINOR.PATCH (e.g. "1.0.0")` });

  const status = str(input.status);
  if (!status) errors.push({ path: 'status', message: `is required — one of ${ODCS_STATUSES.join(', ')}` });
  else if (!(ODCS_STATUSES as readonly string[]).includes(status)) {
    errors.push({ path: 'status', message: `'${status}' is not a valid ODCS status — expected one of ${ODCS_STATUSES.join(', ')}` });
  }

  // ── description ──
  let description: OdcsDescription | undefined;
  if (input.description !== undefined) {
    if (!isPlainObject(input.description)) errors.push({ path: 'description', message: 'must be an object with purpose / limitations / usage' });
    else {
      description = {};
      for (const k of ['purpose', 'limitations', 'usage'] as const) {
        if (input.description[k] === undefined) continue;
        if (typeof input.description[k] !== 'string') errors.push({ path: `description.${k}`, message: 'must be a string' });
        else description[k] = str(input.description[k]);
      }
    }
  }

  // ── schema ──
  let schema: OdcsSchemaObject[] | undefined;
  if (input.schema !== undefined) {
    if (!Array.isArray(input.schema)) {
      errors.push({ path: 'schema', message: 'must be an array of ODCS schema objects (tables / documents)' });
    } else if (input.schema.length > MAX_OBJECTS) {
      errors.push({ path: 'schema', message: `too many schema objects (${input.schema.length}); the maximum is ${MAX_OBJECTS}` });
    } else {
      schema = [];
      input.schema.forEach((rawObj, oi) => {
        const op = `schema[${oi}]`;
        if (!isPlainObject(rawObj)) { errors.push({ path: op, message: 'must be an object' }); return; }
        const name = str(rawObj.name);
        if (!name) { errors.push({ path: `${op}.name`, message: 'is required — the schema object (table) name' }); return; }
        const logicalType = str(rawObj.logicalType) || 'object';
        if (logicalType !== 'object') {
          errors.push({ path: `${op}.logicalType`, message: `'${logicalType}' is not valid — an ODCS schema object's logicalType must be "object"` });
          return;
        }
        const obj: OdcsSchemaObject = { name, logicalType: 'object' };
        const physicalName = str(rawObj.physicalName);
        if (physicalName) obj.physicalName = physicalName;
        const physicalType = str(rawObj.physicalType);
        if (physicalType) obj.physicalType = physicalType;
        const desc = str(rawObj.description);
        if (desc) obj.description = desc;
        const gran = str(rawObj.dataGranularityDescription);
        if (gran) obj.dataGranularityDescription = gran;

        if (rawObj.properties !== undefined) {
          if (!Array.isArray(rawObj.properties)) {
            errors.push({ path: `${op}.properties`, message: 'must be an array of ODCS properties (columns / fields)' });
          } else if (rawObj.properties.length > MAX_PROPERTIES) {
            errors.push({ path: `${op}.properties`, message: `too many properties (${rawObj.properties.length}); the maximum is ${MAX_PROPERTIES}` });
          } else {
            const props: OdcsProperty[] = [];
            rawObj.properties.forEach((rawProp, pi) => {
              const pp = `${op}.properties[${pi}]`;
              if (!isPlainObject(rawProp)) { errors.push({ path: pp, message: 'must be an object' }); return; }
              const pname = str(rawProp.name);
              if (!pname) { errors.push({ path: `${pp}.name`, message: 'is required — the property (column) name' }); return; }
              const lt = str(rawProp.logicalType);
              if (!lt) { errors.push({ path: `${pp}.logicalType`, message: `is required — one of ${ODCS_LOGICAL_TYPES.join(', ')}` }); return; }
              if (!(ODCS_LOGICAL_TYPES as readonly string[]).includes(lt)) {
                errors.push({ path: `${pp}.logicalType`, message: `'${lt}' is not a valid ODCS logical type — expected one of ${ODCS_LOGICAL_TYPES.join(', ')}` });
                return;
              }
              const prop: OdcsProperty = { name: pname, logicalType: lt as OdcsLogicalType };
              const pt = str(rawProp.physicalType);
              if (pt) prop.physicalType = pt;
              const pdesc = str(rawProp.description);
              if (pdesc) prop.description = pdesc;
              for (const flag of ['required', 'unique', 'primaryKey', 'partitioned', 'criticalDataElement'] as const) {
                if (rawProp[flag] === undefined) continue;
                if (typeof rawProp[flag] !== 'boolean') { errors.push({ path: `${pp}.${flag}`, message: `must be a boolean (got ${JSON.stringify(rawProp[flag])})` }); return; }
                (prop as unknown as Record<string, unknown>)[flag] = rawProp[flag];
              }
              if (rawProp.primaryKeyPosition !== undefined) {
                const n = Number(rawProp.primaryKeyPosition);
                if (!Number.isInteger(n)) { errors.push({ path: `${pp}.primaryKeyPosition`, message: 'must be an integer' }); return; }
                prop.primaryKeyPosition = n;
              }
              const cls = str(rawProp.classification);
              if (cls) prop.classification = cls;
              if (Array.isArray(rawProp.examples)) prop.examples = rawProp.examples;
              const q = validateQuality(rawProp.quality, `${pp}.quality`, errors);
              if (q) prop.quality = q;
              props.push(prop);
            });
            obj.properties = props;
          }
        }
        const oq = validateQuality(rawObj.quality, `${op}.quality`, errors);
        if (oq) obj.quality = oq;
        schema!.push(obj);
      });
    }
  }

  // ── slaProperties ──
  let slaProperties: OdcsSlaProperty[] | undefined;
  if (input.slaProperties !== undefined) {
    if (!Array.isArray(input.slaProperties)) {
      errors.push({ path: 'slaProperties', message: 'must be an array of ODCS SLA properties' });
    } else if (input.slaProperties.length > MAX_SLA) {
      errors.push({ path: 'slaProperties', message: `too many SLA properties (${input.slaProperties.length}); the maximum is ${MAX_SLA}` });
    } else {
      slaProperties = [];
      input.slaProperties.forEach((rawSla, i) => {
        const sp = `slaProperties[${i}]`;
        if (!isPlainObject(rawSla)) { errors.push({ path: sp, message: 'must be an object' }); return; }
        const property = str(rawSla.property);
        if (!property) { errors.push({ path: `${sp}.property`, message: 'is required — the SLA dimension (latency, frequency, retention, availability, …)' }); return; }
        if (rawSla.value === undefined || rawSla.value === null || rawSla.value === '') {
          errors.push({ path: `${sp}.value`, message: `is required — the committed value for '${property}'` });
          return;
        }
        if (typeof rawSla.value !== 'string' && typeof rawSla.value !== 'number') {
          errors.push({ path: `${sp}.value`, message: `must be a string or a number (got ${typeof rawSla.value})` });
          return;
        }
        const sla: OdcsSlaProperty = { property, value: rawSla.value };
        for (const k of ['unit', 'element', 'driver'] as const) {
          const v = str(rawSla[k]);
          if (v) sla[k] = v;
        }
        if (typeof rawSla.valueExt === 'string' || typeof rawSla.valueExt === 'number') sla.valueExt = rawSla.valueExt;
        slaProperties!.push(sla);
      });
    }
  }

  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    errors.push({ path: 'tags', message: 'must be an array of strings' });
  }

  if (errors.length) return { ok: false, errors };

  const contract: OdcsContract = {
    apiVersion, kind, id, version, status,
  };
  const name = str(input.name);
  if (name) contract.name = name;
  for (const k of ['tenant', 'domain', 'dataProduct', 'contractCreatedTs'] as const) {
    const v = str(input[k]);
    if (v) contract[k] = v;
  }
  if (description && Object.keys(description).length) contract.description = description;
  if (schema) contract.schema = schema;
  if (slaProperties) contract.slaProperties = slaProperties;
  if (Array.isArray(input.tags)) contract.tags = input.tags.map((t) => String(t)).filter(Boolean);
  if (Array.isArray(input.customProperties)) {
    contract.customProperties = input.customProperties
      .filter(isPlainObject)
      .map((c) => ({ property: str(c.property), value: c.value }))
      .filter((c) => !!c.property);
  }
  return { ok: true, errors: [], contract };
}

/** Coerce an unknown enforcement mode to a legal one (defaulting SAFE). */
export function normalizeEnforcementMode(v: unknown): EnforcementMode {
  const s = String(v ?? '').trim();
  return (ENFORCEMENT_MODES as readonly string[]).includes(s) ? (s as EnforcementMode) : DEFAULT_ENFORCEMENT_MODE;
}

/** Coerce an unknown binding kind; null when it names no known ingestion path. */
export function normalizeBindingKind(v: unknown): BindingKind | null {
  const s = String(v ?? '').trim();
  return (BINDING_KINDS as readonly string[]).includes(s) ? (s as BindingKind) : null;
}

/**
 * PURE — does `binding` govern this (kind, targetItemId, dataset)? `*` on the
 * binding's dataset governs every dataset of the target. Comparison is
 * case-insensitive because SQL schema/table names are.
 */
export function bindingMatches(
  binding: DataContractBinding, kind: BindingKind, targetItemId: string, dataset: string,
): boolean {
  if (!binding.enabled) return false;
  if (binding.kind !== kind) return false;
  if (String(binding.targetItemId) !== String(targetItemId)) return false;
  const bound = String(binding.dataset || '').trim().toLowerCase();
  if (!bound || bound === '*') return true;
  return bound === String(dataset || '').trim().toLowerCase();
}

/** PURE — append a run, newest first, bounded to MAX_RUNS_PER_DOC. */
export function withRun(doc: DataContractDoc, run: EnforcementRun): DataContractDoc {
  const runs = [run, ...(Array.isArray(doc.runs) ? doc.runs : [])].slice(0, MAX_RUNS_PER_DOC);
  return { ...doc, runs, updatedAt: new Date().toISOString() };
}

/** PURE — the pass/fail trend the governance registry charts. */
export function contractTrend(doc: Pick<DataContractDoc, 'runs'>): {
  runs: number; clean: number; quarantined: number; rejected: number;
  rowsEvaluated: number; rowsRejected: number; passRate: number | null;
} {
  const runs = Array.isArray(doc.runs) ? doc.runs : [];
  let clean = 0, quarantined = 0, rejected = 0, rowsEvaluated = 0, rowsRejected = 0;
  for (const r of runs) {
    if (r.decision === 'landed') clean++;
    else if (r.decision === 'landed-with-quarantine') quarantined++;
    else rejected++;
    rowsEvaluated += Number(r.evaluated) || 0;
    rowsRejected += Number(r.rejected) || 0;
  }
  const passRate = rowsEvaluated > 0 ? (rowsEvaluated - rowsRejected) / rowsEvaluated : null;
  return { runs: runs.length, clean, quarantined, rejected, rowsEvaluated, rowsRejected, passRate };
}

// ── MIG1 ───────────────────────────────────────────────────────────────────

/**
 * Register the versioned migrator chain for `loom-data-contracts`.
 *
 * Per MIG1 there is deliberately NO v1 migrator today — v1 IS the current
 * shape. When a breaking change lands, bump DATA_CONTRACT_SCHEMA_VERSION to 2
 * and register `fromVersion: 1` here; readers upgrade lazily via
 * `migrateOnRead` the moment the migrator ships.
 */
export function registerDataContractMigrators(): void {
  const migrators: Array<{ fromVersion: number; migrate: DocMigrator }> = [];
  for (const m of migrators) registerMigrator(DATA_CONTRACT_CONTAINER, m.fromVersion, m.migrate);
}

registerDataContractMigrators();
