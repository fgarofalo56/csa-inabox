/**
 * Ontology object-level security (WS-4.3) — pure marking model + evaluation.
 *
 * The Palantir-parity moat: object-type / property / row / action markings that
 * gate an ontology's INSTANCE data by the caller's Entra group membership. This
 * module is the PURE spine (no React, no Node I/O) so both the `ontology` editor
 * Security tab AND the BFF routes (`/objects`, `/objects/[vertexId]/view`,
 * `/run-action`) import it, and it is fully vitest-coverable.
 *
 * It mirrors the EH Phase-1 PDP/RLS pattern (lib/auth/pdp) at the object grain:
 *   - a PROPERTY marking is the CLS analogue — a caller not cleared for the
 *     property's allow-groups gets the value MASKED (dropped server-side), never
 *     a client-side hide (per no-vaporware.md).
 *   - a ROW marking is the RLS analogue — an object type nominates a
 *     "marking property" whose value classifies each instance; a caller not
 *     cleared for that value's allow-groups does not see the instance at all.
 *   - an ACTION marking gates a write-back action type — a caller not cleared
 *     for the action's allow-groups is blocked server-side (403).
 *
 * "Cleared" = the allow-group list is EMPTY (unrestricted) OR the caller's Entra
 * group object-ids intersect it. Group membership comes from the existing
 * session/PDP claims path (`session.claims.groups`) — never reinvented here.
 *
 * Azure-native + sovereign: Entra groups + Cosmos-persisted config (on the
 * ontology item's `state.objectSecurity`) + Apache-AGE instances. No Fabric,
 * no Power BI — Gov-safe.
 */

// ---------------------------------------------------------------------------
// Persisted shapes (ontology item `state.objectSecurity`)
// ---------------------------------------------------------------------------

/** An Entra security group the marking clears — object-id + a cached label. */
export interface SecurityGroupRef {
  /** Entra group object-id (the value matched against `session.claims.groups`). */
  id: string;
  /** Cached display name (UI only; never trusted for the ACL decision). */
  name?: string;
}

/** A property-level marking (CLS analogue): callers not in `allowGroups` get the
 *  property value masked. Empty `allowGroups` = unrestricted (no masking). */
export interface PropertyMarking {
  /** apiName of the gated property. */
  property: string;
  allowGroups: SecurityGroupRef[];
}

/** One row-marking clearance rule: instances whose marking value equals `value`
 *  are visible only to callers cleared for `allowGroups`. */
export interface RowClearance {
  value: string;
  allowGroups: SecurityGroupRef[];
}

/** A row-level marking (RLS analogue): the object type nominates a marking
 *  property; each distinct value is cleared to a set of groups. */
export interface RowMarking {
  /** apiName of the property whose value classifies each instance. */
  markingProperty: string;
  /** Per-value clearance rules. */
  clearances: RowClearance[];
  /** When true, an instance whose marking value matches NO clearance rule is
   *  hidden from everyone but a bypass (tenant admin). Default false: an
   *  unclassified row is visible (fail-open ONLY for the unlisted case). */
  hideUnclassified?: boolean;
}

/** Per-object-type security: property markings + an optional row marking. */
export interface ObjectTypeSecurity {
  objectType: string;
  propertyMarkings?: PropertyMarking[];
  rowMarking?: RowMarking;
}

/** Per-action security: callers not in `allowGroups` cannot run the action. */
export interface ActionSecurity {
  action: string;
  allowGroups: SecurityGroupRef[];
}

/** The whole `state.objectSecurity` document. */
export interface ObjectSecurityConfig {
  objectTypes?: ObjectTypeSecurity[];
  actions?: ActionSecurity[];
}

// ---------------------------------------------------------------------------
// Normalizers (coerce persisted / hand-edited Cosmos shapes → clean model)
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Coerce a raw group entry ({id,name} | {id,displayName} | "id") → SecurityGroupRef. */
export function normalizeGroupRef(raw: unknown): SecurityGroupRef | null {
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { id } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id ?? r.objectId ?? r.groupId).trim();
  if (!id) return null;
  const name = str(r.name ?? r.displayName).trim();
  return name ? { id, name } : { id };
}

