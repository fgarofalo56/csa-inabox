/**
 * Confine the lakehouse SQL tab (`POST /api/items/lakehouse/[id]/query`) to the
 * item's own storage root.
 *
 * The SQL tab runs on the shared Synapse Serverless endpoint as the console's
 * identity, so the query TEXT decides which storage it reads. For a caller who
 * is not a tenant admin the text passes this classifier first. What it does,
 * stated as the code does it rather than as a slogan:
 *
 *   - STATEMENTS are refuse-by-default: each statement must start with SELECT,
 *     WITH or `(`, including after every `;`.
 *   - Inside a statement, WORDS are checked against a deny-list
 *     (`REFUSED_WORDS`): the words that begin every other T-SQL statement, plus
 *     the external-access and cursor words. A word not on the list is accepted
 *     (column names, aliases, and built-in functions other than those below).
 *   - NAMES are checked by shape: at most three parts, a three-part name must
 *     start with the database the query runs in, nothing in the `sys` schema,
 *     no system compatibility view, no global temporary table. Each part is
 *     compared as the server compares it: trailing spaces removed, and a part
 *     with any other whitespace or control character is refused. A qualifier
 *     (every part before the last) is plain ASCII. A part is refused when it
 *     can SPELL a refused name ({@link spellsName}): its ASCII characters match
 *     that name's letters, and each other character stands for its ASCII fold
 *     or for nothing, whichever spells the name.
 *   - `OPENROWSET` is allow-list only: `BULK` is required, each location is a
 *     literal string, and each option is on the read-only list below.
 *   - LOCATIONS are confined by `confineQueryLocation`: a literal `https://` or
 *     `abfss://` URL on the item's own storage account, in its container,
 *     strictly under its root.
 *
 * What is refused, with the construct named in the message:
 *   - Anything the lexer (`lib/sql/tsql-lexer.ts`) cannot read.
 *   - Dynamic SQL (`EXEC`, `EXECUTE`, `sp_`/`xp_` procedures), DDL and
 *     data-change verbs, permissions, `USE`, variables and session options,
 *     control flow, transactions, cursors and server administration.
 *   - `OPENDATASOURCE`, `OPENQUERY`, `OPENXML`, `BULK` outside `OPENROWSET`,
 *     `OPENROWSET` without `BULK`, a `BULK` location that is not a literal
 *     string, and the `DATA_SOURCE` and error-file options.
 *   - The `sys` schema and the system compatibility views. For metadata the tab
 *     accepts the `INFORMATION_SCHEMA` views; nothing in the lakehouse editor
 *     reads the `sys` catalog through this route.
 *   - Names with four parts, and three-part names naming another database.
 *   - A call to a metadata, security or session function
 *     (`METADATA_FUNCTIONS`, `SECURITY_FUNCTIONS`, `SESSION_FUNCTIONS`),
 *     `NEXT VALUE FOR`, and the security functions written without
 *     parentheses (`CURRENT_USER`, `SESSION_USER`, `SYSTEM_USER`, `USER`).
 *     Other built-in functions (COUNT, CAST, DATEADD, ISNULL, …) are accepted.
 *   - A string shaped like a storage location (an `abfss://`/`wasbs://`-style
 *     scheme, a `.dfs.core.`/`.blob.core.` host, or a UNC path) anywhere other
 *     than a `BULK` location. Other strings, including `https://` filters in a
 *     WHERE clause, are ordinary literals.
 *
 * A word on the deny-list is accepted as the second or later part of a dotted
 * name (`r.data_source`, `t.[Open]` or `t.Open`), because a statement cannot
 * start there. Unqualified, it has to be bracketed (`[Open]`), and the refusal
 * says so.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: objects already defined
 * in the database the query runs in (views, external tables) run as whatever
 * they were defined to read, and built-in functions outside the three lists
 * above are not restricted. The
 * durable form of this boundary is a per-item serverless database whose external
 * data source is rooted at the item root, with relative `BULK` paths only; that
 * is tracked separately.
 */
import { lexTsql, type TsqlToken } from '@/lib/sql/tsql-lexer';
import { scopePathToRoot } from '@/app/api/lakehouse/_lib/item-scope';
import { abfssHost } from '@/app/api/lakehouse/_lib/item-binding';

export interface QueryRefusal {
  ok: false;
  /** 400 for a construct the SQL tab does not accept; 403 for a location outside the item root. */
  status: 400 | 403;
  code: 'query_construct_not_accepted' | 'query_location_outside_root';
  /** The construct, as written or as the classifier names it. */
  construct: string;
  error: string;
  remediation: string;
}

export interface QueryAnalysis {
  ok: true;
  /** Every `OPENROWSET(BULK …)` location, in order, still to be confined to the item root. */
  locations: string[];
}

/** The item's storage binding, as `resolveLakehouseStorage` returns it. */
export interface ItemStorageLocation {
  abfss: string;
  container: string;
  root: string;
}

const LEAD =
  'The lakehouse SQL tab runs read-only SELECT queries over this lakehouse\'s own files. ';

const SELECT_REMEDIATION =
  'Write a SELECT (optionally with a WITH clause) that reads this lakehouse through '
  + "OPENROWSET(BULK 'https://<account>.dfs.<suffix>/<container>/<lakehouse root>/…'). "
  + 'A tenant admin can run other statements.';

/** Upper-case the first character, so every refusal reads as a sentence. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function refuse(construct: string, why: string, remediation = SELECT_REMEDIATION): QueryRefusal {
  return {
    ok: false,
    status: 400,
    code: 'query_construct_not_accepted',
    construct,
    error: `${LEAD}${sentence(construct)} is not accepted: ${why}.`,
    remediation,
  };
}

/**
 * Remediation for a refused word that could also be a column or table name.
 * `qualify` is false for a word refused even as a later name part, so the hint
 * offers only the form that is accepted. `then` is the sentence that follows.
 */
