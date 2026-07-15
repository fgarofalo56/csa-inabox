/**
 * item-type-icon — catalog-coverage + resolver tests.
 *
 * Enforces the branded-iconography contract:
 *   1. EVERY item type in FABRIC_ITEM_TYPES resolves to an explicit (non-fallback)
 *      branded icon — a newly-added catalog type with no icon fails CI here.
 *   2. Resolution works from slug, restType, AND category.
 *   3. Accents are real Loom family brand colors (hex), never the neutral grey
 *      fallback for a known type.
 */
import { describe, it, expect } from 'vitest';
import { FABRIC_ITEM_TYPES } from '../fabric-item-types';
import { itemTypeIcon, itemTypeAccent, FAMILY_COLOR } from '../item-type-icon';
import { isKnownItemType } from '@/lib/components/ui/item-type-visual';

describe('itemTypeIcon — full catalog coverage', () => {
  it('maps every FABRIC_ITEM_TYPES slug to an explicit branded icon', () => {
    const missing = FABRIC_ITEM_TYPES.filter((t) => !isKnownItemType(t.slug)).map((t) => t.slug);
    expect(missing, `slugs missing a branded icon: ${missing.join(', ')}`).toEqual([]);
  });

  it('returns a non-neutral family accent for every catalog slug', () => {
    for (const t of FABRIC_ITEM_TYPES) {
      const { accent, family } = itemTypeIcon(t.slug);
      expect(family, `${t.slug} fell back to neutral`).not.toBe('neutral');
      expect(accent).toBe(FAMILY_COLOR[family]);
      expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('itemTypeIcon — multi-key resolution', () => {
  it('resolves the same icon from slug and from restType (unique restTypes)', () => {
    // A few restTypes are shared by more than one slug (e.g. workspace-monitor
    // is Eventhouse-backed). For those the restType→slug index resolves to a
    // single member by design; only assert on restTypes that map uniquely.
    const restCounts = new Map<string, number>();
    for (const t of FABRIC_ITEM_TYPES) {
      const k = t.restType.toLowerCase();
      restCounts.set(k, (restCounts.get(k) ?? 0) + 1);
    }
    for (const t of FABRIC_ITEM_TYPES) {
      if ((restCounts.get(t.restType.toLowerCase()) ?? 0) !== 1) continue;
      const bySlug = itemTypeIcon(t.slug);
      const byRest = itemTypeIcon(t.restType);
      expect(byRest.icon, `restType ${t.restType} did not resolve to ${t.slug}`).toBe(bySlug.icon);
    }
  });

  it('resolves a WorkloadCategory to its family accent', () => {
    const v = itemTypeIcon('Real-Time Intelligence');
    expect(v.family).toBe('rti');
    expect(v.accent).toBe(FAMILY_COLOR.rti);
  });

  it('falls back to a neutral Document glyph for an unknown key', () => {
    const v = itemTypeIcon('totally-not-a-real-type');
    expect(v.family).toBe('neutral');
    expect(v.accent).toBe(FAMILY_COLOR.neutral);
  });

  it('itemTypeAccent is the icon accent', () => {
    expect(itemTypeAccent('lakehouse')).toBe(itemTypeIcon('lakehouse').accent);
  });
});