function normalizeGroupRefs(raw: unknown): SecurityGroupRef[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SecurityGroupRef[] = [];
  for (const g of raw) {
    const ref = normalizeGroupRef(g);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

function normalizePropertyMarking(raw: unknown): PropertyMarking | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const property = str(r.property).trim();
  if (!property) return null;
  return { property, allowGroups: normalizeGroupRefs(r.allowGroups) };
}

function normalizeRowMarking(raw: unknown): RowMarking | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const markingProperty = str(r.markingProperty).trim();
  if (!markingProperty) return undefined;
  const clearances: RowClearance[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.clearances)) {
    for (const c of r.clearances) {
      if (!c || typeof c !== 'object') continue;
      const value = str((c as Record<string, unknown>).value);
      if (seen.has(value)) continue;
      seen.add(value);
      clearances.push({ value, allowGroups: normalizeGroupRefs((c as Record<string, unknown>).allowGroups) });
    }
  }
  return {
    markingProperty,
    clearances,
    ...(r.hideUnclassified === true ? { hideUnclassified: true } : {}),
  };
}

function normalizeObjectTypeSecurity(raw: unknown): ObjectTypeSecurity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const objectType = str(r.objectType).trim();
  if (!objectType) return null;
  const propertyMarkings = Array.isArray(r.propertyMarkings)
    ? r.propertyMarkings.map(normalizePropertyMarking).filter((p): p is PropertyMarking => p !== null)
    : [];
  const rowMarking = normalizeRowMarking(r.rowMarking);
  return {
    objectType,
    ...(propertyMarkings.length ? { propertyMarkings } : {}),
    ...(rowMarking ? { rowMarking } : {}),
  };
}

function normalizeActionSecurity(raw: unknown): ActionSecurity | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const action = str(r.action).trim();
  if (!action) return null;
  return { action, allowGroups: normalizeGroupRefs(r.allowGroups) };
}

/** Coerce a persisted `state.objectSecurity` value into a clean config. */
export function normalizeObjectSecurity(raw: unknown): ObjectSecurityConfig {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const objectTypes = Array.isArray(r.objectTypes)
    ? r.objectTypes.map(normalizeObjectTypeSecurity).filter((o): o is ObjectTypeSecurity => o !== null)
    : [];
  const actions = Array.isArray(r.actions)
    ? r.actions.map(normalizeActionSecurity).filter((a): a is ActionSecurity => a !== null)
    : [];
  const cfg: ObjectSecurityConfig = {};
  if (objectTypes.length) cfg.objectTypes = objectTypes;
  if (actions.length) cfg.actions = actions;
  return cfg;
}

// ---------------------------------------------------------------------------
// Clearance primitive
// ---------------------------------------------------------------------------

/**
 * True when the caller is cleared for a marking's allow-group list:
 *   - an EMPTY allow-group list is unrestricted → always cleared;
 *   - otherwise the caller's Entra group object-ids must intersect the list.
 * `callerGroups` is `session.claims.groups` (the existing PDP claims path).
 */