function bracketHint(word: string, qualify = true, then = SELECT_REMEDIATION): string {
  const forms = qualify ? `write it in brackets, as [${word}], or qualify it, as t.${word}` : `write it in brackets, as [${word}]`;
  return `If ${word} is a column or table name, ${forms}. ` + then;
}

/**
 * A name part as the server compares it, or null when it is not accepted.
 * SQL Server ignores trailing spaces in an identifier, so `[sys ]` names the
 * `sys` schema; trailing spaces are removed before any comparison. A leading
 * space, a part made only of spaces, and any whitespace or control character
 * other than a space between other characters are not accepted, so no
 * character the server might also ignore can make two names compare unequal
 * here and equal there.
 */
function normalizeNamePart(raw: string): string | null {
  if (raw === '') return '';
  const value = raw.replace(/ +$/, '');
  if (value === '' || value.startsWith(' ')) return null;
  for (const c of value) {
    if (c !== ' ' && /[\s\p{C}\p{Z}]/u.test(c)) return null;
  }
  return value;
}

/**
 * A name part as the user wrote it, for a message. Only characters that do not
 * show are written as \u{…}: whitespace other than a space, control and format
 * characters, and default-ignorable ones such as variation selectors.
 */
function shownNamePart(raw: string): string {
  return [...raw]
    .map((c) => (c !== ' ' && /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(c)
      ? `\\u{${c.codePointAt(0)!.toString(16)}}`
      : c))
    .join('');
}

