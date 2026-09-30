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
  analyzeLakehouseQuery, confineQueryLocation, spellsName, REFUSED_WORD_NAMES, type ItemStorageLocation,
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

/** A name with every printable ASCII character written as its fullwidth form (U+FF01-U+FF5E). */
const fullwidth = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

/*
 * Every entry of the two Microsoft Learn pages, written out by hand from the pages, NOT derived from
 * the classifier: a function the classifier does not list has a row here that fails.
 *
 *   https://learn.microsoft.com/en-us/sql/t-sql/functions/metadata-functions-transact-sql
 *   https://learn.microsoft.com/en-us/sql/t-sql/functions/security-functions-transact-sql
 *
 * Fetched 2026-09-30 (metadata page updated_at 2026-09-21, security page updated_at 2026-08-24).
 * The one exception is PARSENAME, which splits a string and reads nothing; it must stay ACCEPTED.
 */
const LEARN_METADATA_PAGE = [
  'SERVERPROPERTY', 'DB_ID', 'DB_NAME', 'DATABASEPROPERTYEX', 'ORIGINAL_DB_NAME', 'APP_NAME',
  'DATABASE_PRINCIPAL_ID', 'VERSION', 'OBJECT_ID', 'OBJECT_NAME', 'OBJECT_SCHEMA_NAME', 'SCHEMA_ID',
  'SCHEMA_NAME', 'PARSENAME', '@@PROCID', 'OBJECT_DEFINITION', 'OBJECTPROPERTY', 'OBJECTPROPERTYEX',
  'ASSEMBLYPROPERTY', 'TYPE_ID', 'TYPE_NAME', 'TYPEPROPERTY', 'COL_NAME', 'COL_LENGTH', 'COLUMNPROPERTY',
  'INDEX_COL', 'INDEXKEY_PROPERTY', 'INDEXPROPERTY', 'STATS_DATE', 'FILE_ID', 'FILE_IDEX', 'FILE_NAME',
  'FILEGROUP_ID', 'FILEGROUP_NAME', 'FILEGROUPPROPERTY', 'FILEPROPERTY', 'FULLTEXTCATALOGPROPERTY',
  'FULLTEXTSERVICEPROPERTY', 'APPLOCK_MODE', 'APPLOCK_TEST', 'SCOPE_IDENTITY', 'NEXT VALUE FOR',
];
const LEARN_SECURITY_PAGE = [
  'CERTENCODED', 'PWDCOMPARE', 'CERTPRIVATEKEY', 'PWDENCRYPT', 'CURRENT_USER', 'SCHEMA_ID',
  'DATABASE_PRINCIPAL_ID', 'SCHEMA_NAME', 'sys.fn_builtin_permissions', 'SESSION_USER',
  'sys.fn_get_audit_file', 'SUSER_ID', 'sys.fn_my_permissions', 'SUSER_SID', 'HAS_PERMS_BY_NAME',
  'SUSER_SNAME', 'IS_MEMBER', 'SYSTEM_USER', 'IS_ROLEMEMBER', 'SUSER_NAME', 'IS_SRVROLEMEMBER', 'USER_ID',
  'LOGINPROPERTY', 'USER_NAME', 'ORIGINAL_LOGIN', 'PERMISSIONS', 'xp_logininfo', 'xp_enumgroups',
];
const EXCEPTIONS: Record<string, string> = { PARSENAME: 'splits a string and reads nothing' };
// Learn documents these three as called without parentheses.
const WORDS_WITHOUT_PARENTHESES = new Set(['CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER']);

/**
 * Refused though neither page lists them, each with the reason its kind names: database names and
 * table names that may carry a database (metadata), certificate and key ids (security), and the
 * session's host and connection (session). Removing one from the classifier turns exactly its row red.
 */
const ALSO_REFUSED: Array<[string, 'metadata' | 'security' | 'session']> = [
  ['HAS_DBACCESS', 'metadata'], ['DATABASEPROPERTY', 'metadata'], ['GETANSINULL', 'metadata'],
  ['IDENT_CURRENT', 'metadata'], ['IDENT_SEED', 'metadata'], ['IDENT_INCR', 'metadata'],
  ['FILEPROPERTYEX', 'metadata'], ['CERT_ID', 'security'], ['KEY_ID', 'security'],
  ['HOST_NAME', 'session'], ['HOST_ID', 'session'], ['CONNECTIONPROPERTY', 'session'],
];

/** Every function above called with parentheses, as Learn writes it: the property test's function targets. */
const CALLED_FUNCTIONS = [...LEARN_METADATA_PAGE, ...LEARN_SECURITY_PAGE, ...ALSO_REFUSED.map(([f]) => f)]
  .filter((f, k, all) => /^[A-Z_]+$/.test(f) && !(f in EXCEPTIONS) && !WORDS_WITHOUT_PARENTHESES.has(f)
    && all.indexOf(f) === k);

/**
 * The compatibility views the classifier refuses, written out. The property test below is about how a
 * name is read, not about which views are listed; it breaks if a reading of any of these is accepted.
 */
