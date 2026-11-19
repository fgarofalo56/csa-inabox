import type { Container } from '@azure/cosmos';
import { describe, expect, it } from 'vitest';
import { CosmosCollection } from '../src/store/cosmos.js';
import type { Doc } from '../src/store/types.js';

type Page = { resources?: Record<string, unknown>[] };

// Fake Container: the query iterator serves scripted pages; hasMoreResults() is true until the last is served.
function fake(pages: Page[]): Container {
  let i = 0;
  const it = {
    hasMoreResults: () => i < pages.length,
    fetchNext: async () => pages[i++],
  };
  return { items: { query: () => it } } as unknown as Container;
}
const doc = (id: string) => ({ id, _rid: 'r', _self: 's', _attachments: 'a', _ts: 1, name: id });

describe('CosmosCollection.list paging (#5370)', () => {
  it('(a) undefined resources on the only page yields [] without throwing', async () => {
    // Input that breaks it: the old single fetchNext + resources.slice threw TypeError on undefined.
    const rows = await new CosmosCollection<Doc>(fake([{}])).list(10);
    expect(rows).toEqual([]);
  });

  it('(b) an empty first page with more results pending still returns the next page', async () => {
    // Input that breaks it: the old single fetchNext returned only the empty first page -> [] instead of 3.
    const rows = await new CosmosCollection<Doc>(
      fake([{ resources: [] }, { resources: [doc('a'), doc('b'), doc('c')] }]),
    ).list(10);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('(c) more docs than limit across pages returns exactly limit, in order, system fields stripped', async () => {
    // Input that breaks it: no truncation (returns 5) or no clean() (leaks _rid/_ts).
    const rows = await new CosmosCollection<Doc>(
      fake([{ resources: [doc('a'), doc('b')] }, { resources: [doc('c'), doc('d'), doc('e')] }]),
    ).list(3);
    expect(rows).toEqual([
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
      { id: 'c', name: 'c' },
    ]);
  });
});
