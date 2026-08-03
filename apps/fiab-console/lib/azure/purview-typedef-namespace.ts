/**
 * ATLAS TYPEDEF NAMESPACE AUTHORITY — the single place a tenant-authored word
 * may become an ACCOUNT-GLOBAL Microsoft Purview Atlas classification typedef.
 *
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * In the classic Purview Data Map, Atlas classification typedefs are
 * ACCOUNT-GLOBAL and PERMANENT, while a Loom "tenant" is only a Cosmos
 * partition (`tid || oid`). Any code path that calls
 * `purview-client.ensureClassificationDefs()` with a name derived from
 * tenant-authored text therefore lets one tenant create — and semantically
 * collide with — another tenant's vocabulary inside a shared Purview account.
 *
 * LU-5 fixed that for its OWN writes (`Loom_<t8>_<key>_<value>`), but the fix
 * was applied at the call site, so the class sweep could — and did — miss
 * siblings: `purview-autoonboard` passed `item.state.classifications`
 * VERBATIM, `admin/batch-labeling` passed `body.labelName` VERBATIM, and
 * `items/[type]/[id]/sensitivity` interpolated an unvalidated `body.labelId`
 * into the `MICROSOFT.GOVERNANCE.*` namespace that Purview's own MIP
 * integration owns.
 *
 * THE STRUCTURAL FIX: make the bad state unrepresentable rather than
 * sanitising per caller.
 *
 *   1. {@link AtlasClassificationTypedefName} is a BRANDED string. Only this
 *      module can mint one, and `ensureClassificationDefs` accepts nothing
 *      else — so a future caller that hands it a bare tenant word does not
 *      compile. That is the primary guarantee.
 *   2. {@link assertNamespacedTypedefNames} is a coarse RUNTIME backstop for
 *      the paths TypeScript cannot see (an `any`-typed payload, a JS caller,
 *      a `as any` cast). It is deliberately shape-based and NOT a substitute
 *      for (1).
 *   3. Every name is built by one of the builders below, all of which put an
 *      8-hex tenant discriminator ahead of the tenant-authored segment and
 *      length-cap with {@link capAtlasTypedefName} so truncation stays
 *      injective.
 *
 * The discriminator is `model.tenantTypedefPrefix` — the SAME function LU-5
 * uses, deliberately, so there is exactly one namespace rule in the tree. It is
 * a namespace discriminator, NOT a secret and NOT a security primitive.
 *
 * Docs: https://learn.microsoft.com/purview/data-gov-api-atlas-2-2 (typedefs)
 *       https://learn.microsoft.com/purview/data-map-classification-custom
 */
import {
  capAtlasTypedefName, tenantBusinessMetadataName, tenantTypedefPrefix,
} from '@/lib/governance/uc-overlay/model';
import { trimChar } from '@/lib/util/trim';

export { tenantTypedefPrefix };

/**
 * Atlas classification-typedef prefix used by the Purview Data Map ↔ MIP
 * sensitivity-label integration: `MICROSOFT.GOVERNANCE.LABELS.<labelGuid>`.
 *
 * This namespace is owned by MICROSOFT, not by Loom. A name under it is only
 * legitimate when the suffix is a real MIP label GUID (issued by Purview/MIP,
 * therefore globally unique and not tenant-authored). Anything else is
 * namespace squatting, which is why {@link NAMESPACED_TYPEDEF_SHAPES} requires
 * a GUID here and {@link loomSensitivityLabelTypedefName} falls back to a
 * Loom-owned, tenant-namespaced name when there is no GUID.
 */
export const SENSITIVITY_LABEL_TYPEDEF_PREFIX = 'MICROSOFT.GOVERNANCE.LABELS.';

/**
 * An Atlas CLASSIFICATION typedef name proven to carry a namespace
 * discriminator. Structurally unforgeable outside this module: the brand is a
 * `unique symbol` property no other file can name.
 */
export type AtlasClassificationTypedefName = string & {
  readonly __atlasNamespaced: unique symbol;
};

