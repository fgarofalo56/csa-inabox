/**
 * The classifier pieces the serverless SQL pool editor adds to the lakehouse
 * SQL tab's classifier: confinement to a SET of roots
 * (`confineQueryLocationToRoots`) and the editor's own refusal wording.
 *
 * Each case names what breaks it in its label.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeLakehouseQuery,
  confineQueryLocationToRoots,
  type ItemStorageLocation,
} from '@/app/api/items/lakehouse/_lib/query-scope';
import { SQL_POOL_EDITOR } from '../_lib/query-scope';

const A: ItemStorageLocation = {
  abfss: 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1',
  container: 'gold',
  root: 'lakehouses/sales-1',
};
const B: ItemStorageLocation = {
  abfss: 'abfss://silver@acct2.dfs.core.windows.net/lakehouses/ops-2',
  container: 'silver',
  root: 'lakehouses/ops-2',
};
const OPTS = { surface: SQL_POOL_EDITOR, outside: 'OUTSIDE-REASON', remediation: 'REMEDIATION-TEXT' };

describe('confineQueryLocationToRoots', () => {
  it.each([
    ['inside the first root (breaks if roots are not tried in turn)', 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t'],
    ['inside the second root (breaks if only bounds[0] is checked)', 'https://acct2.dfs.core.windows.net/silver/lakehouses/ops-2/Files/x.csv'],
    ['the abfss form of the second root', 'abfss://silver@acct2.dfs.core.windows.net/lakehouses/ops-2/Tables/t'],
  ])('accepts a location %s', (_label, url) => {
    expect(confineQueryLocationToRoots(url, [A, B], OPTS)).toEqual({ ok: true });
  });

  it.each([
    ['a sibling root in a listed container', 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-10/Tables/t'],
    ['root A\'s path on root B\'s account', 'https://acct2.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t'],
    ['root B\'s container with root A\'s path', 'https://acct1.dfs.core.windows.net/silver/lakehouses/sales-1/Tables/t'],
  ])('refuses %s with the caller-supplied reason and remediation', (_label, url) => {
    const out = confineQueryLocationToRoots(url, [A, B], OPTS);
    expect(out).toMatchObject({
      ok: false, status: 403, code: 'query_location_outside_root', construct: url, remediation: 'REMEDIATION-TEXT',
    });
    expect((out as any).error).toContain('is not accepted: OUTSIDE-REASON.');
  });

  it('refuses everything when no roots are given (breaks if an empty set accepts)', () => {
    const url = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t';
    expect(confineQueryLocationToRoots(url, [], OPTS)).toMatchObject({ ok: false, code: 'query_location_outside_root' });
  });

  it('refuses a location that is not a full URL with that reason, not the outside reason', () => {
    const out = confineQueryLocationToRoots('lakehouses/sales-1/Tables/t', [A, B], OPTS);
    expect((out as any).error).toContain('not a full https:// or abfss:// URL');
    expect((out as any).error).not.toContain('OUTSIDE-REASON');
  });

  it('refuses a location whose escapes do not decode, with the decode reason', () => {
    const out = confineQueryLocationToRoots('https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Files/100%', [A], OPTS);
    expect((out as any).error).toContain('a % that is not a percent-escape');
  });

  it('refuses a dot segment that climbs out of a listed root into a sibling', () => {
    const url = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/../other-9/Tables/t';
    expect(confineQueryLocationToRoots(url, [A, B], OPTS)).toMatchObject({ ok: false });
  });
});

describe('SQL_POOL_EDITOR wording', () => {
  it('a refusal names this editor and its remediation, not the lakehouse SQL tab', () => {
    const out = analyzeLakehouseQuery('SELECT name FROM sys.databases', { database: 'master', surface: SQL_POOL_EDITOR });
    expect(out.ok).toBe(false);
    const r = out as any;
    expect(r.error.startsWith(SQL_POOL_EDITOR.lead)).toBe(true);
    expect(r.error).not.toContain('SQL tab');
    expect(r.error).toContain('this editor reads the files of the lakehouses in this workspace');
  });

  it('a non-SELECT statement gets this editor\'s SELECT remediation (breaks if selectRemediation is not the surface\'s)', () => {
    const out = analyzeLakehouseQuery('DELETE FROM t', { database: 'master', surface: SQL_POOL_EDITOR }) as any;
    expect(out.ok).toBe(false);
    expect(out.remediation).toBe(SQL_POOL_EDITOR.selectRemediation);
  });

  it('the same text without a surface still reads as the lakehouse SQL tab (breaks if the default surface changed)', () => {
    const out = analyzeLakehouseQuery('SELECT name FROM sys.databases', { database: 'master' }) as any;
    expect(out.ok).toBe(false);
    expect(out.error.startsWith(SQL_POOL_EDITOR.lead)).toBe(false);
  });
});