const COMPATIBILITY_VIEWS = [
  'SYSALTFILES', 'SYSCACHEOBJECTS', 'SYSCHARSETS', 'SYSCOLUMNS', 'SYSCOMMENTS', 'SYSCONFIGURES',
  'SYSCONSTRAINTS', 'SYSCURCONFIGS', 'SYSDATABASES', 'SYSDEPENDS', 'SYSDEVICES', 'SYSFILEGROUPS',
  'SYSFILES', 'SYSFOREIGNKEYS', 'SYSFULLTEXTCATALOGS', 'SYSINDEXES', 'SYSINDEXKEYS', 'SYSLANGUAGES',
  'SYSLOCKINFO', 'SYSLOGINS', 'SYSMEMBERS', 'SYSMESSAGES', 'SYSOBJECTS', 'SYSOLEDBUSERS',
  'SYSOPENTAPES', 'SYSPERFINFO', 'SYSPERMISSIONS', 'SYSPROCESSES', 'SYSPROTECTS', 'SYSREFERENCES',
  'SYSREMOTELOGINS', 'SYSSERVERS', 'SYSTYPES', 'SYSUSERS', 'SYSXLOGINS',
];

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
    // A last name part may use other letters; it is checked through the name it reads as.
    ['a non-ASCII column name, bare and qualified (refusing every non-ASCII last part breaks it)',
      'SELECT [caf\u00e9], t.[caf\u00e9], [na\u00efve] FROM t', []],
    ['a fullwidth table name that reads as an ordinary name (folding to "any non-ASCII is refused" breaks it)',
      'SELECT * FROM [\uff4f\uff52\uff44\uff45\uff52\uff53]', []],
    // Each non-ASCII character reads as its ASCII fold or as nothing. None of these can spell a refused
    // name either way, so each is accepted. Refused if every non-ASCII name were refused.
    ['a fullwidth SHIP_DATE', 'SELECT t.[\uff33\uff28\uff29\uff30\uff3f\uff24\uff21\uff34\uff25] FROM t', []],
    ['a fullwidth EXP_DATE', 'SELECT t.[\uff25\uff38\uff30\uff3f\uff24\uff21\uff34\uff25] FROM t', []],
    ['a fullwidth SPEC_NO', 'SELECT t.[\uff33\uff30\uff25\uff23\uff3f\uff2e\uff2f] FROM t', []],
    ['a fullwidth CUSTOMER_ADDRESS_LINE', `SELECT t.[${fullwidth('CUSTOMER_ADDRESS_LINE')}] FROM t`, []],
    // A long Czech name: whatever its accented letters read as, it names nothing.
    ['a Czech column name with many accented letters',
      'SELECT t.[P\u0159\u00edr\u016fstek_\u00fa\u010dt\u016f_z\u00e1kazn\u00edk\u016f_\u011b\u0161\u010d\u0159\u017e\u00fd\u00e1\u00ed\u00e9] FROM t', []],
    // sys, sp_ and xp_ are refused only as a schema or unqualified word, not as the last part of a name.
    ['a fullwidth sys as the last part', 'SELECT t.[\uff53\uff59\uff53] FROM t', []],
    ['an upper-case fullwidth SYS as the last part', 'SELECT t.[\uff33\uff39\uff33] FROM t', []],
    ['a fullwidth sp_ column', 'SELECT t.[\uff53\uff50_who] FROM t', []],
    ['a fullwidth xp_ column', 'SELECT t.[\uff58\uff50_dirtree] FROM t', []],
    // The sharp s reads as ss or as nothing: strasse and strae are no system name.
    ['a column name with a sharp s', 'SELECT [Stra\u00dfe] FROM t', []],
    ['a CJK column name', 'SELECT t.[\u9867\u5ba2\u540d] FROM t', []],
    ['a long CJK column name', `SELECT t.[${'\u5ba2\u6237'.repeat(10)}] FROM t`, []],
    // Cyrillic letters have no ASCII fold, so they read only as nothing: the ASCII letters left are
    // processes, or nothing at all.
    ['a Cyrillic look-alike of sys as the last part', 'SELECT t.[\u0455\u0443\u0455] FROM t', []],
    ['a Cyrillic look-alike of a compatibility view', 'SELECT * FROM [\u0455\u0443\u0455processes]', []],
    // U+2024 (one-dot leader) folds to a dot: v1.2 and v12 are no system name.
    ['a one-dot leader inside an ordinary name', 'SELECT t.[v1\u20242] FROM t', []],
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

