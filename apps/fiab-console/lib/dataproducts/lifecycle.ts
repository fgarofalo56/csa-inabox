/**
 * DP-1 — the ONE canonical data-product lifecycle model.
 *
 * A single `data-product` Cosmos record used to carry THREE never-synced status
 * fields, each written by a different code path and read by a different surface:
 *
 *   - `state.lifecycleStatus`  (F6 ribbon, UPPERCASE 'DRAFT'|'PUBLISHED'|'EXPIRED')
 *   - `state.status`           (wizard/details, TitleCase 'Draft'|'Published'|'Expired')
 *   - `state.publishStatus`    (marketplace, 'Draft'|'Published'|'Deprecated')
 *
 * Net effect: clicking Publish on the ribbon set `lifecycleStatus=PUBLISHED` but
 * neither `status` (so the details badge stayed "Draft" forever) nor
 * `publishStatus` (so the product never entered marketplace search). Three
 * surfaces, three truths.
 *
 * This module collapses them into ONE canonical vocabulary,
 * `state.lifecycleState`, and gives every write path a single mutator that also
 * mirrors the legacy trio for backward-compat during the deprecation window, so
 * a publish anywhere is a publish everywhere. It is PURE + framework-free
 * (client- and server-safe, unit-testable without Cosmos): no React, no Azure
 * SDK, no I/O.
 *
 * Grounding: Dehghani's architectural-quantum (a data product is ONE owned,
 * independently-versioned unit); Bitol ODPS/ODCS one canonical `status`
 * lifecycle; Microsoft Purview Unified Catalog's single Draft → Published →
 * Unpublished → Expired lifecycle
 * (https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage).
 * The canonical superset also carries DP-5's certification rungs (validated /
 * certified) and DP-9's deprecation states (deprecated / retired).
 */

/** The ONE canonical lifecycle vocabulary. Superset of the three legacy fields
 *  plus DP-5 certification (validated/certified) and DP-9 sunset (retired). */
export type LifecycleState =
  | 'draft'
  | 'validated'
  | 'certified'
  | 'published'
  | 'deprecated'
  | 'retired';

export const LIFECYCLE_STATES: readonly LifecycleState[] = [
  'draft', 'validated', 'certified', 'published', 'deprecated', 'retired',
];

/** Monotonic "progress" rank — used to fold conflicting legacy fields to the
 *  furthest-along truth so a publish written to ANY single legacy field surfaces
 *  (closing the "publish here doesn't publish there" read defect for records
 *  written before `lifecycleState` existed). */
const RANK: Record<LifecycleState, number> = {
  draft: 0, validated: 1, certified: 2, published: 3, deprecated: 4, retired: 5,
};

/** Human labels + the Fluent badge color intent per canonical state. */
export const LIFECYCLE_META: Record<
  LifecycleState,
  { label: string; color: 'informative' | 'success' | 'warning' | 'danger' | 'brand' }
> = {
  draft:      { label: 'Draft',      color: 'informative' },
  validated:  { label: 'Validated',  color: 'brand' },
  certified:  { label: 'Certified',  color: 'success' },
  published:  { label: 'Published',  color: 'success' },
  deprecated: { label: 'Deprecated', color: 'warning' },
  retired:    { label: 'Retired',    color: 'danger' },
};

export function isLifecycleState(v: unknown): v is LifecycleState {
  return typeof v === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(v);
}

// ── Legacy vocabularies (kept mirrored during the deprecation window) ────────

/** F6 ribbon lifecycle field (UPPERCASE). */
export type LegacyLifecycleStatus = 'DRAFT' | 'PUBLISHED' | 'EXPIRED';
/** Wizard/details status field (TitleCase = DataProductStatus). */
export type LegacyStatus = 'Draft' | 'Published' | 'Expired';
/** Marketplace publishStatus field (= PublishStatus). */
export type LegacyPublishStatus = 'Draft' | 'Published' | 'Deprecated';

