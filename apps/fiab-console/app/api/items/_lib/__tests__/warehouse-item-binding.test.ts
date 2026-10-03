/**
 * #3669 — the pure halves of the warehouse ↔ item link: which tag keys count as
 * the owner key, how a warehouse's owner is read off its tag list, the stamp
 * read-back verdict, the receipt reader, the shared-warehouse test, and the
 * editor-side preselect / refusal / link-offer decisions.
 * The route-level behaviour is in `ai-function/__tests__/warehouse-binding.test.ts`;
 * the self-heal and the receipt write are in `warehouse-heal.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn(), featurePermissionsContainer: vi.fn() }));
vi.mock('@/lib/azure/databricks-client', () => ({ getWarehouse: vi.fn() }));

import {
  isOwnerTagKey,
  warehouseOwnerTag,
  linkedWarehouseIdFor,
  judgeStampReadBack,
  recordedWarehouseId,
  isDeploymentSharedWarehouse,
  WAREHOUSE_ITEM_TYPE,
} from '../warehouse-item-binding';
import { LOOM_OWNER_KEY } from '../databricks-resource-binding';
import { LOOM_ID_PREFIX } from '../loom-content-id';
import { LOOM_ADOPTABLE_WAREHOUSE_NAMES, WAREHOUSE_ENV_VAR } from '@/lib/azure/databricks-sql-warehouse';
import { preselectWarehouseId } from '@/lib/editors/databricks/linked-warehouse';
import { LINKABLE_ITEM_TYPE, linkOfferFor, runErrorFrom } from '@/lib/editors/components/ai-function-warehouse-link';

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

const tagged = (id: string, owner?: string, extra: any[] = []) => ({
  id,
  tags: { custom_tags: [...extra, ...(owner === undefined ? [] : [{ key: LOOM_OWNER_KEY, value: owner }])] },
});

describe('linkedWarehouseIdFor', () => {
  // RED if it returns the first warehouse (the old `list[0]` preselect) or any
  // warehouse whose tag names another item: `wh-a` is first and is NOT ours.
  it('returns the one warehouse whose tag names this item, in either id form', () => {
    const list = [tagged('wh-a', 'other-item'), tagged('wh-b', 'item-1'), tagged('wh-c')];
    expect(linkedWarehouseIdFor(list, 'item-1')).toBe('wh-b');
    expect(linkedWarehouseIdFor(list, `${LOOM_ID_PREFIX}item-1`)).toBe('wh-b');
    expect(linkedWarehouseIdFor([tagged('wh-b', `${LOOM_ID_PREFIX}item-1`)], 'item-1')).toBe('wh-b');
  });

  // RED if two matches resolve to either one (it would then guess).
  it('returns nothing for two matches, a conflicting tag, or no match', () => {
    expect(linkedWarehouseIdFor([tagged('wh-a', 'item-1'), tagged('wh-b', 'item-1')], 'item-1')).toBe('');
    expect(
      linkedWarehouseIdFor([tagged('wh-a', 'item-1', [{ key: 'LOOM_ITEM_ID', value: 'item-2' }])], 'item-1'),
    ).toBe('');
    expect(linkedWarehouseIdFor([tagged('wh-a', 'item-2')], 'item-1')).toBe('');
    expect(linkedWarehouseIdFor([tagged('wh-a', 'item-1')], '')).toBe('');
  });
});

describe('judgeStampReadBack', () => {
  // RED if the read-back is trusted only for "a tag is present": `item-2` here
  // is a concurrent winner, and reporting `stamped` would claim a link not held.
  it('names the other owner when the read-back shows a different value', () => {
    expect(judgeStampReadBack(tagged('wh', 'item-2'), 'item-1')).toEqual({ kind: 'linked_elsewhere', linkedItemId: 'item-2' });
  });

  // RED if a two-valued read-back is resolved to ours.
  it('reports a conflict for two values, stamped only for exactly ours', () => {
    expect(judgeStampReadBack(tagged('wh', 'item-1', [{ key: 'Loom_Item_Id', value: 'item-2' }]), 'item-1')).toEqual({
      kind: 'tag_conflict',
    });
    expect(judgeStampReadBack(tagged('wh', 'item-1'), 'item-1')).toEqual({ kind: 'stamped' });
  });

  // RED if a missing read-back or an untagged one counts as success.
  it('is unconfirmed with no read-back or no tag', () => {
    expect(judgeStampReadBack(null, 'item-1')).toEqual({ kind: 'unconfirmed' });
    expect(judgeStampReadBack(tagged('wh'), 'item-1')).toEqual({ kind: 'unconfirmed' });
  });
});

describe('recordedWarehouseId', () => {
  // RED if it ever reads the CLIENT-writable top-level `state.warehouseId`:
  // the second fixture carries only that, and must yield nothing.
  it('reads only the server-written provisioning receipt', () => {
    expect(recordedWarehouseId({ state: { provisioning: { secondaryIds: { warehouseId: ' wh-1 ' } } } } as any)).toBe('wh-1');
    expect(recordedWarehouseId({ state: { warehouseId: 'wh-1' } } as any)).toBe('');
    expect(recordedWarehouseId({ state: { provisioning: { secondaryIds: { warehouseId: 7 } } } } as any)).toBe('');
    expect(recordedWarehouseId(null)).toBe('');
  });
});

describe('isDeploymentSharedWarehouse', () => {
  afterEach(() => vi.unstubAllEnvs());
  // Names lifted from the source list, so a rename there cannot leave this stale.
  // RED if the name match goes, or becomes case-sensitive.
  it.each(LOOM_ADOPTABLE_WAREHOUSE_NAMES.flatMap((n) => [n, n.toUpperCase()]))('treats %j as shared', (name) => {
    expect(isDeploymentSharedWarehouse({ id: 'wh-x', name })).toBe(true);
  });

  // RED if the wired-id check goes (first) or matches when unset (second).
  it('treats the wired warehouse id as shared, and nothing else', () => {
    vi.stubEnv(WAREHOUSE_ENV_VAR, 'wh-wired');
    expect(isDeploymentSharedWarehouse({ id: 'wh-wired', name: 'anything' })).toBe(true);
    expect(isDeploymentSharedWarehouse({ id: 'wh-other', name: 'anything' })).toBe(false);
    vi.stubEnv(WAREHOUSE_ENV_VAR, '');
    expect(isDeploymentSharedWarehouse({ id: '', name: 'anything' })).toBe(false);
  });
});

describe('the editor-side helpers', () => {
  // RED if the client constant drifts from the server item type (the adopt route
  // would then 404 every "Link to this item").
  it('links to the same item type the server binds', () => {
    expect(LINKABLE_ITEM_TYPE).toBe(WAREHOUSE_ITEM_TYPE);
  });

  // RED if the old `list[0]` preselect returns (`wh-a` is first), or a linked id
  // the list does not contain is selected.
  it('preselects only the linked warehouse, and only when it is listed', () => {
    const warehouses = [{ id: 'wh-a' }, { id: 'wh-b' }];
    expect(preselectWarehouseId({ warehouses, linkedWarehouseId: 'wh-b' })).toBe('wh-b');
    expect(preselectWarehouseId({ warehouses, linkedWarehouseId: '' })).toBe('');
    expect(preselectWarehouseId({ warehouses })).toBe('');
    expect(preselectWarehouseId({ warehouses, linkedWarehouseId: 'wh-gone' })).toBe('');
    expect(preselectWarehouseId(null)).toBe('');
  });

  // RED if the AOAI fallback is offered for an unrelated failure, or not for a
  // warehouse refusal; or if the code/remediation are dropped.
  it('carries code and remediation, and offers AOAI only for a warehouse refusal', () => {
    expect(runErrorFrom({ error: 'no', code: 'warehouse_not_available', remediation: 'do x' }, 404)).toEqual({
      message: 'no',
      code: 'warehouse_not_available',
      remediation: 'do x',
      aoaiFallback: true,
    });
    expect(runErrorFrom({ error: 'e', code: 'warehouse_unverifiable' }, 502).aoaiFallback).toBe(true);
    expect(runErrorFrom({ error: 'e', code: 'rate_limited' }, 429).aoaiFallback).toBe(false);
    expect(runErrorFrom(null, 500)).toEqual({ message: 'HTTP 500', code: undefined, remediation: undefined, aoaiFallback: false });
  });

  // RED if "Link to this item" is offered for a shared, already-linked, foreign
  // or conflicting warehouse — each row below differs from `wh-free` in one field.
  it('offers the link only for an untagged, unshared, listed warehouse', () => {
    const rows = [
      { id: 'wh-free', linkedItemId: null, conflict: false, deploymentShared: false },
      { id: 'wh-shared', linkedItemId: null, conflict: false, deploymentShared: true },
      { id: 'wh-mine', linkedItemId: `${LOOM_ID_PREFIX}item-1`, conflict: false },
      { id: 'wh-theirs', linkedItemId: 'item-2', conflict: false },
      { id: 'wh-conflict', linkedItemId: null, conflict: true },
    ];
    expect(linkOfferFor(rows, 'wh-free', 'item-1')).toBe('offer');
    expect(linkOfferFor(rows, 'wh-shared', 'item-1')).toBe('shared');
    expect(linkOfferFor(rows, 'wh-mine', 'item-1')).toBe('linked');
    expect(linkOfferFor(rows, 'wh-theirs', 'item-1')).toBe('linked_elsewhere');
    expect(linkOfferFor(rows, 'wh-conflict', 'item-1')).toBe('conflict');
    expect(linkOfferFor(rows, 'wh-absent', 'item-1')).toBe('unknown');
    expect(linkOfferFor(rows, undefined, 'item-1')).toBe('unknown');
    expect(linkOfferFor({ not: 'an array' }, 'wh-free', 'item-1')).toBe('unknown');
  });
});
