/**
 * Custom Attributes / Attribute Groups (F17)
 * ------------------------------------------
 * Admin-defined, per-domain attribute schemas that drive the Create wizard's
 * "Custom attributes" step and item Edit dialogs. This is Loom's Azure-native
 * equivalent of Microsoft Purview Unified Catalog "Custom metadata" — business-
 * concept attributes scoped to governance domains. The schema is stored in
 * Cosmos (container `attribute-groups`, PK `/tenantId`); no live Purview
 * account is required for any of this to work.
 *
 * Purview rules Loom mirrors:
 *   - Every attribute belongs to an attribute group (no free-standing attrs).
 *   - A group's scope is the set of governance domains it applies to; an empty
 *     `domainIds` array means the group applies to ALL domains.
 *   - Attribute field types: Text (string) / Number (number) / Date (date) /
 *     Single-select (enum). Enum attributes carry their allowed values.
 *   - Attributes within a group are ordered (UI reorder via ↑/↓).
 *   - An attribute's `type` cannot change after creation; name / description /
 *     enumValues / required / order can. (Loom relaxes Purview's create-time-
 *     only `required` because Loom owns the schema store.)
 */

export type AttributeType = 'string' | 'number' | 'date' | 'enum';

export const ATTRIBUTE_TYPES: AttributeType[] = ['string', 'number', 'date', 'enum'];

/** Human label for a field type — matches the Purview UI vocabulary. */
export const ATTRIBUTE_TYPE_LABELS: Record<AttributeType, string> = {
  string: 'Text',
  number: 'Number',
  date: 'Date',
  enum: 'Single select',
};

export interface AttributeDef {
  /** Stable slug: `attr-${rand}`. Never changes once created. */
  id: string;
  name: string;
  description?: string;
  type: AttributeType;
  required: boolean;
  /** Populated iff `type === 'enum'`; min 1 entry. */
  enumValues?: string[];
  /** 0-based; drives render order in the form. */
  order: number;
}

export interface AttributeGroupDoc {
  /** Cosmos id: `attr-group:${tenantId}:${groupId}`. */
  id: string;
  /** Partition key — all groups for a tenant live in one physical partition. */
  tenantId: string;

  /** Stable slug set at create (kebab-case), never changes. */
  groupId: string;
  name: string;
  description?: string;
  /** Domains this group applies to; empty array = all domains. */
  domainIds: string[];

  /** Ordered attribute definitions. */
  attributes: AttributeDef[];

  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/** kebab-case a display name for use as a stable slug. */
export function kebab(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'group';
}

/**
 * Validate a proposed attributes array. Returns an error string on the first
 * problem, or null when valid. Shared by the API route and the admin UI so
 * both enforce the same rules.
 */
export function validateAttributes(attrs: AttributeDef[]): string | null {
  const seen = new Set<string>();
  for (const a of attrs) {
    if (!a || typeof a.name !== 'string' || !a.name.trim()) {
      return 'every attribute needs a name';
    }
    if (!ATTRIBUTE_TYPES.includes(a.type)) {
      return `invalid attribute type "${a.type}"`;
    }
    if (a.type === 'enum' && (!Array.isArray(a.enumValues) || a.enumValues.filter((v) => v.trim()).length === 0)) {
      return `enum attribute "${a.name}" requires at least one value`;
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
 * attribute id. Used by the wizard to block completion.
 */
export function missingRequiredAttributes(
  groups: AttributeGroupDoc[],
  values: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const g of groups) {
    for (const a of g.attributes) {
      if (!a.required) continue;
      const v = values[a.id];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        missing.push(a.name);
      }
    }
  }
  return missing;
}
