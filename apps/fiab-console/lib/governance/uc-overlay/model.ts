/**
 * LU-5 — Loom Unity GOVERNANCE OVERLAY model (PURE: no Azure SDK, no fetch, no
 * React). The reducer + validators below are the whole decision surface; the
 * Cosmos I/O lives in `store.ts` and the Purview write in `purview-sync.ts`.
 *
 * WHY AN OVERLAY AND NOT A SECOND CATALOG
 * ---------------------------------------
 * Databricks Unity Catalog governs tags / governed tags / certification with
 * warehouse-side SQL DDL (`ALTER TABLE … SET TAGS`, `CREATE GOVERNED TAG …
 * ALLOWED VALUES`). None of that exists on the OSS Unity Catalog server Loom
 * deploys in Azure Government (`loom-unity`, uc-backend.ts) — which is why
 * `UC_CAPABILITIES.tags` read `oss: 'none'` and the tag dialogs hard-gated at
 * the Gov boundary. LU-5 closes that with a Loom-native overlay: the governance
 * FACTS live in Loom (Cosmos), keyed on the securable's canonical identity, and
 * apply to BOTH backends. No Fabric, no Power BI, no Databricks required
 * (`.claude/rules/no-fabric-dependency.md`).
 *
 * THE FOUR REUSE DECISIONS (the point of this module — see PR body)
 * ----------------------------------------------------------------
 * 1. IDENTITY is not re-invented. A securable is addressed by the SAME string
 *    the lineage merge, `asset-graph`, and the dbt manifest importer already
 *    collapse on: `uc:<catalog.schema.table>` ({@link ucSecurableIdentity},
 *    mirroring `unified-lineage.ucIdentity`) and `col:uc:<fqn>::<column>` for
 *    columns (mirroring `unified-lineage.columnIdentity`). Those two functions
 *    live in a server-only module (it pulls Cosmos + Purview), so they are
 *    re-stated here for the pure/client tier and PINNED to the originals by
 *    `__tests__/model.test.ts` — if either side drifts, that test fails.
 *    Consequence: an overlay row joins to a lineage node, a Purview asset, and
 *    a Loom item with zero extra mapping.
 * 2. CERTIFICATION reuses `EndorsementRung` from `lib/dataproducts/certification`
 *    — the SAME `none | promoted | certified` ladder as the data-product
 *    certification pipeline, the `endorsement` facet on the governance catalog
 *    index (`governance-catalog-shapes.ts`), and Power BI endorsement. No new
 *    enum, so a UC table and a data product sort into the same facet bucket.
 * 3. ATTRIBUTE GROUPS reuse the tenant's existing schema wholesale —
 *    `AttributeGroup` / `AttributeDef` / `missingRequiredAttributes` from
 *    `lib/types/attribute-groups` (Loom's Purview "custom metadata" equivalent,
 *    stored at `attribute-groups:<tenantId>`). The overlay stores VALUES only,
 *    keyed by `AttributeDef.id`; it never defines a second attribute schema.
 * 4. GOVERNED TAGS are the one genuinely new vocabulary, and deliberately so: a
 *    tag is a key=value stamped on a *securable*, while an `AttributeDef` is a
 *    typed field of a *governance-domain business concept*. Modelling a tag as
 *    a "Single choice" AttributeDef would force every tag key into a domain
 *    scope it does not have. The definition shape instead mirrors the
 *    Databricks DDL 1:1 (key + description + ALLOWED VALUES), so LU-6's ABAC
 *    compiler can emit either the Databricks tag DDL or a Synapse secure view
 *    from the same rows.
 *
 * THE CONTROLLED-VOCABULARY RULE: assigning a value that is not in a governed
 * tag's `allowedValues` is REJECTED ({@link validateTagAssignment}) — that is
 * what makes a governed tag governed. Keys with no governed definition stay
 * free-form, matching Databricks plain tags.
 *
 * Grounding (Microsoft Learn / Databricks docs, not memory):
 *   - Tags on database objects: https://learn.microsoft.com/azure/databricks/database-objects/tags
 *   - Governed tags + tag policies: https://learn.microsoft.com/azure/databricks/admin/governed-tags/manage-governed-tags
 *   - Certify / deprecate data: https://docs.databricks.com/aws/en/data-governance/unity-catalog/certify-deprecate-data
 *   - Purview custom metadata (attributes): https://learn.microsoft.com/purview/unified-catalog-attributes-business-concept
 */
