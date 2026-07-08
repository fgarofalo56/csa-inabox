import { describe, it, expect } from 'vitest';
import { extractCitationsFromToolResult, mergeCitations } from '../tool-citations';

describe('extractCitationsFromToolResult (CTS-04)', () => {
  it('maps searchDocs { hits } into doc citations', () => {
    const result = {
      backend: 'ai-search',
      hits: [
        { id: 'a1', kind: 'docs', path: 'docs/x.md', heading: 'Setup', url: 'https://learn/x', content: 'Full chunk text here', score: 0.9 },
        { id: 'a2', kind: 'repo', path: 'lib/y.ts', content: 'code', score: 0.5 },
      ],
    };
    const cs = extractCitationsFromToolResult('searchDocs', result);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ id: 'a1', path: 'docs/x.md', kind: 'docs', heading: 'Setup', url: 'https://learn/x' });
    expect(cs[0].preview).toContain('Full chunk');
    expect(cs[1].kind).toBe('repo');
  });

  it('maps agentic { citations: [{ id, docKey, source }] } into knowledge citations', () => {
    const result = {
      grounded: true,
      citations: [
        { id: 'k1', docKey: 'ZG9jOnBhdGg_0', source: 'https://src/doc' },
        { id: 'k2', docKey: 'abc', source: 'internal-note' },
      ],
    };
    const cs = extractCitationsFromToolResult('knowledge_base_retrieve', result);
    expect(cs).toHaveLength(2);
    expect(cs[0]).toMatchObject({ id: 'k1', kind: 'knowledge', url: 'https://src/doc' });
    // Non-URL source has no url but keeps the path.
    expect(cs[1].url).toBeUndefined();
    expect(cs[1].path).toBe('internal-note');
  });

  it('returns [] for a tool result with no provenance and never throws', () => {
    expect(extractCitationsFromToolResult('loom_x', { ok: true, rows: [] })).toEqual([]);
    expect(extractCitationsFromToolResult('loom_x', null)).toEqual([]);
    expect(extractCitationsFromToolResult('loom_x', 'nope')).toEqual([]);
    expect(extractCitationsFromToolResult('loom_x', 42)).toEqual([]);
  });

  it('mergeCitations de-duplicates by id (first-writer wins)', () => {
    const a = [{ id: '1', path: 'p', kind: 'docs', preview: 'first' }];
    const b = [
      { id: '1', path: 'p', kind: 'docs', preview: 'second' },
      { id: '2', path: 'q', kind: 'docs', preview: 'new' },
    ];
    const merged = mergeCitations(a, b);
    expect(merged).toHaveLength(2);
    expect(merged[0].preview).toBe('first'); // not overwritten
    expect(merged[1].id).toBe('2');
  });
});
