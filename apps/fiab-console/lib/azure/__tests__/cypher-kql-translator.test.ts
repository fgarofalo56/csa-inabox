/**
 * Cypher → KQL translator — coverage for the supported grammar.
 *
 * Per no-vaporware.md, every claim about translation accuracy must be
 * backed by a test. These exercise the patterns the editor surfaces in
 * its sample query + the round-trip "explain this KQL" helper.
 */
import { describe, it, expect } from 'vitest';
import { cypherToKql, kqlToCypherApprox, TranslationError } from '@/lib/azure/cypher-kql-translator';

describe('cypherToKql', () => {
  it('translates a 2-hop MATCH with label predicates', () => {
    const k = cypherToKql(
      `MATCH (a:Person)-[r:KNOWS]->(b:Person) WHERE a.name == "Alice" RETURN a.name, b.name`,
      'GraphSnapshot',
    );
    expect(k).toContain('GraphSnapshot');
    expect(k).toContain('graph-match (a)-[r]->(b)');
    expect(k).toContain('a.Label == "Person"');
    expect(k).toContain('r.Label == "KNOWS"');
    expect(k).toContain('b.Label == "Person"');
    expect(k).toContain('a.name == "Alice"');
    expect(k).toContain('project a.name, b.name');
  });

  it('honors no-WHERE pattern', () => {
    const k = cypherToKql(`MATCH (a)-[r]->(b) RETURN a, b`, 'g');
    expect(k).toContain('graph-match (a)-[r]->(b)');
    expect(k).not.toContain('where');
    expect(k).toContain('project a, b');
  });

  it('throws TranslationError on malformed pattern', () => {
    expect(() => cypherToKql('not a real cypher', 'g')).toThrow(TranslationError);
  });

  it('throws when MATCH or RETURN is missing', () => {
    expect(() => cypherToKql('RETURN x', 'g')).toThrow(TranslationError);
    expect(() => cypherToKql('MATCH (a)', 'g')).toThrow(TranslationError);
  });
});

describe('kqlToCypherApprox', () => {
  it('round-trips the canonical shape', () => {
    const kql = `Snap
| graph-match (a)-[r]->(b) where a.Label == "Person" and a.name == "Alice"
  project a.name, b.name`;
    const c = kqlToCypherApprox(kql);
    expect(c).toContain('MATCH (a)-[r]->(b)');
    expect(c).toContain('WHERE');
    expect(c).toContain('RETURN a.name, b.name');
  });

  it('throws on non-canonical KQL', () => {
    expect(() => kqlToCypherApprox('print 1')).toThrow(TranslationError);
  });
});
