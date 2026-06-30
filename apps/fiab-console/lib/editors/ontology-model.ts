/**
 * Ontology structured model — the typed object/link/action-type schema that the
 * Fabric IQ `ontology` editor (Palantir Foundry Ontology equivalent) persists to
 * Cosmos (`state.objectTypes[] / state.linkTypes[] / state.actionTypes[]`).
 *
 * This replaces the old freeform DSL textarea (`state.source`) as the source of
 * truth (removing the `loom_no_freeform_config` violation). For backward
 * compatibility with the AGE instance/link/action routes — which historically
 * derived the declared object-type names from `parseOntologyHierarchy(source)` —
 * `deriveSourceFromObjectTypes()` keeps `state.source` in sync, and
 * `objectTypeNames(state)` prefers the structured model and falls back to the
 * DSL. All persistence is Cosmos; instances/links/actions execute on Apache AGE
 * (PostgreSQL Flexible Server). Datasource backing is ADLS Gen2 Delta
 * (lakehouse) or Synapse SQL (warehouse) — Azure-native, never Microsoft Fabric.
 *
 * Pure logic + types only (no React, no Node) so both the editor and the BFF
 * routes import it, and so it is vitest-coverable.
 */
import { parseOntologyHierarchy } from './_family-utils';

// ============================================================
// Property base-type system (Foundry "base types")
// ============================================================

/** Object-type property base types (a curated 1:1 of Foundry's base types). */
export const ONTO_BASE_TYPES = [
  'string', 'boolean', 'byte', 'short', 'integer', 'long', 'float', 'double',
  'decimal', 'date', 'timestamp', 'geopoint', 'geoshape', 'timeseries',
  'attachment', 'mediaReference', 'marking', 'vector', 'struct',
] as const;
export type OntoBaseType = typeof ONTO_BASE_TYPES[number];

export const ONTO_BASE_TYPE_LABELS: Record<OntoBaseType, string> = {
  string: 'String', boolean: 'Boolean', byte: 'Byte', short: 'Short',
  integer: 'Integer', long: 'Long', float: 'Float', double: 'Double',
  decimal: 'Decimal', date: 'Date', timestamp: 'Timestamp',
  geopoint: 'Geopoint', geoshape: 'Geoshape', timeseries: 'Time series',
  attachment: 'Attachment', mediaReference: 'Media reference',
  marking: 'Marking', vector: 'Vector / embedding', struct: 'Struct',
};

/** Base types eligible as a primary key / title key (scalar, identity-friendly). */
export const ONTO_KEY_ELIGIBLE_TYPES: ReadonlySet<OntoBaseType> = new Set<OntoBaseType>([
  'string', 'byte', 'short', 'integer', 'long', 'decimal', 'date', 'timestamp',
]);

/** Numeric base types — used for runtime coercion of action parameters. */
const NUMERIC_BASE_TYPES: ReadonlySet<OntoBaseType> = new Set<OntoBaseType>([
  'byte', 'short', 'integer', 'long', 'float', 'double', 'decimal',
]);

export type OntoStatus = 'active' | 'experimental' | 'deprecated';
export const ONTO_STATUSES: readonly OntoStatus[] = ['active', 'experimental', 'deprecated'];

export type OntoVisibility = 'prominent' | 'normal' | 'hidden';
export const ONTO_VISIBILITIES: readonly OntoVisibility[] = ['prominent', 'normal', 'hidden'];

/** A small palette of accent colors (Loom design tokens, not raw hex). */
export type OntoColor = 'brand' | 'success' | 'warning' | 'danger' | 'informative' | 'subtle';
export const ONTO_COLORS: readonly OntoColor[] = ['brand', 'success', 'warning', 'danger', 'informative', 'subtle'];

// ============================================================
// Interfaces
// ============================================================

/** A typed property on an object type. */
export interface OntoProperty {
  /** API name — a safe identifier, unique within the object type. */
  apiName: string;
  /** Display name (defaults to apiName). */
  displayName?: string;
  /** Base type. */
  baseType: OntoBaseType;
  /** When true the property is an array of `baseType`. */
  arrayOf?: boolean;
  /** Required on instances / action create. */
  required?: boolean;
  /** Visibility hint. */
  visibility?: OntoVisibility;
  /** Description. */
  description?: string;
}