/** canonical → F6 ribbon UPPERCASE lifecycleStatus. */
export function toLifecycleStatus(s: LifecycleState): LegacyLifecycleStatus {
  if (s === 'published') return 'PUBLISHED';
  if (s === 'deprecated' || s === 'retired') return 'EXPIRED';
  return 'DRAFT';
}
/** canonical → TitleCase status (DataProductStatus) for the details badge. */
export function toStatus(s: LifecycleState): LegacyStatus {
  if (s === 'published') return 'Published';
  if (s === 'deprecated' || s === 'retired') return 'Expired';
  return 'Draft';
}
/** canonical → marketplace publishStatus (drives AI-Search consumer visibility). */
export function toPublishStatus(s: LifecycleState): LegacyPublishStatus {
  if (s === 'published') return 'Published';
  if (s === 'deprecated' || s === 'retired') return 'Deprecated';
  return 'Draft';
}

/** Fold any one legacy field value (any casing) to canonical. */
function foldLegacyField(v: unknown): LifecycleState | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  switch (v.trim().toUpperCase()) {
    case 'PUBLISHED': return 'published';
    case 'EXPIRED': return 'deprecated';
    case 'DEPRECATED': return 'deprecated';
    case 'RETIRED': return 'retired';
    case 'VALIDATED': return 'validated';
    case 'CERTIFIED': return 'certified';
    case 'DRAFT': return 'draft';
    default: return null;
  }
}

/**
 * Resolve the ONE canonical lifecycle state for a data-product `state`, with a
 * documented precedence:
 *
 *   1. If `state.lifecycleState` is already a valid canonical value, it is the
 *      single source of truth — return it verbatim.
 *   2. Otherwise (a legacy record with no canonical field), fold the three
 *      legacy fields (`lifecycleStatus`, `publishStatus`, `status`, any casing)
 *      to canonical and return the FURTHEST-ALONG of them by progress rank — so
 *      a Publish written to any single legacy field is honored on read, and an
 *      Expire/Deprecate (a deliberate later action) wins over a stale Published.
 *   3. Nothing present → 'draft'.
 *
 * A read-time shim only: no write happens here. `setLifecycleState()` stamps the
 * canonical field on the next save (lazy write-back), so no data backfill is
 * required.
 */
export function resolveLifecycleState(state: unknown): LifecycleState {
  const st = (state ?? {}) as Record<string, unknown>;
  if (isLifecycleState(st.lifecycleState)) return st.lifecycleState;
  const folded = [st.lifecycleStatus, st.publishStatus, st.status]
    .map(foldLegacyField)
    .filter((x): x is LifecycleState => x !== null);
  if (folded.length === 0) return 'draft';
  return folded.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/**
 * The ONE mutator every lifecycle-changing write path calls. Returns a NEW state
 * object with:
 *   (a) `state.lifecycleState` = the canonical value (single source of truth),
 *   (b) the legacy trio (`lifecycleStatus`/`status`/`publishStatus`) mirrored so
 *       every legacy read surface stays in sync during the deprecation window,
 *   (c) a `lifecycleStateAt` ISO timestamp.
 *
 * Callers persist the returned object and then re-project the AI-Search doc (via
 * `docForDataProduct`, which reads the mirrored `publishStatus`) so a lifecycle
 * Publish also makes the product discoverable — closing the
 * "Publish here doesn't publish there" defect.
 */
export function setLifecycleState<T extends Record<string, unknown>>(
  state: T,
  next: LifecycleState,
  at: string = new Date().toISOString(),
): T & {
  lifecycleState: LifecycleState;
  lifecycleStatus: LegacyLifecycleStatus;
  status: LegacyStatus;
  publishStatus: LegacyPublishStatus;
  lifecycleStateAt: string;
} {
  return {
    ...state,
    lifecycleState: next,
    // Legacy mirrors (backward-compat during the deprecation window):
    lifecycleStatus: toLifecycleStatus(next),
    status: toStatus(next),
    publishStatus: toPublishStatus(next),
    lifecycleStateAt: at,
  };
}
