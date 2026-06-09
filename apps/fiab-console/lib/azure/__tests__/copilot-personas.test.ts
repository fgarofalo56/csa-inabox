import { describe, it, expect } from 'vitest';
import {
  computeDynamicPrompts,
  getPersonaPrompts,
  extractSqlTableNames,
  STATIC_PROMPTS,
} from '../copilot-personas';

describe('computeDynamicPrompts', () => {
  it('notebook: produces real lakehouse-name prompts from attachedSourceNames', () => {
    const prompts = computeDynamicPrompts({
      persona: 'notebook',
      attachedSourceNames: ['bronze-sales', 'gold-customers'],
      defaultLang: 'pyspark',
    });
    expect(prompts.some((p) => p.prompt.includes('bronze-sales'))).toBe(true);
    expect(prompts.some((p) => p.prompt.includes('gold-customers'))).toBe(true);
  });

  it('notebook: SQL language yields a Spark SQL read prompt', () => {
    const prompts = computeDynamicPrompts({
      persona: 'notebook',
      attachedSourceNames: ['silver'],
      defaultLang: 'sparksql',
    });
    expect(prompts.some((p) => p.prompt.includes('Spark SQL'))).toBe(true);
  });

  it('warehouse: embeds real table names in chip prompt', () => {
    const prompts = computeDynamicPrompts({
      persona: 'warehouse',
      tableNames: ['gold.sales', 'gold.customers'],
      currentSqlSnippet: 'SELECT region FROM gold.sales',
    });
    expect(prompts.some((p) => p.prompt.includes('gold.sales'))).toBe(true);
    expect(prompts.some((p) => p.prompt.includes('SELECT TOP 10 * FROM gold.sales'))).toBe(true);
  });

  it('returns empty array with no context for non-dynamic personas', () => {
    expect(computeDynamicPrompts({ persona: 'pipeline' })).toHaveLength(0);
  });
});

describe('getPersonaPrompts', () => {
  it('caps at 6 chips', () => {
    const result = getPersonaPrompts({
      persona: 'notebook',
      attachedSourceNames: ['a', 'b', 'c'],
      defaultLang: 'pyspark',
    });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('dynamic prompts appear before static prompts', () => {
    const result = getPersonaPrompts({
      persona: 'warehouse',
      tableNames: ['dbo.orders'],
    });
    expect(result[0].id.startsWith('wh-dyn-')).toBe(true);
  });

  it('falls back to default persona prompts when no dynamic context', () => {
    const result = getPersonaPrompts({ persona: 'default' });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual(STATIC_PROMPTS.default.slice(0, result.length));
  });

  it('notebook with no context returns the static notebook prompts', () => {
    const result = getPersonaPrompts({ persona: 'notebook' });
    expect(result[0].id).toBe('nb-explain');
  });
});

describe('extractSqlTableNames', () => {
  it('extracts FROM and JOIN table names', () => {
    const sql = 'SELECT * FROM gold.sales s JOIN gold.customers c ON s.cid = c.id';
    expect(extractSqlTableNames(sql)).toEqual(
      expect.arrayContaining(['gold.sales', 'gold.customers']),
    );
  });

  it('handles bracketed and bare names', () => {
    expect(extractSqlTableNames('SELECT * FROM [dbo].[orders]')).toContain('dbo.orders');
    expect(extractSqlTableNames('SELECT * FROM sales WHERE 1=1')).toContain('sales');
  });

  it('dedupes and caps at 5 names', () => {
    const sql =
      'FROM a JOIN b JOIN c JOIN d JOIN e JOIN f JOIN g FROM a';
    const out = extractSqlTableNames(sql);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(new Set(out).size).toBe(out.length);
  });
});
