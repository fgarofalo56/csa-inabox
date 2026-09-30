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
 *     plain ASCII is refused when, with width, accents and other non-ASCII
 *     characters set aside, it reads as a system name.
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
 * offers only the form that is accepted.
 */
function bracketHint(word: string, qualify = true): string {
  const forms = qualify ? `write it in brackets, as [${word}], or qualify it, as t.${word}` : `write it in brackets, as [${word}]`;
  return `If ${word} is a column or table name, ${forms}. ` + SELECT_REMEDIATION;
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
 * The ASCII letters a name part keeps once compatibility forms are folded
 * (fullwidth letters, `ſ`), accents are separated from their letters, and
 * everything still outside ASCII is dropped; lower-cased. A collation that
 * ignores width, accents or some characters cannot see more than this.
 */
function asciiSkeleton(part: string): string {
  return part.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
}

/**
 * For a last name part that is not plain ASCII: the system name it folds into
 * (the `sys` schema, a compatibility view, or a `##`, `fn_`, `sp_` or `xp_`
 * name), or null. A plain ASCII part is left to the rules that compare it as
 * written, so `t.sp_rating` and an uncalled `[fn_total]` stay accepted.
 */
function foldedSystemName(part: string): string | null {
  if (/^[\x00-\x7f]*$/.test(part)) return null;
  const s = asciiSkeleton(part);
  if (s === 'sys' || COMPATIBILITY_VIEWS.has(s.toUpperCase()) || /^(?:##|fn_|sp_|xp_)/.test(s)) return s;
  return null;
}

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
} as const;

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
  // ASCII case only: a part that is not plain ASCII is compared through foldedSystemName below.
  const view = parts.find((p) => COMPATIBILITY_VIEWS.has(p.replace(/[a-z]+/g, (s) => s.toUpperCase())));
  if (view !== undefined) {
    return refuse(
      `the system compatibility view ${view}`,
      WHY.catalog,
      'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS.',
    );
  }
  if (parts.some((p) => p.startsWith('##'))) {
    return refuse(`the global temporary table ${shown}`, WHY.database);
  }
  // A bracketed or quoted `fn_` name called as a function; the bare word is refused earlier.
  const last = parts[parts.length - 1];
  if (called && /^fn_/i.test(last)) {
    return refuse(`the system function ${last}`, WHY.admin);
  }
  const folded = foldedSystemName(last);
  if (folded !== null) {
    return refuse(
      `the name part [${shownNamePart(last)}], read as ${folded}`,
      'with letter width, accents and other non-ASCII characters set aside it names a system object',
      'If it is a column or table of yours, write its name in ASCII or without those characters. '
      + SELECT_REMEDIATION,
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
 * Classify caller-authored T-SQL for the lakehouse SQL tab. `database` is the
 * database the query runs in.
 */
export function analyzeLakehouseQuery(sql: string, opts: { database: string }): QueryAnalysis | QueryRefusal {
  const lexed = lexTsql(sql);
  if (!lexed.ok) {
    return refuse(`the text at character ${lexed.pos + 1}`, `it could not be read as T-SQL (${lexed.reason})`);
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