describe('analyzeLakehouseQuery — metadata, security and session functions', () => {
  const METADATA_WHY = 'metadata functions are not run from this tab for a caller who is not a tenant admin; '
    + 'several of them take another database\'s id or name';
  const SECURITY_WHY = 'security functions are not run from this tab for a caller who is not a tenant admin; '
    + 'they return or test logins, users, roles, permissions, certificates or keys';
  const SESSION_WHY = 'functions that describe the session, its connection or its host are not run from this tab '
    + 'for a caller who is not a tenant admin';

  // The calls named in review, each with the arguments it was written with. Each row breaks if its
  // function is dropped from the list, or if the call rule stops firing (the construct would then be
  // missing, or a later rule would name something else).
  const NAMED: Array<[string, string, string]> = [
    ['SELECT DB_NAME(5)', 'the metadata function DB_NAME', METADATA_WHY],
    ["SELECT DB_ID('x')", 'the metadata function DB_ID', METADATA_WHY],
    ["SELECT DB_ID(N'x')", 'the metadata function DB_ID', METADATA_WHY],
    ['SELECT OBJECT_NAME(1, 5)', 'the metadata function OBJECT_NAME', METADATA_WHY],
    ['SELECT OBJECT_SCHEMA_NAME(1, 5)', 'the metadata function OBJECT_SCHEMA_NAME', METADATA_WHY],
    ["SELECT HAS_DBACCESS('x')", 'the metadata function HAS_DBACCESS', METADATA_WHY],
    ["SELECT DATABASEPROPERTYEX('x', 'Status')", 'the metadata function DATABASEPROPERTYEX', METADATA_WHY],
    ["SELECT OBJECT_ID('db.s.t')", 'the metadata function OBJECT_ID', METADATA_WHY],
    ['SELECT SCHEMA_NAME(1)', 'the metadata function SCHEMA_NAME', METADATA_WHY],
    ["SELECT SCHEMA_ID('sys')", 'the metadata function SCHEMA_ID', METADATA_WHY],
    ["SELECT SCHEMA_ID('dbo')", 'the metadata function SCHEMA_ID', METADATA_WHY],
    ["SELECT DATABASE_PRINCIPAL_ID('dbo')", 'the metadata function DATABASE_PRINCIPAL_ID', METADATA_WHY],
    ['SELECT DATABASE_PRINCIPAL_ID()', 'the metadata function DATABASE_PRINCIPAL_ID', METADATA_WHY],
    ["SELECT GETANSINULL('database')", 'the metadata function GETANSINULL', METADATA_WHY],
    ["SELECT IDENT_CURRENT('otherdb.dbo.t')", 'the metadata function IDENT_CURRENT', METADATA_WHY],
    ["SELECT IDENT_SEED('otherdb.dbo.t')", 'the metadata function IDENT_SEED', METADATA_WHY],
    ["SELECT IDENT_INCR('otherdb.dbo.t')", 'the metadata function IDENT_INCR', METADATA_WHY],
    ["SELECT FILEPROPERTYEX('f', 'BlobTier')", 'the metadata function FILEPROPERTYEX', METADATA_WHY],
    ['SELECT NEXT VALUE FOR dbo.s', 'the metadata function NEXT VALUE FOR', METADATA_WHY],
    ['SELECT SUSER_SNAME()', 'the security function SUSER_SNAME', SECURITY_WHY],
    ['SELECT SUSER_NAME()', 'the security function SUSER_NAME', SECURITY_WHY],
    ["SELECT CERT_ID('c')", 'the security function CERT_ID', SECURITY_WHY],
    ["SELECT KEY_ID('k')", 'the security function KEY_ID', SECURITY_WHY],
    ['SELECT HOST_NAME()', 'the session function HOST_NAME', SESSION_WHY],
    ["SELECT CONNECTIONPROPERTY('client_net_address')", 'the session function CONNECTIONPROPERTY', SESSION_WHY],
    // Position and spelling: in a WHERE clause, lower case, qualified, bracketed.
    ["SELECT a FROM t WHERE a = DB_ID('x')", 'the metadata function DB_ID', METADATA_WHY],
    ['select db_name(5)', 'the metadata function db_name', METADATA_WHY],
    ["SELECT dbo.OBJECT_ID('x')", 'the metadata function OBJECT_ID', METADATA_WHY],
    ['SELECT master.dbo.DB_NAME(5)', 'the metadata function DB_NAME', METADATA_WHY],
    ['SELECT [DB_NAME](5)', 'the metadata function DB_NAME', METADATA_WHY],
    ['SELECT "DB_NAME"(5)', 'the metadata function DB_NAME', METADATA_WHY],
    ['SELECT [DB_NAME ](5)', 'the metadata function DB_NAME', METADATA_WHY],
    ['SELECT DB_NAME /* c */ (5)', 'the metadata function DB_NAME', METADATA_WHY],
    ['SELECT DB_NAME\t(5)', 'the metadata function DB_NAME', METADATA_WHY],
    // A fullwidth name, shown with the name it reads as.
    [`SELECT [${fullwidth('DB_NAME')}](5)`, `the metadata function [${fullwidth('DB_NAME')}] (read as DB_NAME)`, METADATA_WHY],
    [`SELECT [${fullwidth('suser_sname')}]()`, `the security function [${fullwidth('suser_sname')}] (read as SUSER_SNAME)`, SECURITY_WHY],
    // Written without parentheses, these words are the function.
    ['SELECT CURRENT_USER', 'the security function CURRENT_USER', SECURITY_WHY],
    ['SELECT (CURRENT_USER)', 'the security function CURRENT_USER', SECURITY_WHY],
    ['SELECT SESSION_USER', 'the security function SESSION_USER', SECURITY_WHY],
    ['SELECT a FROM t WHERE owner = SYSTEM_USER', 'the security function SYSTEM_USER', SECURITY_WHY],
    ['SELECT user', 'the security function user', SECURITY_WHY],
  ];
  for (const [sql, construct, why] of NAMED) {
    it(`refuses ${sql}, naming ${construct}`, () => {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.construct).toBe(construct);
      expect(out.status).toBe(400);
      expect(out.error).toContain(`${asSentence(construct)} is not accepted: ${why}`);
      expect(out.remediation).toContain('INFORMATION_SCHEMA');
    });
  }
  it('refuses master..DB_NAME(5), naming the function and not the database', () => {
    // An empty schema: breaks if the three-part rule is reached first (it names the three-part name).
    const out = analyze('SELECT master..DB_NAME(5)');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.construct).toBe('the metadata function DB_NAME');
  });

  /** The query that calls an entry as Learn writes it, and the construct its refusal must name. */
  function probe(entry: string, kind: 'metadata' | 'security'): [string, string] {
    if (entry.startsWith('@@')) return [`SELECT ${entry}`, `the variable ${entry}`];
    if (entry.startsWith('sys.')) return [`SELECT * FROM ${entry}(NULL)`, `the sys schema object ${entry}`];
    if (entry.startsWith('xp_')) return [`SELECT 1 ${entry}`, `the system procedure ${entry}`];
    if (entry === 'NEXT VALUE FOR') return ['SELECT NEXT VALUE FOR dbo.s', 'the metadata function NEXT VALUE FOR'];
    if (WORDS_WITHOUT_PARENTHESES.has(entry)) return [`SELECT ${entry}`, `the security function ${entry}`];
    return [`SELECT ${entry}(1) FROM t`, `the ${kind} function ${entry}`];
  }
  for (const [page, entries, kind] of [
    ['metadata', LEARN_METADATA_PAGE, 'metadata'],
    ['security', LEARN_SECURITY_PAGE, 'security'],
  ] as const) {
    for (const entry of entries) {
      // An entry on both pages takes the metadata reason.
      const [sql, construct] = probe(entry, LEARN_METADATA_PAGE.includes(entry) ? 'metadata' : kind);
      if (entry in EXCEPTIONS) {
        it(`accepts ${entry} from the ${page} page: it ${EXCEPTIONS[entry]}`, () => {
          expect(analyze(sql)).toEqual({ ok: true, locations: [] });
        });
        continue;
      }
      it(`refuses ${entry} from the ${page} page`, () => {
        const out = analyze(sql);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.construct).toBe(construct);
      });
    }
  }

  const KIND_WHY = { metadata: METADATA_WHY, security: SECURITY_WHY, session: SESSION_WHY } as const;
  for (const [fn, kind] of ALSO_REFUSED) {
    it(`refuses a call to ${fn}, with the ${kind} reason`, () => {
      const out = analyze(`SELECT ${fn}(1) FROM t`);
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.construct).toBe(`the ${kind} function ${fn}`);
      expect(out.error).toContain(KIND_WHY[kind]);
    });
  }

  // Common functions, one row each: a row breaks if its function is added to a refused list.
  const COMMON: Array<[string, string]> = [
    ['COUNT', 'SELECT COUNT(*) FROM t'],
    ['SUM', 'SELECT SUM(a) FROM t'],
    ['CAST', 'SELECT CAST(a AS int) FROM t'],
    ['CONVERT', 'SELECT CONVERT(varchar(10), a) FROM t'],
    ['DATEADD', 'SELECT DATEADD(day, 1, a) FROM t'],
    ['GETDATE', 'SELECT GETDATE()'],
    ['ISNULL', 'SELECT ISNULL(a, 0) FROM t'],
    ['COALESCE', 'SELECT COALESCE(a, b, 0) FROM t'],
    ['LEN', 'SELECT LEN(a) FROM t'],
    ['UPPER', 'SELECT UPPER(a) FROM t'],
    // PARSENAME only splits a string; it is on the metadata page and deliberately not listed.
    ['PARSENAME', "SELECT PARSENAME('a.b.c', 1)"],
    // NEXT as a column, and FETCH NEXT: the NEXT VALUE FOR rule needs all three words.
    ['a column named next', 'SELECT t.next, [next] FROM t'],
    // The serverless OPENROWSET row functions.
    ['filename and filepath', `SELECT r.filename(), r.filepath(1) FROM OPENROWSET(BULK '${IN}/*.parquet', FORMAT='PARQUET') AS r`],
  ];
  for (const [label, sql] of COMMON) {
    it(`accepts ${label}`, () => {
      expect(analyze(sql)).toEqual({ ok: true, locations: sql.includes('OPENROWSET') ? [`${IN}/*.parquet`] : [] });
    });
  }

  it('accepts columns named like the functions when they are not called', () => {
    // Breaks if the call rule ignores whether `(` follows, or if the word rule for USER and its
    // siblings applies to a bracketed name or a later name part.
    const sql = 'SELECT db_name, t.object_id, [suser_sname], [user], t.user, t.[CURRENT_USER], t.host_name FROM t';
    expect(analyze(sql)).toEqual({ ok: true, locations: [] });
  });

  it('a bare USER is told it can be bracketed or qualified', () => {
    // Breaks if the word rule stops offering the column forms that are accepted above.
    const out = analyze('SELECT user FROM t');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.remediation).toContain('write it in brackets, as [user], or qualify it, as t.user');
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
    ['a name part with a zero-width joiner', 'SELECT * FROM [sys\u200dprocesses]', 'the name part [sys\\u{200d}processes]'],
    // A qualifier (every part before the last) is plain ASCII. It is shown as written.
    ['a fullwidth sys schema', 'SELECT * FROM [\uff53\uff59\uff53].[dm_exec_requests_history]', 'the qualifier [\uff53\uff59\uff53]'],
    ['a long-s sys schema', 'SELECT * FROM [\u017fys].objects', 'the qualifier [\u017fys]'],
    // The qualifier is not the first part here: accepted if only the first part were checked.
    ['a long-s sys schema after the database', 'SELECT * FROM master.[\u017fys].objects', 'the qualifier [\u017fys]'],
    // U+034F does not show, so it is written escaped.
    ['a sys schema with a combining grapheme joiner', 'SELECT * FROM [sy\u034fs].objects', 'the qualifier [sy\\u{34f}s]'],
    ['a non-ASCII table alias used as a qualifier', 'SELECT [caf\u00e9].x FROM t AS [caf\u00e9]', 'the qualifier [caf\u00e9]'],
    // A last part refused for the name it reads as: shown as written, then that name.
    ['a fullwidth compatibility view', 'SELECT * FROM [\uff53\uff59\uff53processes]',
      'the system compatibility view [\uff53\uff59\uff53processes] (read as sysprocesses)'],
    // NFKC would compose s + U+0301 into one letter, and the mark would no longer be removed.
    ['a combining accent before a compatibility view\'s letters', 'SELECT * FROM [sys\u0301objects]',
      'the system compatibility view [sys\u0301objects] (read as sysobjects)'],
    ['a combining accent at the end of a compatibility view', 'SELECT * FROM [sysprocesse\u0301s]',
      'the system compatibility view [sysprocesse\u0301s] (read as sysprocesses)'],
    ['a compatibility view with a precomposed accented e', 'SELECT * FROM [sysprocess\u00e9s]',
      'the system compatibility view [sysprocess\u00e9s] (read as sysprocesses)'],
    // Variation selectors and the combining grapheme joiner are marks, removed; they do not show, so they are escaped.
    ['a variation selector after a compatibility view', 'SELECT * FROM [sysobjects\ufe0f]',
      'the system compatibility view [sysobjects\\u{fe0f}] (read as sysobjects)'],
    ['a supplementary variation selector inside a compatibility view', 'SELECT * FROM [sys\u{e0100}objects]',
      'the system compatibility view [sys\\u{e0100}objects] (read as sysobjects)'],
    ['a combining grapheme joiner inside a compatibility view', 'SELECT * FROM [sys\u034fobjects]',
      'the system compatibility view [sys\\u{34f}objects] (read as sysobjects)'],
    // The sharp s reads as ss: each is accepted without that expansion (sysproceses, syspermiions, ...).
    ['a sharp s inside sysprocesses', 'SELECT * FROM [sysproce\u00dfes]',
      'the system compatibility view [sysproce\u00dfes] (read as sysprocesses)'],
    ['a sharp s inside syspermissions', 'SELECT * FROM [syspermi\u00dfions]',
      'the system compatibility view [syspermi\u00dfions] (read as syspermissions)'],
    ['a sharp s inside sysmessages', 'SELECT * FROM [sysme\u00dfages]',
      'the system compatibility view [sysme\u00dfages] (read as sysmessages)'],
    ['a capital sharp s inside SYSPROCESSES', 'SELECT * FROM [SYSPROCE\u1e9eES]',
      'the system compatibility view [SYSPROCE\u1e9eES] (read as sysprocesses)'],
    ['a sharp s inside a qualified compatibility view', 'SELECT * FROM master.dbo.[sysproce\u00dfes]',
      'the system compatibility view [sysproce\u00dfes] (read as sysprocesses)'],
    // Compatibility characters may read as their ASCII fold: accepted if non-ASCII characters could only
    // read as nothing.
    ['a long-s compatibility view', 'SELECT * FROM [\u017fysobjects]', 'the system compatibility view [\u017fysobjects] (read as sysobjects)'],
    ['a mathematical sans-serif s in a compatibility view', 'SELECT * FROM [\u{1d5cc}ysobjects]',
      'the system compatibility view [\u{1d5cc}ysobjects] (read as sysobjects)'],
    ['a superscript s in a compatibility view', 'SELECT * FROM [\u02e2ysobjects]',
      'the system compatibility view [\u02e2ysobjects] (read as sysobjects)'],
    ['a fi ligature in a compatibility view', 'SELECT * FROM [sys\ufb01les]', 'the system compatibility view [sys\ufb01les] (read as sysfiles)'],
    // The Kelvin sign decomposes canonically to K.
    ['a Kelvin sign in a compatibility view', 'SELECT * FROM [sysloc\u212ainfo]', 'the system compatibility view [sysloc\u212ainfo] (read as syslockinfo)'],
    ['a fullwidth global temporary table', 'SELECT * FROM [\uff03\uff03shared]', 'the global temporary table [\uff03\uff03shared] (read as ##shared)'],
    ['a fullwidth fn_ function called', 'SELECT * FROM [\uff46\uff4e_dblog](NULL, NULL)', 'the system function [\uff46\uff4e_dblog] (read as fn_dblog)'],
    ['a fullwidth low line in a called fn_ function', 'SELECT * FROM [fn\uff3fdblog](NULL, NULL)', 'the system function [fn\uff3fdblog] (read as fn_dblog)'],
    // Upper-case fullwidth letters: accepted if the reading were not lower-cased.
    ['an upper-case fullwidth fn_ function called', 'SELECT * FROM [\uff26\uff2e_DBLOG](NULL, NULL)',
      'the system function [\uff26\uff2e_DBLOG] (read as fn_dblog)'],
    // Every non-ASCII character may also read as nothing. Each is accepted if characters with an ASCII
    // fold could only read as that fold (sysxprocesses, ...).
    ['a subscript x inside a compatibility view', 'SELECT * FROM [sys\u2093processes]',
      'the system compatibility view [sys\u2093processes] (read as sysprocesses)'],
    ['a modifier letter a inside a compatibility view', 'SELECT * FROM [sys\u1d43cacheobjects]',
      'the system compatibility view [sys\u1d43cacheobjects] (read as syscacheobjects)'],
    ['a subscript j inside a compatibility view', 'SELECT * FROM [sys\u2c7ccomments]',
      'the system compatibility view [sys\u2c7ccomments] (read as syscomments)'],
    ['a subscript x before a called fn_ function', 'SELECT * FROM [\u2093fn_dblog](NULL, NULL)',
      'the system function [\u2093fn_dblog] (read as fn_dblog)'],
    // A character outside the Basic Multilingual Plane has no ASCII fold, so it reads as nothing and
    // leaves sysobjects. Accepted if such characters were read only as themselves.
    ['a supplementary CJK letter inside a compatibility view', 'SELECT * FROM [sys\u{20000}objects]',
      'the system compatibility view [sys\u{20000}objects] (read as sysobjects)'],
    // U+2024 folds to a dot, or reads as nothing; as nothing it leaves sysobjects. The server keeps it as
    // one character of one bracketed name, so this refusal is stricter than the server needs.
    ['a one-dot leader inside a compatibility view', 'SELECT * FROM [sys\u2024objects]',
      'the system compatibility view [sys\u2024objects] (read as sysobjects)'],
    // Dotless i reads as i; dotted I decomposes to I and a mark.
    ['a dotless i inside a compatibility view', 'SELECT * FROM [sys\u0131ndexes]',
      'the system compatibility view [sys\u0131ndexes] (read as sysindexes)'],
    ['a dotted capital I inside a compatibility view', 'SELECT * FROM [SYS\u0130NDEXES]',
      'the system compatibility view [SYS\u0130NDEXES] (read as sysindexes)'],
    // Mathematical dotless i decomposes to dotless i, which then reads as i. Accepted if the expansions
    // applied only to the character as written (sys + dotless i + ndexes, no system name).
    ['a mathematical dotless i inside a compatibility view', 'SELECT * FROM [sys\u{1d6a4}ndexes]',
      'the system compatibility view [sys\u{1d6a4}ndexes] (read as sysindexes)'],
    // Review probes. Every non-ASCII character reads as its ASCII fold or as nothing, in any mix; each
    // of these is accepted if a character with no ASCII fold is not allowed to read as nothing, or if
    // folding and reading as nothing cannot both occur in one name.
    ['U+2E3A inside sysprocesses', 'SELECT * FROM [sys\u2e3aprocesses]',
      'the system compatibility view [sys\u2e3aprocesses] (read as sysprocesses)'],
    ['U+A7B5 inside syscacheobjects', 'SELECT * FROM [sys\ua7b5cacheobjects]',
      'the system compatibility view [sys\ua7b5cacheobjects] (read as syscacheobjects)'],
    ['U+2C30 inside syscomments', 'SELECT * FROM [sys\u2c30comments]',
      'the system compatibility view [sys\u2c30comments] (read as syscomments)'],
    ['U+2E3A before a called fn_ function', 'SELECT * FROM [\u2e3afn_dblog](NULL, NULL)',
      'the system function [\u2e3afn_dblog] (read as fn_dblog)'],
    ['U+2E3A inside a called DB_NAME', 'SELECT [DB\u2e3a_NAME](5)', 'the metadata function [DB\u2e3a_NAME] (read as DB_NAME)'],
    ['a long s and a subscript x around sysobjects', 'SELECT * FROM [\u017fysobjects\u2093]',
      'the system compatibility view [\u017fysobjects\u2093] (read as sysobjects)'],
    ['a circled s and a subscript x around sysobjects', 'SELECT * FROM [\u24e2ysobjects\u2093]',
      'the system compatibility view [\u24e2ysobjects\u2093] (read as sysobjects)'],
    ['a fi ligature and a subscript x in sysfiles', 'SELECT * FROM [sys\ufb01les\u2093]',
      'the system compatibility view [sys\ufb01les\u2093] (read as sysfiles)'],
    ['a superscript s and a modifier a around sysprocesses', 'SELECT * FROM [\u02e2ysprocesses\u1d43]',
      'the system compatibility view [\u02e2ysprocesses\u1d43] (read as sysprocesses)'],
    ['a long s and a subscript x after a schema', 'SELECT * FROM dbo.[\u017fysobjects\u2093]',
      'the system compatibility view [\u017fysobjects\u2093] (read as sysobjects)'],
    ['a subscript x and a circled f before a called n_dblog', 'SELECT * FROM [\u2093\u24d5n_dblog](NULL, NULL)',
      'the system function [\u2093\u24d5n_dblog] (read as fn_dblog)'],
    ['a subscript x and a circled d before a called B_NAME', 'SELECT [\u2093\u24d3B_NAME](5)',
      'the metadata function [\u2093\u24d3B_NAME] (read as DB_NAME)'],
    ['a Hangul choseong filler inside sysobjects', 'SELECT * FROM [sys\u115fobjects]',
      'the system compatibility view [sys\\u{115f}objects] (read as sysobjects)'],
    ['a Hangul jungseong filler inside sysobjects', 'SELECT * FROM [sys\u1160objects]',
      'the system compatibility view [sys\\u{1160}objects] (read as sysobjects)'],
    ['a halfwidth Hangul filler inside sysobjects', 'SELECT * FROM [sys\uffa0objects]',
      'the system compatibility view [sys\\u{ffa0}objects] (read as sysobjects)'],
    ['a tatweel inside sysobjects', 'SELECT * FROM [sys\u0640objects]',
      'the system compatibility view [sys\u0640objects] (read as sysobjects)'],
    // A fullwidth letter may also read as nothing: sys + x + processes spells sysprocesses.
    ['a fullwidth letter inside a near-miss of a compatibility view', 'SELECT * FROM [sys\uff58processes]',
      'the system compatibility view [sys\uff58processes] (read as sysprocesses)'],
    // Code points whose comparison cannot be known, refused outright.
    ['an unassigned code point in a name', 'SELECT t.[a\u0378b] FROM t', 'the name part [a\\u{378}b]'],
    ['a private-use code point in a name', 'SELECT t.[a\ue000b] FROM t', 'the name part [a\\u{e000}b]'],
    ['an unpaired surrogate in a name', 'SELECT t.[a\ud800b] FROM t', 'the name part [a\\u{d800}b]'],
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

  it('a code point whose comparison cannot be known is refused as that, not as whitespace', () => {
    // The whitespace and control rule also refuses these characters, with another reason. Breaks if the
    // unassigned, private-use and surrogate check is removed or moved after that rule.
    for (const [sql, cp] of [['SELECT t.[a\u0378b] FROM t', 'U+0378'], ['SELECT t.[a\ue000b] FROM t', 'U+E000'],
      ['SELECT t.[a\ud800b] FROM t', 'U+D800']]) {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.error).toContain(`it contains ${cp}, which is unassigned, private-use or an unpaired surrogate`);
      expect(out.error).not.toContain('whitespace or control character');
    }
  });

  it('a name refused for the name it reads as says SELECT * returns the column', () => {
    // Breaks if the hint is dropped, or added to a refusal of a name written in ASCII.
    const read = analyze('SELECT t.[\uff53\uff59\uff53processes] FROM t');
    const ascii = analyze('SELECT t.[sysprocesses] FROM t');
    expect(read.ok || ascii.ok).toBe(false);
    if (read.ok || ascii.ok) return;
    expect(read.remediation).toContain('If it is a column of yours, SELECT * returns it without naming it.');
    expect(ascii.remediation).not.toContain('SELECT * returns it');
    expect(ascii.remediation).toContain('INFORMATION_SCHEMA.COLUMNS');
    expect(read.remediation).not.toContain('ASCII alias');
  });

  it('a fullwidth name that holds a refused name in order is refused, where its ASCII twin is not', () => {
    // A stated limit of the rule, pinned so it reads as a choice and not a defect: a fullwidth letter may
    // read as nothing, so fullwidth SYSTEM_OBJECTS can spell sysobjects, and fullwidth FIN_YEAR, called,
    // can spell fn_year. The ASCII forms are accepted. Breaks if fullwidth letters stop reading as nothing
    // (the review probes above break too), or if ASCII letters may read as nothing (the ASCII rows break).
    expect(analyze('SELECT t.[SYSTEM_OBJECTS] FROM t')).toEqual({ ok: true, locations: [] });
    expect(analyze('SELECT [FIN_YEAR](1)')).toEqual({ ok: true, locations: [] });
    const view = analyze(`SELECT t.[${fullwidth('SYSTEM_OBJECTS')}] FROM t`);
    expect(view.ok).toBe(false);
    if (!view.ok) {
      expect(view.construct).toBe(`the system compatibility view [${fullwidth('SYSTEM_OBJECTS')}] (read as sysobjects)`);
    }
    // Not called, the same name is accepted: the fn_ rule applies only to a call.
    expect(analyze(`SELECT t.[${fullwidth('FIN_YEAR')}] FROM t`)).toEqual({ ok: true, locations: [] });
    const called = analyze(`SELECT [${fullwidth('FIN_YEAR')}](1)`);
    expect(called.ok).toBe(false);
    if (!called.ok) expect(called.construct).toBe(`the system function [${fullwidth('FIN_YEAR')}] (read as fn_year)`);
  });

  it('a 2000-character name is matched in at most (length + 1) x (target length + 1) steps, with no cap', () => {
    // Counted, not timed. Trying every fold-or-nothing choice would take 2^1990 steps here; the match
    // visits each (position, target letter) pair at most once. Breaks if the match is replaced by an
    // enumeration (the upper bound), if the count stops counting (the lower bound), or if a long name is
    // refused for its length (the accepted row).
    const refusedPart = `${'\u2093'.repeat(1990)}sysobjects`;
    const refused = spellsName(refusedPart, 'sysobjects');
    expect(refused.end).toBe(2000);
    // Each subscript x keeps only offset 0 reachable (x is not s), then one offset per ASCII letter.
    expect(refused.cells).toBe(2000);
    expect(refused.cells).toBeLessThanOrEqual(2001 * 11);
    const acceptedPart = '\u00e9\uff41\u2093'.repeat(667);
    expect([...acceptedPart].length).toBe(2001);
    const accepted = spellsName(acceptedPart, 'sysobjects');
    expect(accepted.end).toBe(-1);
    expect(accepted.cells).toBe(2001);
    // Mixed: a stand-in for s keeps two offsets reachable at every step (read as s, or as nothing).
    const mixed = spellsName('\u017f'.repeat(2000), 'sysobjects');
    expect(mixed.end).toBe(-1);
    expect(mixed.cells).toBe(1 + 2 * 1999);
    // Through the classifier, with a generous wall-clock backstop: the counts above are the measure.
    const started = performance.now();
    expect(analyze(`SELECT * FROM [${refusedPart}]`).ok).toBe(false);
    expect(analyze(`SELECT t.[${acceptedPart}] FROM t`)).toEqual({ ok: true, locations: [] });
    expect(performance.now() - started).toBeLessThan(4000);
  });

  it('an unbracketed name with letters outside ASCII is told to bracket it', () => {
    // Breaks if the hint is dropped, or names a word other than the one the lexer stopped in.
    for (const [sql, word] of [['SELECT caf\u00e9 FROM t', 'caf\u00e9'], ['SELECT 1 AS na\u00efve', 'na\u00efve']]) {
      const out = analyze(sql);
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.remediation).toContain(`If ${word} is a column or table name, write it in brackets, as [${word}].`);
    }
    // Not a letter: no hint.
    const other = analyze('SELECT {fn user()}');
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.remediation).not.toContain('write it in brackets');
  });

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

