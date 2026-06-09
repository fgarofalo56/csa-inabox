import { describe, it, expect } from 'vitest';
import {
  CREATE_TEMPLATES,
  SQL_SNIPPETS,
  chooseRunText,
  shouldOfferSnippets,
  parseDottedReference,
} from '@/lib/azure/sql-templates';

describe('CREATE_TEMPLATES', () => {
  it('covers all five Fabric query-editor templates', () => {
    expect(Object.keys(CREATE_TEMPLATES).sort()).toEqual(
      ['function', 'index', 'procedure', 'table', 'view'],
    );
  });

  it('produces real, runnable DDL per template', () => {
    expect(CREATE_TEMPLATES.table).toContain('CREATE TABLE');
    expect(CREATE_TEMPLATES.view).toContain('CREATE VIEW');
    expect(CREATE_TEMPLATES.procedure).toContain('CREATE PROCEDURE');
    expect(CREATE_TEMPLATES.function).toContain('CREATE FUNCTION');
    expect(CREATE_TEMPLATES.index).toContain('CREATE INDEX');
  });
});

describe('SQL_SNIPPETS', () => {
  it('every snippet label starts with the `sql` trigger prefix', () => {
    expect(SQL_SNIPPETS.length).toBeGreaterThanOrEqual(10);
    for (const sn of SQL_SNIPPETS) {
      expect(sn.label.toLowerCase().startsWith('sql')).toBe(true);
      expect(sn.body.trim().length).toBeGreaterThan(0);
      expect(sn.documentation.length).toBeGreaterThan(0);
    }
  });

  it('exposes CREATE snippets that reuse the template bodies', () => {
    const create = SQL_SNIPPETS.find((s) => s.label === 'sqlCreateTable');
    expect(create?.body).toBe(CREATE_TEMPLATES.table);
  });
});

describe('shouldOfferSnippets', () => {
  it('offers snippets only once `sql` is typed (case-insensitive)', () => {
    expect(shouldOfferSnippets('sql')).toBe(true);
    expect(shouldOfferSnippets('SQL')).toBe(true);
    expect(shouldOfferSnippets('sqlSel')).toBe(true);
    expect(shouldOfferSnippets('sel')).toBe(false);
    expect(shouldOfferSnippets('')).toBe(false);
    expect(shouldOfferSnippets(null)).toBe(false);
  });
});

describe('chooseRunText (run-selection behavior)', () => {
  const full = 'SELECT 1;\nSELECT 2;\nSELECT 3;';

  it('runs the highlighted selection when present', () => {
    expect(chooseRunText(full, 'SELECT 2;')).toBe('SELECT 2;');
  });

  it('runs the whole script when nothing is highlighted', () => {
    expect(chooseRunText(full, '')).toBe(full);
    expect(chooseRunText(full, '   \n  ')).toBe(full);
    expect(chooseRunText(full, null)).toBe(full);
    expect(chooseRunText(full, undefined)).toBe(full);
  });

  it('trims surrounding whitespace from a real selection', () => {
    expect(chooseRunText(full, '  SELECT 2;  ')).toBe('SELECT 2;');
  });
});

describe('parseDottedReference (column IntelliSense)', () => {
  it('parses schema.table. for column suggestions', () => {
    expect(parseDottedReference('SELECT * FROM dbo.Customers.')).toEqual({
      schema: 'dbo', table: 'Customers', partial: '',
    });
  });

  it('parses bracketed names with a partial column prefix', () => {
    expect(parseDottedReference('SELECT * FROM [dbo].[Customers].Em')).toEqual({
      schema: 'dbo', table: 'Customers', partial: 'Em',
    });
  });

  it('returns null when there is no trailing dotted reference', () => {
    expect(parseDottedReference('SELECT Email FROM dbo.Customers')).toBeNull();
    expect(parseDottedReference('SELECT * FROM dbo.')).toBeNull();
    expect(parseDottedReference('')).toBeNull();
  });
});