export function isCleared(callerGroups: readonly string[], allowGroups: readonly SecurityGroupRef[]): boolean {
  if (!allowGroups || allowGroups.length === 0) return true;
  if (!callerGroups || callerGroups.length === 0) return false;
  const set = new Set(callerGroups);
  return allowGroups.some((g) => set.has(g.id));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function objectTypeSecurity(config: ObjectSecurityConfig | null | undefined, objectType: string): ObjectTypeSecurity | null {
  return (config?.objectTypes || []).find((o) => o.objectType === objectType) || null;
}

export function actionSecurity(config: ObjectSecurityConfig | null | undefined, action: string): ActionSecurity | null {
  return (config?.actions || []).find((a) => a.action === action) || null;
}

/** True when ANY marking is configured (used to short-circuit enforcement). */
export function hasAnyMarkings(config: ObjectSecurityConfig | null | undefined): boolean {
  return !!(config && ((config.objectTypes && config.objectTypes.length) || (config.actions && config.actions.length)));
}

// ---------------------------------------------------------------------------
// Enforcement — property masking (CLS), row visibility (RLS), action ACL
// ---------------------------------------------------------------------------

export interface MaskResult {
  /** The property bag with masked keys REMOVED (value never leaves the server). */
  properties: Record<string, unknown>;
  /** apiNames of the properties that were masked for this caller. */
  maskedProperties: string[];
}

/**
 * Mask the properties an object-type's property markings gate for a caller not
 * cleared for them. Masked keys are DROPPED from the returned bag (server-side
 * redaction) and reported in `maskedProperties`. `bypass` (tenant admin) sees
 * everything. Pure — no store access.
 */
export function maskProperties(
  sec: ObjectTypeSecurity | null,
  callerGroups: readonly string[],
  properties: Record<string, unknown> | null | undefined,
  bypass = false,
): MaskResult {
  const props = properties && typeof properties === 'object' ? properties : {};
  if (bypass || !sec || !sec.propertyMarkings || sec.propertyMarkings.length === 0) {
    return { properties: { ...props }, maskedProperties: [] };
  }
  const gated = new Map(sec.propertyMarkings.map((m) => [m.property, m.allowGroups]));
  const out: Record<string, unknown> = {};
  const maskedProperties: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const allow = gated.get(k);
    if (allow && !isCleared(callerGroups, allow)) {
      maskedProperties.push(k);
      continue; // drop — never serialize the value
    }
    out[k] = v;
  }
  return { properties: out, maskedProperties };
}

/**
 * Whether an instance is visible under the object type's ROW marking. `bypass`
 * (tenant admin) always sees it; no row marking = always visible; an unlisted
 * marking value is visible unless `hideUnclassified`. Pure.
 */
export function isRowVisible(
  sec: ObjectTypeSecurity | null,
  callerGroups: readonly string[],
  properties: Record<string, unknown> | null | undefined,
  bypass = false,
): boolean {
  if (bypass) return true;
  const rm = sec?.rowMarking;
  if (!rm) return true;
  const props = properties && typeof properties === 'object' ? properties : {};
  const value = str(props[rm.markingProperty]);
  const rule = rm.clearances.find((c) => c.value === value);
  if (!rule) return !rm.hideUnclassified;
  return isCleared(callerGroups, rule.allowGroups);
}

/** A single instance as returned by the AGE store. */
export interface SecuredInstance {
  id: string;
  objectType: string;
  properties: Record<string, unknown>;
  /** Set when property masking dropped one or more values for this caller. */
  maskedProperties?: string[];
}

export interface FilterMaskResult {
  objects: SecuredInstance[];
  /** How many instances were hidden by the row marking. */
  filteredCount: number;
  /** True when any property was masked or any row filtered (an enforcement event). */
  restricted: boolean;
}

/**
 * Apply row-visibility filtering THEN property masking to a set of instances of
 * ONE object type for a caller. The single enforcement primitive both the list
 * route and the neighbour shaping reuse. Pure.
 */
export function secureInstances(
  sec: ObjectTypeSecurity | null,
  callerGroups: readonly string[],
  instances: SecuredInstance[],
  bypass = false,
): FilterMaskResult {
  let filteredCount = 0;
  let restricted = false;
  const objects: SecuredInstance[] = [];
  for (const inst of instances || []) {
    if (!isRowVisible(sec, callerGroups, inst.properties, bypass)) {
      filteredCount++;
      restricted = true;
      continue;
    }
    const masked = maskProperties(sec, callerGroups, inst.properties, bypass);
    if (masked.maskedProperties.length) restricted = true;
    objects.push({
      id: inst.id,
      objectType: inst.objectType,
      properties: masked.properties,
      ...(masked.maskedProperties.length ? { maskedProperties: masked.maskedProperties } : {}),
    });
  }
  return { objects, filteredCount, restricted };
}

/**
 * Whether the caller may run a write-back action. An action with no marking (or
 * an empty allow-group list) is unrestricted; otherwise the caller's groups must
 * intersect the allow-list. `bypass` (tenant admin) always allowed. Pure.
 */
export function isActionAllowed(
  config: ObjectSecurityConfig | null | undefined,
  action: string,
  callerGroups: readonly string[],
  bypass = false,
): boolean {
  if (bypass) return true;
  const sec = actionSecurity(config, action);
  if (!sec) return true;
  return isCleared(callerGroups, sec.allowGroups);
}
