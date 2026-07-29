/**
 * ReDoS class regression — behavior parity + adversarial timing for the
 * functions refactored away from quantified-run-before-$ regexes
 * (CodeQL js/polynomial-redos). Same regression shape as the FOCUS
 * fingerprinter fix in lib/finops/__tests__/focus-mart.test.ts (619ms → 0ms).
 */
import { describe, it, expect } from 'vitest';
import { normalizeIdentity } from '../unified-lineage';
import { parseDeltaSource } from '../delta-source-uri';
import { extractSqlSources, safeSegment } from '../materialized-lake-view-model';
import { domainCollectionName } from '../purview-client';
import { datasetUri } from '../openlineage-ingest';

describe('normalizeIdentity — behavior preserved', () => {
  it('extracts UC table identity from a registered Atlas URL', () => {
    expect(normalizeIdentity('https://adb-1.azuredatabricks.net/api/2.1/unity-catalog/tables/Cat.Sch.Tbl'))
      .toBe('uc:cat.sch.tbl');
  });
  it('strips trailing slashes and lowercases storage paths', () => {
    expect(normalizeIdentity('abfss://Bronze@Acct.dfs.core.windows.net/Sales///'))
      .toBe('path:abfss://bronze@acct.dfs.core.windows.net/sales');
  });
  it('recognises a bare UC full_name', () => {
    expect(normalizeIdentity('cat.sch.tbl')).toBe('uc:cat.sch.tbl');
  });
  it('falls through to lowercase for everything else', () => {
    expect(normalizeIdentity('SOME-ITEM-id')).toBe('some-item-id');
    expect(normalizeIdentity('')).toBe('');
    expect(normalizeIdentity(null)).toBe('');
  });
});

describe('parseDeltaSource — behavior preserved by the unambiguous regex', () => {
  it('parses abfss form with and without a path', () => {
    expect(parseDeltaSource('abfss://bronze@acct.dfs.core.windows.net/exports/orders'))
      .toEqual({ container: 'bronze', account: 'acct', path: 'exports/orders' });
    expect(parseDeltaSource('abfss://bronze@acct.dfs.core.windows.net'))
      .toEqual({ container: 'bronze', account: 'acct', path: '' });
    expect(parseDeltaSource('abfss://bronze@acct.dfs.core.windows.net/'))
      .toEqual({ container: 'bronze', account: 'acct', path: '' });
  });
  it('parses https dfs/blob form', () => {
    expect(parseDeltaSource('https://acct.dfs.core.windows.net/bronze/exports/orders/'))
      .toEqual({ account: 'acct', container: 'bronze', path: 'exports/orders' });
    expect(parseDeltaSource('https://acct.blob.core.windows.net/bronze'))
      .toEqual({ account: 'acct', container: 'bronze', path: '' });
  });
  it('rejects non-ADLS URIs', () => {
    expect(parseDeltaSource('s3://bucket/key')).toBeNull();
    expect(parseDeltaSource('')).toBeNull();
  });
});

describe('slug/segment helpers — behavior preserved', () => {
  it('safeSegment', () => {
    expect(safeSegment('__My View!__')).toBe('My_View');
    expect(safeSegment('___')).toBe('mlv');
  });
  it('domainCollectionName', () => {
    expect(domainCollectionName('Sales & Finance')).toBe('sales-finance');
    expect(domainCollectionName('---')).toBe('domain');
  });
  it('datasetUri joins namespace + name', () => {
    expect(datasetUri({ namespace: 'abfss://c@a.dfs.core.windows.net/', name: '/tables/t1' } as any))
      .toBe('abfss://c@a.dfs.core.windows.net/tables/t1');
  });
});

describe('adversarial timing (the old regexes were quadratic here)', () => {
  it('normalizeIdentity: 300k-slash run + marker flood', () => {
    const started = Date.now();
    normalizeIdentity('/'.repeat(300_000) + 'x');
    normalizeIdentity('/unity-catalog/tables/'.repeat(10_000) + '\n');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it('parseDeltaSource: long unterminated tail', () => {
    const started = Date.now();
    parseDeltaSource('abfss://c@a.dfs.' + 'x'.repeat(200_000) + '\n');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  it('extractSqlSources: unterminated block-comment flood (pump "a/*")', () => {
    const hostile = '/*' + 'a/*'.repeat(60_000);
    const started = Date.now();
    extractSqlSources(hostile);
    expect(Date.now() - started).toBeLessThan(1_000);
    // and the linear matcher still strips real comments:
    expect(extractSqlSources('SELECT * FROM t1 /* FROM phantom */')).toEqual(['t1']);
  });
  it('safeSegment/domainCollectionName: long underscore/dash runs', () => {
    const started = Date.now();
    safeSegment('!'.repeat(300_000));
    domainCollectionName('-'.repeat(300_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
