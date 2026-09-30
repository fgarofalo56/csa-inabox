/**
 * Synapse notebook <-> Loom item binding (#4619). Pure; no mocks.
 * Each load-bearing assertion names the input that breaks it.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTEBOOK_NAME_RE, MIN_TOKEN_LENGTH, notebookItemToken, boundNotebookName, isNameBoundToItem, itemIdQuery,
} from '../synapse-notebook-binding';

const UUID = '3F2A9C1E-7b4d-4e8a-9f10-1234567890ab';
const TOKEN = '3f2a9c1e7b4d4e8a9f101234567890ab';
const OTHER = 'b7e1d2c3-0a9f-4e8d-8c7b-6a5f4e3d2c1b';

describe('notebookItemToken', () => {
  it('strips separators and lower-cases a UUID into 32 hex chars', () => {
    // Breaks if dashes are kept (the token would then fail NAME_RE) or case is kept.
    expect(notebookItemToken(UUID)).toBe(TOKEN);
  });

  it('refuses an id shorter than MIN_TOKEN_LENGTH after stripping', () => {
    // Breaks if the floor is removed: "new" (the unsaved-editor id) would
    // become a 3-char token that many free names end with.
    expect(MIN_TOKEN_LENGTH).toBe(16);
    expect(notebookItemToken('new')).toBeNull();
    expect(notebookItemToken('a-b-c-d-e-f-g-h-i-j-k-l-m-n-o')).toBeNull(); // 15 alnum
    expect(notebookItemToken('abcdefghijklmnop')).toBe('abcdefghijklmnop'); // exactly 16
  });
});

describe('boundNotebookName', () => {
  it('sanitises the display name and appends _<token>', () => {
    // Breaks if the separator or sanitiser changes.
    expect(boundNotebookName('Sales nb!', UUID)).toBe(`Sales_nb_${TOKEN}`);
    expect(boundNotebookName('', UUID)).toBe(`notebook_${TOKEN}`);
    expect(boundNotebookName('***', UUID)).toBe(`notebook_${TOKEN}`);
  });

  it('caps at 260 chars and still matches NAME_RE and its own binding', () => {
    // Breaks if the display prefix is not truncated to leave room for the
    // suffix: a 300-char display name would give a >260 name that NAME_RE refuses.
    const n = boundNotebookName('x'.repeat(300), UUID)!;
    expect(n.length).toBe(260);
    expect(NOTEBOOK_NAME_RE.test(n)).toBe(true);
    expect(isNameBoundToItem(n, UUID)).toBe(true);
  });

  it('is null for an id too short to bind', () => {
    expect(boundNotebookName('Sales', 'new')).toBeNull();
  });
});

describe('isNameBoundToItem', () => {
  it('accepts the item\'s own bound name, any display prefix, any case', () => {
    // Breaks if the check requires the CURRENT display prefix, or is case-sensitive.
    expect(isNameBoundToItem(`Sales_nb_${TOKEN}`, UUID)).toBe(true);
    expect(isNameBoundToItem(`renamed_${TOKEN}`, UUID)).toBe(true);
    expect(isNameBoundToItem(`Sales_${TOKEN.toUpperCase()}`, UUID)).toBe(true);
  });

  it.each([
    ['another item\'s bound name', `Sales_nb_${notebookItemToken(OTHER)}`],
    ['a free name', 'Sales_nb'],
    ['the bare token', TOKEN],
    ['"_" + token with no prefix', `_${TOKEN}`],
    ['token glued to prefix', `Sales${TOKEN}`],
    ['token plus trailing char', `Sales_${TOKEN}0`],
    ['token then another segment', `Sales_${TOKEN}_v2`],
    ['a name failing NAME_RE', `Sales.nb_${TOKEN}`],
    ['an over-long name', `${'x'.repeat(230)}_${TOKEN}`],
  ])('refuses %s', (_label, name) => {
    // Breaks if the suffix test degrades to includes/endsWith(token) without
    // the "_" or without the NAME_RE / non-empty-prefix conditions.
    expect(isNameBoundToItem(name, UUID)).toBe(false);
  });

  it('refuses every name for an id with no token', () => {
    // Breaks if a null token is treated as "" (every name ending in "_" binds).
    expect(isNameBoundToItem('x_', 'new')).toBe(false);
    expect(isNameBoundToItem('x_new', 'new')).toBe(false);
  });
});

describe('itemIdQuery', () => {
  it('encodes the id, and is empty when there is none', () => {
    expect(itemIdQuery(UUID)).toBe(`?itemId=${UUID}`);
    expect(itemIdQuery('a&b=c')).toBe('?itemId=a%26b%3Dc');
    expect(itemIdQuery('')).toBe('');
  });
});
