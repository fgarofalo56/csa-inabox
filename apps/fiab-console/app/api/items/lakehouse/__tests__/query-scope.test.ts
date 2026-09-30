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
import {
  analyzeLakehouseQuery, confineQueryLocation, REFUSED_WORD_NAMES, type ItemStorageLocation,
} from '../_lib/query-scope';
import { LAKEHOUSE_COLUMNS_SQL } from '@/lib/components/shared/entity-diagram-sources';
import { lexTsql } from '@/lib/sql/tsql-lexer';

const IN = 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';
const OTHER_ACCOUNT = 'https://acct2.dfs.core.windows.net/gold/lakehouses/sales-1/Tables/orders';
const NL = '\n';
const BS = '\\';

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

/** The refusal sentence starts with the construct, upper-cased. */
const asSentence = (construct: string) => construct.charAt(0).toUpperCase() + construct.slice(1);

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
    ['a three-part INFORMATION_SCHEMA name in the query database, any case (a case-sensitive database compare breaks it)',
      'SELECT TABLE_NAME FROM MASTER.INFORMATION_SCHEMA.TABLES', []],
    ['INFORMATION_SCHEMA.COLUMNS (refusing INFORMATION_SCHEMA with the sys schema breaks it)',
      'SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS', []],
    ['a three-part name in a database the caller passes', 'SELECT * FROM lakedb.dbo.orders', []],
    // Refused words as a later part of a dotted name: removing the dotted-name exception breaks these.
    ['refused words as qualified column names (the dotted-name exception removed breaks it)',
      'SELECT t.Open, t.Close, t.Begin, t.credential FROM t', []],
    ['DATA_SOURCE as a qualified column of an OPENROWSET row',
      `SELECT r.data_source FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r`, [IN]],
    ['an sp_-prefixed qualified column (the sp_ rule applied to later parts breaks it)', 'SELECT t.sp_rating FROM t', []],
    // Strings outside BULK are literals unless storage-shaped.
    ['an https:// filter in a WHERE clause (a location check on every :// breaks it)',
      `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='DELTA') AS r WHERE r.referrer LIKE 'https://www.bing.com%'`, [IN]],
    ['ESCAPECHAR of two backslashes (a UNC check on a two-character value breaks it)',
      `SELECT * FROM OPENROWSET(BULK '${IN}/a.csv', FORMAT='CSV', PARSER_VERSION='2.0', ESCAPECHAR = '${BS}${BS}') AS r`, [`${IN}/a.csv`]],
    ['a negative MAXERRORS (lexing -1 as two tokens without the minus rule breaks it)',
      `SELECT * FROM OPENROWSET(BULK '${IN}/a.csv', FORMAT='CSV', MAXERRORS = -1) AS r`, [`${IN}/a.csv`]],
    // Name parts compared as the server compares them.
    ['bracketed names with a space between words (refusing every space in a name part breaks it)',
      'SELECT [Order Details].[Unit Price] FROM [Order Details]', []],
    ['the query database with a trailing space (comparing the raw part breaks it)',
      'SELECT * FROM [master ].dbo.orders', []],
    ['a bracketed fn_-prefixed column that is not called (refusing every bracketed fn_ name breaks it)',
      'SELECT [fn_total], t.[fn_total] FROM t', []],
  ];
  for (const [label, sql, locations] of cases) {
    it(`accepts ${label}`, () => {
      const database = sql.includes('lakedb') ? 'lakedb' : 'master';
      expect(analyze(sql, database)).toEqual({ ok: true, locations });
    });
  }
});

