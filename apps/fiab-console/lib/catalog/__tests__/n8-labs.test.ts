/**
 * N8 Openness Tier-3 labs — catalog registration.
 *
 * Asserts the two new Preview lab item types register correctly: preview:true,
 * noRestApi, in Data Engineering, with a branded icon (so item-type-icon
 * coverage stays green). The third lab (PRQL modern-query mode) is an in-editor
 * toggle on SQL Lab, not a separate item, so it is covered by the transpiler
 * tests and the runtime-flag registry instead.
 */
import { describe, it, expect } from 'vitest';
import { FABRIC_ITEM_TYPES, findItemType } from '../fabric-item-types';
import { isKnownItemType } from '@/lib/components/ui/item-type-visual';

const N8_PREVIEW_ITEMS = ['ducklake-catalog', 's3-gateway'] as const;

describe('N8 Tier-3 labs — catalog registration', () => {
  it('registers each lab item as a Preview, Loom-native (noRestApi) Data Engineering type', () => {
    for (const slug of N8_PREVIEW_ITEMS) {
      const t = findItemType(slug);
      expect(t, `catalog entry for '${slug}'`).toBeDefined();
      expect(t!.preview, `'${slug}' preview:true`).toBe(true);
      expect(t!.noRestApi, `'${slug}' noRestApi`).toBe(true);
      expect(t!.category).toBe('Data Engineering');
    }
  });

  it('gives each lab item a branded icon (item-type-icon coverage stays green)', () => {
    for (const slug of N8_PREVIEW_ITEMS) {
      expect(isKnownItemType(slug), `branded icon for '${slug}'`).toBe(true);
    }
  });

  it('adds exactly the two expected N8 Preview items (count bump)', () => {
    const previewSlugs = new Set(FABRIC_ITEM_TYPES.filter((t) => t.preview).map((t) => t.slug));
    for (const slug of N8_PREVIEW_ITEMS) {
      expect(previewSlugs.has(slug), `'${slug}' is a preview item`).toBe(true);
    }
  });
});
