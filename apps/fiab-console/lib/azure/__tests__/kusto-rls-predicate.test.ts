/**
 * Unit tests for the dependency-free Kusto RLS query validator.
 * No Azure SDK / fetch — pure function under test.
 */
import { describe, it, expect } from 'vitest';
import { validateKustoRlsQuery, KUSTO_RLS_QUERY_MAX } from '../kusto-rls-predicate';

describe('validateKustoRlsQuery', () => {
  it('rejects an empty query', () => {
    const r = validateKustoRlsQuery('');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/i);
  });

  it('accepts a principal-membership predicate', () => {
    const r = validateKustoRlsQuery("MyTable | where current_principal_is_member_of('aadgroup=analysts@co.com')");
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('accepts a stored-function call', () => {
    const r = validateKustoRlsQuery('MyRlsFunction()');
    expect(r.ok).toBe(true);
  });

  it('rejects an embedded control command', () => {
    const r = validateKustoRlsQuery('.create table Hack (x:string)');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/control command/i);
  });

  it('rejects a statement separator', () => {
    const r = validateKustoRlsQuery('T | where x; T | take 1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/single KQL expression/i);
  });

  it('rejects a query exceeding the length cap', () => {
    const r = validateKustoRlsQuery('T | where ' + 'a'.repeat(KUSTO_RLS_QUERY_MAX + 1));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too long/i);
  });

  it('warns (but allows) a predicate that does not reference the principal', () => {
    const r = validateKustoRlsQuery('T | where Region == "EU"');
    expect(r.ok).toBe(true);
    expect(r.warning).toBeTruthy();
  });
});
