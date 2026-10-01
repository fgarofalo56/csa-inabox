/**
 * #3669 — the pure halves of the warehouse ↔ item link: which tag keys count as
 * the owner key, and how a warehouse's owner is read off its tag list.
 * The route-level behaviour is in `ai-function/__tests__/warehouse-binding.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn(), featurePermissionsContainer: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ getWarehouse: vi.fn() }));

import { isOwnerTagKey, warehouseOwnerTag } from '../warehouse-item-binding';
import { LOOM_OWNER_KEY } from '../databricks-resource-binding';

describe('isOwnerTagKey', () => {
  // The key is LIFTED from the source, so a rename cannot leave this probing a stale literal.
  it('pins the shared key this module reserves', () => {
    expect(LOOM_OWNER_KEY).toBe('loom_item_id');
  });

  // RED if the match is case- or whitespace-sensitive.
  it.each([LOOM_OWNER_KEY, LOOM_OWNER_KEY.toUpperCase(), ` ${LOOM_OWNER_KEY}\t`, 'Loom_Item_Id'])(
    'treats %j as the owner key',
    (k) => expect(isOwnerTagKey(k)).toBe(true),
  );

  // RED if the match becomes a prefix/substring/normalising match.
  it.each(['loom_item_ids', 'xloom_item_id', 'loom-item-id', 'loom item id', '', 42, null, undefined])(
    'does not treat %j as the owner key',
    (k) => expect(isOwnerTagKey(k)).toBe(false),
  );
});

describe('warehouseOwnerTag', () => {
  const wh = (custom_tags: any[]) => ({ tags: { custom_tags } });

  // RED if the first non-owner tag, or the key instead of the value, is returned.
  it('returns the owner value from among other tags', () => {
    expect(warehouseOwnerTag(wh([{ key: 'env', value: 'dev' }, { key: 'LOOM_ITEM_ID', value: ' item-1 ' }])))
      .toEqual({ value: 'item-1', conflict: false });
  });

  // RED if two DIFFERENT values resolve to either one (first-wins or last-wins).
  it('reports a conflict, and no value, for two distinct owner values', () => {
    expect(warehouseOwnerTag(wh([{ key: 'loom_item_id', value: 'a' }, { key: 'Loom_Item_Id', value: 'b' }])))
      .toEqual({ conflict: true });
  });

  // RED if duplicates of the SAME value are counted as a conflict.
  it('does not report a conflict for a repeated identical value', () => {
    expect(warehouseOwnerTag(wh([{ key: 'loom_item_id', value: 'a' }, { key: 'loom_item_id', value: 'a' }])))
      .toEqual({ value: 'a', conflict: false });
  });

  // RED if a blank value counts as an owner (it would then be looked up as an item id).
  it('ignores a blank owner value, and copes with no tags at all', () => {
    expect(warehouseOwnerTag(wh([{ key: 'loom_item_id', value: '  ' }]))).toEqual({ value: undefined, conflict: false });
    expect(warehouseOwnerTag(null)).toEqual({ value: undefined, conflict: false });
    expect(warehouseOwnerTag({ tags: undefined })).toEqual({ value: undefined, conflict: false });
  });
});
