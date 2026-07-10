/**
 * Tests for PSR-6 buildKqlWithOptions: results-cache `set` prefix + server-side
 * row_number paging, render-strip, integer coercion, and control-command guard.
 */
import { describe, expect, it } from 'vitest';
import { buildKqlWithOptions } from '../kusto-client';

describe('buildKqlWithOptions — results cache', () => {
  it('prefixes the query-results-cache set statement', () => {
    const { csl } = buildKqlWithOptions('T | count', { resultsCacheMaxAgeSec: 300 });
    expect(csl.startsWith('set query_results_cache_max_age = time(300s);\n')).toBe(true);
    expect(csl).toContain('T | count');
  });
  it('floors a fractional max-age and ignores non-positive values', () => {
    expect(buildKqlWithOptions('T', { resultsCacheMaxAgeSec: 12.9 }).csl).toContain('time(12s)');
    expect(buildKqlWithOptions('T', { resultsCacheMaxAgeSec: 0 }).csl).toBe('T');
  });
  it('never applies the cache set to a control command', () => {
    const { csl } = buildKqlWithOptions('.show tables', { resultsCacheMaxAgeSec: 60 });
    expect(csl).toBe('.show tables');
  });
});

describe('buildKqlWithOptions — paging', () => {
  it('appends a row_number window and reports paged', () => {
    const { csl, paged } = buildKqlWithOptions('T | where x > 1', { page: { skip: 100, take: 50 } });
    expect(paged).toBe(true);
    expect(csl).toContain('| serialize __loom_rn = row_number()');
    expect(csl).toContain('| where __loom_rn > 100 and __loom_rn <= 150');
    expect(csl).toContain('| project-away __loom_rn');
  });
  it('strips a trailing render before paging', () => {
    const { csl } = buildKqlWithOptions('T | summarize c=count() | render piechart', {
      page: { skip: 0, take: 10 },
    });
    expect(csl).not.toContain('render');
    expect(csl).toContain('| where __loom_rn > 0 and __loom_rn <= 10');
  });
  it('coerces skip/take to safe non-negative integers', () => {
    const { csl } = buildKqlWithOptions('T', { page: { skip: -5, take: 3.9 } });
    expect(csl).toContain('| where __loom_rn > 0 and __loom_rn <= 3');
  });
  it('does not page a control command', () => {
    const { csl, paged } = buildKqlWithOptions('.show tables', { page: { skip: 0, take: 10 } });
    expect(paged).toBe(false);
    expect(csl).toBe('.show tables');
  });
  it('combines cache prefix and paging', () => {
    const { csl } = buildKqlWithOptions('T | take 100000', {
      resultsCacheMaxAgeSec: 60,
      page: { skip: 0, take: 5000 },
    });
    expect(csl.startsWith('set query_results_cache_max_age = time(60s);')).toBe(true);
    expect(csl).toContain('__loom_rn <= 5000');
  });
});