import type { EndorsementRung } from '@/lib/dataproducts/certification';
import { kebab, type AttributeGroup } from '@/lib/types/attribute-groups';

export type { EndorsementRung };

/** Securable kinds the overlay can annotate. Mirrors the UC securable set that
 *  both backends implement, plus `column` (Loom-side, keyed on `col:` identity). */
export type UcSecurableType =
  | 'catalog' | 'schema' | 'table' | 'volume' | 'function' | 'model' | 'column';

export const UC_SECURABLE_TYPES: UcSecurableType[] = [
  'catalog', 'schema', 'table', 'volume', 'function', 'model', 'column',
];

/** A tag assignment on a securable. `governed` is DERIVED at write time from the
 *  tenant vocabulary — persisted so a later vocabulary edit cannot silently
 *  re-characterise history (and so the ABAC compiler can trust the flag). */
export interface UcOverlayTag {
  key: string;
  value: string;
  governed?: boolean;
}

/** One governed-tag definition — the controlled vocabulary entry. Shape mirrors
 *  `CREATE GOVERNED TAG <key> ALLOWED VALUES (…)`. */
export interface UcGovernedTagDef {
  /** Stable slug (kebab). Case-insensitive on assignment. */
  key: string;
  description?: string;
  /** Non-empty; a value outside this list is rejected on assignment. */
  allowedValues: string[];
}

/** The single per-tenant vocabulary document (Cosmos `tenant-settings`), stored
 *  alongside `attribute-groups:<tenantId>` and `policies:<tenantId>`. */
export interface UcGovernedTagsDoc {
  /** `uc-governed-tags:<tenantId>`. */
  id: string;
  tenantId: string;
  kind: 'uc-governed-tags';
  tags: UcGovernedTagDef[];
  updatedAt: string;
  updatedBy?: string;
}

/** Certification status of a securable, on the shared Loom endorsement ladder. */
export interface UcCertification {
  rung: EndorsementRung;
  /** UPN of the signer for the CURRENT rung (absent while `none`). */
  by?: string;
  at?: string;
  note?: string;
}

/** Values for the tenant's attribute groups, keyed by `AttributeDef.id`. */
export type UcAttributeValues = Record<string, string | number | boolean | string[]>;

/** Result of the last Purview fold-in for this securable (provenance, not a cache). */
export interface UcPurviewProvenance {
  guid?: string;
  syncedAt?: string;
  /** Atlas classification names last pushed (governed tags). */
  classifications?: string[];
  /** `LoomCustomTags` business-metadata keys last pushed. */
  businessMetadataKeys?: string[];
}

/** One overlay document — one per securable identity, per tenant. */
export interface UcGovernanceOverlay {
  /** Cosmos id === {@link UcGovernanceOverlay.identity} (colons/dots are legal). */
  id: string;
  /** Partition key. */
  tenantId: string;
  kind: 'uc-governance-overlay';
  /** `uc:<fqn>` or `col:uc:<fqn>::<column>`. The cross-source join key. */
  identity: string;
  /** The UC full name as typed (original case preserved for display). */
  fullName: string;
  securableType: UcSecurableType;
  /** Present only when `securableType === 'column'`. */
  column?: string;
  tags: UcOverlayTag[];
  certification: UcCertification;
  attributes: UcAttributeValues;
  purview?: UcPurviewProvenance;
  updatedAt: string;
  updatedBy: string;
}

/** Validation failure carrying an HTTP status so routes can pass it straight through. */
export class UcOverlayError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'UcOverlayError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Identity — KEEP IN SYNC with unified-lineage.ucIdentity / columnIdentity.
// Pinned by __tests__/model.test.ts (it imports both and asserts equality).
// ---------------------------------------------------------------------------

/** `catalog.schema.table` → `uc:<lowercased>`, the canonical securable identity. */
export function ucSecurableIdentity(fullName: string): string {
  return `uc:${String(fullName || '').trim().toLowerCase()}`;
}