/** Where an object type's instances come from (Azure-native, no Fabric). */
export interface OntoDatasource {
  /** ADLS Gen2 Delta (lakehouse) or Synapse SQL (warehouse) backing. */
  kind: 'lakehouse' | 'warehouse';
  /** Cosmos item id of the backing lakehouse/warehouse. */
  sourceItemId: string;
  /** Cached display name of the backing item. */
  sourceDisplayName?: string;
  /** Backing table (e.g. `dbo.Customer` or a Delta table name). */
  table?: string;
  /** Source column → property apiName map. */
  columnMap?: Record<string, string>;
  /** Source column that is the object's primary key. */
  primaryKeyColumn?: string;
  /** ISO-8601 timestamp the binding was last saved. */
  boundAt?: string;
}

/** A typed object type (Foundry "object type"). */
export interface OntoObjectType {
  apiName: string;
  displayName?: string;
  pluralDisplayName?: string;
  description?: string;
  /** Fluent icon key (UI maps to an icon component); optional. */
  icon?: string;
  color?: OntoColor;
  status?: OntoStatus;
  visibility?: OntoVisibility;
  /** Type groups (free tags). */
  groups?: string[];
  /** IS_A parent object type apiName (inheritance). */
  parent?: string;
  /** Typed properties. */
  properties: OntoProperty[];
  /** apiName of the primary-key property. */
  primaryKey?: string;
  /** apiName of the title property. */
  titleKey?: string;
  /** Backing datasource. */
  datasource?: OntoDatasource;
}

export type OntoCardinality = 'one-to-one' | 'one-to-many' | 'many-to-many';
export const ONTO_CARDINALITIES: readonly OntoCardinality[] = ['one-to-one', 'one-to-many', 'many-to-many'];
export const ONTO_CARDINALITY_LABELS: Record<OntoCardinality, string> = {
  'one-to-one': 'One-to-one', 'one-to-many': 'One-to-many', 'many-to-many': 'Many-to-many',
};

/** A named link type between two object types (Foundry "link type"). */
export interface OntoLinkType {
  apiName: string;
  displayName?: string;
  /** Display name in the reverse (to → from) direction. */
  reverseDisplayName?: string;
  fromType: string;
  toType: string;
  cardinality: OntoCardinality;
  /**
   * Backing: a foreign-key property on an object datasource (1:1 / 1:many) or a
   * join/mapping table for many:many. Property apiName on the FK-holding side.
   */
  foreignKeyProperty?: string;
  /** For many:many — the join table that materializes the link. */
  joinTable?: string;
  description?: string;
}

export type OntoParamType =
  | 'string' | 'boolean' | 'integer' | 'long' | 'double' | 'decimal'
  | 'date' | 'timestamp' | 'objectReference' | 'enum';
export const ONTO_PARAM_TYPES: readonly OntoParamType[] = [
  'string', 'boolean', 'integer', 'long', 'double', 'decimal',
  'date', 'timestamp', 'objectReference', 'enum',
];
export const ONTO_PARAM_TYPE_LABELS: Record<OntoParamType, string> = {
  string: 'String', boolean: 'Boolean', integer: 'Integer', long: 'Long',
  double: 'Double', decimal: 'Decimal', date: 'Date', timestamp: 'Timestamp',
  objectReference: 'Object reference', enum: 'Enum (allowed values)',
};

/** A typed action parameter (Foundry action "parameter"). */
export interface OntoActionParam {
  apiName: string;
  type: OntoParamType;
  required?: boolean;
  /** Default value (string-encoded; coerced at run time). */
  defaultValue?: string;
  /** Operator prompt / help text. */
  prompt?: string;
  /** For type=enum — the allowed values. */
  allowedValues?: string[];
  /** For type=objectReference — the referenced object type apiName. */
  objectTypeRef?: string;
}

export type OntoActionKind = 'create' | 'update' | 'delete';
export const ONTO_ACTION_KINDS: readonly OntoActionKind[] = ['create', 'update', 'delete'];

/** A typed action type (Foundry "action type" — the write-back surface). */
export interface OntoActionType {
  name: string;
  objectType: string;
  kind: OntoActionKind;
  description?: string;
  /** Typed parameters. */
  parameters: OntoActionParam[];
}

// ============================================================
// Identifiers
// ============================================================

/** A safe API-name identifier: leading letter/underscore, ≤62 word chars. */
export function isOntoIdent(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][\w]{0,62}$/.test(name);
}

// ============================================================
// Normalizers (coerce persisted Cosmos shapes → clean typed model)
// ============================================================

function str(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];
}

