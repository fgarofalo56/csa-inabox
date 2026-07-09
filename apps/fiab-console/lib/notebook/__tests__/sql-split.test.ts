import { describe, it, expect } from 'vitest';
import { splitSqlStatements, cellToStatements } from '../sql-split';

describe('splitSqlStatements', () => {
  it('splits multiple statements on semicolons', () => {
    const sql = 'CREATE DATABASE a;\nCREATE DATABASE b;\nCREATE DATABASE c;';
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE DATABASE a',
      'CREATE DATABASE b',
      'CREATE DATABASE c',
    ]);
  });

  it('returns one entry for a single statement without a trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('strips leading line comments and a comment-only trailing fragment', () => {
    const sql = `-- create the medallion databases
CREATE DATABASE IF NOT EXISTS realtime_bronze;
CREATE DATABASE IF NOT EXISTS realtime_silver;
-- least-privilege is enforced outside the engine
`;
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE DATABASE IF NOT EXISTS realtime_bronze',
      'CREATE DATABASE IF NOT EXISTS realtime_silver',
    ]);
  });

  it('does not split on a semicolon inside a string literal', () => {
    const sql = "INSERT INTO t VALUES ('a;b'); SELECT 'x;y'";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('a;b')",
      "SELECT 'x;y'",
    ]);
  });

  it('handles doubled-quote escapes inside literals', () => {
    const sql = "SELECT 'it''s; fine'; SELECT 2";
    expect(splitSqlStatements(sql)).toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
  });

  it('ignores semicolons in block comments', () => {
    const sql = 'SELECT 1 /* a; b; c */; SELECT 2';
    expect(splitSqlStatements(sql)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('respects backtick-quoted identifiers', () => {
    const sql = 'SELECT `a;b` FROM t; SELECT 2';
    expect(splitSqlStatements(sql)).toEqual(['SELECT `a;b` FROM t', 'SELECT 2']);
  });

  it('returns [] for comment-only source', () => {
    expect(splitSqlStatements('-- nothing here\n/* still nothing */')).toEqual([]);
  });
});

describe('cellToStatements', () => {
  it('splits sql cells', () => {
    expect(cellToStatements('CREATE DATABASE a; CREATE DATABASE b;', 'sql')).toEqual([
      { source: 'CREATE DATABASE a', lang: 'sql' },
      { source: 'CREATE DATABASE b', lang: 'sql' },
    ]);
  });

  it('keeps non-sql cells whole (python may contain semicolons legitimately)', () => {
    const py = 'x = 1; y = 2\nprint(x + y)';
    expect(cellToStatements(py, 'pyspark')).toEqual([{ source: py, lang: 'pyspark' }]);
  });

  it('drops an empty non-sql cell', () => {
    expect(cellToStatements('   \n', 'pyspark')).toEqual([]);
  });

  it('drops a comment-only sql cell', () => {
    expect(cellToStatements('-- just a note', 'sql')).toEqual([]);
  });
});