describe('analyzeLakehouseQuery — every refused word, written out', () => {
  // A LITERAL list, not a loop over the classifier's map: removing a word from
  // REFUSED_WORDS turns exactly its row red. The completeness check below only
  // makes sure a word ADDED to the map also gets a row.
  const WORDS = [
    'EXEC', 'EXECUTE', 'SP_EXECUTESQL',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'EXTERNAL', 'CREDENTIAL', 'ENABLE', 'DISABLE', 'ADD', 'RENAME',
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'WRITETEXT', 'UPDATETEXT', 'READTEXT',
    'GRANT', 'REVOKE', 'DENY', 'SETUSER', 'REVERT',
    'USE', 'DECLARE', 'SET',
    'OPENDATASOURCE', 'OPENQUERY', 'OPENXML', 'BULK', 'DATA_SOURCE',
    'DBCC', 'BACKUP', 'RESTORE', 'KILL', 'SHUTDOWN', 'RECONFIGURE', 'CHECKPOINT', 'DISK', 'EXPLAIN',
    'WAITFOR', 'RAISERROR', 'THROW', 'PRINT', 'IF', 'WHILE', 'BEGIN', 'BREAK', 'CONTINUE', 'GOTO', 'RETURN',
    'COMMIT', 'ROLLBACK', 'SAVE', 'TRAN', 'TRANSACTION',
    'OPEN', 'CLOSE', 'DEALLOCATE',
    'SEND', 'RECEIVE', 'CONVERSATION',
  ];
  for (const word of WORDS) {
    it(`refuses ${word} after a SELECT, naming it and the bracket form`, () => {
      const out = analyze(`SELECT 1 ${word} x`);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.construct).toBe(word);
      expect(out.status).toBe(400);
      expect(out.error).toContain(`${word} is not accepted`);
      expect(out.remediation).toContain(`[${word}]`);
    });
  }
  it('every word in the classifier has a row above', () => {
    expect([...REFUSED_WORD_NAMES].sort()).toEqual([...WORDS].sort());
  });
});