export function normalizeProperty(raw: unknown): OntoProperty | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  if (!isOntoIdent(apiName)) return null;
  const baseType = (ONTO_BASE_TYPES as readonly string[]).includes(str(r.baseType))
    ? (str(r.baseType) as OntoBaseType) : 'string';
  const visibility = (ONTO_VISIBILITIES as readonly string[]).includes(str(r.visibility))
    ? (str(r.visibility) as OntoVisibility) : undefined;
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    baseType,
    ...(r.arrayOf ? { arrayOf: true } : {}),
    ...(r.required ? { required: true } : {}),
    ...(visibility ? { visibility } : {}),
    ...(r.description ? { description: str(r.description) } : {}),
  };
}

function normalizeDatasource(raw: unknown): OntoDatasource | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'warehouse' ? 'warehouse' : r.kind === 'lakehouse' ? 'lakehouse' : null;
  const sourceItemId = str(r.sourceItemId).trim();
  if (!kind || !sourceItemId) return undefined;
  const columnMap: Record<string, string> = {};
  if (r.columnMap && typeof r.columnMap === 'object') {
    for (const [k, v] of Object.entries(r.columnMap as Record<string, unknown>)) {
      if (isOntoIdent(k) && str(v).trim()) columnMap[k] = str(v).trim();
    }
  }
  return {
    kind,
    sourceItemId,
    ...(r.sourceDisplayName ? { sourceDisplayName: str(r.sourceDisplayName) } : {}),
    ...(r.table ? { table: str(r.table).trim() } : {}),
    ...(Object.keys(columnMap).length ? { columnMap } : {}),
    ...(r.primaryKeyColumn ? { primaryKeyColumn: str(r.primaryKeyColumn).trim() } : {}),
    ...(r.boundAt ? { boundAt: str(r.boundAt) } : {}),
  };
}

export function normalizeObjectType(raw: unknown): OntoObjectType | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  if (!isOntoIdent(apiName)) return null;
  const properties = Array.isArray(r.properties)
    ? r.properties.map(normalizeProperty).filter((p): p is OntoProperty => p !== null)
    : [];
  const propNames = new Set(properties.map((p) => p.apiName));
  const status = (ONTO_STATUSES as readonly string[]).includes(str(r.status)) ? (str(r.status) as OntoStatus) : undefined;
  const visibility = (ONTO_VISIBILITIES as readonly string[]).includes(str(r.visibility)) ? (str(r.visibility) as OntoVisibility) : undefined;
  const color = (ONTO_COLORS as readonly string[]).includes(str(r.color)) ? (str(r.color) as OntoColor) : undefined;
  const primaryKey = propNames.has(str(r.primaryKey)) ? str(r.primaryKey) : undefined;
  const titleKey = propNames.has(str(r.titleKey)) ? str(r.titleKey) : undefined;
  const parent = isOntoIdent(str(r.parent).trim()) ? str(r.parent).trim() : undefined;
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    ...(r.pluralDisplayName ? { pluralDisplayName: str(r.pluralDisplayName) } : {}),
    ...(r.description ? { description: str(r.description) } : {}),
    ...(r.icon ? { icon: str(r.icon) } : {}),
    ...(color ? { color } : {}),
    ...(status ? { status } : {}),
    ...(visibility ? { visibility } : {}),
    ...(strArr(r.groups).length ? { groups: strArr(r.groups) } : {}),
    ...(parent ? { parent } : {}),
    properties,
    ...(primaryKey ? { primaryKey } : {}),
    ...(titleKey ? { titleKey } : {}),
    ...(normalizeDatasource(r.datasource) ? { datasource: normalizeDatasource(r.datasource) } : {}),
  };
}

export function normalizeObjectTypes(raw: unknown): OntoObjectType[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeObjectType).filter((o): o is OntoObjectType => o !== null);
}

export function normalizeLinkType(raw: unknown): OntoLinkType | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  const fromType = str(r.fromType).trim();
  const toType = str(r.toType).trim();
  if (!isOntoIdent(apiName) || !isOntoIdent(fromType) || !isOntoIdent(toType)) return null;
  const cardinality = (ONTO_CARDINALITIES as readonly string[]).includes(str(r.cardinality))
    ? (str(r.cardinality) as OntoCardinality) : 'one-to-many';
  return {
    apiName,
    ...(r.displayName ? { displayName: str(r.displayName) } : {}),
    ...(r.reverseDisplayName ? { reverseDisplayName: str(r.reverseDisplayName) } : {}),
    fromType,
    toType,
    cardinality,
    ...(isOntoIdent(str(r.foreignKeyProperty).trim()) ? { foreignKeyProperty: str(r.foreignKeyProperty).trim() } : {}),
    ...(r.joinTable ? { joinTable: str(r.joinTable).trim() } : {}),
    ...(r.description ? { description: str(r.description) } : {}),
  };
}

