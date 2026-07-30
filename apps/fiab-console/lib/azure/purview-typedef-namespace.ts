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
import { capAtlasTypedefName, tenantTypedefPrefix } from '@/lib/governance/uc-overlay/model';

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
  constructor(rejected: string[]) {
    super(
      `Refusing to create ACCOUNT-GLOBAL Purview Atlas classification typedef(s) from ` +
      `un-namespaced name(s): ${rejected.slice(0, 5).join(', ')}. Build the name with ` +
      `lib/azure/purview-typedef-namespace (loomClassificationTypedefName / ` +
      `loomSensitivityLabelTypedefName) so it carries a tenant discriminator.`,
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

/** Uppercase A–Z/0–9/underscore slug for one Atlas typedef path segment. */
function typedefSlug(s: string): string {
  return (s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
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
