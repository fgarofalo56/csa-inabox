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
 *     (column names, aliases, built-in functions).
 *   - NAMES are checked by shape: at most three parts, a three-part name must
 *     start with the database the query runs in, nothing in the `sys` schema,
 *     no system compatibility view, no global temporary table. Each part is
 *     compared as the server compares it: trailing spaces removed, and a part
 *     with any other whitespace or control character is refused. A qualifier
 *     (every part before the last) is plain ASCII. A last part that is not
 *     plain ASCII is refused when any reading of it names a system object,
 *     each non-ASCII character read either as its ASCII fold or as nothing.
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
 * they were defined to read, and built-in functions are not restricted. The
 * durable form of this boundary is a per-item serverless database whose external
 * data source is rooted at the item root, with relative `BULK` paths only; that
 * is tracked separately.
 *
 * SECOND SURFACE. The serverless SQL pool editor
 * (`POST /api/items/synapse-serverless-sql-pool/[id]/query`) runs the same
 * classifier for a caller who is not a tenant admin. It passes its own
 * {@link QueryScopeSurface}, so its refusals are worded for that editor, and
 * confines each location with {@link confineQueryLocationToRoots} against the
 * roots of the lakehouses in its workspace instead of one item root. The rules
 * are the same on both surfaces.
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

/**
 * The surface a query runs from, as its refusals name it. The rules are the
 * same on every surface; only the wording differs, so a refusal on the
 * serverless SQL pool editor does not talk about "this lakehouse".
 */
export interface QueryScopeSurface {
  /** The sentence every refusal opens with, ending in a space. */
  lead: string;
  /** The surface as a subject: "the SQL tab". */
  name: string;
  /** The surface as a place: "this tab". */
  place: string;
  /** The files a query may read: "this lakehouse's files". */
  files: string;
  /** What to write instead, ending with what a tenant admin can do. */
  selectRemediation: string;
  /** Why the OPENROWSET `DATA_SOURCE` option is refused. */
  dataSource: string;
}

/** The lakehouse SQL tab (`POST /api/items/lakehouse/[id]/query`), the default surface. */
export const LAKEHOUSE_SQL_TAB: QueryScopeSurface = {
  lead: 'The lakehouse SQL tab runs read-only SELECT queries over this lakehouse\'s own files. ',
  name: 'the SQL tab',
  place: 'this tab',
  files: 'this lakehouse\'s files',
  selectRemediation:
    'Write a SELECT (optionally with a WITH clause) that reads this lakehouse through '
    + "OPENROWSET(BULK 'https://<account>.dfs.<suffix>/<container>/<lakehouse root>/…'). "
    + 'A tenant admin can run other statements.',
  dataSource:
    'this lakehouse has no external data source of its own; name each file by its full URL under the lakehouse root',
};

/** The reason for each refused construct class, worded for one surface. */
function reasons(s: QueryScopeSurface) {
  return {
    dynamic: `dynamic SQL is not run from ${s.place}`,
    ddl: `statements that create, change or remove objects are not run from ${s.place}`,
    dml: `statements that change data are not run from ${s.place}`,
    perms: `permission statements are not run from ${s.place}`,
    database: `the query runs in the database ${s.place} chooses`,
    session: `variables and session options are not accepted in ${s.place}`,
    external: `external data access goes through OPENROWSET(BULK …) on ${s.files} only`,
    admin: `server administration is not run from ${s.place}`,
    control: `control flow and transactions are not accepted in ${s.place}`,
    cursor: `cursors are not accepted in ${s.place}`,
    broker: `Service Broker statements are not run from ${s.place}`,
    catalog: `${s.name} reads ${s.files} and the INFORMATION_SCHEMA views, not the server catalog`,
    select: `only SELECT statements are run from ${s.place}`,
  } as const;
}

type Why = keyof ReturnType<typeof reasons>;

/** The surface and its reasons, passed to every rule. */
interface Scope {
  s: QueryScopeSurface;
  why: Record<Why, string>;
}

