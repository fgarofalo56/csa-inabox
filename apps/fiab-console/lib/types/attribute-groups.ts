/**
 * Custom Attributes / Attribute Groups (F17)
 * ------------------------------------------
 * Admin-defined, per-domain attribute schemas that drive the Create wizard's
 * "Custom attributes" step, the data-product create wizard, and item Edit
 * dialogs. This is Loom's Azure-native equivalent of Microsoft Purview Unified
 * Catalog "Custom metadata" — business-concept attributes scoped to governance
 * domains. The schema is stored in Cosmos as a single per-tenant document in
 * the `tenant-settings` container (`attribute-groups:<tenantId>`); no live
 * Purview / Fabric account is required for any of this to work.
 *
 * Field types mirror the Purview portal vocabulary exactly:
 *   Text / Single choice / Multiple choice / Date / Boolean / Integer /
 *   Double / Rich text
 * grounded in
 *   https://learn.microsoft.com/purview/unified-catalog-attributes-business-concept
 *
 * Purview rules Loom mirrors:
 *   - Every attribute belongs to an attribute group (no free-standing attrs).
 *   - A group's scope is the set of governance domains it applies to; an empty
 *     / absent `domainIds` means the group applies to ALL domains.
 *   - Single/Multiple choice attributes carry their allowed `choices`.
 *   - Attributes within a group are ordered (UI reorder via ↑/↓).
 *
 * The API route (`/api/attribute-groups`) imports these types so the route,
 * the admin authoring UI, and the wizard consumers all share one schema.
 */

export type AttributeFieldType =
  | 'Text'
  | 'Single choice'
  | 'Multiple choice'
  | 'Date'
  | 'Boolean'
  | 'Integer'
  | 'Double'
  | 'Rich text';

export const ATTRIBUTE_FIELD_TYPES: AttributeFieldType[] = [
  'Text',
  'Single choice',
  'Multiple choice',
  'Date',
  'Boolean',
  'Integer',
  'Double',
  'Rich text',
];

/** Field types that require a non-empty `choices` list. */
export const CHOICE_FIELD_TYPES: AttributeFieldType[] = ['Single choice', 'Multiple choice'];

export interface AttributeDef {
  /** Stable slug, never changes once created. */
  id: string;
  name: string;
  description?: string;
  fieldType: AttributeFieldType;
  required?: boolean;
  /** Populated for Single/Multiple choice; min 1 entry. */
  choices?: string[];
}

export interface AttributeGroup {
  id: string;
  name: string;
  description?: string;
  /** Governance-domain ids this group applies to; empty/absent = all domains. */
  domainIds?: string[];
  attributes: AttributeDef[];
}

/** The single per-tenant Cosmos document (in `tenant-settings`). */
export interface AttributeGroupsDoc {
  /** `attribute-groups:<tenantId>`. */
  id: string;
  /** Partition key. */
  tenantId: string;
  kind: 'attribute-groups';
  groups: AttributeGroup[];
  updatedAt: string;
}

/** kebab-case a display name for use as a stable slug. */
export function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'group'
  );
}

/**
 * Validate a proposed attributes array. Returns an error string on the first
 * problem, or null when valid. Shared by the admin UI and the route so both
 * enforce the same rules (no free-form junk persisted).
 */
export function validateAttributes(attrs: AttributeDef[]): string | null {
  const seen = new Set<string>();
  for (const a of attrs) {
    if (!a || typeof a.name !== 'string' || !a.name.trim()) {
      return 'every attribute needs a name';
    }
    if (!ATTRIBUTE_FIELD_TYPES.includes(a.fieldType)) {
      return `invalid attribute field type "${a.fieldType}"`;
    }
    if (CHOICE_FIELD_TYPES.includes(a.fieldType)) {
      const vals = (a.choices || []).filter((v) => (v ?? '').trim());
      if (vals.length === 0) {
        return `choice attribute "${a.name}" requires at least one value`;
      }
    }
    const key = a.name.trim().toLowerCase();
    if (seen.has(key)) return `duplicate attribute name "${a.name}"`;
    seen.add(key);
  }
  return null;
}

/**
 * Resolve the list of required attribute names that are missing a value, given
 * the groups that apply to a domain and the current value map keyed by
 * attribute id. Used by the wizards to block completion. A `false` Boolean is
 * considered a filled value (matches the data-product wizard semantics).
 */
export function missingRequiredAttributes(
  groups: AttributeGroup[],
  values: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const g of groups) {
    for (const a of g.attributes) {
      if (!a.required) continue;
      const v = values[a.id];
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0);
      if (empty) missing.push(a.name);
    }
  }
  return missing;
}