describe('analyzeLakehouseQuery — every reading of a refused name is refused (property)', () => {
  /** mulberry32: a seeded generator, so a failing name is the same name on every run. */
  function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Inserted between letters. Under the rule each may read as nothing, so the refused name is still
  // spelled whatever else it could read as.
  const INSERTS = [
    // Letters of other scripts: CJK, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari, Latin ae.
    '\u4e00', '\u9867', '\uac00', '\u0436', '\u03bb', '\u0628', '\u05d0', '\u0e01', '\u0915', '\u00e6',
    // Combining marks and a variation selector.
    '\u0301', '\u0308', '\u0327', '\u034f', '\ufe0f',
    // The fillers, the tatweel and the letters with no decomposition named in review.
    '\u115f', '\u1160', '\u3164', '\uffa0', '\u0640', '\u2e3a', '\ua7b5', '\u2c30',
    // Characters that fold to ASCII, here placed where their fold is not wanted.
    '\u2093', '\u1d43', '\u2c7c', '\u02e2', '\uff58', '\u2024', '\u00df',
    // Outside the Basic Multilingual Plane: a CJK letter and a mathematical s.
    '\u{20000}', '\u{1d5cc}',
  ];
  // Stand-ins for a letter of the name, each folding to that letter. Written out, not computed with the
  // classifier's fold, so a fold that drops one of these is caught rather than agreed with.
  const EXTRA_STAND_INS: Record<string, string[]> = {
    s: ['\u017f', '\u02e2'], k: ['\u212a'], e: ['\u00e9', '\u00e8'], a: ['\u00e1', '\u00e0', '\u1d43'],
    i: ['\u0131', '\u00ed', '\u0130'], o: ['\u00f6'], u: ['\u00fc'], c: ['\u00e7'], n: ['\u00f1'],
    x: ['\u2093'], j: ['\u2c7c'], _: ['\uff3f'], '#': ['\uff03'],
  };
  function standIns(c: string): string[] {
    const out = [...(EXTRA_STAND_INS[c] ?? [])];
    if (/^[a-z]$/.test(c)) {
      const k = c.charCodeAt(0) - 0x61;
      out.push(
        String.fromCharCode(0xff41 + k), String.fromCharCode(0xff21 + k), // fullwidth small, capital
        String.fromCharCode(0x24d0 + k), String.fromCharCode(0x24b6 + k), // circled small, capital
        String.fromCodePoint(0x1d41a + k), String.fromCodePoint(0x1d5ba + k), // mathematical bold, sans-serif
      );
    }
    return out;
  }
  // Ligatures standing for two letters.
  const LIGATURES: Record<string, string> = { fi: '\ufb01', fl: '\ufb02', ss: '\u00df' };

  const next = seeded(0x4822);
  const pick = (xs: string[]) => xs[Math.floor(next() * xs.length)];
  const counts = { withStandIn: 0, withInsert: 0, withBoth: 0, variants: 0 };
  /** A spelling of `name` with at least one character outside ASCII. */
  function variant(name: string): string {
    const t = name.toLowerCase();
    let out = '';
    let standIn = false;
    let insert = false;
    for (let j = 0; j < t.length;) {
      if (next() < 0.3) { out += pick(INSERTS); insert = true; }
      const pair = LIGATURES[t.slice(j, j + 2)];
      if (pair !== undefined && next() < 0.5) { out += pair; standIn = true; j += 2; continue; }
      const alts = standIns(t[j]);
      if (alts.length > 0 && next() < 0.4) { out += pick(alts); standIn = true; } else out += next() < 0.5 ? t[j] : t[j].toUpperCase();
      j += 1;
    }
    if (!insert && !standIn) { out += pick(INSERTS); insert = true; }
    counts.variants += 1;
    if (standIn) counts.withStandIn += 1;
    if (insert) counts.withInsert += 1;
    if (standIn && insert) counts.withBoth += 1;
    return out;
  }

  const PER_TARGET = 6;
  const cases: Array<[string, RegExp]> = [];
  for (const view of COMPATIBILITY_VIEWS) {
    for (let n = 0; n < PER_TARGET; n += 1) {
      const v = variant(view);
      const refused = /^the system compatibility view \[.*\] \(read as sys[a-z]+\)$/su;
      cases.push([`SELECT * FROM [${v}]`, refused], [`SELECT * FROM dbo.[${v}]`, refused]);
    }
  }
  for (let n = 0; n < PER_TARGET * 4; n += 1) {
    cases.push([`SELECT * FROM [${variant('##')}shared]`, /^the global temporary table \[.*\] \(read as ##/su]);
    cases.push([`SELECT * FROM [${variant('fn_')}dblog](NULL, NULL)`, /^the system function \[.*\] \(read as fn_/su]);
  }
  for (const fn of CALLED_FUNCTIONS) {
    for (let n = 0; n < PER_TARGET; n += 1) {
      cases.push([`SELECT [${variant(fn)}](1)`, /^the (metadata|security|session) function \[.*\] \(read as [A-Z_]+\)$/su]);
    }
  }

  it('refuses every generated spelling, naming what it reads as', () => {
    // Breaks if a character outside ASCII may not read as nothing (every row with an insert), if the fold
    // is not used (every row with a stand-in), or if the two cannot mix in one name (rows with both).
    const failures: Array<[string, string]> = [];
    for (const [sql, construct] of cases) {
      const out = analyze(sql);
      if (out.ok) failures.push([sql, 'accepted']);
      else if (!construct.test(out.construct)) failures.push([sql, out.construct]);
    }
    expect(failures).toEqual([]);
  });

  it('the generated spellings exercise both readings and their mix', () => {
    // Breaks if the generator stops producing one kind, which would leave the test above blind to it.
    expect(cases.length).toBe(COMPATIBILITY_VIEWS.length * PER_TARGET * 2 + PER_TARGET * 4 * 2
      + CALLED_FUNCTIONS.length * PER_TARGET);
    expect(counts.variants).toBeGreaterThan(600);
    expect(counts.withStandIn).toBeGreaterThan(300);
    expect(counts.withInsert).toBeGreaterThan(300);
    expect(counts.withBoth).toBeGreaterThan(200);
  });
});

describe('analyzeLakehouseQuery — ordinary names in other scripts are accepted', () => {
  // The names tried in review. Whatever each character outside ASCII is read as, its fold or nothing,
  // none spells a refused name, so each is accepted as a column, a table and a qualified table.
  // Breaks if a name is refused for having characters outside ASCII, or if a fold gives one of these
  // letters an ASCII reading that, with its neighbours, spells a refused name.
  const NAMES: Array<[string, string]> = [
    ['German with sharp s and umlauts', 'Stra\u00dfe_Gr\u00f6\u00dfe_\u00c4nderung'],
    ['Japanese', '\u9867\u5ba2\u540d_\u65e5\u672c\u8a9e'],
    ['halfwidth katakana', '\uff76\uff80\uff76\uff85'],
    ['Russian', '\u0418\u043c\u044f_\u043a\u043b\u0438\u0435\u043d\u0442\u0430'],
    ['Turkish with dotless and dotted i', 'I\u011fd\u0131r_\u0130stanbul'],
    ['Arabic with a tatweel', '\u0645\u0640\u062d\u0645\u062f'],
    ['Hindi', '\u0917\u094d\u0930\u093e\u0939\u0915'],
    ['Thai', '\u0e25\u0e39\u0e01\u0e04\u0e49\u0e32'],
    ['Korean', '\uace0\uac1d\uba85'],
    ['Vietnamese', 'T\u00ean_kh\u00e1ch_h\u00e0ng'],
    ['Greek', '\u038c\u03bd\u03bf\u03bc\u03b1_\u03c0\u03b5\u03bb\u03ac\u03c4\u03b7'],
    ['Hebrew with points', '\u05e9\u05c1\u05b8\u05dc\u05d5\u05b9\u05dd'],
    ['a superscript two', 'm\u00b2'],
    ['a fi ligature', '\ufb01nance'],
    ['System', 'System'],
    ['sysdate', 'sysdate'],
    ['Czech with many accented letters',
      'P\u0159\u00edr\u016fstek_\u00fa\u010dt\u016f_z\u00e1kazn\u00edk\u016f_\u011b\u0161\u010d\u0159\u017e\u00fd\u00e1\u00ed\u00e9'],
    ['fullwidth SHIP_DATE', '\uff33\uff28\uff29\uff30\uff3f\uff24\uff21\uff34\uff25'],
  ];
  for (const [label, name] of NAMES) {
    it(`accepts ${label} as a column, a table and a qualified table`, () => {
      expect(analyze(`SELECT t.[${name}] FROM t`)).toEqual({ ok: true, locations: [] });
      expect(analyze(`SELECT * FROM [${name}]`)).toEqual({ ok: true, locations: [] });
      expect(analyze(`SELECT * FROM dbo.[${name}]`)).toEqual({ ok: true, locations: [] });
    });
  }
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
