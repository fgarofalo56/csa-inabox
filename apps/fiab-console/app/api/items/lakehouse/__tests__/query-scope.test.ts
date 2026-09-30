/**
 * The lakehouse SQL tab's item-scope classifier (`../_lib/query-scope.ts`) and
 * the lexer under it (`lib/sql/tsql-lexer.ts`).
 *
 * Every refusal case names the construct the classifier must report, and the
 * assertion compares it EXACTLY: a case passes only when the rule it is written
 * for is the one that refused it. A case refused by some other, earlier rule
 * names a different construct and fails, so removing a rule turns its own case
 * red even when another rule would still refuse the query.
 *
 * Every accept case states what would break it in its label.
 */
import { describe, it, expect } from 'vitest';
import { analyzeLakehouseQuery, confineQueryLocation, type ItemStorageLocation } from '../_lib/query-scope';
import { LAKEHOUSE_COLUMNS_SQL } from '@/lib/components/shared/entity-diagram-sources';
import { lexTsql } from '@/lib/sql/tsql-lexer';

const IN = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';
const OTHER_ACCOUNT = 'https://acct2.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';

const BOUND: ItemStorageLocation = {
  abfss: 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1',
  container: 'gold',
  root: 'lakehouses/sales-1',
};
const BOUND_GOV: ItemStorageLocation = {
  abfss: 'abfss://gold@acctg.dfs.core.usgovcloudapi.net/lakehouses/sales-1',
  container: 'gold',
  root: 'lakehouses/sales-1',
};

function analyze(sql: string, database = 'master') {
  return analyzeLakehouseQuery(sql, { database });
}

