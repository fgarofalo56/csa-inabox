import { describe, it, expect } from 'vitest';
import {
  TsqlBuildError,
  buildCreateFtCatalog,
  buildDropFtCatalog,
  buildCreateFtIndex,
  buildDropFtIndex,
  buildCreateVectorIndex,
  buildDropVectorIndex,
  buildSearchWizardSql,
} from '../sql-search-builders';

describe('buildCreateFtCatalog', () => {
  it('builds a plain catalog', () => {
    expect(buildCreateFtCatalog({ catalogName: 'ftCatalog' })).toBe('CREATE FULLTEXT CATALOG [ftCatalog];');
  });
  it('adds accent sensitivity + AS DEFAULT', () => {
    const sql = buildCreateFtCatalog({ catalogName: 'ftCat', accentSensitivity: 'OFF', asDefault: true });
    expect(sql).toContain('WITH ACCENT_SENSITIVITY = OFF');
    expect(sql).toContain('AS DEFAULT');
  });
  it('rejects an unsafe catalog name (injection-safe)', () => {
    expect(() => buildCreateFtCatalog({ catalogName: 'a; DROP TABLE x;--' })).toThrow(TsqlBuildError);
  });
});

describe('buildDropFtCatalog', () => {
  it('drops a catalog', () => {
    expect(buildDropFtCatalog('ftCatalog')).toBe('DROP FULLTEXT CATALOG [ftCatalog];');
  });
});

describe('buildCreateFtIndex', () => {
  it('builds an index with columns, language, KEY INDEX, catalog, change tracking', () => {
    const sql = buildCreateFtIndex({
      schema: 'dbo', tableName: 'Documents',
      columns: [{ column: 'Body', languageLcid: 1033 }, { column: 'Title' }],
      keyIndex: 'PK_Documents', catalogName: 'ftCatalog', changeTracking: 'AUTO',
    });
    expect(sql).toContain('CREATE FULLTEXT INDEX ON [dbo].[Documents]');
    expect(sql).toContain('[Body] LANGUAGE 1033');
    expect(sql).toContain('[Title]');
    expect(sql).toContain('KEY INDEX [PK_Documents] ON [ftCatalog]');
    expect(sql).toContain('WITH CHANGE_TRACKING AUTO;');
  });
  it('omits LANGUAGE when neutral (0)', () => {
    const sql = buildCreateFtIndex({
      schema: 'dbo', tableName: 'T', columns: [{ column: 'C', languageLcid: 0 }],
      keyIndex: 'PK', catalogName: 'cat',
    });
    expect(sql).not.toContain('LANGUAGE');
  });
  it('supports TYPE COLUMN for binary docs', () => {
    const sql = buildCreateFtIndex({
      schema: 'dbo', tableName: 'Files', columns: [{ column: 'Blob', typeColumn: 'Ext' }],
      keyIndex: 'PK', catalogName: 'cat',
    });
    expect(sql).toContain('[Blob] TYPE COLUMN [Ext]');
  });
  it('requires at least one column', () => {
    expect(() => buildCreateFtIndex({ schema: 'dbo', tableName: 'T', columns: [], keyIndex: 'PK', catalogName: 'cat' }))
      .toThrow(TsqlBuildError);
  });
  it('rejects an out-of-range LCID', () => {
    expect(() => buildCreateFtIndex({
      schema: 'dbo', tableName: 'T', columns: [{ column: 'C', languageLcid: 999999 }],
      keyIndex: 'PK', catalogName: 'cat',
    })).toThrow(TsqlBuildError);
  });
});

describe('buildDropFtIndex', () => {
  it('drops the FT index on a table', () => {
    expect(buildDropFtIndex('dbo', 'Documents')).toBe('DROP FULLTEXT INDEX ON [dbo].[Documents];');
  });
});

describe('buildCreateVectorIndex', () => {
  it('builds a DiskANN cosine index', () => {
    const sql = buildCreateVectorIndex({
      indexName: 'vec_idx', schema: 'dbo', tableName: 'Articles', vectorColumn: 'embedding', metric: 'cosine',
    });
    expect(sql).toContain('CREATE VECTOR INDEX [vec_idx]');
    expect(sql).toContain('ON [dbo].[Articles] ([embedding])');
    expect(sql).toContain("METRIC = N'cosine'");
    expect(sql).toContain("TYPE = N'DiskANN'");
    expect(sql).not.toContain('MAXDOP');
  });
  it('adds MAXDOP when non-zero', () => {
    const sql = buildCreateVectorIndex({
      indexName: 'vi', schema: 'dbo', tableName: 'T', vectorColumn: 'v', metric: 'dot', maxdop: 4,
    });
    expect(sql).toContain('MAXDOP = 4');
  });
  it('rejects an unsafe index name', () => {
    expect(() => buildCreateVectorIndex({
      indexName: '1; DROP', schema: 'dbo', tableName: 'T', vectorColumn: 'v', metric: 'cosine',
    })).toThrow(TsqlBuildError);
  });
  it('rejects MAXDOP out of range', () => {
    expect(() => buildCreateVectorIndex({
      indexName: 'vi', schema: 'dbo', tableName: 'T', vectorColumn: 'v', metric: 'cosine', maxdop: 999,
    })).toThrow(TsqlBuildError);
  });
});

describe('buildDropVectorIndex', () => {
  it('drops via DROP INDEX ... ON object', () => {
    expect(buildDropVectorIndex('vec_idx', 'dbo', 'Articles')).toBe('DROP INDEX [vec_idx] ON [dbo].[Articles];');
  });
});

describe('buildSearchWizardSql dispatch', () => {
  it('routes each wizard kind', () => {
    expect(buildSearchWizardSql('ft-catalog', { catalogName: 'c' })).toContain('CREATE FULLTEXT CATALOG');
    expect(buildSearchWizardSql('ft-catalog-drop', { catalogName: 'c' })).toContain('DROP FULLTEXT CATALOG');
    expect(buildSearchWizardSql('ft-index-drop', { schema: 'dbo', tableName: 't' })).toContain('DROP FULLTEXT INDEX');
    expect(buildSearchWizardSql('vector-index', { indexName: 'v', schema: 'dbo', tableName: 't', vectorColumn: 'e', metric: 'cosine' })).toContain('CREATE VECTOR INDEX');
    expect(buildSearchWizardSql('vector-index-drop', { indexName: 'v', schema: 'dbo', tableName: 't' })).toContain('DROP INDEX');
  });
  it('throws on an unknown wizard', () => {
    expect(() => buildSearchWizardSql('nope' as any, {})).toThrow(TsqlBuildError);
  });
});
