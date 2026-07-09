/**
 * Query-centric Copilot builder factory — pure normalizeOps / applyOps tests (G1).
 *
 * Exercises the REAL set-query extraction: it takes the first set-query op,
 * strips a stray ```lang fence, drops empties, and applyOps persists the query
 * to the configured docKey.
 */
import { describe, it, expect } from 'vitest';
import { makeQueryBuilderConfig } from '../copilot-query-builder';

const cfg = makeQueryBuilderConfig({
  itemType: 'stream-analytics-job',
  docKey: 'copilotSaqlDraft',
  language: 'SAQL',
  systemPrompt: 'SYS',
  grounding: (state) => (typeof state.schema === 'string' ? `SCHEMA: ${state.schema}` : ''),
}) as any;

describe('query builder — normalizeOps', () => {
  it('extracts the first set-query op and strips a code fence', () => {
    const ops = cfg.normalizeOps([{ kind: 'set-query', query: '```sql\nSELECT * INTO Output FROM Input\n```' }], { query: '', grounding: '' });
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('set-query');
    expect(ops[0].query).toBe('SELECT * INTO Output FROM Input');
    expect(ops[0].badge).toBe('Set SAQL');
  });

  it('drops empty / non-set-query ops', () => {
    expect(cfg.normalizeOps([{ kind: 'other', query: 'x' }], { query: '', grounding: '' })).toHaveLength(0);
    expect(cfg.normalizeOps([{ kind: 'set-query', query: '   ' }], { query: '', grounding: '' })).toHaveLength(0);
  });

  it('takes only the FIRST valid set-query op', () => {
    const ops = cfg.normalizeOps([
      { kind: 'set-query', query: 'SELECT 1' },
      { kind: 'set-query', query: 'SELECT 2' },
    ], { query: '', grounding: '' });
    expect(ops).toHaveLength(1);
    expect(ops[0].query).toBe('SELECT 1');
  });
});

describe('query builder — applyOps + readDoc + grounding', () => {
  it('persists the query to the configured docKey', () => {
    const ops = cfg.normalizeOps([{ kind: 'set-query', query: 'SELECT 1' }], { query: '', grounding: '' });
    const { patch, applied } = cfg.applyOps({ query: '', grounding: '' }, ops);
    expect(patch).toEqual({ copilotSaqlDraft: 'SELECT 1' });
    expect(applied).toHaveLength(1);
  });

  it('reads the draft + real grounding out of state', () => {
    const doc = cfg.readDoc({ copilotSaqlDraft: 'SELECT 9', schema: 'events(ts, id)' });
    expect(doc.query).toBe('SELECT 9');
    expect(doc.grounding).toContain('events(ts, id)');
    // groundingText embeds BOTH schema and the current draft for revision.
    const g = cfg.groundingText(doc);
    expect(g).toContain('events(ts, id)');
    expect(g).toContain('SELECT 9');
  });

  it('never fabricates grounding when state is empty', () => {
    const doc = cfg.readDoc({});
    expect(doc.grounding).toBe('(no schema captured yet)');
  });
});
