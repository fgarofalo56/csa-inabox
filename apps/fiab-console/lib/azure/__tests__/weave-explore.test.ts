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
  it('filters in JS (case-insensitive CONTAINS on any prop) — needle never in cypher', async () => {
    runCypher.mockResolvedValue({ rows: [
      ['{"id":1,"label":"Customer","properties":{"name":"Contoso E2E","customerId":"CUST-E2E-001"}}::vertex'],
      ['{"id":2,"label":"Customer","properties":{"name":"Fabrikam","customerId":"CUST-002"}}::vertex'],
    ] });
    const objs = await searchObjects('Customer', 'contoso', 50);   // lower-case query, mixed-case data
    expect(objs).toEqual([{ id: '1', objectType: 'Customer', properties: { name: 'Contoso E2E', customerId: 'CUST-E2E-001' } }]);
    // AGE can't run the predicate — the query must NOT reach cypher (injection-free)
    const stmt = runCypher.mock.calls[0][0] as string;
    expect(stmt).not.toContain('contoso');
    expect(stmt).not.toContain('WHERE');
    expect(stmt).toContain('MATCH (n:Customer) RETURN n LIMIT');
  });
  it('matches the hyphenated id substring (the live-caught miss)', async () => {
    runCypher.mockResolvedValue({ rows: [
      ['{"id":1,"label":"Customer","properties":{"name":"Contoso","customerId":"CUST-E2E-001"}}::vertex'],
    ] });
    const objs = await searchObjects('Customer', 'CUST-E2E', 50);
    expect(objs).toHaveLength(1);
  });
  it('ignores private (_-prefixed) props and lists all when q is empty', async () => {
    runCypher.mockResolvedValue({ rows: [
      ['{"id":1,"label":"Customer","properties":{"_hidden":"secret","name":"A"}}::vertex'],
    ] });
    // q matches only a private prop → no result
    expect(await searchObjects('Customer', 'secret')).toHaveLength(0);
    runCypher.mockClear();
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
