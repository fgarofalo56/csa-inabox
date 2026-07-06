import { describe, it, expect } from 'vitest';
import { itemGrantConfersWrite } from '../item-access';

/**
 * rel-T87 — the item-grant WRITE decision. `resolveItemAccessByOid` itself
 * touches Cosmos + the workspace ACL resolver (integration-covered live), but
 * the write-vs-read decision it derives from a grant's permission-type set is
 * pure and unit-tested here.
 */
describe('itemGrantConfersWrite — Edit is the only write-carrying permission', () => {
  it('grants write when the set includes Edit', () => {
    expect(itemGrantConfersWrite(['Read', 'Edit'])).toBe(true);
    expect(itemGrantConfersWrite(['Edit'])).toBe(true);
    expect(itemGrantConfersWrite(['Read', 'Edit', 'Reshare'])).toBe(true);
  });

  it('is read-only for every non-Edit set', () => {
    expect(itemGrantConfersWrite(['Read'])).toBe(false);
    expect(itemGrantConfersWrite(['Read', 'ReadData', 'ReadAllSQL', 'ReadAllSpark'])).toBe(false);
    expect(itemGrantConfersWrite(['Read', 'Reshare', 'Execute', 'Build'])).toBe(false);
    expect(itemGrantConfersWrite(['SubscribeOneLakeEvents'])).toBe(false);
  });

  it('is read-only for an empty / undefined set', () => {
    expect(itemGrantConfersWrite([])).toBe(false);
    expect(itemGrantConfersWrite(undefined)).toBe(false);
  });
});
