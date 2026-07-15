/**
 * item-type-icon — the catalog-layer, single source of truth for resolving a
 * BRANDED, color-accented icon for any Loom / Fabric / Azure item type.
 *
 * WHY THIS FILE (and how it relates to item-type-visual):
 *   `lib/components/ui/item-type-visual.ts` is the icon REGISTRY — it maps a
 *   type *slug* to a Fluent icon component + a family brand color. It is
 *   consumed directly by ~45 UI surfaces (tiles, list rows, headers).
 *
 *   This module is the CATALOG-AWARE resolver on top of that registry. It lets
 *   callers resolve an icon from ANY of the three identifiers the catalog
 *   carries — the route `slug`, the Fabric/ARM `restType`, or the
 *   `WorkloadCategory` — without every call site having to know which one it is
 *   holding. The restType→slug and category→family indexes are derived
 *   automatically from `FABRIC_ITEM_TYPES`, so they never drift from the
 *   catalog. There is exactly ONE icon table (item-type-visual); this is the
 *   typed façade over it. Later waves reuse `itemTypeIcon()` — keep it clean.
 *
 * Every catalog item type resolves to a DISTINCT, sensible icon + a Loom family
 * brand accent (grouped by workload category). Unknown keys fall back to a
 * neutral Document glyph. See `item-type-icon.test.ts` — it asserts full
 * catalog coverage so a newly-added item type without an icon fails CI.
 */

import type { FluentIcon } from '@fluentui/react-icons';
import { FABRIC_ITEM_TYPES } from './fabric-item-types';
import type { WorkloadCategory } from './item-types/types';
import {
  itemVisual,
  isKnownItemType,
  FAMILY_COLOR,
  type ItemFamily,
} from '@/lib/components/ui/item-type-visual';

export interface ItemTypeIcon {
  /** Fluent icon *component* (24px regular) branded for this item type. */
  icon: FluentIcon;
  /** Loom family brand accent (hex) — reads identically in light + dark, and
   *  matches the catalog tile palette (item-tile chip, all-items table). */
  accent: string;
  /** The family bucket the type belongs to. */
  family: ItemFamily;
  /** Human-friendly label. */
  label: string;
}

// ── Derived indexes (kept in lock-step with the catalog automatically) ──────

/** restType (lowercased) → route slug. Built from the authoritative catalog. */
const REST_TO_SLUG: Map<string, string> = new Map(
  FABRIC_ITEM_TYPES.map((t) => [t.restType.toLowerCase(), t.slug]),
);

/** WorkloadCategory → the family of its first catalog member, so a bare
 *  category resolves to the accent family its items share. */
const CATEGORY_TO_FAMILY: Map<string, ItemFamily> = (() => {
  const m = new Map<string, ItemFamily>();
  for (const t of FABRIC_ITEM_TYPES) {
    const key = t.category.toLowerCase();
    if (!m.has(key) && isKnownItemType(t.slug)) {
      m.set(key, itemVisual(t.slug).family);
    }
  }
  return m;
})();

/** WorkloadCategory → a representative slug (first catalog member) for a
 *  category-level icon. */
const CATEGORY_TO_SLUG: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const t of FABRIC_ITEM_TYPES) {
    const key = t.category.toLowerCase();
    if (!m.has(key)) m.set(key, t.slug);
  }
  return m;
})();

function fromSlug(slug: string): ItemTypeIcon {
  const v = itemVisual(slug);
  return { icon: v.icon, accent: v.color, family: v.family, label: v.label };
}

/**
 * Resolve a branded icon + accent for an item-type identifier. Accepts a route
 * `slug`, a Fabric/ARM `restType`, or a `WorkloadCategory` — resolution is tried
 * in that order. Always returns a usable value; unknown keys fall back to a
 * neutral Document glyph.
 */
export function itemTypeIcon(
  key: string | WorkloadCategory | null | undefined,
): ItemTypeIcon {
  const raw = (key ?? '').trim();
  if (!raw) return fromSlug('');

  // 1) Direct slug hit (the common case).
  if (isKnownItemType(raw)) return fromSlug(raw);

  const lower = raw.toLowerCase();

  // 2) restType (e.g. 'KQLDatabase', 'Microsoft.Batch/batchAccounts').
  const slugByRest = REST_TO_SLUG.get(lower);
  if (slugByRest) return fromSlug(slugByRest);

  // 3) WorkloadCategory (e.g. 'Real-Time Intelligence') → representative
  //    item's icon, coloured by the category's shared family accent.
  const catSlug = CATEGORY_TO_SLUG.get(lower);
  if (catSlug) {
    const v = fromSlug(catSlug);
    const fam = CATEGORY_TO_FAMILY.get(lower) ?? v.family;
    return { ...v, family: fam, accent: FAMILY_COLOR[fam], label: raw };
  }

  // 4) Unknown — neutral fallback (itemVisual handles Document + grey).
  return fromSlug(raw);
}

/** Convenience: just the accent hex for a key (slug | restType | category). */
export function itemTypeAccent(
  key: string | WorkloadCategory | null | undefined,
): string {
  return itemTypeIcon(key).accent;
}

export { FAMILY_COLOR } from '@/lib/components/ui/item-type-visual';
export type { ItemFamily } from '@/lib/components/ui/item-type-visual';