describe('analyzeLakehouseQuery — refused queries name the construct', () => {
  const cases: Array<[string, string, string]> = [
    // statement words
    ['EXEC as the first statement', "EXEC('SELECT 1')", 'a statement starting with EXEC'],
    ['EXEC after a SELECT without a semicolon', "SELECT 1 EXEC('x')", 'EXEC'],
    ['exec in mixed case', "SELECT 1 eXeC sp_who", 'eXeC'],
    ['another sp_ procedure', 'SELECT 1 sp_who2', 'the system procedure sp_who2'],
    ['an xp_ procedure', 'SELECT 1 xp_dirtree', 'the system procedure xp_dirtree'],
    ['an unqualified sp_-prefixed name', 'SELECT sp_rating FROM t', 'the system procedure sp_rating'],
    ['a stacked second statement', 'SELECT 1; DROP TABLE t', 'a statement starting with DROP'],
    ['a stacked second statement after empty ones', 'SELECT 1 ;; ENABLE TRIGGER t ON DATABASE', 'a statement starting with ENABLE'],
    ['a first statement that is not SELECT', 'ENABLE TRIGGER t ON DATABASE', 'a statement starting with ENABLE'],
    ['DISABLE TRIGGER after a SELECT without a semicolon', 'SELECT 1 DISABLE TRIGGER t ON DATABASE', 'DISABLE'],
    ['CREATE EXTERNAL DATA SOURCE', "CREATE EXTERNAL DATA SOURCE d WITH (LOCATION = 'x')", 'a statement starting with CREATE'],
    ['SELECT … INTO', 'SELECT * INTO t2 FROM t', 'INTO'],
    ['USE of another database', 'USE otherdb', 'a statement starting with USE'],
    ['a cursor FETCH', 'SELECT 1 FETCH NEXT FROM c', 'FETCH'],
    ['BULK INSERT', "BULK INSERT t FROM 'x'", 'a statement starting with BULK'],
    ['unqualified column names that are cursor words', 'SELECT Open, Close FROM t', 'Open'],
    // Dotted names keep these refused: they run text or name an external source.
    ['EXEC as a later part of a dotted name', "SELECT t.EXEC('x')", 'EXEC'],
    ['OPENQUERY as a later part of a dotted name', "SELECT * FROM x.OPENQUERY(srv, 'SELECT 1')", 'OPENQUERY'],
    // `1.` is one number token, so the word after it is not a later name part.
    ['EXEC straight after a number and a dot', "SELECT 1.EXEC('x')", 'EXEC'],
    // A dot after `)` does not make a dotted name: the exception needs a name before the dot.
    ['DROP after a parenthesis and a dot', 'SELECT (x).DROP', 'DROP'],
    // comment splitting and lexer boundaries
    ['OPEN/**/ROWSET split by a comment', `SELECT * FROM OPEN/**/ROWSET(BULK '${IN}') AS r`, 'OPEN'],
    ['EXEC after a line comment ended by a form feed', "SELECT 1 -- note\fEXEC('x')", 'EXEC'],
    // U+2028 ends the comment too, and is then refused itself as a non-ASCII character outside a string.
    ['text after a line comment ended by U+2028', "SELECT 1 -- note\u2028EXEC('x')", 'the text at character 17'],
    ['EXEC after a line comment ended by CR', "SELECT 1 -- note\rEXEC('x')", 'EXEC'],
    ['an unterminated block comment', 'SELECT 1 /* open', 'the text at character 10'],
    ['an unterminated string', "SELECT 'open", 'the text at character 8'],
    ['an unterminated N-string', "SELECT N'open", 'the text at character 8'],
    ['an unterminated bracketed identifier', 'SELECT 1 AS [open', 'the text at character 13'],
    ['an unterminated quoted identifier', 'SELECT 1 AS "open', 'the text at character 13'],
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
    ['a BULK list whose first location is not a literal', "SELECT * FROM OPENROWSET(BULK (x, 'y'), FORMAT='PARQUET') AS r",
      'an OPENROWSET(BULK …) location that is not a literal string'],
    ['ERRORFILE_LOCATION', `SELECT * FROM OPENROWSET(BULK '${IN}/a.csv', FORMAT='CSV', ERRORFILE_LOCATION = 'x') AS r`,
      'the OPENROWSET option ERRORFILE_LOCATION'],
    ['an option value that is a URL', `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='https://example.org/x') AS r`,
      'the value of OPENROWSET option FORMAT'],
    ['an option value that is a UNC path', `SELECT * FROM OPENROWSET(BULK '${IN}', FORMAT='${BS}${BS}srv${BS}share') AS r`,
      'the value of OPENROWSET option FORMAT'],
    ['OPENROWSET without BULK', "SELECT * FROM OPENROWSET('CosmosDB', 'Account=a', c) AS r", "OPENROWSET('CosmosDB' …)"],
    ['OPENROWSET without an argument list', 'SELECT * FROM OPENROWSET', 'OPENROWSET without an argument list'],
    ['OPENDATASOURCE', "SELECT * FROM OPENDATASOURCE('p', 's').d.dbo.t", 'OPENDATASOURCE'],
    // names
    ['a three-part name in another database', 'SELECT * FROM otherdb.dbo.t', 'the three-part name otherdb.dbo.t'],
    ['a bracketed three-part name in another database', 'SELECT * FROM [otherdb].[dbo].[t]', 'the three-part name otherdb.dbo.t'],
    ['a three-part name with an empty schema', 'SELECT * FROM otherdb..t', 'the three-part name otherdb..t'],
    ['a three-part column reference', 'SELECT dbo.t.col FROM dbo.t', 'the three-part name dbo.t.col'],
    ['a four-part name', 'SELECT * FROM srv.master.dbo.t', 'the four-part name srv.master.dbo.t'],
    ['a global temporary table', 'SELECT * FROM ##shared', 'the global temporary table ##shared'],
    // `##` in a later name part: accepted if only the first part were checked.
    ['a global temporary table after a schema', 'SELECT * FROM dbo.[##shared]', 'the global temporary table dbo.##shared'],
    // Read as a three-part name if only the first part were checked.
    ['a global temporary table in tempdb', 'SELECT * FROM tempdb..##shared', 'the global temporary table tempdb..##shared'],
    // the sys catalog
    ['a dm_ view', 'SELECT TOP 50 * FROM sys.dm_exec_requests_history ORDER BY start_time DESC',
      'the sys schema object sys.dm_exec_requests_history'],
    ['a dm_ view joined to a dm_ function', 'SELECT t.text FROM sys.dm_exec_requests AS q CROSS APPLY sys.dm_exec_sql_text(q.sql_handle) AS t',
      'the sys schema object sys.dm_exec_requests'],
    ['sys.databases', 'SELECT name FROM sys.databases', 'the sys schema object sys.databases'],
    ['an upper-case SYS schema', 'SELECT name FROM SYS.databases', 'the sys schema object SYS.databases'],
    ['sys.external_data_sources', 'SELECT name, location FROM sys.external_data_sources', 'the sys schema object sys.external_data_sources'],
    ['sys.objects in the query database', 'SELECT name FROM MASTER.sys.objects', 'the sys schema object MASTER.sys.objects'],
    ['a bracketed sys schema', 'SELECT * FROM [sys].[tables]', 'the sys schema object sys.tables'],
    ['a sys.fn_ function', 'SELECT * FROM sys.fn_dblog(NULL, NULL)', 'the sys schema object sys.fn_dblog'],
    ['an unqualified fn_ function', 'SELECT * FROM fn_dblog(NULL, NULL)', 'the system function fn_dblog'],
    ['a compatibility view without a schema', 'SELECT * FROM sysprocesses', 'the system compatibility view sysprocesses'],
    ['a compatibility view with an empty schema', 'SELECT * FROM master..sysobjects', 'the system compatibility view sysobjects'],
    // Trailing spaces in a name part are ignored by the server, so they are removed before every comparison.
    ['a bracketed sys schema with a trailing space', 'SELECT * FROM [sys ].[dm_exec_requests]', 'the sys schema object sys.dm_exec_requests'],
    ['a quoted sys schema with a trailing space', 'SELECT * FROM "sys ".x', 'the sys schema object sys.x'],
    ['a compatibility view with a trailing space', 'SELECT * FROM [sysprocesses ]', 'the system compatibility view sysprocesses'],
    ['a three-part sys name with a trailing space', 'SELECT * FROM master.[sys ].objects', 'the sys schema object master.sys.objects'],
    ['a global temporary table in brackets with a trailing space', 'SELECT * FROM [##shared ]', 'the global temporary table ##shared'],
    ['a bracketed fn_ function called', 'SELECT * FROM [fn_dblog](NULL, NULL)', 'the system function fn_dblog'],
    ['a bracketed fn_ function with an empty schema', 'SELECT * FROM master..[fn_dblog ](NULL, NULL)', 'the system function fn_dblog'],
    // Any other whitespace or control character in a name part is refused, shown escaped.
    ['a name part with a non-breaking space', 'SELECT * FROM [sys\u00a0].x', 'the name part [sys\\u{a0}]'],
    ['a name part with a tab', 'SELECT * FROM [sys\t].x', 'the name part [sys\\u{9}]'],
    ['a name part with a zero-width space', 'SELECT * FROM [sy\u200bs].x', 'the name part [sy\\u{200b}s]'],
    ['a name part with a leading space', 'SELECT * FROM [ sys].x', 'the name part [ sys]'],
    ['a name part of spaces only', 'SELECT * FROM [  ].x', 'the name part [  ]'],
    // variables, functions and storage-shaped strings outside BULK
    ['a system variable', 'SELECT @@VERSION', 'the variable @@VERSION'],
    ['the :: function syntax', "SELECT * FROM ::fn_trace_gettable('x', default)", 'the :: function syntax'],
    ['a dfs URL in a plain string', `SELECT '${OTHER_ACCOUNT}' AS link`, `the storage location '${OTHER_ACCOUNT}'`],
    ['a blob host in a plain string', "SELECT 'https://acct2.blob.core.windows.net/c/p' AS link", "the storage location 'https://acct2.blob.core.windows.net/c/p'"],
    ['an abfss URL in a plain string', "SELECT 'abfss://c@acct2.dfs.core.windows.net/p' AS link", "the storage location 'abfss://c@acct2.dfs.core.windows.net/p'"],
    // No storage host in it, so only the scheme rule refuses it.
    ['a wasbs URL with no storage host', "SELECT 'wasbs://c@acct2/p' AS link", "the storage location 'wasbs://c@acct2/p'"],
    ['a UNC path in a plain string', `SELECT '${BS}${BS}srv${BS}share' AS p`, `the storage location '${BS}${BS}srv${BS}share'`],
    ['an abfss scheme split by a line continuation', `SELECT 'abfss:/${BS}${NL}/c@acct2/p' AS s`, `the storage location 'abfss:/${BS}${NL}/c@acct2/p'`],
    ['a dfs URL in a quoted identifier', `SELECT 1 AS "${OTHER_ACCOUNT}"`, `the storage location "${OTHER_ACCOUNT}"`],
  ];
  for (const [label, sql, construct] of cases) {
    it(`refuses ${label}`, () => {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.construct).toBe(construct);
      expect(out.status).toBe(400);
      expect(out.code).toBe('query_construct_not_accepted');
      expect(out.error).toContain(`${asSentence(construct)} is not accepted`);
    });
  }

  it('the character offsets named above are where the text stops being readable', () => {
    // Lifted from the lexer, so the offsets in the table are measured, not guessed.
    const at = (sql: string) => { const r = lexTsql(sql); return r.ok ? -1 : r.pos + 1; };
    expect(at('SELECT 1 /* open')).toBe(10);
    expect(at("SELECT 'open")).toBe(8);
    expect(at("SELECT N'open")).toBe(8);
    expect(at('SELECT 1 AS [open')).toBe(13);
    expect(at('SELECT 1 AS "open')).toBe(13);
    expect(at('SELECT {fn user()}')).toBe(8);
    expect(at('SELECT 1 AS naïve')).toBe(15);
  });

  it('a refusal reads as a sentence: the construct is capitalised after the lead', () => {
    // Breaks if `refuse()` stops upper-casing the first character.
    const out = analyze("EXEC('SELECT 1')");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("own files. A statement starting with EXEC is not accepted");
  });

  it('an unqualified column named like a refused word says how to write it', () => {
    const out = analyze('SELECT Open, Close FROM t');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.remediation).toContain('[Open]');
    expect(out.remediation).toContain('t.Open');
    // And the bracketed form it names is accepted.
    expect(analyze('SELECT [Open], [Close] FROM t')).toEqual({ ok: true, locations: [] });
  });

  it('a word refused in every position is offered only the bracketed form', () => {
    // Breaks if the hint offers t.EXEC / t.fn_x, which are themselves refused.
    for (const [sql, word] of [["SELECT 1 EXEC('x')", 'EXEC'], ['SELECT fn_dblog(NULL, NULL)', 'fn_dblog']]) {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.remediation).toContain(`[${word}]`);
      expect(out.remediation).not.toContain(`t.${word}`);
      expect(analyze(`SELECT t.${word} FROM t`).ok).toBe(false);
    }
  });

  it('a three-part column reference is told to use table.column, not that dbo is a database', () => {
    const out = analyze('SELECT dbo.t.col FROM dbo.t');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain('must start with the database this query runs in (master)');
    expect(out.remediation).toContain('t.col');
  });

  it('a sys catalog refusal points at INFORMATION_SCHEMA', () => {
    const out = analyze('SELECT name FROM sys.tables');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.remediation).toContain('INFORMATION_SCHEMA.TABLES');
  });
});