describe('analyzeLakehouseQuery — accepted queries', () => {
  const cases: Array<[string, string, string[]]> = [
    ['the entity-diagram column query (refusing two-part names or ORDER BY breaks it)', LAKEHOUSE_COLUMNS_SQL, []],
    ['a bare SELECT', 'SELECT 1', []],
    ['OPENROWSET over one literal URL (a BULK parser that drops the location breaks it)',
      `SELECT TOP 10 * FROM OPENROWSET(BULK '${IN}', FORMAT = 'DELTA') AS r`, [IN]],
    ['lower-case keywords and an N-string location (case-sensitive keywords or no N-prefix break it)',
      `select * from openrowset(bulk N'${IN}/*.parquet', format='PARQUET') as r`, [`${IN}/*.parquet`]],
    ['a list of locations (reading only the first breaks it)',
      `SELECT * FROM OPENROWSET(BULK ('${IN}/a.parquet', '${IN}/b.parquet'), FORMAT='PARQUET') AS r`,
      [`${IN}/a.parquet`, `${IN}/b.parquet`]],
    ['CSV options with TRUE and numbers (a narrower option list breaks it)',
      `SELECT * FROM OPENROWSET(BULK '${IN}/a.csv', FORMAT='CSV', PARSER_VERSION='2.0', HEADER_ROW=TRUE, FIRSTROW=2, FIELDTERMINATOR=',') AS r`,
      [`${IN}/a.csv`]],
    ['a WITH schema clause after OPENROWSET',
      `SELECT * FROM OPENROWSET(BULK '${IN}/a.json', FORMAT='CSV', FIELDQUOTE='0x0b') WITH (doc nvarchar(max)) AS r CROSS APPLY OPENJSON(doc) WITH (name varchar(50) '$.name') AS j`,
      [`${IN}/a.json`]],
    ['a CTE and a trailing semicolon', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x;', []],
    ['two SELECT statements separated by semicolons', 'SELECT 1; SELECT 2;;', []],
    ['a URL inside a line comment (a lexer that keeps comments breaks it)',
      `SELECT 1 -- ${OTHER_ACCOUNT}\n`, []],
    ['a URL and EXEC inside a block comment', `/* '${OTHER_ACCOUNT}' EXEC('x') */ SELECT 1`, []],
    ['EXEC inside a nested block comment (non-nesting comments break it)',
      "/* outer /* inner */ EXEC('x') */ SELECT 1", []],
    ['[OPENROWSET] and "EXEC" as identifiers (treating quoted identifiers as keywords breaks it)',
      'SELECT 1 AS [OPENROWSET], 2 AS "EXEC", [drop] FROM t', []],
    ['a bracketed identifier with a doubled ] (no ]] escape breaks it)', 'SELECT 1 AS [a]]b]', []],
    ['a string with doubled quotes around EXEC (no \'\' escape breaks it)', "SELECT 'a'' EXEC ''b'", []],
    ['a quoted identifier with a doubled " (no "" escape breaks it)', 'SELECT 1 AS "a""b"', []],
    ['OFFSET … FETCH NEXT … ROWS ONLY', 'SELECT a FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', []],
    ['a three-part name in the item database, any case', 'SELECT name FROM MASTER.sys.objects', []],
    ['a three-part name in a database the item declares', 'SELECT * FROM lakedb.dbo.orders', []],
  ];
  for (const [label, sql, locations] of cases) {
    it(`accepts ${label}`, () => {
      const database = sql.includes('lakedb') ? 'lakedb' : 'master';
      expect(analyze(sql, database)).toEqual({ ok: true, locations });
    });
  }
});

describe('analyzeLakehouseQuery — refused queries name the construct', () => {
  const cases: Array<[string, string, string]> = [
    // statement words
    ['EXEC as the first statement', "EXEC('SELECT 1')", 'a statement starting with EXEC'],
    ['EXEC after a SELECT without a semicolon', "SELECT 1 EXEC('x')", 'EXEC'],
    ['exec in mixed case', "SELECT 1 eXeC sp_who", 'eXeC'],
    ['sp_executesql', "SELECT 1 sp_executesql N'SELECT 1'", 'sp_executesql'],
    ['another sp_ procedure', 'SELECT 1 sp_who2', 'the system procedure sp_who2'],
    ['an xp_ procedure', 'SELECT 1 xp_dirtree', 'the system procedure xp_dirtree'],
    ['a stacked second statement', 'SELECT 1; DROP TABLE t', 'a statement starting with DROP'],
    ['a stacked second statement after empty ones', 'SELECT 1 ;; ENABLE TRIGGER t ON DATABASE', 'a statement starting with ENABLE'],
    ['a first statement that is not SELECT', 'ENABLE TRIGGER t ON DATABASE', 'a statement starting with ENABLE'],
    ['DDL after a SELECT', 'SELECT 1 CREATE CREDENTIAL c', 'CREATE'],
    ['CREATE EXTERNAL DATA SOURCE', "CREATE EXTERNAL DATA SOURCE d WITH (LOCATION = 'x')", 'a statement starting with CREATE'],
    ['SELECT … INTO', 'SELECT * INTO t2 FROM t', 'INTO'],
    ['USE of another database', 'USE otherdb', 'a statement starting with USE'],
    ['USE after a SELECT', 'SELECT 1 USE otherdb', 'USE'],
    ['a SET option', 'SELECT 1 SET NOCOUNT ON', 'SET'],
    ['WAITFOR', "SELECT 1 WAITFOR DELAY '00:00:10'", 'WAITFOR'],
    ['a cursor FETCH', 'SELECT 1 FETCH NEXT FROM c', 'FETCH'],
    ['BULK INSERT', "BULK INSERT t FROM 'x'", 'a statement starting with BULK'],
    // Each of the next two is the only case naming its word; the word removed from REFUSED_WORDS turns it red.
    ['EXECUTE after a SELECT', "SELECT 1 EXECUTE('x')", 'EXECUTE'],
    ['BULK after a SELECT', "SELECT 1 BULK INSERT t FROM 'x'", 'BULK'],
    // comment splitting and lexer boundaries
    ['OPEN/**/ROWSET split by a comment', `SELECT * FROM OPEN/**/ROWSET(BULK '${IN}') AS r`, 'OPEN'],
    ['EXEC after a line comment ended by a form feed', "SELECT 1 -- note\fEXEC('x')", 'EXEC'],
    // U+2028 ends the comment too, and is then refused itself as a non-ASCII character outside a string.
    ['text after a line comment ended by U+2028', "SELECT 1 -- note\u2028EXEC('x')", 'the text at character 17'],
    ['EXEC after a line comment ended by CR', "SELECT 1 -- note\rEXEC('x')", 'EXEC'],
    ['an unterminated block comment', 'SELECT 1 /* open', 'the text at character 10'],
    ['an unterminated string', "SELECT 'open", 'the text at character 8'],
    ['an ODBC escape', 'SELECT {fn user()}', 'the text at character 8'],
    ['a non-ASCII character outside a string', 'SELECT 1 AS naïve', 'the text at character 15'],
    ['an empty query', '-- nothing here', 'an empty query'],
    // OPENROWSET shapes
    ['a BULK location built with +', `SELECT * FROM OPENROWSET(BULK N'https://acct1' + N'.dfs.core.windows.net/gold/x', FORMAT='PARQUET') AS r`,
      "'+' inside OPENROWSET(BULK …)"],
    ['a BULK location from a variable', 'SELECT * FROM OPENROWSET(BULK @p, FORMAT=\'PARQUET\') AS r',
      'an OPENROWSET(BULK …) location that is not a literal string'],
    ['a BULK list with an expression', `SELECT * FROM OPENROWSET(BULK ('${IN}' + 'x'), FORMAT='PARQUET') AS r`,
      'an OPENROWSET(BULK …) location built from an expression'],
    ['DATA_SOURCE', `SELECT * FROM OPENROWSET(BULK 'Tables/orders', DATA_SOURCE = 'ds', FORMAT='DELTA') AS r`,
      'the OPENROWSET option DATA_SOURCE'],
    // Outside OPENROWSET the word itself is refused; a column of that name is written [DATA_SOURCE].
    ['DATA_SOURCE outside OPENROWSET', 'SELECT DATA_SOURCE FROM t', 'DATA_SOURCE'],
    // The first list entry is not a string: accepting it would carry a non-literal into the location list.
    ['a BULK list whose first location is not a literal', "SELECT * FROM OPENROWSET(BULK (x, 'y'), FORMAT='PARQUET') AS r",
      'an OPENROWSET(BULK …) location that is not a literal string'],
    ['ERRORFILE_LOCATION', `SELECT * FROM OPENROWSET(BULK '${IN}/a.csv', FORMAT='CSV', ERRORFILE_LOCATION = 'x') AS r`,
      'the OPENROWSET option ERRORFILE_LOCATION'],
    ['an option value that is a URL', `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='${OTHER_ACCOUNT}') AS r`,
      'the value of OPENROWSET option FORMAT'],
    ['OPENROWSET without BULK', "SELECT * FROM OPENROWSET('CosmosDB', 'Account=a', c) AS r", "OPENROWSET('CosmosDB' …)"],
    ['OPENDATASOURCE', "SELECT * FROM OPENDATASOURCE('p', 's').d.dbo.t", 'OPENDATASOURCE'],
    ['OPENQUERY', "SELECT * FROM OPENQUERY(srv, 'SELECT 1')", 'OPENQUERY'],
    ['OPENXML', 'SELECT * FROM OPENXML(1, 2)', 'OPENXML'],
    // names
    ['a three-part name in another database', 'SELECT * FROM otherdb.dbo.t', 'the three-part name otherdb.dbo.t'],
    ['a bracketed three-part name in another database', 'SELECT * FROM [otherdb].[dbo].[t]', 'the three-part name otherdb.dbo.t'],
    ['a three-part name with an empty schema', 'SELECT * FROM otherdb..t', 'the three-part name otherdb..t'],
    ['a four-part name', 'SELECT * FROM srv.master.dbo.t', 'the four-part name srv.master.dbo.t'],
    ['a global temporary table', 'SELECT * FROM ##shared', 'the global temporary table ##shared'],
    // variables, functions and locations outside BULK
    ['a system variable', 'SELECT @@VERSION', 'the variable @@VERSION'],
    ['a sys.fn_ function', 'SELECT * FROM sys.fn_dblog(NULL, NULL)', 'the system function fn_dblog'],
    ['the :: function syntax', "SELECT * FROM ::fn_trace_gettable('x', default)", 'the :: function syntax'],
    ['a URL in a plain string', `SELECT '${OTHER_ACCOUNT}' AS link`, `the storage location '${OTHER_ACCOUNT}'`],
    ['a URL in a quoted identifier', `SELECT 1 AS "${OTHER_ACCOUNT}"`, `the storage location "${OTHER_ACCOUNT}"`],
  ];
  for (const [label, sql, construct] of cases) {
    it(`refuses ${label}`, () => {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.construct).toBe(construct);
      expect(out.status).toBe(400);
      expect(out.code).toBe('query_construct_not_accepted');
      expect(out.error).toContain(`${construct} is not accepted`);
    });
  }

  it('the character offsets named above are where the text stops being readable', () => {
    // Lifted from the lexer, so the offsets in the table are measured, not guessed.
    const at = (sql: string) => { const r = lexTsql(sql); return r.ok ? -1 : r.pos + 1; };
    expect(at('SELECT 1 /* open')).toBe(10);
    expect(at("SELECT 'open")).toBe(8);
    expect(at('SELECT {fn user()}')).toBe(8);
    expect(at('SELECT 1 AS naïve')).toBe(15);
  });
});

