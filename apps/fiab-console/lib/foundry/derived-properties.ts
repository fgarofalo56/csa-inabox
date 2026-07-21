/**
 * Ontology Derived Properties (WS-4.2) — live rollups/aggregations computed from
 * an object instance's LINKED objects (Palantir Foundry "derived properties" /
 * rollup parity, row Foundry-4.2). Plus the reference to a registered
 * function-on-objects for a derived property that needs custom logic.
 *
 * A derived property is NOT stored on the AGE vertex — it is computed LIVE on
 * object read (the object-view route calls `computeRollups` over the SAME real
 * neighbours it already traversed via `weave-explore.traverseObject`). Because
 * the route feeds only the SECURITY-MASKED neighbours (WS-4.3), a rollup can
 * never leak a value the caller isn't cleared to see.
 *
 * Two derived-property kinds:
 *   - `rollup`   → an aggregate (sum/avg/count/min/max) over a linked-object
 *                  property, traversed by (link type × direction). Pure — no I/O.
 *                  Computed here, in-process, from the traversal result.
 *   - `function` → a value produced by a REGISTERED function-on-objects executed
 *                  on the Loom UDF runtime (Azure Functions / ACA). The pure
 *                  layer only resolves WHICH function + payload; the route does
 *                  the real HTTP invoke (honest-gate when the runtime is unset).
 *
 * Authored via a wizard (loom-no-freeform-config) and persisted at Cosmos
 * `state.derivedProperties[<objectType>]` — a sibling map exactly like
 * `state.objectViews` / `state.objectSecurity`, so no change to the object-type
 * normalizer is needed. Azure-native (AGE + ACA/Functions), Gov-safe — no
 * Microsoft Fabric.
 *
 * Pure logic + types only (no React, no Node) so the editor, the wizard, and the
 * BFF routes import it and it is fully vitest-coverable.
 */
import type { OntoObjectType, OntoProperty } from '@/lib/editors/ontology-model';
import type { RawNeighbor } from '@/lib/foundry/object-view';

// ============================================================
// Model
// ============================================================

/** Supported rollup aggregations (Foundry rollup operators). */
export const DERIVED_AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type DerivedAggregation = typeof DERIVED_AGGREGATIONS[number];

export const DERIVED_AGGREGATION_LABELS: Record<DerivedAggregation, string> = {
  count: 'Count of linked objects',
  sum: 'Sum of a linked property',
  avg: 'Average of a linked property',
  min: 'Minimum of a linked property',
  max: 'Maximum of a linked property',
};

/** Traversal direction a rollup follows from the anchor object. */
export const DERIVED_DIRECTIONS = ['out', 'in', 'any'] as const;
export type DerivedDirection = typeof DERIVED_DIRECTIONS[number];

/** The kind of a derived property. */
export const DERIVED_KINDS = ['rollup', 'function'] as const;
export type DerivedKind = typeof DERIVED_KINDS[number];

/**
 * A derived property on an object type. `rollup` computes an aggregate over
 * linked objects; `function` delegates to a registered function-on-objects.
 */
export interface OntoDerivedProperty {
  /** API name of the derived property (unique within the object type). */
  apiName: string;
  displayName?: string;
  description?: string;
  kind: DerivedKind;

  // ── rollup ────────────────────────────────────────────────
  /** Aggregation operator (rollup kind). */
  aggregation?: DerivedAggregation;
  /** Link type to traverse (rollup kind). Absent = any link. */
  linkType?: string;
  /** Direction to follow (rollup kind). Default 'any'. */
  direction?: DerivedDirection;
  /** Only aggregate neighbours of this object type (rollup kind). Absent = any. */
  targetType?: string;
  /** Linked-object property to aggregate (rollup kind; ignored for `count`). */
  targetProperty?: string;

  // ── function ──────────────────────────────────────────────
  /** Registered function name to invoke (function kind). */
  functionName?: string;
  /** Pinned function version (function kind). Absent = latest registered. */
  functionVersion?: string;
}

// ============================================================
// Normalizers (coerce persisted Cosmos shapes → clean model)
// ============================================================

/** A safe API-name identifier: leading letter/underscore, ≤62 word chars. */
export function isDerivedIdent(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][\w]{0,62}$/.test(name);
}

function s(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }

