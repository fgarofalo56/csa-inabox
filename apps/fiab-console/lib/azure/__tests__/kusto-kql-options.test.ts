/**
 * Tests for PSR-6 buildKqlWithOptions: results-cache `set` prefix + server-side
 * row_number paging, render-strip, integer coercion, and control-command guard.
 */
import { describe, expect, it } from 'vitest';
import { buildKqlWithOptions, computePagingEnvelope, parseKqlPage, KQL_MAX_ROWS } from '../kusto-client';

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

describe('computePagingEnvelope — PSR-6 hasMore / nextPage', () => {
  it('over-fetch of take+1 signals hasMore and the next window', () => {
    // Asked for take=50, executor over-fetched 51 → there is more.
    const env = computePagingEnvelope(51, { skip: 100, take: 50 });
    expect(env.keep).toBe(50);
    expect(env.hasMore).toBe(true);
    expect(env.nextPage).toEqual({ skip: 150, take: 50 });
  });
  it('exactly take rows means the last page (no more, no nextPage)', () => {
    const env = computePagingEnvelope(50, { skip: 0, take: 50 });
    expect(env.hasMore).toBe(false);
    expect(env.nextPage).toBeUndefined();
  });
  it('fewer than take rows means the last page', () => {
    const env = computePagingEnvelope(12, { skip: 0, take: 50 });
    expect(env.hasMore).toBe(false);
    expect(env.keep).toBe(50);
  });
  it('floors fractional / negative windows before advancing', () => {
    const env = computePagingEnvelope(6, { skip: -5, take: 5.9 });
    expect(env.keep).toBe(5);
    expect(env.hasMore).toBe(true);
    expect(env.nextPage).toEqual({ skip: 5, take: 5 });
  });
});

describe('parseKqlPage — safe page parsing off a route body', () => {
  it('returns undefined when no paging was requested', () => {
    expect(parseKqlPage(undefined)).toBeUndefined();
    expect(parseKqlPage({})).toBeUndefined();
    expect(parseKqlPage('nope')).toBeUndefined();
  });
  it('parses skip + take, flooring skip non-negative', () => {
    expect(parseKqlPage({ skip: 100, take: 50 })).toEqual({ skip: 100, take: 50 });
    expect(parseKqlPage({ skip: -3, take: 10 })).toEqual({ skip: 0, take: 10 });
  });
  it('clamps take to [1, KQL_MAX_ROWS]', () => {
    expect(parseKqlPage({ take: 0 })).toEqual({ skip: 0, take: KQL_MAX_ROWS });
    expect(parseKqlPage({ take: 9_999_999 })).toEqual({ skip: 0, take: KQL_MAX_ROWS });
    expect(parseKqlPage({ skip: 10 })).toEqual({ skip: 10, take: KQL_MAX_ROWS });
  });
});
