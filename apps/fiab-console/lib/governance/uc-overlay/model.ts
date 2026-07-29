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
 *    `AttributeGroup` / `AttributeDef` from `lib/types/attribute-groups`
 *    (Loom's Purview "custom metadata" equivalent, stored at
 *    `attribute-groups:<tenantId>`). The overlay stores VALUES only, keyed by
 *    `AttributeDef.id`; it never defines a second attribute schema, and
 *    {@link validateAttributeValues} enforces each value against its OWN
 *    `fieldType` / `choices`. NOTE: `AttributeDef.required` is deliberately NOT
 *    enforced on an overlay write — required-ness is a wizard-completion rule
 *    (`missingRequiredAttributes`) for a NEW object, whereas an overlay is
 *    incrementally annotated and must accept a partial write.
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
import {
  CHOICE_FIELD_TYPES, kebab, type AttributeDef, type AttributeGroup,
} from '@/lib/types/attribute-groups';

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
  /** Business-metadata keys last pushed. */
  businessMetadataKeys?: string[];
  /** The TENANT-NAMESPACED business-metadata typedef those keys were written
   *  under (`LoomCustomTags_<t8>`) — recorded so an audit reader can tell which
   *  Atlas namespace on a shared account a value came from. */
  businessMetadataName?: string;
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

/** `catalog.schema.table` → `uc:<lowercased>`, the canonical securable identity.
 *  Mirrors `unified-lineage.ucIdentity` (which does not trim; `assertValidFullName`
 *  has already trimmed everything that reaches here). */
export function ucSecurableIdentity(fullName: string): string {
  return `uc:${String(fullName || '').trim().toLowerCase()}`;
}

/**
 * Pure restatement of the UC branch of `unified-lineage.normalizeIdentity`.
 *
 * That function only prefixes `uc:` for a name with EXACTLY three dot parts
 * (`^[\w$]+\.[\w$]+\.[\w$]+$`); anything else is returned lowercased as-is. The
 * column join key has to agree with it EXACTLY or column overlays silently stop
 * joining the lineage graph — an unconditional `uc:` prefix diverges for every
 * non-three-part name. Pinned against the original by `__tests__/model.test.ts`
 * across 1-, 2-, 3- and 4-part names.
 */
export function normalizeUcIdentity(raw: string): string {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (/^[\w$]+\.[\w$]+\.[\w$]+$/.test(v)) return `uc:${v.toLowerCase()}`;
  return v.toLowerCase();
}

/** A column of a UC securable → `col:<normalized table>::<column>`, byte-identical
 *  to `unified-lineage.columnIdentity` for every trimmed input. */