/** Thrown when a name that would become an account-global typedef is not namespaced. */
export class UnnamespacedTypedefError extends Error {
  readonly rejected: string[];
  constructor(rejected: string[], kind: 'classification' | 'business metadata' = 'classification') {
    const builders = kind === 'classification'
      ? 'loomClassificationTypedefName / loomSensitivityLabelTypedefName'
      : 'loomTenantBusinessMetadataName';
    super(
      `Refusing to create ACCOUNT-GLOBAL Purview Atlas ${kind} typedef(s) from ` +
      `un-namespaced name(s): ${rejected.slice(0, 5).join(', ')}. Build the name with ` +
      `lib/azure/purview-typedef-namespace (${builders}) so it carries a tenant discriminator.`,
    );
    this.name = 'UnnamespacedTypedefError';
    this.rejected = rejected;
  }
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Shapes that PROVE a namespace discriminator sits ahead of any
 * tenant-authored segment. COARSE BY DESIGN — the brand is the real guarantee;
 * this only has to reject a bare vocabulary word (`PII`, `Confidential`,
 * `Highly Confidential`) and MIP-namespace squatting.
 */
const NAMESPACED_TYPEDEF_SHAPES: RegExp[] = [
  // items/[id]/classifications + purview-autoonboard: LOOM.CLASSIFICATION.<t8>.<SLUG>
  // batch-labeling + items/[id]/sensitivity fallback:  LOOM.LABEL.<t8>.<SLUG>
  // `(_[0-9a-f]{8})?` is the injective digest tail capAtlasTypedefName appends
  // when the natural name overflows MAX_ATLAS_NAME_LENGTH.
  /^LOOM\.(CLASSIFICATION|LABEL)\.[0-9a-f]{8}\.[A-Z0-9_]+(_[0-9a-f]{8})?$/,
  // purview-classification-sync (already correct): LOOM.<TENANT8>.<CLASS>
  /^LOOM\.[A-Z0-9]{1,8}\.[A-Z0-9_]+$/,
  // LU-5 governance overlay: Loom_<t8>_<key>_<value> (+ digest tail when capped)
  /^Loom_[0-9a-f]{8}_[A-Za-z0-9_]+$/,
];

/** True when `name` carries a namespace discriminator (see the shapes above). */
export function isNamespacedTypedefName(name: string): boolean {
  const n = (name || '').trim();
  if (!n) return false;
  if (n.startsWith(SENSITIVITY_LABEL_TYPEDEF_PREFIX)) {
    // The MICROSOFT.GOVERNANCE.* namespace is Microsoft's: only a real MIP
    // label GUID may appear under it.
    return GUID_RE.test(n.slice(SENSITIVITY_LABEL_TYPEDEF_PREFIX.length));
  }
  return NAMESPACED_TYPEDEF_SHAPES.some((re) => re.test(n));
}

/**
 * Validate + brand. THE ONLY mint in the codebase — every other module either
 * calls a builder below or funnels an already-namespaced name through here.
 * @throws UnnamespacedTypedefError when the name is not namespaced.
 */
export function asAtlasClassificationTypedefName(name: string): AtlasClassificationTypedefName {
  const n = (name || '').trim();
  if (!isNamespacedTypedefName(n)) throw new UnnamespacedTypedefError([name]);
  return n as AtlasClassificationTypedefName;
}

/**
 * Runtime backstop for `ensureClassificationDefs`. Fails CLOSED (throws) —
 * creating the typedef anyway would be permanent and account-global, so
 * refusing is strictly safer than proceeding.
 */
export function assertNamespacedTypedefNames(names: readonly string[]): void {
  const rejected = (names || []).map((n) => (n || '').trim()).filter((n) => n && !isNamespacedTypedefName(n));
  if (rejected.length) throw new UnnamespacedTypedefError(rejected);
}

/**
 * Uppercase A–Z/0–9/underscore slug for one Atlas typedef path segment.
 *
 * CodeQL js/polynomial-redos HIGH, alert #728 — the last open instance of the
 * class #2677 closed. The edge-trim was `.replace(/^_+|_+$/g, '')`.
 *
 * The regex IS quadratic in isolation. Measured, on `'A' + '_'.repeat(N) + 'B'`
 * (a non-`_` head, so `^_+` does not consume the run, then a tail so `_+$`
 * fails and retries from every offset):
 *
 *     N =  10_000 ->      58 ms
 *     N =  50_000 ->   1_421 ms
 *     N = 200_000 ->  23_948 ms
 *
 * But it is NOT reachable here, and the honest reason matters more than the
 * fix: `[^A-Z0-9]+ -> '_'` runs FIRST and collapses each run of non-alphanumerics
 * to a SINGLE underscore, so the trim never sees a run longer than 1. Verified —
 * 200_000 chars of `_`, of spaces, and of mixed punctuation all reduce to `A_B`,
 * longest underscore run 1. (My first draft of this comment claimed the opposite;
 * the measurement corrected it.)
 *
 * So this is defence-in-depth, not an incident fix. It is still worth doing: the
 * safety of the old form depended on the ORDER of two operations chained in one
 * expression — reorder them, or drop the collapse, and the quadratic blowup above
 * becomes reachable with tenant-authored input. `trimChar` is linear regardless,
 * so the property no longer depends on a neighbouring call.
 *
 * `trimChar` is the sanctioned linear primitive (index scan, no backtracking);
 * `check-quadratic-trims.mjs` forbids reintroducing the regex form.
 */
function typedefSlug(s: string): string {
  return trimChar((s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_'), '_');
}

/**
 * The Atlas CLASSIFICATION typedef name for one Loom taxonomy classification.
 *
 * `LOOM.CLASSIFICATION.<t8>.<SLUG>` — the tenant discriminator sits AHEAD of
 * the tenant-authored word, so tenant A's `PII` and tenant B's `PII` are
 * different account-global typedefs.
 */
export function loomClassificationTypedefName(
  tenantId: string,
  classification: string,
): AtlasClassificationTypedefName {
  const slug = typedefSlug(classification) || 'CLASSIFICATION';
  return capAtlasTypedefName(
    `LOOM.CLASSIFICATION.${tenantTypedefPrefix(tenantId)}.${slug}`,
  ) as AtlasClassificationTypedefName;
}

/**
 * The Atlas CLASSIFICATION typedef name for a sensitivity label.
 *
 *   - `labelId` is a real MIP GUID → `MICROSOFT.GOVERNANCE.LABELS.<guid>`, the
 *     typedef Purview's own MIP integration creates. Account-global BY DESIGN
 *     and safe: the GUID is issued by MIP, not authored by a tenant, so two
 *     tenants naming the same label cannot collide on a different meaning.
 *   - anything else (a free-text label, an unvalidated `labelId`) →
 *     `LOOM.LABEL.<t8>.<SLUG>`, Loom-owned and tenant-namespaced. This is the
 *     branch that stops `MICROSOFT.GOVERNANCE.LABELS.<whatever-was-typed>`
 *     from squatting Microsoft's namespace.
 */
export function loomSensitivityLabelTypedefName(
  tenantId: string,
  opts: { labelId?: string; labelName?: string },
): AtlasClassificationTypedefName {
  const id = (opts.labelId || '').trim();
  if (GUID_RE.test(id)) {
    return `${SENSITIVITY_LABEL_TYPEDEF_PREFIX}${id}` as AtlasClassificationTypedefName;
  }
  const slug = typedefSlug(opts.labelName || id) || 'LABEL';
  return capAtlasTypedefName(
    `LOOM.LABEL.${tenantTypedefPrefix(tenantId)}.${slug}`,
  ) as AtlasClassificationTypedefName;
}

// ---------------------------------------------------------------------------
// BUSINESS METADATA (issue #2633) — the same class, one API surface over.
//
// An Atlas BUSINESS-METADATA typedef ("managed attributes") is ACCOUNT-GLOBAL
// exactly like a classification typedef, and `setBusinessMetadata` writes it
// with `isOverwrite=true` — which REPLACES the whole bag on that entity. So the
// account-global `LoomCustomTags` bag has TWO cross-tenant failure modes on a
// shared Purview account, not one:
//
//   1. LEAK/CLOBBER — tenant B saving custom tags on an asset overwrites every
//      attribute tenant A had written into the same bag on the same entity.
//   2. PERMANENT VOCABULARY GROWTH — `ensureBusinessMetadataDef` adds each
//      tenant-authored key to the shared typedef, forever, visible to everyone.
//
// LU-5 already writes a per-tenant bag (`model.tenantBusinessMetadataName` →
// `LoomCustomTags_<t8>`); the pre-existing item-level custom-tags route did not.
// The remedy is the SAME shape as the classification one above: a branded name
// that only this module can mint, so `purview-client.setBusinessMetadata` /
// `ensureBusinessMetadataDef` cannot be handed a bare bag name and still
// compile. `LOOM_BUSINESS_METADATA_NAME` therefore survives as a READ-ONLY
// legacy constant (pre-migration values live under it) and is not mintable.
// ---------------------------------------------------------------------------

/**
 * An Atlas BUSINESS-METADATA bag name proven to carry a tenant discriminator.
 * Structurally unforgeable outside this module, same as
 * {@link AtlasClassificationTypedefName}.
 */
export type AtlasBusinessMetadataName = string & {
  readonly __atlasNamespacedBag: unique symbol;
};

/** `LoomCustomTags_<t8>` — the ONLY shape {@link tenantBusinessMetadataName} emits. */
const NAMESPACED_BUSINESS_METADATA_SHAPE = /^LoomCustomTags_[0-9a-f]{8}$/;

/** True when `name` is a tenant-namespaced business-metadata bag. */
export function isNamespacedBusinessMetadataName(name: string): boolean {
  return NAMESPACED_BUSINESS_METADATA_SHAPE.test((name || '').trim());
}

/**
 * Validate + brand a business-metadata bag name. THE ONLY mint. Fails CLOSED:
 * the bare `LoomCustomTags` bag is rejected, because growing/overwriting it is
 * the defect this exists to prevent.
 * @throws UnnamespacedTypedefError when the name is not namespaced.
 */
export function asAtlasBusinessMetadataName(name: string): AtlasBusinessMetadataName {
  const n = (name || '').trim();
  if (!isNamespacedBusinessMetadataName(n)) throw new UnnamespacedTypedefError([name], 'business metadata');
  return n as AtlasBusinessMetadataName;
}

/**
 * The business-metadata bag a tenant's free-form custom tags are written to —
 * `LoomCustomTags_<t8>`. Delegates to `model.tenantBusinessMetadataName` so the
 * LU-5 overlay and the item-level custom-tags route resolve to the SAME bag for
 * the same tenant (one namespace rule in the tree), then brands it.
 */
export function loomTenantBusinessMetadataName(tenantId: string): AtlasBusinessMetadataName {
  return asAtlasBusinessMetadataName(tenantBusinessMetadataName(tenantId));
}