export function normalizeLinkTypes(raw: unknown): OntoLinkType[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeLinkType).filter((l): l is OntoLinkType => l !== null);
}

export function normalizeActionParam(raw: unknown): OntoActionParam | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = str(r.apiName).trim();
  if (!isOntoIdent(apiName)) return null;
  const type = (ONTO_PARAM_TYPES as readonly string[]).includes(str(r.type)) ? (str(r.type) as OntoParamType) : 'string';
  return {
    apiName,
    type,
    ...(r.required ? { required: true } : {}),
    ...(r.defaultValue != null && str(r.defaultValue) !== '' ? { defaultValue: str(r.defaultValue) } : {}),
    ...(r.prompt ? { prompt: str(r.prompt) } : {}),
    ...(type === 'enum' && strArr(r.allowedValues).length ? { allowedValues: strArr(r.allowedValues) } : {}),
    ...(type === 'objectReference' && isOntoIdent(str(r.objectTypeRef).trim()) ? { objectTypeRef: str(r.objectTypeRef).trim() } : {}),
  };
}

/**
 * Normalize a persisted action type into the typed shape. Backward-compatible
 * with the legacy `{ name, objectType, kind, params: string[] }` shape — the
 * old `params` string names become typed `parameters` of base type `string`.
 */
export function normalizeOntoActionType(raw: unknown): OntoActionType | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name).trim();
  const objectType = str(r.objectType).trim();
  const kind = str(r.kind) as OntoActionKind;
  if (!isOntoIdent(name) || !isOntoIdent(objectType) || !(ONTO_ACTION_KINDS as readonly string[]).includes(kind)) return null;
  let parameters: OntoActionParam[] = [];
  if (Array.isArray(r.parameters)) {
    parameters = r.parameters.map(normalizeActionParam).filter((p): p is OntoActionParam => p !== null);
  } else if (Array.isArray(r.params)) {
    // Legacy: params: string[] → string parameters.
    parameters = r.params
      .map((p) => str(p).trim())
      .filter(isOntoIdent)
      .map((apiName) => ({ apiName, type: 'string' as const }));
  }
  return {
    name, objectType, kind,
    ...(r.description ? { description: str(r.description) } : {}),
    parameters,
  };
}

export function normalizeOntoActionTypes(raw: unknown): OntoActionType[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeOntoActionType).filter((a): a is OntoActionType => a !== null);
}

// ============================================================
// DSL sync + name resolution (keeps the AGE routes working)
// ============================================================

/**
 * Derive the lightweight DSL (`Name : Parent -- description`) from the structured
 * object types, so legacy routes that `parseOntologyHierarchy(state.source)`
 * keep resolving the same declared type names + IS_A hierarchy.
 */
export function deriveSourceFromObjectTypes(objectTypes: OntoObjectType[]): string {
  return objectTypes
    .map((o) => {
      const desc = (o.description || '').replace(/[\r\n]+/g, ' ').trim();
      return `${o.apiName} : ${o.parent || ''}${desc ? ` -- ${desc}` : ''}`.trimEnd();
    })
    .join('\n') + (objectTypes.length ? '\n' : '');
}

/** Declared object-type names — prefers the structured model, falls back to DSL. */
export function objectTypeNames(state: Record<string, unknown> | undefined | null): Set<string> {
  const ots = normalizeObjectTypes((state || {}).objectTypes);
  if (ots.length) return new Set(ots.map((o) => o.apiName));
  return new Set(parseOntologyHierarchy(str((state || {}).source)).map((c) => c.name));
}

/** Resolve a single object type by api name from persisted state. */
export function objectTypeByName(state: Record<string, unknown> | undefined | null, name: string): OntoObjectType | null {
  return normalizeObjectTypes((state || {}).objectTypes).find((o) => o.apiName === name) || null;
}

// ============================================================
// Migration — ensure a structured model exists for legacy items
// ============================================================

export interface OntoModel {
  objectTypes: OntoObjectType[];
  linkTypes: OntoLinkType[];
  actionTypes: OntoActionType[];
  /** Derived DSL kept in sync for the AGE routes. */
  source: string;
}

/**
 * Produce a structured model from persisted state. If `state.objectTypes` is
 * absent/empty but the legacy `state.source` DSL has classes, migrate each class
 * to a typed object type (no properties yet — the user models them). Action types
 * migrate from the legacy `params: string[]` shape. The returned `source` is the
 * canonical DSL derived from the (possibly migrated) object types.
 */