function scopeFor(s: QueryScopeSurface): Scope {
  return { s, why: reasons(s) };
}

/** Upper-case the first character, so every refusal reads as a sentence. */
function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function refuse(c: Scope, construct: string, why: string, remediation = c.s.selectRemediation): QueryRefusal {
  return {
    ok: false,
    status: 400,
    code: 'query_construct_not_accepted',
    construct,
    error: `${c.s.lead}${sentence(construct)} is not accepted: ${why}.`,
    remediation,
  };
}

/**
 * Remediation for a refused word that could also be a column or table name.
 * `qualify` is false for a word refused even as a later name part, so the hint
 * offers only the form that is accepted.
 */
function bracketHint(c: Scope, word: string, qualify = true): string {
  const forms = qualify ? `write it in brackets, as [${word}], or qualify it, as t.${word}` : `write it in brackets, as [${word}]`;
  return `If ${word} is a column or table name, ${forms}. ` + c.s.selectRemediation;
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

/** A name part with every character outside printable ASCII written as \u{…}, for a message. */
function shownNamePart(raw: string): string {
  return [...raw].map((c) => (/^[\x21-\x7e]$/.test(c) || c === ' ' ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`)).join('');
}

/**
 * The ASCII readings of one character of a name part, lower-cased. An ASCII
 * character reads as itself. Any other character reads as its compatibility
 * decomposition with everything outside ASCII dropped (fullwidth `ｓ` and `ſ`
 * as `s`, `é` as `e`), OR as nothing: a collation whose tables predate the
 * character gives it no weight and compares the name as if it were absent.
 * Dotless `ı` and dotted `İ` may also read as `i`.
 */
function asciiReadings(c: string): string[] {
  if (c.charCodeAt(0) < 0x80) return [c.toLowerCase()];
  const folded = [...c.normalize('NFKD')].filter((d) => d.charCodeAt(0) < 0x80).join('').toLowerCase();
  const readings = folded ? [folded, ''] : [''];
  if ((c === '\u0131' || c === '\u0130') && !readings.includes('i')) readings.push('i');
  return readings;
}

/** At most this many characters with more than one reading are checked; a part with more is refused. */
const MAX_BRANCHING_CHARACTERS = 16;

const SYSTEM_PREFIXES = ['##', 'fn_', 'sp_', 'xp_'];

/** `sys` and every compatibility view, lower-cased. */
function systemNames(): Set<string> {
  return new Set(['sys', ...[...COMPATIBILITY_VIEWS].map((v) => v.toLowerCase())]);
}

/**
 * For a last name part that is not plain ASCII: whether any reading of it
 * (each character read as in {@link asciiReadings}) is `sys`, a compatibility
 * view, or starts with `##`, `fn_`, `sp_` or `xp_`. Returns the full name it
 * reads as, `'unclassifiable'` for a part with more than
 * {@link MAX_BRANCHING_CHARACTERS} characters that have more than one reading,
 * or null. A plain ASCII part is left to the rules that compare it as written,
 * so `t.sp_rating` and an uncalled `[fn_total]` stay accepted.
 *
 * The walk keeps only readings that are still the start of a system name, and
 * each distinct one once, so it never holds more states than there are such
 * starts, whatever the length of the part.
 */
function foldedSystemName(part: string): { name: string } | 'unclassifiable' | null {
  if (/^[\x00-\x7f]*$/.test(part)) return null;
  const readings = [...part].map(asciiReadings);
  if (readings.filter((r) => r.length > 1).length > MAX_BRANCHING_CHARACTERS) return 'unclassifiable';
  const names = systemNames();
  const live = (s: string) =>
    [...names].some((n) => n.startsWith(s)) || SYSTEM_PREFIXES.some((p) => p.startsWith(s));
  let states = new Set<string>(['']);
  for (let i = 0; i < readings.length; i += 1) {
    const next = new Set<string>();
    for (const s of states) {
      for (const r of readings[i]) {
        const n = s + r;
        if (SYSTEM_PREFIXES.some((p) => n.startsWith(p))) {
          // Name the whole part as read: the rest in its first reading.
          return { name: n + readings.slice(i + 1).map((rest) => rest[0]).join('') };
        }
        if (live(n)) next.add(n);
      }
    }
    states = next;
    if (states.size === 0) return null;
  }
  for (const s of states) if (names.has(s)) return { name: s };
  return null;
}

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
const REFUSED_WORDS: Record<string, Why> = {
  EXEC: 'dynamic',
  EXECUTE: 'dynamic',
  SP_EXECUTESQL: 'dynamic',
  CREATE: 'ddl',
  ALTER: 'ddl',
  DROP: 'ddl',
  TRUNCATE: 'ddl',
  EXTERNAL: 'ddl',
  CREDENTIAL: 'ddl',
  ENABLE: 'ddl',
  DISABLE: 'ddl',
  ADD: 'ddl',
  RENAME: 'ddl',
  INSERT: 'dml',
  UPDATE: 'dml',
  DELETE: 'dml',
  MERGE: 'dml',
  INTO: 'dml',
  WRITETEXT: 'dml',
  UPDATETEXT: 'dml',
  READTEXT: 'dml',
  GRANT: 'perms',
  REVOKE: 'perms',
  DENY: 'perms',
  SETUSER: 'perms',
  REVERT: 'perms',
  USE: 'database',
  DECLARE: 'session',
  SET: 'session',
  OPENDATASOURCE: 'external',
  OPENQUERY: 'external',
  OPENXML: 'external',
  BULK: 'external',
  DATA_SOURCE: 'external',
  DBCC: 'admin',
  BACKUP: 'admin',
  RESTORE: 'admin',
  KILL: 'admin',
  SHUTDOWN: 'admin',
  RECONFIGURE: 'admin',
  CHECKPOINT: 'admin',
  DISK: 'admin',
  EXPLAIN: 'admin',
  WAITFOR: 'control',
  RAISERROR: 'control',
  THROW: 'control',
  PRINT: 'control',
  IF: 'control',
  WHILE: 'control',
  BEGIN: 'control',
  BREAK: 'control',
  CONTINUE: 'control',
  GOTO: 'control',
  RETURN: 'control',
  COMMIT: 'control',
  ROLLBACK: 'control',
  SAVE: 'control',
  TRAN: 'control',
  TRANSACTION: 'control',
  OPEN: 'cursor',
  CLOSE: 'cursor',
  DEALLOCATE: 'cursor',
  SEND: 'broker',
  RECEIVE: 'broker',
  CONVERSATION: 'broker',
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
  c: Scope,
  tokens: TsqlToken[],
  i: number,
): { next: number; locations: string[] } | QueryRefusal {
  const locations: string[] = [];
  let j = i + 1;
  if (!isPunct(tokens[j], '(')) {
    return refuse(c, 'OPENROWSET without an argument list', c.why.external);
  }
  j += 1;
  if (upper(tokens[j]) !== 'BULK') {
    const what = tokens[j]?.text ?? 'end of input';
    return refuse(c, `OPENROWSET(${what} …)`, 'only the OPENROWSET(BULK …) file form is accepted');
  }
  j += 1;
  const readLocation = (t: TsqlToken | undefined): string | null =>
    t && t.kind === 'string' ? t.value : null;
  if (isPunct(tokens[j], '(')) {
    j += 1;
    for (;;) {
      const loc = readLocation(tokens[j]);
      if (loc === null) {
        return refuse(c, 'an OPENROWSET(BULK …) location that is not a literal string', 'each file location must be written out as a quoted URL');
      }
      locations.push(loc);
      j += 1;
      if (isPunct(tokens[j], ',')) { j += 1; continue; }
      if (isPunct(tokens[j], ')')) { j += 1; break; }
      return refuse(c, 'an OPENROWSET(BULK …) location built from an expression', 'each file location must be written out as a quoted URL');
    }
  } else {
    const loc = readLocation(tokens[j]);
    if (loc === null) {
      return refuse(c, 'an OPENROWSET(BULK …) location that is not a literal string', 'each file location must be written out as a quoted URL');
    }
    locations.push(loc);
    j += 1;
  }
  for (;;) {
    if (isPunct(tokens[j], ')')) return { next: j + 1, locations };
    if (!isPunct(tokens[j], ',')) {
      const what = tokens[j]?.text ?? 'end of input';
      return refuse(c, `'${what}' inside OPENROWSET(BULK …)`, 'each file location must be written out as a quoted URL, followed only by name = value options');
    }
    j += 1;
    const name = upper(tokens[j]);
    if (!name) {
      return refuse(c, `'${tokens[j]?.text ?? 'end of input'}' inside OPENROWSET(BULK …)`, 'options are written as name = value');
    }
    if (!OPENROWSET_OPTIONS.has(name)) {
      return refuse(c, 
        `the OPENROWSET option ${tokens[j].text}`,
        name === 'DATA_SOURCE'
          ? c.s.dataSource
          : 'only the read-only file-format options are accepted',
      );
    }
    j += 1;
    if (!isPunct(tokens[j], '=')) {
      return refuse(c, `the OPENROWSET option ${name} without a value`, 'options are written as name = value');
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
      return refuse(c, `the value of OPENROWSET option ${name}`, 'an option value is a literal string, number, TRUE or FALSE, and never a storage location');
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
function checkName(c: Scope, rawParts: string[], database: string, databaseLabel: string, called: boolean): QueryRefusal | null {
  const parts: string[] = [];
  for (const raw of rawParts) {
    const part = normalizeNamePart(raw);
    if (part === null) {
      return refuse(c, 
        `the name part [${shownNamePart(raw)}]`,
        'a name part may contain a space only between other characters, and no other whitespace or control character',
        'Write the name without leading spaces, tabs, line breaks, non-breaking spaces or control characters. '
        + c.s.selectRemediation,
      );
    }
    parts.push(part);
  }
  const shown = parts.join('.');
  if (parts.length >= 4) {
    return refuse(c, `the four-part name ${shown}`, 'names that reach another server are not accepted');
  }
  // Every part before the last (a database, schema or table qualifier) is plain ASCII.
  const qualifier = parts.slice(0, -1).find((p) => /[^\x00-\x7f]/.test(p));
  if (qualifier !== undefined) {
    return refuse(c,
      `the qualifier [${shownNamePart(qualifier)}]`,
      'a database, schema or table qualifier is written in ASCII; only the last part of a name may use other letters',
      'Write the qualifier in ASCII (for example dbo.t or t.col), or give the table an ASCII alias. '
      + c.s.selectRemediation,
    );
  }
  // `sys` as a schema: `sys.x`, or `db.sys.x`. The last part is never a schema.
  if (parts.slice(0, -1).some((p) => p.toLowerCase() === 'sys')) {
    return refuse(c, 
      `the sys schema object ${shown}`,
      c.why.catalog,
      'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS. '
      + 'A tenant admin can read the sys catalog.',
    );
  }
  // ASCII case only: a part that is not plain ASCII is compared through foldedSystemName below.
  const view = parts.find((p) => COMPATIBILITY_VIEWS.has(p.replace(/[a-z]+/g, (s) => s.toUpperCase())));
  if (view !== undefined) {
    return refuse(c, 
      `the system compatibility view ${view}`,
      c.why.catalog,
      'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS.',
    );
  }
  if (parts.some((p) => p.startsWith('##'))) {
    return refuse(c, `the global temporary table ${shown}`, c.why.database);
  }
  // A bracketed or quoted `fn_` name called as a function; the bare word is refused earlier.
  const last = parts[parts.length - 1];
  if (called && /^fn_/i.test(last)) {
    return refuse(c, `the system function ${last}`, c.why.admin);
  }
  const folded = foldedSystemName(last);
  if (folded === 'unclassifiable') {
    return refuse(c,
      `the name part [${shownNamePart(last)}]`,
      `it has more than ${MAX_BRANCHING_CHARACTERS} characters outside ASCII that a collation may read as a letter `
      + 'or skip, too many to check against the system object names',
      'Write the name in ASCII, or give it an ASCII alias. ' + c.s.selectRemediation,
    );
  }
  if (folded !== null) {
    return refuse(c,
      `the name part [${shownNamePart(last)}], read as ${folded.name}`,
      'with letter width and accents folded, and characters a collation may not define skipped, it names a system object',
      'If it is a column or table of yours, write its name in ASCII or without those characters. '
      + c.s.selectRemediation,
    );
  }
  if (parts.length === 3 && parts[0].toLowerCase() !== database) {
    return refuse(c, 
      `the three-part name ${shown}`,
      `a three-part name must start with the database this query runs in (${databaseLabel})`,
      `Name a table as schema.table, and a column as table.column (for example t.col, not dbo.t.col). `
      + c.s.selectRemediation,
    );
  }
  return null;
}

/**
 * Classify caller-authored T-SQL. `database` is the database the query runs
 * in; `surface` words the refusals for the surface running it (the lakehouse
 * SQL tab when omitted). The rules do not depend on `surface`.
 */
export function analyzeLakehouseQuery(
  sql: string,
  opts: { database: string; surface?: QueryScopeSurface },
): QueryAnalysis | QueryRefusal {
  const c = scopeFor(opts.surface ?? LAKEHOUSE_SQL_TAB);
  const lexed = lexTsql(sql);
  if (!lexed.ok) {
    return refuse(c, `the text at character ${lexed.pos + 1}`, `it could not be read as T-SQL (${lexed.reason})`);
  }
  const tokens = lexed.tokens;
  if (tokens.length === 0) return refuse(c, 'an empty query', 'there is no statement to run');
  if (!statementStartOk(tokens[0])) {
    return refuse(c, `a statement starting with ${tokens[0].text}`, c.why.select);
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
          return refuse(c, `a statement starting with ${tokens[k].text}`, c.why.select);
        }
        i = k;
        continue;
      }
      if (t.value === ':' && isPunct(tokens[i + 1], ':')) {
        return refuse(c, 'the :: function syntax', c.why.admin);
      }
      i += 1;
      continue;
    }

    if (t.kind === 'variable') {
      return refuse(c, `the variable ${t.text}`, c.why.session);
    }

    if ((t.kind === 'string' || t.kind === 'quoted-ident') && looksLikeStorage(t.value)) {
      return refuse(c, 
        `the storage location ${t.text}`,
        'a storage location is accepted only as the literal BULK argument of OPENROWSET',
      );
    }

    const laterPart = isLaterNamePart(tokens, i);

    if (t.kind === 'word') {
      const w = t.value.toUpperCase();
      if (w === 'OPENROWSET') {
        const call = readOpenrowset(c, tokens, i);
        if ('status' in call) return call;
        locations.push(...call.locations);
        i = call.next;
        continue;
      }
      if (w === 'FETCH') {
        const prev = upper(tokens[i - 1]);
        if (prev !== 'ROW' && prev !== 'ROWS') return refuse(c, 'FETCH', c.why.cursor, bracketHint(c, t.text));
        i += 1;
        continue;
      }
      const why = REFUSED_WORDS[w];
      if (why && (!laterPart || REFUSED_IN_ANY_POSITION.has(w))) {
        return refuse(c, t.text, c.why[why], bracketHint(c, t.text, !REFUSED_IN_ANY_POSITION.has(w)));
      }
      if (/^(SP|XP)_/.test(w) && !laterPart) {
        return refuse(c, `the system procedure ${t.text}`, c.why.dynamic, bracketHint(c, t.text));
      }
      if (/^FN_/.test(w)) return refuse(c, `the system function ${t.text}`, c.why.admin, bracketHint(c, t.text, false));
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
      const refused = checkName(c, parts, database, opts.database, isPunct(tokens[j], '('));
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

/** A full `https://<host>/<container>/<path>` location. */
const HTTPS_LOCATION = /^https:\/\/([^/]+)\/([^/]+)\/(.*)$/i;
/** A full `abfss://<container>@<host>/<path>` location. */
const ABFSS_LOCATION = /^abfss:\/\/([^@/]+)@([^/]+)\/(.*)$/i;

/** A location's verdict against one storage binding: accepted, or the reason it is not. */
type LocationVerdict = { ok: true } | { ok: false; why: string };

/**
 * Is `raw` inside `bound`: its own account (dfs or blob endpoint of the
 * binding's cloud suffix), its container, and strictly under its root —
 * through the same `scopePathToRoot` (strict) the lakehouse routes use. `*`
 * wildcards are accepted only below the root.
 *
 * Spaces and non-ASCII letters are accepted as written or percent-encoded.
 * Backslashes, `?`, `#`, ports, user info, empty segments, `.`/`..` segments,
 * segments that start or end with a space or end with `.`, and escapes for any
 * other character are refused rather than normalised.
 */
function locationVerdict(raw: string, bound: ItemStorageLocation): LocationVerdict {
  const outside = (why: string): LocationVerdict => ({ ok: false, why });

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
  const https = HTTPS_LOCATION.exec(raw);
  const abfss = ABFSS_LOCATION.exec(raw);
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

function locationRefusal(s: QueryScopeSurface, raw: string, why: string, remediation: string): QueryRefusal {
  return {
    ok: false,
    status: 403,
    code: 'query_location_outside_root',
    construct: raw,
    error: `${s.lead}The location '${raw}' is not accepted: ${why}.`,
    remediation,
  };
}

/**
 * Confine one `OPENROWSET(BULK …)` location to the item's own storage binding
 * (see {@link locationVerdict} for what is accepted).
 */
export function confineQueryLocation(raw: string, bound: ItemStorageLocation): { ok: true } | QueryRefusal {
  const v = locationVerdict(raw, bound);
  if (v.ok) return v;
  return locationRefusal(
    LAKEHOUSE_SQL_TAB,
    raw,
    v.why,
    `Read files under ${bound.abfss} (or its https://<account>.dfs.<suffix>/${bound.container}/${bound.root}/ form). `
    + 'A space or a non-ASCII letter in a file name can be written as itself. '
    + 'To read another lakehouse, open that lakehouse and query it there.',
  );
}

/**
 * Confine one `OPENROWSET(BULK …)` location to a SET of storage roots: it is
 * accepted when it is inside at least one of `bounds`, by the same
 * {@link locationVerdict} a single item root uses. With no bounds nothing is
 * accepted.
 *
 * A location that could not be inside ANY root (an escape that is not
 * accepted, or not a full https:// / abfss:// URL) is refused with that
 * reason; any other is refused with `opts.outside`, because the reason one
 * particular root gave would describe a root the caller did not choose.
 */
export function confineQueryLocationToRoots(
  raw: string,
  bounds: readonly ItemStorageLocation[],
  opts: { surface: QueryScopeSurface; outside: string; remediation: string },
): { ok: true } | QueryRefusal {
  const read = decodeLocation(raw);
  if (!read.ok) return locationRefusal(opts.surface, raw, read.why, opts.remediation);
  if (!HTTPS_LOCATION.test(raw) && !ABFSS_LOCATION.test(raw)) {
    return locationRefusal(
      opts.surface, raw, 'it is not a full https:// or abfss:// URL with a container and a path', opts.remediation,
    );
  }
  for (const bound of bounds) {
    if (locationVerdict(raw, bound).ok) return { ok: true };
  }
  return locationRefusal(opts.surface, raw, opts.outside, opts.remediation);
}

