/**
 * tutorial-scope — receiptScopeFromTutorialId.
 *
 * Guards the editor-tutorial → receipt-scope fallback the Help Copilot widget
 * uses so per-step auto-error detection still resolves to a concrete item when
 * the route hasn't put the item id in the path. A "new"/unsaved item or a
 * non-editor tutorial id must NOT fabricate a scope (the agent then honestly
 * reports "No item in context").
 */
import { describe, it, expect } from 'vitest';
import { receiptScopeFromTutorialId } from '../tutorial-scope';

describe('receiptScopeFromTutorialId', () => {
  it('parses editor:<type>#<id> into a concrete receipt scope', () => {
    expect(receiptScopeFromTutorialId('editor:data-pipeline#itm-1')).toEqual({
      itemType: 'data-pipeline',
      itemId: 'itm-1',
    });
  });

  it('handles ids whose item id contains a hash-free guid', () => {
    expect(
      receiptScopeFromTutorialId('editor:lakehouse#3f2c9a10-7b1e-4d8c-9a01-22aa55bb77cc'),
    ).toEqual({ itemType: 'lakehouse', itemId: '3f2c9a10-7b1e-4d8c-9a01-22aa55bb77cc' });
  });

  it('returns undefined for an unsaved "new" item (no receipts yet)', () => {
    expect(receiptScopeFromTutorialId('editor:notebook#new')).toBeUndefined();
  });

  it('returns undefined for a tutorial id without an item reference', () => {
    expect(receiptScopeFromTutorialId('editor:notebook')).toBeUndefined();
    expect(receiptScopeFromTutorialId('tutorial:02-first-lakehouse')).toBeUndefined();
  });

  it('returns undefined for empty / undefined input', () => {
    expect(receiptScopeFromTutorialId(undefined)).toBeUndefined();
    expect(receiptScopeFromTutorialId('')).toBeUndefined();
    expect(receiptScopeFromTutorialId('   ')).toBeUndefined();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(receiptScopeFromTutorialId('  editor:warehouse#wh-9  ')).toEqual({
      itemType: 'warehouse',
      itemId: 'wh-9',
    });
  });
});