/** `U+00E9`, for a message. */
function codePoint(c: string): string {
  return `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Letters with no decomposition that a collation compares as other letters.
 * The sharp s (`ß`, `ẞ`) case-folds to `ss`; that is not a
 * decomposition, so NFKD never produces it. Dotless `ı` compares as `i`
 * under a Turkish collation. Dotted `İ` decomposes to `I` and a combining
 * dot, which the mark rule removes.
 */
const LETTER_EXPANSIONS: Readonly<Record<string, string>> = { '\u00df': 'ss', '\u1e9e': 'ss', '\u0131': 'i' };

/**
 * The lower-case ASCII a character outside ASCII may stand for, or '' when it
 * has none. The character is NFKD-decomposed, the sharp s in the decomposition
 * reads as `ss` and dotless i as `i`, combining marks (`Mn`, `Me`) are removed,
 * and the result is lower-cased; it counts only when every character left is
 * ASCII.
 *
 * This contains the case-folded NFKC fold wherever that fold is ASCII (NFKC is
 * the composition of NFKD, and an ASCII string composes to itself), and adds
 * two things NFKC alone does not give: an accented letter stands for its base
 * letter, since a serverless database may use an accent-insensitive collation,
 * and dotless i stands for `i`.
 */
function asciiFold(c: string): string {
  const f = [...c.normalize('NFKD')]
    .map((d) => LETTER_EXPANSIONS[d] ?? d)
    .join('')
    .replace(/[\p{Mn}\p{Me}]/gu, '')
    .toLowerCase();
  return /^[\x00-\x7f]*$/.test(f) ? f : '';
}

/**
 * Can `part` spell `target` (lower-case ASCII)? This is the whole reading rule,
 * and it is closed: no list of characters decides it.
 *
 *   - An ASCII character matches exactly one letter of the target, compared
 *     case-insensitively.
 *   - Every other character stands EITHER for its ASCII fold ({@link asciiFold})
 *     OR for nothing. If any choice, made separately for each character, spells
 *     the target, the part can spell it.
 *
 * Why "or nothing" for every character: a collation gives no weight to a
 * character its tables do not define, or define as ignorable, and which
 * characters those are depends on the collation's version, which the tab does
 * not know. Reading every character outside ASCII as possibly absent needs no
 * such knowledge. Why the fold: without `_WS` the full-width and half-width
 * forms of a character are identical, without `_AS` accented and unaccented
 * letters are identical, and compatibility forms (long s, circled letters,
 * ligatures, superscripts) may compare as their plain letters (Microsoft
 * Learn, "Collation and Unicode support").
 *
 * `prefix`: the target need only begin the part (`##`, `fn_`).
 *
 * Returns the index, in code points, just after the shortest match (-1 when the
 * part cannot spell the target), and `cells`: the number of (position, letter)
 * states the match visited. It never exceeds (|part| + 1) x (|target| + 1), so
 * the cost is linear in each and no length cap is needed.
 */
export function spellsName(part: string, target: string, prefix = false): { end: number; cells: number } {
  const chars = [...part];
  const m = target.length;
  let cells = 0;
  let reach = new Array<boolean>(m + 1).fill(false);
  reach[0] = true;
  for (let i = 0; ; i += 1) {
    if (prefix && reach[m]) return { end: i, cells };
    if (i === chars.length) return { end: reach[m] ? i : -1, cells };
    const c = chars[i];
    const ascii = c.charCodeAt(0) < 0x80;
    const fold = ascii ? '' : asciiFold(c);
    const next = new Array<boolean>(m + 1).fill(false);
    let any = false;
    for (let j = 0; j <= m; j += 1) {
      if (!reach[j]) continue;
      cells += 1;
      if (ascii) {
        if (j < m && c.toLowerCase() === target[j]) { next[j + 1] = true; any = true; }
        continue;
      }
      // Read as nothing.
      next[j] = true;
      any = true;
      // Read as its fold.
      if (fold !== '' && target.startsWith(fold, j)) next[j + fold.length] = true;
    }
    if (!any) return { end: -1, cells };
    reach = next;
  }
}

/**
 * The name a refused part spells, for a message: the target, then (for a
 * prefix target) the rest of the part, each character written as its fold, or
 * as written when it has none.
 */
function spelled(part: string, target: string, end: number, prefix: boolean): string {
  if (!prefix) return target;
  return target + [...part].slice(end).map((c) => (c.charCodeAt(0) < 0x80 ? c : asciiFold(c) || c)).join('').toLowerCase();
}

/** The first of `targets` (lower-case) the part can spell, as {@link spelled} shows it, or undefined. */
function firstSpelled(part: string, targets: Iterable<string>, prefix = false): string | undefined {
  for (const t of targets) {
    const { end } = spellsName(part, t, prefix);
    if (end >= 0) return spelled(part, t, end, prefix);
  }
  return undefined;
}

/** A part as written, then the name it spells when that differs. */
function shownRead(part: string, reading: string): string {
  return /^[\x00-\x7f]*$/.test(part) ? part : `[${shownNamePart(part)}] (read as ${reading})`;
}

/** Remediation added when a part was refused for the name it reads as, not as written. */
const READ_AS_HINT = 'If it is a column of yours, SELECT * returns it without naming it. ';

const WHY = {
  dynamic: 'dynamic SQL is not run from this tab',
  ddl: 'statements that create, change or remove objects are not run from this tab',
  dml: 'statements that change data are not run from this tab',
  perms: 'permission statements are not run from this tab',
  database: 'the query runs in the database this tab chooses',
  session: 'variables and session options are not accepted in this tab',
  external: 'external data access goes through OPENROWSET(BULK …) on this lakehouse\'s files only',
  admin: 'server administration is not run from this tab',
  control: 'control flow and transactions are not accepted in this tab',
  cursor: 'cursors are not accepted in this tab',
  broker: 'Service Broker statements are not run from this tab',
  catalog: 'the SQL tab reads this lakehouse\'s files and the INFORMATION_SCHEMA views, not the server catalog',
  metadata: 'metadata functions are not run from this tab for a caller who is not a tenant admin; '
    + 'several of them take another database\'s id or name',
  security: 'security functions are not run from this tab for a caller who is not a tenant admin; '
    + 'they return or test logins, users, roles, permissions, certificates or keys',
  connection: 'functions that describe the session, its connection or its host are not run from this tab '
    + 'for a caller who is not a tenant admin',
} as const;

const FUNCTION_REMEDIATION =
  'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS. '
  + 'A tenant admin can call these functions.';

/**
 * Built-in functions refused when called, whatever their arguments. A deny-list,
 * not an allow-list of scalar functions: an allow-list would also refuse
 * user-defined functions and type methods (`t.doc.value(…)`), and would have to
 * track the whole built-in catalogue.
 *
 * Every function on Microsoft Learn's "Metadata functions" page, except
 * PARSENAME, which splits a string and reads nothing. On that page but not
 * here: `@@PROCID`, a variable (variables are refused), and `NEXT VALUE FOR`,
 * which is not a call and is refused by its own rule. SCHEMA_ID, SCHEMA_NAME and
 * DATABASE_PRINCIPAL_ID are on both this page and the security page, and take
 * this reason.
 *
 * Also refused, though that page does not list them: HAS_DBACCESS, the
 * deprecated DATABASEPROPERTY and GETANSINULL, which take a database name;
 * IDENT_CURRENT, IDENT_SEED and IDENT_INCR, which take a table name that may be
 * qualified with a database; and FILEPROPERTYEX, the extended form of
 * FILEPROPERTY.
 *
 * The whole family is refused rather than the ones Learn documents as taking a
 * database id or name, so a function whose arguments reach another database is
 * not missed through a reading of its syntax page.
 */
const METADATA_FUNCTIONS = new Set([
  'SERVERPROPERTY', 'DB_ID', 'DB_NAME', 'DATABASEPROPERTYEX', 'ORIGINAL_DB_NAME', 'APP_NAME',
  'DATABASE_PRINCIPAL_ID', 'VERSION',
  'OBJECT_ID', 'OBJECT_NAME', 'OBJECT_SCHEMA_NAME', 'SCHEMA_ID', 'SCHEMA_NAME',
  'OBJECT_DEFINITION', 'OBJECTPROPERTY', 'OBJECTPROPERTYEX', 'ASSEMBLYPROPERTY',
  'TYPE_ID', 'TYPE_NAME', 'TYPEPROPERTY', 'COL_NAME', 'COL_LENGTH', 'COLUMNPROPERTY',
  'INDEX_COL', 'INDEXKEY_PROPERTY', 'INDEXPROPERTY', 'STATS_DATE',
  'FILE_ID', 'FILE_IDEX', 'FILE_NAME', 'FILEGROUP_ID', 'FILEGROUP_NAME', 'FILEGROUPPROPERTY', 'FILEPROPERTY',
  'FULLTEXTCATALOGPROPERTY', 'FULLTEXTSERVICEPROPERTY', 'APPLOCK_MODE', 'APPLOCK_TEST', 'SCOPE_IDENTITY',
  // Not on the metadata page.
  'HAS_DBACCESS', 'DATABASEPROPERTY', 'GETANSINULL', 'IDENT_CURRENT', 'IDENT_SEED', 'IDENT_INCR', 'FILEPROPERTYEX',
]);

/**
 * Every function on Microsoft Learn's "Security functions" page that is called
 * with parentheses, except the three that take the metadata reason above. The
 * page's `sys.fn_` functions are in the `sys` schema, refused as such, and its
 * CURRENT_USER, SESSION_USER and SYSTEM_USER are words, refused below. Also
 * refused: CERT_ID and KEY_ID, which return the id of a certificate or key.
 */
const SECURITY_FUNCTIONS = new Set([
  'CERTENCODED', 'CERTPRIVATEKEY', 'PWDCOMPARE', 'PWDENCRYPT', 'HAS_PERMS_BY_NAME', 'PERMISSIONS',
  'IS_MEMBER', 'IS_ROLEMEMBER', 'IS_SRVROLEMEMBER', 'LOGINPROPERTY', 'ORIGINAL_LOGIN',
  'SUSER_ID', 'SUSER_SID', 'SUSER_SNAME', 'SUSER_NAME', 'USER_ID', 'USER_NAME',
  // Not on the security page.
  'CERT_ID', 'KEY_ID',
]);

/** Functions that return the session's host or connection details. Not on either page. */
const SESSION_FUNCTIONS = new Set(['HOST_NAME', 'HOST_ID', 'CONNECTIONPROPERTY']);

type FunctionKind = 'metadata' | 'security' | 'session';

/** Every refused function, lower-cased as {@link spellsName} compares it, with the kind a refusal names. */
const REFUSED_FUNCTIONS: ReadonlyMap<string, { name: string; kind: FunctionKind }> = (() => {
  const all = new Map<string, { name: string; kind: FunctionKind }>();
  const add = (names: Set<string>, kind: FunctionKind) => {
    for (const name of names) all.set(name.toLowerCase(), { name, kind });
  };
  add(METADATA_FUNCTIONS, 'metadata');
  add(SECURITY_FUNCTIONS, 'security');
  add(SESSION_FUNCTIONS, 'session');
  return all;
})();

const FUNCTION_WHY = { metadata: WHY.metadata, security: WHY.security, session: WHY.connection } as const;

/**
 * Security functions written without parentheses. Unqualified, each of these
 * words is the function, so they are refused as words; `[user]` and `t.user`
 * name a column and are accepted.
 */
const NILADIC_PRINCIPAL_WORDS = new Set(['CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER']);

/**
 * Words refused wherever they appear outside a string, comment or quoted
 * identifier, unless they are a later part of a dotted name.
 *
 * The list is drawn from the Transact-SQL statement reference: the words that
 * begin a statement other than SELECT, plus CONVERSATION (which GET, MOVE and
 * END CONVERSATION contain; END itself also closes CASE, so it is not listed).
 * It exists so the statement-start rule also holds WITHOUT a `;`: a second
 * statement written straight after a SELECT has to begin with a statement
 * word, and this list is what refuses it. If the reference gains a statement,
 * its leading word belongs here. A GOTO label (`name:`) has no leading keyword;
 * it runs nothing by itself.
 */
const REFUSED_WORDS: Record<string, string> = {
  EXEC: WHY.dynamic,
  EXECUTE: WHY.dynamic,
  SP_EXECUTESQL: WHY.dynamic,
  CREATE: WHY.ddl,
  ALTER: WHY.ddl,
  DROP: WHY.ddl,
  TRUNCATE: WHY.ddl,
  EXTERNAL: WHY.ddl,
  CREDENTIAL: WHY.ddl,
  ENABLE: WHY.ddl,
  DISABLE: WHY.ddl,
  ADD: WHY.ddl,
  RENAME: WHY.ddl,
  INSERT: WHY.dml,
  UPDATE: WHY.dml,
  DELETE: WHY.dml,
  MERGE: WHY.dml,
  INTO: WHY.dml,
  WRITETEXT: WHY.dml,
  UPDATETEXT: WHY.dml,
  READTEXT: WHY.dml,
  GRANT: WHY.perms,
  REVOKE: WHY.perms,
  DENY: WHY.perms,
  SETUSER: WHY.perms,
  REVERT: WHY.perms,
  USE: WHY.database,
  DECLARE: WHY.session,
  SET: WHY.session,
  OPENDATASOURCE: WHY.external,
  OPENQUERY: WHY.external,
  OPENXML: WHY.external,
  BULK: WHY.external,
  DATA_SOURCE: WHY.external,
  DBCC: WHY.admin,
  BACKUP: WHY.admin,
  RESTORE: WHY.admin,
  KILL: WHY.admin,
  SHUTDOWN: WHY.admin,
  RECONFIGURE: WHY.admin,
  CHECKPOINT: WHY.admin,
  DISK: WHY.admin,
  EXPLAIN: WHY.admin,
  WAITFOR: WHY.control,
  RAISERROR: WHY.control,
  THROW: WHY.control,
  PRINT: WHY.control,
  IF: WHY.control,
  WHILE: WHY.control,
  BEGIN: WHY.control,
  BREAK: WHY.control,
  CONTINUE: WHY.control,
  GOTO: WHY.control,
  RETURN: WHY.control,
  COMMIT: WHY.control,
  ROLLBACK: WHY.control,
  SAVE: WHY.control,
  TRAN: WHY.control,
  TRANSACTION: WHY.control,
  OPEN: WHY.cursor,
  CLOSE: WHY.cursor,
  DEALLOCATE: WHY.cursor,
  SEND: WHY.broker,
  RECEIVE: WHY.broker,
  CONVERSATION: WHY.broker,
};

/**
 * The deny-list's words, for the test that checks every one has a written-out
 * case. Not used by the classifier.
 */
export const REFUSED_WORD_NAMES: readonly string[] = Object.keys(REFUSED_WORDS);

/**
 * Deny-list words refused even as a later part of a dotted name. These name
 * an external source or run text, so they stay refused in every position.
 */
const REFUSED_IN_ANY_POSITION = new Set([
  'EXEC', 'EXECUTE', 'SP_EXECUTESQL', 'OPENDATASOURCE', 'OPENQUERY', 'OPENXML', 'BULK',
]);

/**
 * The system compatibility views. They live in the `sys` schema but resolve
 * without it (`SELECT * FROM sysprocesses`), so the `sys` schema rule alone
 * does not reach them.
 */
const COMPATIBILITY_VIEWS = new Set([
  'SYSALTFILES', 'SYSCACHEOBJECTS', 'SYSCHARSETS', 'SYSCOLUMNS', 'SYSCOMMENTS', 'SYSCONFIGURES',
  'SYSCONSTRAINTS', 'SYSCURCONFIGS', 'SYSDATABASES', 'SYSDEPENDS', 'SYSDEVICES', 'SYSFILEGROUPS',
  'SYSFILES', 'SYSFOREIGNKEYS', 'SYSFULLTEXTCATALOGS', 'SYSINDEXES', 'SYSINDEXKEYS', 'SYSLANGUAGES',
  'SYSLOCKINFO', 'SYSLOGINS', 'SYSMEMBERS', 'SYSMESSAGES', 'SYSOBJECTS', 'SYSOLEDBUSERS',
  'SYSOPENTAPES', 'SYSPERFINFO', 'SYSPERMISSIONS', 'SYSPROCESSES', 'SYSPROTECTS', 'SYSREFERENCES',
  'SYSREMOTELOGINS', 'SYSSERVERS', 'SYSTYPES', 'SYSUSERS', 'SYSXLOGINS',
]);

/** The compatibility views lower-cased, as {@link spellsName} compares them. */
const COMPATIBILITY_VIEW_TARGETS: readonly string[] = [...COMPATIBILITY_VIEWS].map((v) => v.toLowerCase());

/** Read-only `OPENROWSET(BULK …)` options for Synapse Serverless. */
const OPENROWSET_OPTIONS = new Set([
  'FORMAT',
  'FIELDTERMINATOR',
  'ROWTERMINATOR',
  'ESCAPECHAR',
  'ESCAPE_CHAR',
  'FIRSTROW',
  'FIELDQUOTE',
  'DATA_COMPRESSION',
  'PARSER_VERSION',
  'HEADER_ROW',
  'DATAFILETYPE',
  'CODEPAGE',
  'ROWSET_OPTIONS',
  'MAXERRORS',
]);

const STATEMENT_START = new Set(['SELECT', 'WITH']);

function upper(t: TsqlToken | undefined): string {
  return t && t.kind === 'word' ? t.value.toUpperCase() : '';
}

function isPunct(t: TsqlToken | undefined, p: string): boolean {
  return !!t && t.kind === 'punct' && t.value === p;
}

function isNamePart(t: TsqlToken | undefined): boolean {
  return !!t && (t.kind === 'word' || t.kind === 'quoted-ident');
}

/**
 * Is token `i` a later part of a dotted name: preceded by one or more `.`, with
 * a name part before them? `1.` is lexed as one number token, so `SELECT 1.EXEC`
 * is not a dotted name.
 */
function isLaterNamePart(tokens: TsqlToken[], i: number): boolean {
  let k = i - 1;
  if (!isPunct(tokens[k], '.')) return false;
  while (isPunct(tokens[k], '.')) k -= 1;
  return isNamePart(tokens[k]);
}

/** T-SQL removes a backslash followed by a line break inside a string. */
function withoutLineContinuations(value: string): string {
  return value.replace(/\\(?:\r\n|\n|\r)/g, '');
}

/** A string shaped like a storage location. */
function looksLikeStorage(value: string): boolean {
  const v = withoutLineContinuations(value).toLowerCase();
  if (v.length > 2 && v.startsWith('\\\\')) return true;
  if (/(?:^|[^a-z0-9])(?:abfss?|wasbs?|adl|hdfs|s3a?|gs|az):\/\//.test(v)) return true;
  return /\.(?:dfs|blob)\.core\./.test(v) || v.includes('.azuredatalakestore.');
}

/** An option value must not name any location: storage-shaped, or any URL. */
function looksLikeAnyLocation(value: string): boolean {
  return looksLikeStorage(value) || withoutLineContinuations(value).includes('://');
}

function statementStartOk(t: TsqlToken | undefined): boolean {
  return STATEMENT_START.has(upper(t)) || isPunct(t, '(');
}

/**
 * Parse one `OPENROWSET(…)` call starting at `i` (the OPENROWSET word). Returns
 * the index after its closing `)` and the locations it names, or a refusal.
 */
function readOpenrowset(
  tokens: TsqlToken[],
  i: number,
): { next: number; locations: string[] } | QueryRefusal {
  const locations: string[] = [];
  let j = i + 1;
  if (!isPunct(tokens[j], '(')) {
    return refuse('OPENROWSET without an argument list', WHY.external);
  }
  j += 1;
  if (upper(tokens[j]) !== 'BULK') {
    const what = tokens[j]?.text ?? 'end of input';
    return refuse(`OPENROWSET(${what} …)`, 'only the OPENROWSET(BULK …) file form is accepted');
  }
  j += 1;
  const readLocation = (t: TsqlToken | undefined): string | null =>
    t && t.kind === 'string' ? t.value : null;
  if (isPunct(tokens[j], '(')) {
    j += 1;
    for (;;) {
      const loc = readLocation(tokens[j]);
      if (loc === null) {
        return refuse('an OPENROWSET(BULK …) location that is not a literal string', 'each file location must be written out as a quoted URL');
      }
      locations.push(loc);
      j += 1;
      if (isPunct(tokens[j], ',')) { j += 1; continue; }
      if (isPunct(tokens[j], ')')) { j += 1; break; }
      return refuse('an OPENROWSET(BULK …) location built from an expression', 'each file location must be written out as a quoted URL');
    }
  } else {
    const loc = readLocation(tokens[j]);
    if (loc === null) {
      return refuse('an OPENROWSET(BULK …) location that is not a literal string', 'each file location must be written out as a quoted URL');
    }
    locations.push(loc);
    j += 1;
  }
  for (;;) {
    if (isPunct(tokens[j], ')')) return { next: j + 1, locations };
    if (!isPunct(tokens[j], ',')) {
      const what = tokens[j]?.text ?? 'end of input';
      return refuse(`'${what}' inside OPENROWSET(BULK …)`, 'each file location must be written out as a quoted URL, followed only by name = value options');
    }
    j += 1;
    const name = upper(tokens[j]);
    if (!name) {
      return refuse(`'${tokens[j]?.text ?? 'end of input'}' inside OPENROWSET(BULK …)`, 'options are written as name = value');
    }
    if (!OPENROWSET_OPTIONS.has(name)) {
      return refuse(
        `the OPENROWSET option ${tokens[j].text}`,
        name === 'DATA_SOURCE'
          ? 'this lakehouse has no external data source of its own; name each file by its full URL under the lakehouse root'
          : 'only the read-only file-format options are accepted',
      );
    }
    j += 1;
    if (!isPunct(tokens[j], '=')) {
      return refuse(`the OPENROWSET option ${name} without a value`, 'options are written as name = value');
    }
    j += 1;
    // A negative number is lexed as `-` then the number (`MAXERRORS = -1`).
    if (isPunct(tokens[j], '-') && tokens[j + 1]?.kind === 'number') j += 1;
    const v = tokens[j];
    const valueOk = !!v && (
      v.kind === 'number'
      || (v.kind === 'string' && !looksLikeAnyLocation(v.value))
      || (v.kind === 'word' && (upper(v) === 'TRUE' || upper(v) === 'FALSE'))
    );
    if (!valueOk) {
      return refuse(`the value of OPENROWSET option ${name}`, 'an option value is a literal string, number, TRUE or FALSE, and never a storage location');
    }
    j += 1;
  }
}

/**
 * Check one dotted name (1 to n parts, `''` for an omitted part as in `db..t`).
 * Every comparison uses the parts as the server compares them
 * ({@link normalizeNamePart}). `called` is true when `(` follows the name.
 * Returns a refusal or null.
 */
function checkName(rawParts: string[], database: string, databaseLabel: string, called: boolean): QueryRefusal | null {
  const parts: string[] = [];
  for (const raw of rawParts) {
    // A code point whose comparison cannot be known: unassigned, private-use or an unpaired surrogate.
    const unknown = [...raw].find((c) => /[\p{Cn}\p{Co}\p{Cs}]/u.test(c));
    if (unknown !== undefined) {
      return refuse(
        `the name part [${shownNamePart(raw)}]`,
        `it contains ${codePoint(unknown)}, which is unassigned, private-use or an unpaired surrogate, `
        + 'so how the server compares it is not known',
        'Write the name without that character. ' + SELECT_REMEDIATION,
      );
    }
    const part = normalizeNamePart(raw);
    if (part === null) {
      return refuse(
        `the name part [${shownNamePart(raw)}]`,
        'a name part may contain a space only between other characters, and no other whitespace or control character',
        'Write the name without leading spaces, tabs, line breaks, non-breaking spaces or control characters. '
        + SELECT_REMEDIATION,
      );
    }
    parts.push(part);
  }
  const shown = parts.join('.');
  if (parts.length >= 4) {
    return refuse(`the four-part name ${shown}`, 'names that reach another server are not accepted');
  }
  // Every part before the last (a database, schema or table qualifier) is plain ASCII.
  const qualifier = parts.slice(0, -1).find((p) => /[^\x00-\x7f]/.test(p));
  if (qualifier !== undefined) {
    return refuse(
      `the qualifier [${shownNamePart(qualifier)}]`,
      'a database, schema or table qualifier is written in ASCII; only the last part of a name may use other letters',
      'Write the qualifier in ASCII (for example dbo.t or t.col), or give the table an ASCII alias. '
      + SELECT_REMEDIATION,
    );
  }
  // `sys` as a schema: `sys.x`, or `db.sys.x`. The last part is never a schema.
  if (parts.slice(0, -1).some((p) => p.toLowerCase() === 'sys')) {
    return refuse(
      `the sys schema object ${shown}`,
      WHY.catalog,
      'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS. '
      + 'A tenant admin can read the sys catalog.',
    );
  }
  // Every part is refused when it can spell a refused name (spellsName): an ASCII part only when it IS
  // that name, a part with other characters when any reading of them spells it.
  const plain = (p: string) => /^[\x00-\x7f]*$/.test(p);
  for (const part of parts) {
    const view = firstSpelled(part, COMPATIBILITY_VIEW_TARGETS);
    if (view !== undefined) {
      return refuse(
        `the system compatibility view ${shownRead(part, view)}`,
        WHY.catalog,
        (plain(part) ? '' : READ_AS_HINT)
        + 'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS.',
      );
    }
  }
  for (const [k, part] of parts.entries()) {
    const temp = firstSpelled(part, ['##'], true);
    if (temp !== undefined) {
      const name = plain(part) ? shown : parts.map((p, n) => (n === k ? shownRead(p, temp) : p)).join('.');
      return refuse(`the global temporary table ${name}`, WHY.database, (plain(part) ? '' : READ_AS_HINT) + SELECT_REMEDIATION);
    }
  }
  // A bracketed or quoted `fn_` name called as a function; the bare word is refused earlier.
  const last = parts.length - 1;
  const fn = called ? firstSpelled(parts[last], ['fn_'], true) : undefined;
  if (fn !== undefined) {
    return refuse(`the system function ${shownRead(parts[last], fn)}`, WHY.admin);
  }
  // A metadata, security or session function, called. Checked on the last part whatever qualifies
  // it, so `dbo.DB_NAME(…)` is refused too; a qualified call is a user-defined function the tab has
  // no need to run.
  const denied = called ? firstSpelled(parts[last], REFUSED_FUNCTIONS.keys()) : undefined;
  if (denied !== undefined) {
    const { name, kind } = REFUSED_FUNCTIONS.get(denied)!;
    return refuse(
      `the ${kind} function ${plain(parts[last]) ? parts[last] : shownRead(parts[last], name)}`,
      FUNCTION_WHY[kind],
      FUNCTION_REMEDIATION,
    );
  }
  if (parts.length === 3 && parts[0].toLowerCase() !== database) {
    return refuse(
      `the three-part name ${shown}`,
      `a three-part name must start with the database this query runs in (${databaseLabel})`,
      `Name a table as schema.table, and a column as table.column (for example t.col, not dbo.t.col). `
      + SELECT_REMEDIATION,
    );
  }
  return null;
}

/**
 * The word around `pos` when the lexer stopped on a letter outside ASCII, so the
 * refusal can say to bracket it: `SELECT café FROM t` gives `café`. Null when
 * the character at `pos` is not a letter or mark, or the word is longer than a
 * name can be (128 characters).
 */
function unbracketedWordAt(sql: string, pos: number): string | null {
  const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{M}\p{N}_]/u.test(c);
  if (!/[\p{L}\p{M}]/u.test(sql[pos] ?? '')) return null;
  let a = pos;
  let b = pos + 1;
  while (a > 0 && inWord(sql[a - 1])) a -= 1;
  while (b < sql.length && inWord(sql[b])) b += 1;
  return b - a > 128 ? null : sql.slice(a, b);
}

/**
 * Classify caller-authored T-SQL for the lakehouse SQL tab. `database` is the
 * database the query runs in.
 */
export function analyzeLakehouseQuery(sql: string, opts: { database: string }): QueryAnalysis | QueryRefusal {
  const lexed = lexTsql(sql);
  if (!lexed.ok) {
    const word = unbracketedWordAt(sql, lexed.pos);
    return refuse(
      `the text at character ${lexed.pos + 1}`,
      `it could not be read as T-SQL (${lexed.reason})`,
      word === null ? SELECT_REMEDIATION : `If ${word} is a column or table name, write it in brackets, as [${word}]. `
        + SELECT_REMEDIATION,
    );
  }
  const tokens = lexed.tokens;
  if (tokens.length === 0) return refuse('an empty query', 'there is no statement to run');
  if (!statementStartOk(tokens[0])) {
    return refuse(`a statement starting with ${tokens[0].text}`, 'only SELECT statements are run from this tab');
  }

  const database = opts.database.trim().toLowerCase();
  const locations: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.kind === 'punct') {
      if (t.value === ';') {
        let k = i + 1;
        while (isPunct(tokens[k], ';')) k += 1;
        if (k < tokens.length && !statementStartOk(tokens[k])) {
          return refuse(`a statement starting with ${tokens[k].text}`, 'only SELECT statements are run from this tab');
        }
        i = k;
        continue;
      }
      if (t.value === ':' && isPunct(tokens[i + 1], ':')) {
        return refuse('the :: function syntax', WHY.admin);
      }
      i += 1;
      continue;
    }

    if (t.kind === 'variable') {
      return refuse(`the variable ${t.text}`, WHY.session);
    }

    if ((t.kind === 'string' || t.kind === 'quoted-ident') && looksLikeStorage(t.value)) {
      return refuse(
        `the storage location ${t.text}`,
        'a storage location is accepted only as the literal BULK argument of OPENROWSET',
      );
    }

    const laterPart = isLaterNamePart(tokens, i);

    if (t.kind === 'word') {
      const w = t.value.toUpperCase();
      if (w === 'OPENROWSET') {
        const call = readOpenrowset(tokens, i);
        if ('status' in call) return call;
        locations.push(...call.locations);
        i = call.next;
        continue;
      }
      if (w === 'FETCH') {
        const prev = upper(tokens[i - 1]);
        if (prev !== 'ROW' && prev !== 'ROWS') return refuse('FETCH', WHY.cursor, bracketHint(t.text));
        i += 1;
        continue;
      }
      const why = REFUSED_WORDS[w];
      if (why && (!laterPart || REFUSED_IN_ANY_POSITION.has(w))) {
        return refuse(t.text, why, bracketHint(t.text, !REFUSED_IN_ANY_POSITION.has(w)));
      }
      if (/^(SP|XP)_/.test(w) && !laterPart) {
        return refuse(`the system procedure ${t.text}`, WHY.dynamic, bracketHint(t.text));
      }
      if (/^FN_/.test(w)) return refuse(`the system function ${t.text}`, WHY.admin, bracketHint(t.text, false));
      if (NILADIC_PRINCIPAL_WORDS.has(w) && !laterPart) {
        return refuse(`the security function ${t.text}`, WHY.security, bracketHint(t.text, true, FUNCTION_REMEDIATION));
      }
      // NEXT VALUE FOR is on the metadata page and is not written as a call. `FETCH NEXT 10 ROWS` and a
      // column named next are not followed by VALUE FOR.
      if (w === 'NEXT' && !laterPart && upper(tokens[i + 1]) === 'VALUE' && upper(tokens[i + 2]) === 'FOR') {
        return refuse('the metadata function NEXT VALUE FOR', WHY.metadata, FUNCTION_REMEDIATION);
      }
      // A `##` name, bare or bracketed, is refused by checkName below.
    }

    // Dotted names: collect the chain that starts here.
    if (isNamePart(t) && !laterPart) {
      const parts: string[] = [t.value];
      let j = i + 1;
      while (isPunct(tokens[j], '.')) {
        if (isNamePart(tokens[j + 1])) { parts.push(tokens[j + 1].value); j += 2; continue; }
        if (isPunct(tokens[j + 1], '.')) { parts.push(''); j += 1; continue; }
        break;
      }
      const refused = checkName(parts, database, opts.database, isPunct(tokens[j], '('));
      if (refused) return refused;
    }
    i += 1;
  }
  return { ok: true, locations };
}

