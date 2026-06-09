/**
 * copilot-result-tagger — pure unit tests (node env).
 *
 * Verifies the heuristic that gives an arbitrary tool result a kind so the
 * renderer can pick a surface. These run without a DOM since the tagger is
 * pure TypeScript (no React).
 */
import { describe, it, expect } from 'vitest';
import {
  tagResult, asTable, asSummary, asCode, isTypedResult, inferChartType,
  type TableResult, type SummaryResult,
} from '../copilot-result-tagger';

describe('tagResult', () => {
  it('tags a QueryResult {columns, rows} shape as table', () => {
    const raw = {
      columns: ['region', 'revenue'],
      rows: [['East', 100], ['West', 250]],
      rowCount: 2,
      executionMs: 42,
      truncated: false,
    };
    const t = tagResult(raw, 'synapse_serverless_query');
    expect(t.kind).toBe('table');
    const tt = t as TableResult;
    expect(tt.columns).toEqual(['region', 'revenue']);
    expect(tt.rows).toHaveLength(2);
    expect(tt.rowCount).toBe(2);
    expect(tt.executionMs).toBe(42);
  });

  it('tags a string value as a markdown summary', () => {
    const t = tagResult('## Explanation\nThis query joins two tables.');
    expect(t.kind).toBe('summary');
    expect((t as SummaryResult).markdown).toContain('Explanation');
  });

  it('tags an object with a markdown field as summary', () => {
    const t = tagResult({ markdown: '**done**', title: 'Audit' });
    expect(t.kind).toBe('summary');
    expect((t as SummaryResult).title).toBe('Audit');
  });

  it('tags { ok:false, error } as an error', () => {
    const t = tagResult({ ok: false, error: 'pool paused', code: 'POOL_PAUSED' });
    expect(t.kind).toBe('error');
    if (t.kind === 'error') {
      expect(t.message).toBe('pool paused');
      expect(t.code).toBe('POOL_PAUSED');
    }
  });

  it('tags { code, language } as code', () => {
    const t = tagResult({ code: 'SELECT 1', language: 'sql', filename: 'q.sql' });
    expect(t.kind).toBe('code');
    if (t.kind === 'code') {
      expect(t.code).toBe('SELECT 1');
      expect(t.language).toBe('sql');
    }
  });

  it('tags { changes, targetType } as proposed_change', () => {
    const t = tagResult({ targetType: 'lakehouse', targetId: 'i1', displayName: 'Gold', changes: [{ field: 'created', after: true }] });
    expect(t.kind).toBe('proposed_change');
    if (t.kind === 'proposed_change') expect(t.changes).toHaveLength(1);
  });

  it('leaves an opaque object as unknown (raw preserved)', () => {
    const raw = { foo: 1, bar: { baz: 2 } };
    const t = tagResult(raw);
    expect(t.kind).toBe('unknown');
    if (t.kind === 'unknown') expect(t.raw).toBe(raw);
  });

  it('is idempotent on an already-tagged TypedResult', () => {
    const tagged = asTable({ columns: ['a'], rows: [[1]] }, 'x');
    expect(tagResult(tagged)).toBe(tagged);
    expect(isTypedResult(tagged)).toBe(true);
  });

  it('treats null/undefined as unknown', () => {
    expect(tagResult(null).kind).toBe('unknown');
    expect(tagResult(undefined).kind).toBe('unknown');
  });
});

describe('constructors + helpers', () => {
  it('asSummary / asCode build proper envelopes', () => {
    expect(asSummary('hi', 'T')).toEqual({ kind: 'summary', markdown: 'hi', title: 'T' });
    const c = asCode('python', 'print(1)', { filename: 'a.py' });
    expect(c.kind).toBe('code');
    expect(c.filename).toBe('a.py');
  });

  it('inferChartType picks timechart for an ISO-time first column', () => {
    const rows = [['2026-06-01T00:00', 5], ['2026-06-02T00:00', 8]];
    expect(inferChartType(['ts', 'v'], rows)).toBe('timechart');
    expect(inferChartType(['region', 'v'], [['East', 5], ['West', 8]])).toBe('barchart');
  });
});