export function migrateOntologyState(state: Record<string, unknown> | undefined | null): OntoModel {
  const s = state || {};
  let objectTypes = normalizeObjectTypes(s.objectTypes);
  if (objectTypes.length === 0) {
    const classes = parseOntologyHierarchy(str(s.source));
    objectTypes = classes.map((c) => ({
      apiName: c.name,
      displayName: c.name,
      ...(c.parent ? { parent: c.parent } : {}),
      ...(c.description ? { description: c.description } : {}),
      status: 'active' as const,
      properties: [],
    }));
  }
  const objectNameSet = new Set(objectTypes.map((o) => o.apiName));
  // Drop link/action types that reference object types that no longer exist.
  const linkTypes = normalizeLinkTypes(s.linkTypes).filter(
    (l) => objectNameSet.has(l.fromType) && objectNameSet.has(l.toType),
  );
  const actionTypes = normalizeOntoActionTypes(s.actionTypes).filter((a) => objectNameSet.has(a.objectType));
  return { objectTypes, linkTypes, actionTypes, source: deriveSourceFromObjectTypes(objectTypes) };
}

// ============================================================
// Action-run validation + coercion (server-side, no-vaporware)
// ============================================================

export type ActionRunResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Validate + coerce runtime action parameters against the declared schema.
 * Required params must be present; numeric/boolean/date params are coerced from
 * their string form; enum params must be one of the allowed values. Returns the
 * coerced `values` (property values to write) or a precise error. The action's
 * target object id (update/delete) is handled by the route separately.
 */
export function validateActionRun(action: OntoActionType, raw: Record<string, unknown>): ActionRunResult {
  const values: Record<string, unknown> = {};
  for (const p of action.parameters) {
    const present = Object.prototype.hasOwnProperty.call(raw, p.apiName) && raw[p.apiName] !== '' && raw[p.apiName] != null;
    let v: unknown = present ? raw[p.apiName] : (p.defaultValue !== undefined ? p.defaultValue : undefined);
    if (v === undefined || v === '') {
      if (p.required) return { ok: false, error: `Parameter "${p.apiName}" is required.` };
      continue;
    }
    switch (p.type) {
      case 'boolean':
        v = v === true || v === 'true' || v === '1' || v === 1;
        break;
      case 'integer':
      case 'long': {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, error: `Parameter "${p.apiName}" must be an integer.` };
        v = n;
        break;
      }
      case 'double':
      case 'decimal': {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `Parameter "${p.apiName}" must be a number.` };
        v = n;
        break;
      }
      case 'enum': {
        const sv = str(v);
        if (p.allowedValues && p.allowedValues.length && !p.allowedValues.includes(sv)) {
          return { ok: false, error: `Parameter "${p.apiName}" must be one of: ${p.allowedValues.join(', ')}.` };
        }
        v = sv;
        break;
      }
      case 'date':
      case 'timestamp':
      case 'string':
      case 'objectReference':
      default:
        v = str(v);
        break;
    }
    values[p.apiName] = v;
  }
  return { ok: true, values };
}

/**
 * Validate object-instance properties against an object type's property schema.
 * When the type declares properties, every supplied key must be a declared
 * property and every `required` property must be present; otherwise (legacy
 * type with no declared properties) any scalar bag is accepted. Numbers/booleans
 * are coerced from string form to match the declared base type.
 */
export function validateObjectInstance(
  ot: OntoObjectType | null,
  raw: Record<string, unknown>,
): ActionRunResult {
  if (!ot || ot.properties.length === 0) return { ok: true, values: raw };
  const byName = new Map(ot.properties.map((p) => [p.apiName, p]));
  const values: Record<string, unknown> = {};
  for (const [k, rawV] of Object.entries(raw)) {
    const p = byName.get(k);
    if (!p) return { ok: false, error: `"${k}" is not a declared property of ${ot.apiName}.` };
    if (rawV === '' || rawV == null) continue;
    let v: unknown = rawV;
    if (NUMERIC_BASE_TYPES.has(p.baseType) && !p.arrayOf) {
      const n = Number(rawV);
      if (!Number.isFinite(n)) return { ok: false, error: `Property "${k}" must be a number.` };
      v = n;
    } else if (p.baseType === 'boolean' && !p.arrayOf) {
      v = rawV === true || rawV === 'true' || rawV === '1' || rawV === 1;
    } else {
      v = str(rawV);
    }
    values[k] = v;
  }
  for (const p of ot.properties) {
    if (p.required && !(p.apiName in values)) {
      return { ok: false, error: `Property "${p.apiName}" is required on ${ot.apiName}.` };
    }
  }
  return { ok: true, values };
}