describe('confineQueryLocation', () => {
  const P = 'https://acct1.dfs.core.windows.net/gold/lakehouses';
  const accepted: Array<[string, string, ItemStorageLocation]> = [
    ['the dfs URL of a table under the root', IN, BOUND],
    ['the blob endpoint of the same account', 'https://acct1.blob.core.windows.net/gold/lakehouses/sales-1/Files/a.csv', BOUND],
    ['the abfss form with a trailing slash', 'abfss://gold@acct1.dfs.core.windows.net/lakehouses/sales-1/Tables/orders/', BOUND],
    ['an upper-case host', 'https://ACCT1.DFS.CORE.WINDOWS.NET/gold/lakehouses/sales-1/Tables/orders', BOUND],
    ['a wildcard below the root', 'https://acct1.dfs.core.windows.net/gold/lakehouses/sales-1/Files/**', BOUND],
    ['the Gov cloud suffix of a Gov binding', 'https://acctg.dfs.core.usgovcloudapi.net/gold/lakehouses/sales-1/Tables/t', BOUND_GOV],
    // File names: refusing every space or non-ASCII character breaks these.
    ['a file name with a space', `${P}/sales-1/Files/Q1 report.csv`, BOUND],
    ['a file name with a non-ASCII letter', `${P}/sales-1/Files/café.csv`, BOUND],
    ['a percent-encoded space', `${P}/sales-1/Files/Q1%20report.csv`, BOUND],
    ['a percent-encoded non-ASCII letter', `${P}/sales-1/Files/caf%C3%A9.csv`, BOUND],
  ];
  for (const [label, url, bound] of accepted) {
    it(`accepts ${label}`, () => {
      expect(confineQueryLocation(url, bound)).toEqual({ ok: true });
    });
  }

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
    ['a root segment written with an escape', `${P}/sales%2D1/Tables/t`, BOUND, 'a percent-escape for a character other than'],
    ['a space in a root segment', `${P}/sales 1/Tables/t`, BOUND, 'outside this lakehouse'],
    ['a .. segment', `${P}/sales-1/../sales-2/Tables/t`, BOUND, 'not a relative path inside the container'],
    ['a . segment', `${P}/sales-1/./Tables/t`, BOUND, 'not a relative path inside the container'],
    ['percent-encoded dots', `${P}/sales-1/%2e%2e/sales-2/Tables/t`, BOUND, 'a percent-escape for a character other than'],
    ['an overlong UTF-8 dot', `${P}/sales-1/%C0%AE%C0%AE/sales-2/Tables/t`, BOUND, 'not valid UTF-8'],
    ['a bare %', `${P}/sales-1/Files/100%`, BOUND, 'a % that is not a percent-escape'],
    ['a backslash', `${P}/sales-1\\..\\sales-2`, BOUND, 'a backslash, a query string or a fragment'],
    ['a query string', `${IN}?sv=1`, BOUND, 'a query string'],
    ['a full-width dot', `${P}/sales-1/．．/sales-2/t`, BOUND, 'punctuation outside ASCII'],
    ['a tab', `${P}/sales-1/Files/a\tb.csv`, BOUND, 'a control character'],
    ['a segment that ends with a space', `${P}/sales-1/Files /a.csv`, BOUND, 'starts or ends with a space'],
    ['a segment that is dots and a space', `${P}/sales-1/.. /sales-2/t`, BOUND, 'starts or ends with a space'],
    ['a segment that ends with a dot', `${P}/sales-1/Files./a.csv`, BOUND, 'ends with a dot'],
    ['an encoded space that ends a segment', `${P}/sales-1/..%20/sales-2/t`, BOUND, 'starts or ends with a space'],
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

  it('lexes 1. as one number, so a word after it is not a dotted-name part', () => {
    const r = lexTsql('SELECT 1.EXEC');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tokens.map((t) => [t.kind, t.text])).toEqual([['word', 'SELECT'], ['number', '1.'], ['word', 'EXEC']]);
  });
});