export function ucColumnIdentity(fullName: string, column: string): string {
  return `col:${normalizeUcIdentity(fullName)}::${String(column || '').trim().toLowerCase()}`;
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

/** Max characters in one governed-tag allowed VALUE. See the note in
 *  {@link validateGovernedTagDefs} — this bounds half of the Atlas typedef name. */
export const MAX_ALLOWED_VALUE_LENGTH = 64;
/** Max allowed values in one governed-tag definition. */
export const MAX_ALLOWED_VALUES = 200;

/**
 * Validate a proposed vocabulary. Returns the first problem as a string, or
 * null when valid — same contract as `validateAttributes` in
 * `lib/types/attribute-groups`, so the admin UI and the route share one rule set.
 */
export function validateGovernedTagDefs(defs: UcGovernedTagDef[]): string | null {  if (!Array.isArray(defs)) return 'tags must be an array';
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
    // An allowed VALUE is half of the Atlas classification typedef name
    // (`Loom_<t8>_<key>_<value>`), which Atlas caps — so an uncapped value is
    // not a cosmetic omission: it pushes the distinguishing characters past the
    // truncation point. Capped here AND made collision-proof by the hash tail
    // in `atlasClassificationName`; both, because either alone is fragile.
    const tooLong = values.find((v) => v.length > MAX_ALLOWED_VALUE_LENGTH);
    if (tooLong) {
      return `governed tag "${key}" has an allowed value that is too long (max ${MAX_ALLOWED_VALUE_LENGTH}): "${tooLong.slice(0, 32)}…"`;
    }
    if (values.length > MAX_ALLOWED_VALUES) {
      return `governed tag "${key}" has too many allowed values (max ${MAX_ALLOWED_VALUES})`;
    }
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
// Attribute VALUE validation (typed + bounded)
// ---------------------------------------------------------------------------

/**
 * Hard caps on what an authenticated caller may push into one overlay document.
 * Without these, `attributes` is unvalidated JSON straight from the request
 * body into a Cosmos document on a SHARED container — an authenticated
 * storage-amplification vector (and Cosmos rejects >2 MB documents with a
 * confusing 413 rather than an actionable 400).
 */
export const OVERLAY_LIMITS = {
  /** Max attribute ids touched in one mutation. */
  maxAttributes: 200,
  /** Max characters in a Text / Rich text / Date / choice value. */
  maxStringLength: 4096,
  /** Max entries in a Multiple choice value. */
  maxArrayItems: 100,
  /** Max tags on one securable. */
  maxTags: 200,
  /** Max Atlas classifications pushed in one Purview sync. */
  maxClassifications: 100,
} as const;

/** Flatten every tenant AttributeDef by id (later groups do not shadow earlier). */
export function attributeDefIndex(groups: AttributeGroup[]): Map<string, AttributeDef> {
  const idx = new Map<string, AttributeDef>();
  for (const g of groups || []) for (const a of g.attributes || []) if (!idx.has(a.id)) idx.set(a.id, a);
  return idx;
}

/**
 * THE ATTRIBUTE-VALUE GATE — the typed counterpart of
 * {@link validateTagAssignment}, and the reason `attributes` is no longer a raw
 * cast at the route boundary.
 *
 * Enforces, per the tenant's OWN `AttributeDef.fieldType` (the same 8 Purview
 * types the admin authoring UI writes):
 *   - the id is defined by some attribute group (unchanged behaviour),
 *   - the JS type matches the field type (a `Boolean` attribute cannot be
 *     handed an object/array; an `Integer` cannot be handed `"platinum"`),
 *   - `Single choice` / `Multiple choice` values are members of `choices`
 *     (case-insensitive, canonical casing restored) — the same rule governed
 *     tags get, so the PR's own thesis is not asymmetric,
 *   - size bounds from {@link OVERLAY_LIMITS}.
 * `null` / `undefined` / `''` still mean DELETE the value.
 *
 * Returns the normalized value map; throws {@link UcOverlayError} (400) on the
 * first violation, so nothing partial is ever persisted.
 */
export function validateAttributeValues(
  raw: unknown,
  groups: AttributeGroup[],
): Record<string, string | number | boolean | string[] | null> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UcOverlayError('attributes must be an object keyed by attribute id');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > OVERLAY_LIMITS.maxAttributes) {
    throw new UcOverlayError(`too many attributes (max ${OVERLAY_LIMITS.maxAttributes})`);
  }
  const defs = attributeDefIndex(groups);
  const out: Record<string, string | number | boolean | string[] | null> = {};

  for (const [id, value] of entries) {
    const def = defs.get(id);
    if (!def) {
      throw new UcOverlayError(
        `unknown attribute "${id}" — define it in an attribute group first (Admin → Catalog & domains → Custom attributes, /admin/attribute-groups)`,
      );
    }
    if (value === null || value === undefined || value === '') { out[id] = null; continue; }

    const label = def.name || def.id;
    switch (def.fieldType) {
      case 'Boolean': {
        if (typeof value !== 'boolean') {
          throw new UcOverlayError(`attribute "${label}" is a Boolean — expected true or false`);
        }
        out[id] = value;
        break;
      }
      case 'Integer': {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
          throw new UcOverlayError(`attribute "${label}" is an Integer — expected a whole number`);
        }
        out[id] = value;
        break;
      }
      case 'Double': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new UcOverlayError(`attribute "${label}" is a Double — expected a finite number`);
        }
        out[id] = value;
        break;
      }
      case 'Multiple choice': {
        if (!Array.isArray(value)) {
          throw new UcOverlayError(`attribute "${label}" is a Multiple choice — expected an array of values`);
        }
        if (value.length > OVERLAY_LIMITS.maxArrayItems) {
          throw new UcOverlayError(`attribute "${label}" has too many values (max ${OVERLAY_LIMITS.maxArrayItems})`);
        }
        const choices = (def.choices || []).filter(Boolean);
        const picked: string[] = [];
        for (const v of value) {
          if (typeof v !== 'string') {
            throw new UcOverlayError(`attribute "${label}" accepts only string values`);
          }
          const t = v.trim();
          if (!t) continue;
          if (t.length > OVERLAY_LIMITS.maxStringLength) {
            throw new UcOverlayError(`attribute "${label}" value is too long (max ${OVERLAY_LIMITS.maxStringLength})`);
          }
          const canonical = choices.find((c) => c.toLowerCase() === t.toLowerCase());
          if (!canonical) {
            throw new UcOverlayError(
              `"${t}" is not an allowed value for attribute "${label}" (allowed: ${choices.join(', ')})`,
            );
          }
          if (!picked.includes(canonical)) picked.push(canonical);
        }
        out[id] = picked.length ? picked : null;
        break;
      }
      case 'Single choice': {
        if (typeof value !== 'string') {
          throw new UcOverlayError(`attribute "${label}" is a Single choice — expected one of its values as a string`);
        }
        const choices = (def.choices || []).filter(Boolean);
        const canonical = choices.find((c) => c.toLowerCase() === value.trim().toLowerCase());
        if (!canonical) {
          throw new UcOverlayError(
            `"${value}" is not an allowed value for attribute "${label}" (allowed: ${choices.join(', ')})`,
          );
        }
        out[id] = canonical;
        break;
      }
      case 'Date': {
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          throw new UcOverlayError(`attribute "${label}" is a Date — expected an ISO-8601 date string`);
        }
        out[id] = value.trim();
        break;
      }
      default: {
        // Text / Rich text — any string, bounded.
        if (typeof value !== 'string') {
          throw new UcOverlayError(`attribute "${label}" is ${def.fieldType} — expected a string`);
        }
        if (value.length > OVERLAY_LIMITS.maxStringLength) {
          throw new UcOverlayError(`attribute "${label}" value is too long (max ${OVERLAY_LIMITS.maxStringLength})`);
        }
        out[id] = value;
        break;
      }
    }
    // Defence in depth for a choice def authored with no choices at all.
    if (CHOICE_FIELD_TYPES.includes(def.fieldType) && !(def.choices || []).filter(Boolean).length) {
      throw new UcOverlayError(
        `attribute "${label}" is a ${def.fieldType} with no allowed values defined — fix it at /admin/attribute-groups`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Overlay reducer
// ---------------------------------------------------------------------------

/**
 * True when an overlay carries no governance facts at all.
 *
 * PURE and defined HERE (not in the Cosmos store) on purpose: the BFF route's
 * delete-vs-persist decision turns on it, and a test that `vi.mock`s the store
 * would otherwise be able to substitute its own copy of the predicate — making
 * the assertion unfalsifiable. Living in the pure model means the route always
 * exercises the real implementation.
 */
export function isEmptyOverlay(o: UcGovernanceOverlay): boolean {
  return (o.tags || []).length === 0
    && (o.certification?.rung || 'none') === 'none'
    && Object.keys(o.attributes || {}).length === 0;
}

/**
 * True when a PREVIOUS Purview sync left something on the Atlas entity that
 * Loom would still need to revoke (a classification, or a business-metadata key
 * carrying a real value).
 *
 * The delete-the-row rule is `isEmptyOverlay(next) && !hasPurviewResidue(next)`
 * — NOT `!next.purview`. A securable that was ever synced carries a `purview`
 * provenance stamp forever, so keying on the stamp's mere presence would
 * persist exactly the hollow row the rule exists to prevent. Keying on residue
 * keeps the row only while it is still the record of something revocable.
 */
export function hasPurviewResidue(o: UcGovernanceOverlay): boolean {
  const p = o.purview;
  if (!p) return false;
  if ((p.classifications || []).length > 0) return true;
  // `loom_certification: none` is a tombstone we deliberately keep pushing; it
  // is not residue that needs revoking.
  return (p.businessMetadataKeys || []).some((k) => k !== 'loom_certification');
}

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
  if (tags.length > OVERLAY_LIMITS.maxTags) {
    throw new UcOverlayError(`too many tags on one securable (max ${OVERLAY_LIMITS.maxTags})`);
  }

  let certification = overlay.certification || { rung: 'none' as EndorsementRung };
  if (mutation.certification) {
    const rung = mutation.certification.rung;
    if (!RUNGS.includes(rung)) {
      throw new UcOverlayError(`certification rung must be one of ${RUNGS.join(', ')}`);
    }
    const note = mutation.certification.note !== undefined
      ? String(mutation.certification.note).slice(0, OVERLAY_LIMITS.maxStringLength)
      : certification.note;
    if (rung === 'none') {
      // De-certifying clears the signer: `by`/`at` describe the CURRENT rung.
      certification = { rung, ...(note ? { note } : {}) };
    } else if (rung === certification.rung && certification.by && certification.at) {
      // PROVENANCE IS NOT RE-STAMPED WHEN THE RUNG DOES NOT MOVE. Editing the
      // note (or re-saving) must not silently transfer the attestation to
      // whoever last touched the row — the recorded certifier has to remain the
      // person who actually moved it to this rung.
      certification = { rung, by: certification.by, at: certification.at, ...(note ? { note } : {}) };
    } else {
      certification = { rung, by: ctx.actorUpn, at: now, ...(note ? { note } : {}) };
    }
  }

  const attributes: UcAttributeValues = { ...(overlay.attributes || {}) };
  if (mutation.attributes) {
    // Typed + bounded against the tenant's OWN AttributeDef schema — not just
    // an id-membership check (see validateAttributeValues).
    const validated = validateAttributeValues(mutation.attributes, ctx.attributeGroups || []);
    for (const [id, value] of Object.entries(validated)) {
      if (value === null) delete attributes[id];
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

/**
 * SHARED-TENANT TYPEDEF NAMESPACE DISCRIMINATOR.
 *
 * Atlas classification typedefs are ACCOUNT-GLOBAL in the classic Purview Data
 * Map, while a Loom "tenant" is a Cosmos partition (`tid || oid`). Without a
 * discriminator, tenant A's vocabulary word `pii=yes` and tenant B's would
 * create/attach the SAME global `Loom_pii_yes` typedef — one tenant's
 * vocabulary polluting (and semantically colliding with) another's inside a
 * shared Purview account.
 *
 * So every Loom classification is namespaced `Loom_<t8>_<key>_<value>`, where
 * `t8` is a stable 8-hex-char FNV-1a digest of the tenant scope id. This is a
 * NAMESPACE discriminator, not a secret and not a security primitive — it only
 * has to make accidental cross-tenant collision improbable, so a pure hash is
 * used deliberately (this module must stay importable by the client tier: no
 * `node:crypto`).
 */
export function tenantTypedefPrefix(tenantId: string): string {
  return fnv1aHex(String(tenantId || ''));
}

/** 8-hex FNV-1a. Pure (no `node:crypto`) so this module stays client-importable;
 *  used ONLY as a namespace/uniqueness discriminator, never as a secret. */
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Atlas caps typedef names; Loom caps its own at 96 to stay well inside it. */
export const MAX_ATLAS_NAME_LENGTH = 96;

/**
 * The Atlas CLASSIFICATION typedef name for one governed tag.
 *
 * TRUNCATION MUST NOT COLLIDE. A naive `….slice(0, 96)` is safe ACROSS tenants
 * (the discriminator is leading) but NOT WITHIN one: a 64-char key leaves as
 * few as ~17 value characters, so two distinct governed values sharing a long
 * prefix collapse onto ONE typedef name — and the supersede logic in
 * `purview-sync` then computes `stale` against a name that means both, so
 * revoking one revokes the other. When the natural name overflows, the tail is
 * replaced by an 8-hex digest of the FULL name, which is injective for every
 * input that differs anywhere.
 */
export function atlasClassificationName(prefix: string, key: string, value: string): string {
  const full = `Loom_${prefix}_${key}_${value}`;
  if (full.length <= MAX_ATLAS_NAME_LENGTH) return full;
  return `${full.slice(0, MAX_ATLAS_NAME_LENGTH - 9)}_${fnv1aHex(full)}`;
}

/**
 * The Atlas BUSINESS-METADATA typedef name Loom writes an overlay's free tags +
 * certification under — TENANT-NAMESPACED, for the same reason classifications
 * are.
 *
 * `purview-client.LOOM_BUSINESS_METADATA_NAME` ('LoomCustomTags') is a single
 * ACCOUNT-GLOBAL typedef whose attribute names come verbatim from tenant-authored
 * free-tag keys, grown permanently by `ensureBusinessMetadataDef` and written
 * with `isOverwrite=true`. In a SHARED Purview account that is the identical
 * cross-tenant collision the classification namespacing closes, one API surface
 * over: tenant B syncing the same asset would overwrite tenant A's
 * `cost_center`, `loom_certification`, `loom_certified_by`/`_at`. So the overlay
 * writes `LoomCustomTags_<t8>` instead — a per-tenant bag on the same entity.
 */
export function tenantBusinessMetadataName(tenantId: string): string {
  return `LoomCustomTags_${tenantTypedefPrefix(tenantId)}`;
}

export interface UcPurviewProjection {
  /** Atlas CLASSIFICATION names for the governed tags (controlled vocabulary →
   *  controlled classification set). `Loom_<tenant8>_<key>_<value>`. */
  classifications: string[];
  /** Free tags + certification, as business-metadata attributes. */
  businessMetadata: Record<string, string>;
  /** The TENANT-NAMESPACED business-metadata typedef to write them under. */
  businessMetadataName: string;
}

/**
 * Project an overlay onto the CLASSIC Purview Data Map's two extension points.
 *
 * Why this split: an Atlas classification is a *controlled* typedef that has to
 * exist before it can be attached — an exact structural match for a governed
 * tag. Free-form key/values have no typedef, so they go to business metadata,
 * the namespace `purview-client.setBusinessMetadata` grows on demand.
 * Certification rides along as a business-metadata attribute because classic
 * Atlas has no endorsement concept.
 *
 * BOTH halves are TENANT-NAMESPACED, because Atlas typedefs are ACCOUNT-GLOBAL:
 * classifications by name ({@link atlasClassificationName}) and business
 * metadata by BAG ({@link tenantBusinessMetadataName}). Namespacing only the
 * classifications would leave the free-tag + certification half of this very
 * function colliding across tenants on a shared account.
 *
 * The account Loom provisions via ARM is a CLASSIC Data Map account (Atlas v2)
 * — it does NOT expose the unified-catalog `/datagovernance` surface (see the
 * header of `lib/azure/purview-client.ts`), so nothing here targets that host.
 *
 * COLLISIONS ARE REFUSED, NOT SILENTLY MERGED. `atlasSafeName` is lossy
 * (`cost center` and `cost-center` both normalize to `cost_center`), so two
 * distinct free tags could otherwise overwrite each other with the last writer
 * winning and no warning — a governance surface must not quietly drop a fact.
 * Both that case and a key that normalizes to nothing throw
 * {@link UcOverlayError}, which the sync turns into an honest `reason`.
 *
 * ALWAYS emits `loom_certification` (as `none` when de-certified) so a
 * superseding sync can overwrite a stale `certified` label rather than leaving
 * it behind — see `purview-sync.syncOverlayToPurview`.
 */
export function projectOverlayToPurview(overlay: UcGovernanceOverlay): UcPurviewProjection {
  const prefix = tenantTypedefPrefix(overlay.tenantId);
  const classifications: string[] = [];
  const businessMetadata: Record<string, string> = {};
  const normalizedFrom = new Map<string, string>();

  for (const t of overlay.tags || []) {
    if (t.governed) {
      const k = atlasSafeName(t.key);
      const v = atlasSafeName(t.value);
      if (!k || !v) {
        throw new UcOverlayError(
          `governed tag "${t.key}=${t.value}" cannot be expressed as an Atlas classification (Atlas typedef names allow letters, digits and underscore only). Rename it in the tenant vocabulary.`,
        );
      }
      const name = atlasClassificationName(prefix, k, v);
      if (!classifications.includes(name)) classifications.push(name);
    } else {
      const norm = atlasSafeName(t.key);
      if (!norm) {
        throw new UcOverlayError(
          `tag key "${t.key}" cannot be expressed as Purview business metadata (it normalizes to an empty name). Rename the tag.`,
        );
      }
      const prior = normalizedFrom.get(norm);
      if (prior !== undefined && prior !== t.key) {
        throw new UcOverlayError(
          `tags "${prior}" and "${t.key}" both normalize to the Purview attribute "${norm}" — one would silently overwrite the other. Rename one of them before syncing.`,
        );
      }
      normalizedFrom.set(norm, t.key);
      businessMetadata[norm] = t.value;
    }
  }
  if (classifications.length > OVERLAY_LIMITS.maxClassifications) {
    throw new UcOverlayError(
      `too many governed tags to project into Purview (max ${OVERLAY_LIMITS.maxClassifications} classifications)`,
    );
  }
  const rung = overlay.certification?.rung || 'none';
  businessMetadata.loom_certification = rung;
  businessMetadata.loom_certified_by = rung === 'none' ? '' : (overlay.certification?.by || '');
  businessMetadata.loom_certified_at = rung === 'none' ? '' : (overlay.certification?.at || '');
  return {
    classifications,
    businessMetadata,
    businessMetadataName: tenantBusinessMetadataName(overlay.tenantId),
  };
}