/** A column of a UC securable → `col:uc:<fqn>::<column>`. */
export function ucColumnIdentity(fullName: string, column: string): string {
  return `col:${ucSecurableIdentity(fullName)}::${String(column || '').trim().toLowerCase()}`;
}

/** The identity for a (fullName, column?) pair — the single entry point routes use. */
export function overlayIdentity(fullName: string, column?: string): string {
  return column ? ucColumnIdentity(fullName, column) : ucSecurableIdentity(fullName);
}

/**
 * Default securable type from the dotted arity of a UC full name: 1 part =
 * catalog, 2 = schema, 3+ = table. Volumes / functions / models are also
 * three-part, so callers that KNOW the kind pass it explicitly; this is only
 * the fallback for a bare name.
 */
export function defaultSecurableType(fullName: string): UcSecurableType {
  const parts = String(fullName || '').trim().split('.').filter(Boolean);
  if (parts.length <= 1) return 'catalog';
  if (parts.length === 2) return 'schema';
  return 'table';
}

/** Reject names that would produce a malformed identity or an unusable Cosmos id. */
export function assertValidFullName(fullName: string): string {
  const v = String(fullName || '').trim();
  if (!v) throw new UcOverlayError('fullName is required');
  if (v.length > 512) throw new UcOverlayError('fullName is too long (max 512)');
  // Cosmos ids may not contain / \ ? # — and a UC name never legitimately does.
  if (/[/\\?#]/.test(v)) throw new UcOverlayError('fullName contains an illegal character (/ \\ ? #)');
  return v;
}

// ---------------------------------------------------------------------------
// Governed-tag vocabulary
// ---------------------------------------------------------------------------

/**
 * Validate a proposed vocabulary. Returns the first problem as a string, or
 * null when valid — same contract as `validateAttributes` in
 * `lib/types/attribute-groups`, so the admin UI and the route share one rule set.
 */
export function validateGovernedTagDefs(defs: UcGovernedTagDef[]): string | null {
  if (!Array.isArray(defs)) return 'tags must be an array';
  const seen = new Set<string>();
  for (const d of defs) {
    const key = (d?.key || '').trim();
    if (!key) return 'every governed tag needs a key';
    if (key.length > 64) return `governed tag key "${key}" is too long (max 64)`;
    const norm = key.toLowerCase();
    if (seen.has(norm)) return `duplicate governed tag key "${key}"`;
    seen.add(norm);
    const values = (d.allowedValues || []).map((v) => (v ?? '').trim()).filter(Boolean);
    if (values.length === 0) return `governed tag "${key}" requires at least one allowed value`;
    const dupe = values.find((v, i) => values.findIndex((o) => o.toLowerCase() === v.toLowerCase()) !== i);
    if (dupe) return `governed tag "${key}" has a duplicate allowed value "${dupe}"`;
  }
  return null;
}

/** Normalize a vocabulary for persistence: kebab keys, trimmed unique values. */
export function normalizeGovernedTagDefs(defs: UcGovernedTagDef[]): UcGovernedTagDef[] {
  return (defs || []).map((d) => {
    const values: string[] = [];
    for (const raw of d.allowedValues || []) {
      const v = (raw ?? '').trim();
      if (v && !values.some((o) => o.toLowerCase() === v.toLowerCase())) values.push(v);
    }
    return {
      key: kebab(d.key),
      ...(d.description ? { description: String(d.description).trim() } : {}),
      allowedValues: values,
    };
  });
}

/** Case-insensitive lookup of a governed-tag definition. */
export function findGovernedTag(
  vocabulary: UcGovernedTagDef[],
  key: string,
): UcGovernedTagDef | undefined {
  const k = (key || '').trim().toLowerCase();
  return (vocabulary || []).find((d) => (d.key || '').toLowerCase() === k);
}

/**
 * THE CONTROLLED-VOCABULARY GATE. Validates one batch of tag assignments
 * against the tenant vocabulary and returns them normalized (with `governed`
 * stamped). Throws {@link UcOverlayError} on:
 *   - an empty key,
 *   - a governed key whose value is not in `allowedValues` (case-insensitive
 *     match, canonical casing restored),
 *   - a governed key with an empty value.
 * Ungoverned keys pass through as free-form tags (Databricks plain-tag parity).
 */
export function validateTagAssignment(
  tags: Array<{ key: string; value?: string }>,
  vocabulary: UcGovernedTagDef[],
): UcOverlayTag[] {
  const out: UcOverlayTag[] = [];
  for (const t of tags || []) {
    const key = (t?.key || '').trim();
    if (!key) throw new UcOverlayError('every tag needs a key');
    if (key.length > 64) throw new UcOverlayError(`tag key "${key}" is too long (max 64)`);
    const raw = (t?.value ?? '').toString().trim();
    const def = findGovernedTag(vocabulary, key);
    if (!def) {
      if (raw.length > 256) throw new UcOverlayError(`tag "${key}" value is too long (max 256)`);
      out.push({ key, value: raw, governed: false });
      continue;
    }
    if (!raw) {
      throw new UcOverlayError(
        `governed tag "${def.key}" requires a value from its vocabulary (allowed: ${def.allowedValues.join(', ')})`,
      );
    }
    const canonical = def.allowedValues.find((v) => v.toLowerCase() === raw.toLowerCase());
    if (!canonical) {
      throw new UcOverlayError(
        `"${raw}" is not an allowed value for governed tag "${def.key}" (allowed: ${def.allowedValues.join(', ')})`,
      );
    }
    out.push({ key: def.key, value: canonical, governed: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlay reducer
// ---------------------------------------------------------------------------

/** A fresh, empty overlay for a securable — the shape a first read returns. */
export function emptyOverlay(p: {
  tenantId: string;
  fullName: string;
  securableType?: UcSecurableType;
  column?: string;
  now?: string;
}): UcGovernanceOverlay {
  const fullName = assertValidFullName(p.fullName);
  const column = p.column ? String(p.column).trim() : undefined;
  const identity = overlayIdentity(fullName, column);
  return {
    id: identity,
    tenantId: p.tenantId,
    kind: 'uc-governance-overlay',
    identity,
    fullName,
    securableType: column ? 'column' : (p.securableType || defaultSecurableType(fullName)),
    ...(column ? { column } : {}),
    tags: [],
    certification: { rung: 'none' },
    attributes: {},
    updatedAt: p.now || new Date().toISOString(),
    updatedBy: '',
  };
}

/** One overlay mutation. Every field is optional; omitted fields are untouched. */
export interface UcOverlayMutation {
  /** Upsert these tags (key match is case-insensitive; last write wins). */
  setTags?: Array<{ key: string; value?: string }>;
  /** Remove these tag keys (case-insensitive). */
  removeTagKeys?: string[];
  /** Move the certification rung. `by`/`at` are stamped from the caller. */
  certification?: { rung: EndorsementRung; note?: string };
  /** Merge these attribute values (keyed by AttributeDef.id). `null` deletes. */
  attributes?: Record<string, string | number | boolean | string[] | null>;
}

const RUNGS: EndorsementRung[] = ['none', 'promoted', 'certified'];

/**
 * Apply a mutation to an overlay. PURE — returns a new document, never mutates
 * the input, never touches I/O. Throws {@link UcOverlayError} on any invalid
 * input (governed-tag violation, unknown rung, unknown attribute id).
 *
 * `attributeGroups` is the tenant's EXISTING attribute schema
 * (`lib/types/attribute-groups`); values whose id is not defined by any group
 * are rejected rather than silently persisted, so the overlay can never
 * accumulate orphan attributes the wizards will not render.
 */
export function applyOverlayMutation(
  overlay: UcGovernanceOverlay,
  mutation: UcOverlayMutation,
  ctx: {
    vocabulary: UcGovernedTagDef[];
    attributeGroups: AttributeGroup[];
    actorUpn: string;
    now?: string;
  },
): UcGovernanceOverlay {
  const now = ctx.now || new Date().toISOString();
  let tags = [...(overlay.tags || [])];

  if (mutation.removeTagKeys?.length) {
    const drop = new Set(mutation.removeTagKeys.map((k) => (k || '').trim().toLowerCase()).filter(Boolean));
    tags = tags.filter((t) => !drop.has(t.key.toLowerCase()));
  }

  if (mutation.setTags?.length) {
    const incoming = validateTagAssignment(mutation.setTags, ctx.vocabulary);
    for (const t of incoming) {
      const i = tags.findIndex((x) => x.key.toLowerCase() === t.key.toLowerCase());
      if (i >= 0) tags[i] = t; else tags.push(t);
    }
  }

  let certification = overlay.certification || { rung: 'none' as EndorsementRung };
  if (mutation.certification) {
    const rung = mutation.certification.rung;
    if (!RUNGS.includes(rung)) {
      throw new UcOverlayError(`certification rung must be one of ${RUNGS.join(', ')}`);
    }
    certification = rung === 'none'
      ? { rung, ...(mutation.certification.note ? { note: mutation.certification.note } : {}) }
      : {
          rung,
          by: ctx.actorUpn,
          at: now,
          ...(mutation.certification.note ? { note: mutation.certification.note } : {}),
        };
  }

  const attributes: UcAttributeValues = { ...(overlay.attributes || {}) };
  if (mutation.attributes) {
    const known = new Set<string>();
    for (const g of ctx.attributeGroups || []) for (const a of g.attributes || []) known.add(a.id);
    for (const [id, value] of Object.entries(mutation.attributes)) {
      if (!known.has(id)) {
        throw new UcOverlayError(
          `unknown attribute "${id}" — define it in an attribute group first (Governance → Custom attributes)`,
        );
      }
      if (value === null || value === undefined || value === '') delete attributes[id];
      else attributes[id] = value;
    }
  }

  return { ...overlay, tags, certification, attributes, updatedAt: now, updatedBy: ctx.actorUpn };
}

// ---------------------------------------------------------------------------
// Purview projection (pure half of the fold-in; the REST calls live in
// purview-sync.ts so this stays unit-testable without a Purview account).
// ---------------------------------------------------------------------------

/** Atlas typedef names accept letters/digits/underscore only. */
export function atlasSafeName(s: string): string {
  return (s || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface UcPurviewProjection {
  /** Atlas CLASSIFICATION names for the governed tags (controlled vocabulary →
   *  controlled classification set). `Loom_<key>_<value>`. */
  classifications: string[];
  /** `LoomCustomTags` business-metadata attributes: free tags + certification. */
  businessMetadata: Record<string, string>;
}

/**
 * Project an overlay onto the CLASSIC Purview Data Map's two extension points.
 *
 * Why this split: an Atlas classification is a *controlled* typedef that has to
 * exist before it can be attached — an exact structural match for a governed
 * tag. Free-form key/values have no typedef, so they go to business metadata
 * (`LoomCustomTags`), the namespace `purview-client.setBusinessMetadata` already
 * grows on demand. Certification rides along as a business-metadata attribute
 * because classic Atlas has no endorsement concept.
 *
 * The account Loom provisions via ARM is a CLASSIC Data Map account (Atlas v2)
 * — it does NOT expose the unified-catalog `/datagovernance` surface (see the
 * header of `lib/azure/purview-client.ts`), so nothing here targets that host.
 */
export function projectOverlayToPurview(overlay: UcGovernanceOverlay): UcPurviewProjection {
  const classifications: string[] = [];
  const businessMetadata: Record<string, string> = {};
  for (const t of overlay.tags || []) {
    if (t.governed) {
      const name = `Loom_${atlasSafeName(t.key)}_${atlasSafeName(t.value)}`;
      if (!classifications.includes(name)) classifications.push(name);
    } else {
      businessMetadata[atlasSafeName(t.key) || 'tag'] = t.value;
    }
  }
  const rung = overlay.certification?.rung || 'none';
  if (rung !== 'none') {
    businessMetadata.loom_certification = rung;
    if (overlay.certification?.by) businessMetadata.loom_certified_by = overlay.certification.by;
    if (overlay.certification?.at) businessMetadata.loom_certified_at = overlay.certification.at;
  }
  return { classifications, businessMetadata };
}
