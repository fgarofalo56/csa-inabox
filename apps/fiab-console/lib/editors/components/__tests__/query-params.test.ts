/**
 * query-params — unit tests for the parameter detection + injection-safe
 * substitution helpers that drive the SQL-editor parameter widgets (T9).
 *
 * The security-critical invariant these tests lock down: substitution rewrites
 * ONLY the `{{name}}` placeholder token to the engine-native marker (`:name`
 * for Databricks, `@name` for Synapse). The user-supplied VALUE is never spliced
 * into the SQL string — it travels out-of-band in the parameters[] array
 * (Databricks) / via req.input() (mssql). So a SQL metacharacter in a value
 * cannot alter the statement.
 */
import { describe, it, expect } from 'vitest';
import { extractParams, substituteDbx, substituteSynapse, type QueryParam } from '../query-params-utils';

describe('extractParams', () => {
  it('extracts distinct {{name}} tokens in first-seen order', () => {
    expect(extractParams('SELECT * FROM t WHERE region = {{region}} AND yr = {{year}}'))
      .toEqual(['region', 'year']);
  });

  it('de-duplicates repeated tokens', () => {
    expect(extractParams('WHERE a = {{x}} OR b = {{x}} OR c = {{y}}')).toEqual(['x', 'y']);
  });

  it('tolerates inner whitespace', () => {
    expect(extractParams('WHERE r = {{ region }}')).toEqual(['region']);
  });

  it('returns [] when there are no tokens', () => {
    expect(extractParams('SELECT 1')).toEqual([]);
  });
});

describe('substituteDbx (Databricks :name)', () => {
  it('rewrites {{name}} to :name', () => {
    expect(substituteDbx('WHERE region = {{region}}', [{ name: 'region', value: 'West' }]))
      .toBe('WHERE region = :region');
  });

  it('does NOT splice the value into the SQL (injection-safe)', () => {
    const malicious: QueryParam[] = [{ name: 'region', value: "x'; DROP TABLE sales; --" }];
    const out = substituteDbx('SELECT * FROM sales WHERE region = {{region}}', malicious);
    expect(out).toBe('SELECT * FROM sales WHERE region = :region');
    expect(out).not.toContain('DROP TABLE');
    expect(out).not.toContain("'");
  });
});

describe('substituteSynapse (Synapse @name)', () => {
  it('rewrites {{name}} to @name', () => {
    expect(substituteSynapse('WHERE region = {{region}}', [{ name: 'region', value: 'West' }]))
      .toBe('WHERE region = @region');
  });

  it('rewrites every occurrence of a repeated token', () => {
    expect(substituteSynapse('a = {{x}} OR b = {{x}}', [{ name: 'x', value: '1' }]))
      .toBe('a = @x OR b = @x');
  });

  it('does NOT splice the value into the SQL (injection-safe)', () => {
    const malicious: QueryParam[] = [{ name: 'region', value: "'; DELETE FROM dbo.sales; --" }];
    const out = substituteSynapse('SELECT * FROM dbo.sales WHERE region = {{region}}', malicious);
    expect(out).toBe('SELECT * FROM dbo.sales WHERE region = @region');
    expect(out).not.toContain('DELETE FROM');
    expect(out).not.toContain("'");
  });
});
