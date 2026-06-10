/**
 * Unit tests for the FTS + vector-index DDL builders in azure-sql-client.
 * These are the security-critical pieces: every identifier from the create
 * dialogs must be brace-quoted so no dialog value reaches the engine as raw
 * SQL. Pure functions — no TDS, no network.
 */
import { describe, it, expect, vi } from 'vitest';

// azure-sql-client imports `mssql` + `@azure/identity` at module top for its TDS
// query path. The DDL builders under test are pure — stub both so the import
// graph never loads the native tedious/identity stack.
vi.mock('mssql', () => ({ default: {}, ConnectionPool: class {} }));
vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'fake', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { ChainedTokenCredential: FakeCred, DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred };
});

import {
  quoteIdent,
  buildCreateVectorIndexSql,
  buildCreateFullTextCatalogSql,
  buildCreateFullTextIndexSql,
} from '../azure-sql-client';

describe('quoteIdent', () => {
  it('brace-quotes a simple identifier', () => {
    expect(quoteIdent('vec_idx')).toBe('[vec_idx]');
  });
  it('escapes an embedded ] by doubling it', () => {
    expect(quoteIdent('a]b')).toBe('[a]]b]');
  });
  it('rejects empty identifiers', () => {
    expect(() => quoteIdent('')).toThrow();
    expect(() => quoteIdent('   ')).toThrow();
  });
  it('neutralizes an injection attempt by brace-quoting (no raw SQL escapes)', () => {
    // The whole payload becomes a single delimited identifier — the ] is doubled
    // and nothing can break out of the brackets, so the DROP never executes.
    expect(quoteIdent('a]; DROP TABLE x; --')).toBe('[a]]; DROP TABLE x; --]');
  });
  it('rejects an embedded NUL', () => {
    expect(() => quoteIdent('a\0b')).toThrow();
  });
});

describe('buildCreateVectorIndexSql', () => {
  it('emits CREATE VECTOR INDEX with DiskANN + metric', () => {
    const sql = buildCreateVectorIndexSql({
      indexName: 'vec_idx', schema: 'dbo', table: 'Articles', column: 'embedding', metric: 'cosine',
    });
    expect(sql).toContain('CREATE VECTOR INDEX [vec_idx]');
    expect(sql).toContain('ON [dbo].[Articles] ([embedding])');
    expect(sql).toContain("METRIC = 'cosine'");
    expect(sql).toContain("TYPE = 'DiskANN'");
  });
  it('defaults schema to dbo and adds MAXDOP when provided', () => {
    const sql = buildCreateVectorIndexSql({
      indexName: 'v', table: 'T', column: 'c', metric: 'dot', maxdop: 8,
    });
    expect(sql).toContain('ON [dbo].[T] ([c])');
    expect(sql).toContain('MAXDOP = 8');
  });
  it('falls back to cosine for an unknown metric', () => {
    const sql = buildCreateVectorIndexSql({
      indexName: 'v', table: 'T', column: 'c', metric: 'bogus' as any,
    });
    expect(sql).toContain("METRIC = 'cosine'");
  });
});

describe('buildCreateFullTextCatalogSql', () => {
  it('emits CREATE FULLTEXT CATALOG', () => {
    expect(buildCreateFullTextCatalogSql({ catalogName: 'ft' })).toBe('CREATE FULLTEXT CATALOG [ft];');
  });
  it('appends AS DEFAULT when requested', () => {
    expect(buildCreateFullTextCatalogSql({ catalogName: 'ft', asDefault: true }))
      .toBe('CREATE FULLTEXT CATALOG [ft] AS DEFAULT;');
  });
});

describe('buildCreateFullTextIndexSql', () => {
  it('emits CREATE FULLTEXT INDEX with KEY INDEX + change tracking', () => {
    const sql = buildCreateFullTextIndexSql({
      schema: 'dbo', table: 'Docs', columns: [{ name: 'Title' }, { name: 'Body' }],
      keyIndexName: 'PK_Docs', catalogName: 'ft', changeTracking: 'AUTO',
    });
    expect(sql).toContain('CREATE FULLTEXT INDEX ON [dbo].[Docs] ([Title], [Body])');
    expect(sql).toContain('KEY INDEX [PK_Docs]');
    expect(sql).toContain('ON [ft]');
    expect(sql).toContain('CHANGE_TRACKING = AUTO');
  });
  it('passes integer LCID through and brace-quotes a named language', () => {
    const sql = buildCreateFullTextIndexSql({
      table: 'Docs', columns: [{ name: 'Body', language: '1033' }],
      keyIndexName: 'PK', changeTracking: 'MANUAL',
    });
    expect(sql).toContain('[Body] LANGUAGE 1033');
    expect(sql).toContain('CHANGE_TRACKING = MANUAL');
  });
  it('supports STOPLIST', () => {
    const sql = buildCreateFullTextIndexSql({
      table: 'T', columns: [{ name: 'c' }], keyIndexName: 'PK', stoplist: 'SYSTEM',
    });
    expect(sql).toContain('STOPLIST = SYSTEM');
  });
  it('throws when no columns are supplied', () => {
    expect(() => buildCreateFullTextIndexSql({ table: 'T', columns: [], keyIndexName: 'PK' })).toThrow();
  });
});
