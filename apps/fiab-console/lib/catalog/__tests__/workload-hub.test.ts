import { describe, it, expect } from 'vitest';
import {
  WORKLOAD_GROUPS,
  WORKLOAD_CATEGORIES,
  CATEGORY_TO_WORKLOAD,
  workloadGroups,
  findWorkloadGroup,
  creatableItemTypes,
  workloadItemCount,
  representativeSlug,
  totalCreatableItemTypes,
  matchWorkloadKey,
} from '../workload-hub';
import {
  FABRIC_ITEM_TYPES,
  itemsByCategory,
  findItemType,
  type WorkloadCategory,
} from '../fabric-item-types';

describe('workload-hub grouping', () => {
  it('maps every catalog category to exactly one workload group', () => {
    for (const cat of WORKLOAD_CATEGORIES) {
      const owners = WORKLOAD_GROUPS.filter((g) => g.categories.includes(cat));
      expect(owners, `category "${cat}" must belong to exactly one group`).toHaveLength(1);
      expect(CATEGORY_TO_WORKLOAD[cat]).toBe(owners[0].key);
    }
  });

  it('has unique workload keys', () => {
    const keys = WORKLOAD_GROUPS.map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not reference unknown categories', () => {
    const known = new Set<string>(WORKLOAD_CATEGORIES as readonly string[]);
    for (const g of WORKLOAD_GROUPS) {
      for (const c of g.categories) {
        expect(known.has(c), `unknown category "${c}" in group "${g.key}"`).toBe(true);
      }
    }
  });

  it('derives counts from the registry and never leaks deprecated types', () => {
    for (const g of workloadGroups()) {
      const items = creatableItemTypes(g);
      expect(workloadItemCount(g)).toBe(items.length);
      expect(items.every((t) => !t.deprecated)).toBe(true);
      // count equals the sum of non-deprecated items across the group categories
      const expected = g.categories
        .flatMap((c) => itemsByCategory(c as WorkloadCategory))
        .filter((t) => !t.deprecated).length;
      expect(items.length).toBe(expected);
    }
  });

  it('sorts GA item types before preview ones', () => {
    for (const g of workloadGroups()) {
      const items = creatableItemTypes(g);
      const firstPreview = items.findIndex((t) => t.preview);
      if (firstPreview === -1) continue;
      // no GA item may appear after the first preview item
      expect(items.slice(firstPreview).every((t) => t.preview)).toBe(true);
    }
  });

  it('every group covers at least one creatable item type and a real representative slug', () => {
    for (const g of workloadGroups()) {
      expect(creatableItemTypes(g).length).toBeGreaterThan(0);
      const rep = representativeSlug(g);
      expect(findItemType(rep), `representative slug "${rep}" must be a real item type`).toBeDefined();
    }
  });

  it('covers the entire catalog with no orphaned item types', () => {
    const grouped = new Set<string>();
    for (const g of workloadGroups()) {
      for (const t of creatableItemTypes(g)) grouped.add(t.slug);
    }
    const nonDeprecated = FABRIC_ITEM_TYPES.filter((t) => !t.deprecated);
    for (const t of nonDeprecated) {
      expect(grouped.has(t.slug), `item type "${t.slug}" is not in any workload`).toBe(true);
    }
    expect(totalCreatableItemTypes()).toBe(new Set(nonDeprecated.map((t) => t.slug)).size);
  });

  it('resolves a workload group by key (case-insensitive)', () => {
    expect(findWorkloadGroup('data-engineering')?.name).toBe('Data Engineering');
    expect(findWorkloadGroup('DATA-ENGINEERING')?.key).toBe('data-engineering');
    expect(findWorkloadGroup('nope')).toBeUndefined();
  });

  it('matches seeded workloads to a registry key by name or shared slug', () => {
    expect(matchWorkloadKey('Data Engineering')).toBe('data-engineering');
    expect(matchWorkloadKey('Real-Time Intelligence')).toBe('real-time-intelligence');
    // by shared slug when the name does not match a group exactly
    const k = matchWorkloadKey('FedRAMP Compliance Engine', ['scorecard']);
    expect(k).toBe('power-bi');
    expect(matchWorkloadKey('totally-unknown', [])).toBeUndefined();
  });
});