/**
 * The location as the storage service will read it, or the reason it cannot be
 * accepted. Percent-escapes are decoded only when they form valid UTF-8 for a
 * space, letter, digit or mark, so no escape can produce `/`, `.` or `\`.
 */
function decodeLocation(raw: string): { ok: true; decoded: string } | { ok: false; why: string } {
  if (/[\\?#]/.test(raw)) {
    return { ok: false, why: 'it contains a backslash, a query string or a fragment' };
  }
  let decoded = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '%') {
      const m = /^(?:%[0-9A-Fa-f]{2})+/.exec(raw.slice(i));
      if (!m) return { ok: false, why: 'it contains a % that is not a percent-escape' };
      let text: string;
      try {
        text = decodeURIComponent(m[0]);
      } catch {
        return { ok: false, why: 'it contains a percent-escape that is not valid UTF-8' };
      }
      if (!/^[ \p{L}\p{N}\p{M}]+$/u.test(text)) {
        return { ok: false, why: 'it contains a percent-escape for a character other than a space, a letter or a digit' };
      }
      decoded += text;
      i += m[0].length;
      continue;
    }
    const c = String.fromCodePoint(raw.codePointAt(i) ?? 0);
    const printableAscii = c >= '\x21' && c <= '\x7e';
    if (!printableAscii && c !== ' ' && !/^[\p{L}\p{N}\p{M}]$/u.test(c)) {
      return { ok: false, why: 'it contains a control character, or punctuation outside ASCII' };
    }
    decoded += c;
    i += c.length;
  }
  return { ok: true, decoded };
}

