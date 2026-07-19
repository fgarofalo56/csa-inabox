/**
 * weave-explore — cross-type Object Explorer query composition (Foundry 2.6).
 * runCypher is mocked so we test the SQL/cypher shaping + agtype parsing + the
 * safeLabel injection guard, no PG I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runCypher = vi.fn();
vi.mock('@/lib/azure/weave-ontology-store', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/weave-ontology-store');
  return { ...actual, runCypher: (...a: any[]) => runCypher(...a) };
});

import { objectFacets, searchObjects, traverseObject } from '../weave-explore';

beforeEach(() => runCypher.mockReset());

describe('objectFacets', () => {
  it('keeps only declared types and sorts by count desc', async () => {
    runCypher.mockResolvedValue({ rows: [['"Customer"', '3'], ['"Order"', '10'], ['"Stray"', '99']] });
    const f = await objectFacets(['Customer', 'Order']);
    expect(f).toEqual([{ objectType: 'Order', count: 10 }, { objectType: 'Customer', count: 3 }]);
  });
});

describe('searchObjects', () => {
  it('rejects an invalid label (injection guard)', async () => {
    await expect(searchObjects('bad label; DROP', 'x')).rejects.toThrow(/valid AGE label/);
  });
  it('embeds the needle as a JSON-escaped literal + parses vertices', async () => {
    runCypher.mockResolvedValue({ rows: [['{"id":844,"label":"Customer","properties":{"name":"Contoso"}}::vertex']] });
    const objs = await searchObjects('Customer', 'con"to', 50);
    // the statement must contain the escaped needle, never a raw quote break
    const stmt = runCypher.mock.calls[0][0] as string;
    expect(stmt).toContain('"con\\"to"'.toLowerCase().replace('con\\"to', 'con\\"to')); // escaped
    expect(objs).toEqual([{ id: '844', objectType: 'Customer', properties: { name: 'Contoso' } }]);
  });
  it('lists without a WHERE when q is empty', async () => {
    runCypher.mockResolvedValue({ rows: [] });
    await searchObjects('Customer', '');
    expect(runCypher.mock.calls[0][0]).toContain('MATCH (n:Customer) RETURN n LIMIT');
    expect(runCypher.mock.calls[0][0]).not.toContain('WHERE');
  });
});

describe('traverseObject', () => {
  it('requires a numeric AGE id', async () => {
    await expect(traverseObject('Customer', 'abc')).rejects.toThrow(/numeric AGE id/);
  });
  it('maps direction + link type from the row', async () => {
    runCypher.mockResolvedValue({ rows: [['"OWNS"', 'true', '{"id":9,"label":"Account","properties":{}}::vertex']] });
    const n = await traverseObject('Customer', '844');
    expect(n).toEqual([{ linkType: 'OWNS', direction: 'out', neighbor: { id: '9', objectType: 'Account', properties: {} } }]);
  });
});