export function normalizeDerivedProperty(raw: unknown): OntoDerivedProperty | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const apiName = s(r.apiName).trim();
  if (!isDerivedIdent(apiName)) return null;
  const kind: DerivedKind = (DERIVED_KINDS as readonly string[]).includes(s(r.kind)) ? (s(r.kind) as DerivedKind) : 'rollup';

  if (kind === 'function') {
    const functionName = s(r.functionName).trim();
    if (!isDerivedIdent(functionName)) return null; // a function derived prop MUST name a function
    const functionVersion = s(r.functionVersion).trim();
    return {
      apiName, kind: 'function', functionName,
      ...(r.displayName ? { displayName: s(r.displayName) } : {}),
      ...(r.description ? { description: s(r.description) } : {}),
      ...(functionVersion ? { functionVersion } : {}),
    };
  }

  // rollup
  const aggregation: DerivedAggregation = (DERIVED_AGGREGATIONS as readonly string[]).includes(s(r.aggregation))
    ? (s(r.aggregation) as DerivedAggregation) : 'count';
  const direction: DerivedDirection = (DERIVED_DIRECTIONS as readonly string[]).includes(s(r.direction))
    ? (s(r.direction) as DerivedDirection) : 'any';
  const linkType = s(r.linkType).trim();
  const targetType = s(r.targetType).trim();
  const targetProperty = s(r.targetProperty).trim();
  // Every aggregation except `count` needs a target property to aggregate.
  if (aggregation !== 'count' && !isDerivedIdent(targetProperty)) return null;
  return {
    apiName, kind: 'rollup', aggregation, direction,
    ...(r.displayName ? { displayName: s(r.displayName) } : {}),
    ...(r.description ? { description: s(r.description) } : {}),
    ...(isDerivedIdent(linkType) ? { linkType } : {}),
    ...(isDerivedIdent(targetType) ? { targetType } : {}),
    ...(aggregation !== 'count' && isDerivedIdent(targetProperty) ? { targetProperty } : {}),
  };
}

export function normalizeDerivedProperties(raw: unknown): OntoDerivedProperty[] {
  if (!Array.isArray(raw)) return [];
  const out: OntoDerivedProperty[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const dp = normalizeDerivedProperty(item);
    if (!dp || seen.has(dp.apiName)) continue;
    seen.add(dp.apiName);
    out.push(dp);
  }
  return out;
}

/**
 * Coerce the persisted `state.derivedProperties` map (keyed by object-type
 * apiName) into a clean `Record<objectType, OntoDerivedProperty[]>`. Drops
 * entries with an invalid object-type key or an empty property list.
 */
export function normalizeDerivedPropertyMap(raw: unknown): Record<string, OntoDerivedProperty[]> {
  const out: Record<string, OntoDerivedProperty[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDerivedIdent(k)) continue;
    const dps = normalizeDerivedProperties(v);
    if (dps.length) out[k] = dps;
  }
  return out;
}

/** The derived properties declared for one object type in persisted state. */
export function derivedPropertiesFor(
  state: Record<string, unknown> | undefined | null,
  objectType: string,
): OntoDerivedProperty[] {
  const map = normalizeDerivedPropertyMap((state || {}).derivedProperties);
  return map[objectType] || [];
}

// ============================================================
// Rollup compute (pure — over the real AGE traversal result)
// ============================================================

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Does a neighbour match the rollup's link-type / direction / target-type filter? */
function neighborMatches(dp: OntoDerivedProperty, n: RawNeighbor): boolean {
  if (!n || !n.neighbor) return false;
  if (dp.linkType && n.linkType !== dp.linkType) return false;
  const dir = dp.direction || 'any';
  if (dir !== 'any' && n.direction !== dir) return false;
  if (dp.targetType && n.neighbor.objectType !== dp.targetType) return false;
  return true;
}

/**
 * Compute one rollup derived property over a set of traversed neighbours.
 *   - count → number of matching neighbours (always a number ≥ 0)
 *   - sum/avg/min/max → aggregate of the matching neighbours' `targetProperty`
 *     numeric values; returns null when NO matching neighbour carries a numeric
 *     value for that property (an honest "—" rather than a misleading 0).
 *
 * Only defined for `kind: 'rollup'`; returns null for a function-kind property
 * (those are computed by the route via the runtime).
 */
export function computeRollup(dp: OntoDerivedProperty, neighbors: RawNeighbor[]): number | null {
  if (dp.kind !== 'rollup') return null;
  const matched = (neighbors || []).filter((n) => neighborMatches(dp, n));
  const agg = dp.aggregation || 'count';
  if (agg === 'count') return matched.length;
  if (!dp.targetProperty) return null;
  const nums: number[] = [];
  for (const n of matched) {
    const v = toNum(n.neighbor.properties?.[dp.targetProperty]);
    if (v !== null) nums.push(v);
  }
  if (nums.length === 0) return null;
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return null;
  }
}