describe('confineQueryLocation', () => {
  const accepted: Array<[string, string, ItemStorageLocation]> = [
    ['the dfs URL of a table under the root', IN, BOUND],
    ['the blob endpoint of the same account', 'https://acct1.blob.core.windows.net/gold/lakehouses/sales-1/Files/a.csv', BOUND],
    ['the abfss form with a trailing slash', 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1/Tables/orders/', BOUND],
    ['an upper-case host', 'https://ACCT1.DFS.CORE.WINDOWS.NET/gold/lakehouses/sales-1/Tables/orders', BOUND],
    ['a wildcard below the root', 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Files/**', BOUND],
    ['the Gov cloud suffix of a Gov binding', 'https://acctg.dfs.core.usgovcloudapi.net/gold/lakehouses/sales-1/Tables/t', BOUND_GOV],
  ];
  for (const [label, url, bound] of accepted) {
    it(`accepts ${label}`, () => {
      expect(confineQueryLocation(url, bound)).toEqual({ ok: true });
    });
  }

  const P = 'https://acct1.dfs.core.windows.net/gold/lakehouses';
  const refused: Array<[string, string, ItemStorageLocation, string]> = [
    ['another storage account', OTHER_ACCOUNT, BOUND, "not on this lakehouse's storage account"],
    ['another account in abfss form', 'abfss://gold@acct2.dfs.core.windows.net/lakehouses/sales-1/Tables/t', BOUND, "not on this lakehouse's storage account"],
    ['the blob host in abfss form', 'abfss://gold@acct1.blob.core.windows.net/lakehouses/sales-1/Tables/t', BOUND, "not on this lakehouse's storage account"],
    ['the Commercial suffix for a Gov binding', 'https://acctg.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t', BOUND_GOV, "not on this lakehouse's storage account"],
    ['a host with a port', 'https://acct1.dfs.core.windows.net:443/gold/lakehouses/sales-1/Tables/t', BOUND, "not on this lakehouse's storage account"],
    ['a host with user info', 'https://x@acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t', BOUND, "not on this lakehouse's storage account"],
    ['a host with an extra suffix', 'https://acct1.dfs.core.windows.net.example.org/gold/lakehouses/sales-1/Tables/t', BOUND, "not on this lakehouse's storage account"],
    ['plain http', 'http://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/t', BOUND, 'not a full https:// or abfss:// URL'],
    ['abfs without s', 'abfs://gold@acct1.dfs.core.windows.net/lakehouses/sales-1/Tables/t', BOUND, 'not a full https:// or abfss:// URL'],
    ['a relative path', 'lakehouses/sales-1/Tables/t', BOUND, 'not a full https:// or abfss:// URL'],
    ['another container', 'https://acct1.dfs.core.windows.net/silver/lakehouses/sales-1/Tables/t', BOUND, 'outside this lakehouse'],
    ['the container in another case', 'https://acct1.dfs.core.windows.net/Gold/lakehouses/sales-1/Tables/t', BOUND, 'outside this lakehouse'],
    ['a sibling root that shares a prefix', `${P}/sales-10/Tables/t`, BOUND, 'outside this lakehouse'],
    ['the root itself', `${P}/sales-1`, BOUND, 'outside this lakehouse'],
    ['the root itself with a trailing slash', `${P}/sales-1/`, BOUND, 'outside this lakehouse'],
    ['a wildcard in a root segment', `${P}/*/Tables/t`, BOUND, 'outside this lakehouse'],
    ['a wildcard container', 'https://acct1.dfs.core.windows.net/*/lakehouses/sales-1/Tables/t', BOUND, 'outside this lakehouse'],
    ['a .. segment', `${P}/sales-1/../sales-2/Tables/t`, BOUND, 'not a relative path inside the container'],
    ['a . segment', `${P}/sales-1/./Tables/t`, BOUND, 'not a relative path inside the container'],
    ['percent-encoded dots', `${P}/sales-1/%2e%2e/sales-2/Tables/t`, BOUND, 'percent-encoding'],
    ['a backslash', `${P}/sales-1\\..\\sales-2`, BOUND, 'percent-encoding, a backslash'],
    ['a query string', `${IN}?sv=1`, BOUND, 'a query string'],
    // Inside the root in every other respect, so only the non-ASCII check refuses it.
    ['a non-ASCII character under the root', `${P}/sales-1/Tables/café`, BOUND, 'a non-ASCII character'],
    ['a doubled slash', `${P}/sales-1//Tables/t`, BOUND, 'not written in its canonical form'],
  ];
  for (const [label, url, bound, reason] of refused) {
    it(`refuses ${label}`, () => {
      const out = confineQueryLocation(url, bound);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.status).toBe(403);
      expect(out.code).toBe('query_location_outside_root');
      expect(out.construct).toBe(url);
      expect(out.error).toContain(reason);
    });
  }
});

describe('lexTsql', () => {
  it('unescapes strings, N-strings and quoted identifiers', () => {
    const r = lexTsql(`SELECT N'it''s', [a]]b], "c""d" FROM t`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => [t.kind, t.value])).toEqual([
      ['word', 'SELECT'],
      ['string', "it's"],
      ['punct', ','],
      ['quoted-ident', 'a]b'],
      ['punct', ','],
      ['quoted-ident', 'c"d'],
      ['word', 'FROM'],
      ['word', 't'],
    ]);
  });
});