/**
 * Confine one `OPENROWSET(BULK …)` location to the item's storage: its own
 * account (dfs or blob endpoint of the binding's cloud suffix), its container,
 * and strictly under its root — through the same `scopePathToRoot` (strict)
 * the lakehouse routes use. `*` wildcards are accepted only below the root.
 *
 * Spaces and non-ASCII letters are accepted as written or percent-encoded.
 * Backslashes, `?`, `#`, ports, user info, empty segments, `.`/`..` segments,
 * segments that start or end with a space or end with `.`, and escapes for any
 * other character are refused rather than normalised.
 */
export function confineQueryLocation(raw: string, bound: ItemStorageLocation): { ok: true } | QueryRefusal {
  const outside = (why: string): QueryRefusal => ({
    ok: false,
    status: 403,
    code: 'query_location_outside_root',
    construct: raw,
    error: `${LEAD}The location '${raw}' is not accepted: ${why}.`,
    remediation:
      `Read files under ${bound.abfss} (or its https://<account>.dfs.<suffix>/${bound.container}/${bound.root}/ form). `
      + 'A space or a non-ASCII letter in a file name can be written as itself. '
      + 'To read another lakehouse, open that lakehouse and query it there.',
  });

  const read = decodeLocation(raw);
  if (!read.ok) return outside(read.why);
  const host = abfssHost(bound.abfss);
  const hostMatch = host ? /^([^.]+)\.dfs\.(.+)$/i.exec(host) : null;
  if (!hostMatch) return outside("this lakehouse's storage binding has no dfs host to compare it with");
  const account = hostMatch[1].toLowerCase();
  const suffix = hostMatch[2].toLowerCase();

  let urlHost: string;
  let container: string;
  let rest: string;
  const https = /^https:\/\/([^/]+)\/([^/]+)\/(.*)$/i.exec(raw);
  const abfss = /^abfss:\/\/([^@/]+)@([^/]+)\/(.*)$/i.exec(raw);
  if (https) {
    [, urlHost, container, rest] = https;
    const h = urlHost.toLowerCase();
    if (h !== `${account}.dfs.${suffix}` && h !== `${account}.blob.${suffix}`) {
      return outside(`it is not on this lakehouse's storage account (${account}.dfs.${suffix})`);
    }
  } else if (abfss) {
    [, container, urlHost, rest] = abfss;
    if (urlHost.toLowerCase() !== `${account}.dfs.${suffix}`) {
      return outside(`it is not on this lakehouse's storage account (${account}.dfs.${suffix})`);
    }
  } else {
    return outside('it is not a full https:// or abfss:// URL with a container and a path');
  }

  const path = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  // Judge each segment as the service will read it (escapes decoded).
  for (const seg of path.split('/')) {
    const plain = decodeLocation(seg);
    const s = plain.ok ? plain.decoded : seg;
    if (s !== s.trim() || (s.endsWith('.') && s !== '.' && s !== '..')) {
      return outside('a path segment starts or ends with a space, or ends with a dot');
    }
  }
  // `scopePathToRoot` refuses `.`/`..` segments and compares every root segment
  // exactly, so a wildcard can only match below the root. It collapses `//`;
  // the canonical comparison after it refuses that spelling instead.
  const scoped = scopePathToRoot({ container: bound.container, root: bound.root }, container, path, true);
  if (!scoped.ok) {
    if (scoped.reason === 'root-unusable') return outside("this lakehouse's recorded root is not a usable path");
    if (scoped.reason === 'invalid') return outside('its path is not a relative path inside the container');
    return outside(`it is outside this lakehouse's container and root (${bound.container}/${bound.root})`);
  }
  if (scoped.path !== path || scoped.container !== container) {
    return outside('its path is not written in its canonical form');
  }
  return { ok: true };
}