/** A computed derived-property value the route surfaces on the object view. */
export interface DerivedValue {
  apiName: string;
  displayName?: string;
  kind: DerivedKind;
  /** The computed value (number for a rollup; anything JSON for a function). */
  value: unknown;
  /** A short human summary of how it was computed (for the inspector caption). */
  summary: string;
  /** For a function-kind value that could not run (honest per-derived gate). */
  gated?: boolean;
  error?: string;
}

/** A one-line human description of a rollup's definition (for UI captions). */
export function describeDerived(dp: OntoDerivedProperty): string {
  if (dp.kind === 'function') {
    return `function ${dp.functionName}${dp.functionVersion ? `@${dp.functionVersion}` : ' (latest)'}`;
  }
  const agg = dp.aggregation || 'count';
  const link = dp.linkType ? ` over ${dp.linkType}` : ' over any link';
  const dir = dp.direction && dp.direction !== 'any' ? ` (${dp.direction})` : '';
  const tgt = dp.targetType ? ` ${dp.targetType}` : '';
  if (agg === 'count') return `count of linked${tgt} objects${link}${dir}`;
  return `${agg}(${tgt ? `${tgt}.` : ''}${dp.targetProperty})${link}${dir}`;
}

/**
 * Compute every ROLLUP derived property for an object over its traversed
 * neighbours. Returns the computed rollup values PLUS the function-kind derived
 * properties left for the route to invoke against the runtime.
 */
export function computeRollups(
  derived: OntoDerivedProperty[],
  neighbors: RawNeighbor[],
): { values: DerivedValue[]; functionRefs: OntoDerivedProperty[] } {
  const values: DerivedValue[] = [];
  const functionRefs: OntoDerivedProperty[] = [];
  for (const dp of derived || []) {
    if (dp.kind === 'function') { functionRefs.push(dp); continue; }
    const v = computeRollup(dp, neighbors);
    values.push({
      apiName: dp.apiName,
      ...(dp.displayName ? { displayName: dp.displayName } : {}),
      kind: 'rollup',
      value: v,
      summary: describeDerived(dp),
    });
  }
  return { values, functionRefs };
}

// ============================================================
// Authoring validation (wizard-side, loom-no-freeform-config)
// ============================================================

/**
 * Validate a candidate derived property against an object type's schema + the
 * ontology's declared link types before it is saved. Ensures a rollup names a
 * real link (when pinned) and — for a numeric aggregation — a real numeric
 * target property, and that a function derived prop names a function. Returns a
 * precise error the wizard shows, or ok.
 */
export function validateDerivedProperty(
  dp: OntoDerivedProperty,
  ctx: {
    ownProperties: OntoProperty[];
    linkTypeNames: ReadonlySet<string>;
    objectTypeNames: ReadonlySet<string>;
    functionNames?: ReadonlySet<string>;
  },
): { ok: true } | { ok: false; error: string } {
  if (!isDerivedIdent(dp.apiName)) return { ok: false, error: 'Derived property name must be a valid identifier.' };
  // A derived property must not collide with a real (stored) property.
  if (ctx.ownProperties.some((p) => p.apiName === dp.apiName)) {
    return { ok: false, error: `"${dp.apiName}" is already a stored property — pick a different derived-property name.` };
  }
  if (dp.kind === 'function') {
    if (!dp.functionName || !isDerivedIdent(dp.functionName)) return { ok: false, error: 'Pick a registered function.' };
    if (ctx.functionNames && !ctx.functionNames.has(dp.functionName)) {
      return { ok: false, error: `Function "${dp.functionName}" is not registered.` };
    }
    return { ok: true };
  }
  // rollup
  if (dp.linkType && !ctx.linkTypeNames.has(dp.linkType)) {
    return { ok: false, error: `Link type "${dp.linkType}" is not declared on this ontology.` };
  }
  if (dp.targetType && !ctx.objectTypeNames.has(dp.targetType)) {
    return { ok: false, error: `Object type "${dp.targetType}" is not declared on this ontology.` };
  }
  const agg = dp.aggregation || 'count';
  if (agg !== 'count' && !isDerivedIdent(dp.targetProperty || '')) {
    return { ok: false, error: `${agg} needs a linked-object property to aggregate.` };
  }
  return { ok: true };
}
