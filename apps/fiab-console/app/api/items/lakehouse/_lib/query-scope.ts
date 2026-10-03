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
 *   - A call to a metadata, security, cryptographic or session function
 *     (`METADATA_FUNCTIONS`, `SECURITY_FUNCTIONS`, `CRYPTOGRAPHIC_FUNCTIONS`,
 *     `SESSION_FUNCTIONS`), `NEXT VALUE FOR`, and the security functions
 *     written without parentheses (`CURRENT_USER`, `SESSION_USER`,
 *     `SYSTEM_USER`, `USER`). Other built-in functions (COUNT, CAST, DATEADD,
 *     ISNULL, HASHBYTES, …) are accepted.
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
 * they were defined to read, and built-in functions outside the four lists
 * above are not restricted. The
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
  /**
   * True when the surface runs SQL that a compiler built from a canvas, with
   * every name it writes in brackets. A refused word there (the `INTO` of a
   * Sink) was written by the compiler, so the hint to bracket or qualify it is
   * left out. Absent on the surfaces where the caller types the SQL, which
   * keep the hint.
   */
  generated?: boolean;
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
    metadata: `metadata functions are not run from ${s.place} for a caller who is not a tenant admin; `
      + 'several of them take another database\'s id or name',
    security: `security functions are not run from ${s.place} for a caller who is not a tenant admin; `
      + 'they return or test logins, users, roles, permissions, certificates or keys',
    connection: `functions that describe the session, its connection or its host are not run from ${s.place} `
      + 'for a caller who is not a tenant admin',
    cryptographic: 'cryptographic functions that use or describe the server\'s keys and certificates are not run '
      + `from ${s.place} for a caller who is not a tenant admin`,
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
 * offers only the form that is accepted. `then` is the sentence that follows.
 * On a surface whose SQL is generated, `then` alone (see `generated`).
 */
function bracketHint(c: Scope, word: string, qualify = true, then = c.s.selectRemediation): string {
  if (c.s.generated) return then;
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
 * Letters with no decomposition that a collation may compare as other letters,
 * each with the ASCII it reads as. The sharp s (`ß`, `ẞ`) case-folds to
 * `ss`; that is not a decomposition, so NFKD never produces it. Dotless `ı`
 * compares as `i` under a Turkish collation. `æ`, `œ` and `þ` are compared
 * as `ae`, `oe` and `th` by some collations. Dotted `İ` decomposes to `I` and
 * a combining dot, which the mark rule removes. This is the only list of
 * characters the reading rule uses.
 */
const LETTER_EXPANSIONS: Readonly<Record<string, string>> = {
  '\u00df': 'ss', '\u1e9e': 'ss', '\u0131': 'i',
  '\u00e6': 'ae', '\u00c6': 'ae', '\u0153': 'oe', '\u0152': 'oe', '\u00fe': 'th', '\u00de': 'th',
};

/**
 * The lower-case ASCII a character outside ASCII may stand for, or '' when it
 * has none. The character is NFKD-decomposed, each letter of the decomposition
 * that {@link LETTER_EXPANSIONS} lists reads as its expansion, combining marks
 * (`Mn`, `Me`) are removed, the result is lower-cased, and every character
 * still outside ASCII is dropped. So `ŀ` (`l` and a middle dot) reads as `l`,
 * `ŉ` (an apostrophe and `n`) as `n`, and `℃` (a degree sign and `C`) as `c`:
 * the non-ASCII part of a decomposition reads as nothing, as it may when it is
 * written on its own.
 *
 * What it covers: wherever the case-folded NFKC fold is ASCII, this fold
 * contains it (NFKC is the composition of NFKD, and an ASCII string composes to
 * itself). It is wider in three ways, each of which refuses more, never less:
 * an accented letter reads as its base letter (the database a caller who is
 * not a tenant admin queries is serverless `master`, whose collation is
 * accent-sensitive, so this is wider than that collation needs); dotless i
 * reads as `i`; and the ASCII letters of a decomposition are kept when the
 * rest of it is not ASCII. Letters with no decomposition that an
 * accent-insensitive collation might equate with a base letter (`ø`, `ł`) are
 * not mapped.
 */
function asciiFold(c: string): string {
  const f = [...c.normalize('NFKD')]
    .map((d) => LETTER_EXPANSIONS[d] ?? d)
    .join('')
    .replace(/[\p{Mn}\p{Me}]/gu, '')
    .toLowerCase();
  return f.replace(/[^\x00-\x7f]/g, '');
}

/**
 * Can `part` spell `target` (lower-case ASCII)? This is the whole reading rule,
 * and it is closed: no list of characters decides it beyond the letter
 * expansions {@link asciiFold} applies.
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
 * forms of a character are identical, and compatibility forms (long s,
 * circled letters, ligatures, superscripts) may compare as their plain
 * letters (Microsoft Learn, "Collation and Unicode support"). Accents are
 * removed too, which only an accent-insensitive (`_AI`) collation needs; the
 * reader's database, `master`, is accent-sensitive, so that part refuses more
 * than it must.
 *
 * `prefix`: the target need only begin the part (`##`, `fn_`). A fold of
 * several letters that starts inside the target and runs past its end also
 * completes a prefix match.
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
      else if (prefix && fold !== '' && j < m && fold.startsWith(target.slice(j))) next[m] = true;
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

/** Where a name stands: in a column position, as a table (after FROM, JOIN, APPLY or WITH), or called. */
type NamePosition = 'column' | 'table' | 'call';

/** Clause words that decide a name's position; the last one seen at the same parenthesis depth wins. */
const CLAUSE_WORDS = new Set(['SELECT', 'FROM', 'JOIN', 'APPLY', 'WITH', 'WHERE', 'ON', 'GROUP', 'ORDER',
  'HAVING', 'UNION', 'EXCEPT', 'INTERSECT']);
const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'APPLY', 'WITH']);

/**
 * The reason given when a name with letters outside ASCII is refused for the
 * name it reads as: it says why it reads that way, then the rule's own reason.
 */
function readAsWhy(readsAs: string, why: string): string {
  return `non-ASCII letters in this name may be read as their plain form or ignored, so it reads as ${readsAs}; ${why}`;
}

/**
 * Remediation added when a part was refused for the name it reads as. SELECT *
 * returns a column without naming it, so it is offered only for a column.
 */
function readAsHint(position: NamePosition): string {
  if (position === 'column') {
    return 'If it is a column of yours, SELECT * returns it without naming it, or ask a tenant admin to run the query. ';
  }
  return `If it is a ${position === 'call' ? 'function' : 'table'} of yours, ask a tenant admin to run the query. `;
}

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
 * CURRENT_USER, SESSION_USER and SYSTEM_USER are words, refused below.
 */
const SECURITY_FUNCTIONS = new Set([
  'CERTENCODED', 'CERTPRIVATEKEY', 'PWDCOMPARE', 'PWDENCRYPT', 'HAS_PERMS_BY_NAME', 'PERMISSIONS',
  'IS_MEMBER', 'IS_ROLEMEMBER', 'IS_SRVROLEMEMBER', 'LOGINPROPERTY', 'ORIGINAL_LOGIN',
  'SUSER_ID', 'SUSER_SID', 'SUSER_SNAME', 'SUSER_NAME', 'USER_ID', 'USER_NAME',
]);

/**
 * Every function on Microsoft Learn's "Cryptographic functions" page that uses
 * or describes a key or certificate the server holds: their ids, names and
 * properties, and the encryption, decryption and signing functions that take
 * one. CERTENCODED and CERTPRIVATEKEY are on this page and the security page,
 * and take the security reason. Accepted from the page: HASHBYTES and the
 * two functions that encrypt and decrypt with a passphrase, which take
 * everything they use as arguments and read nothing the server holds. Also
 * refused, though the page does not list them: CERT_ID and CERTPROPERTY.
 */
const CRYPTOGRAPHIC_FUNCTIONS = new Set([
  'ENCRYPTBYKEY', 'DECRYPTBYKEY', 'KEY_ID', 'KEY_GUID', 'DECRYPTBYKEYAUTOASYMKEY', 'KEY_NAME', 'SYMKEYPROPERTY',
  'ENCRYPTBYASYMKEY', 'DECRYPTBYASYMKEY', 'ENCRYPTBYCERT', 'DECRYPTBYCERT', 'ASYMKEYPROPERTY', 'ASYMKEY_ID',
  'SIGNBYASYMKEY', 'VERIFYSIGNEDBYASYMKEY', 'SIGNBYCERT', 'VERIFYSIGNEDBYCERT', 'IS_OBJECTSIGNED',
  'DECRYPTBYKEYAUTOCERT',
  // Not on the cryptographic page.
  'CERT_ID', 'CERTPROPERTY',
]);

/** Functions that return the session's settings, host or connection details. Not on any of the pages. */
const SESSION_FUNCTIONS = new Set(['HOST_NAME', 'HOST_ID', 'CONNECTIONPROPERTY', 'SESSIONPROPERTY', 'CONTEXT_INFO']);

type FunctionKind = 'metadata' | 'security' | 'cryptographic' | 'session';

/** Every refused function, lower-cased as {@link spellsName} compares it, with the kind a refusal names. */
const REFUSED_FUNCTIONS: ReadonlyMap<string, { name: string; kind: FunctionKind }> = (() => {
  const all = new Map<string, { name: string; kind: FunctionKind }>();
  const add = (names: Set<string>, kind: FunctionKind) => {
    for (const name of names) all.set(name.toLowerCase(), { name, kind });
  };
  add(METADATA_FUNCTIONS, 'metadata');
  add(SECURITY_FUNCTIONS, 'security');
  add(CRYPTOGRAPHIC_FUNCTIONS, 'cryptographic');
  add(SESSION_FUNCTIONS, 'session');
  return all;
})();

const FUNCTION_WHY: Readonly<Record<FunctionKind, Why>> = {
  metadata: 'metadata', security: 'security', cryptographic: 'cryptographic', session: 'connection',
};

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
 * ({@link normalizeNamePart}). `position` is `call` when `(` follows the name.
 * Returns a refusal or null.
 */
function checkName(
  c: Scope, rawParts: string[], database: string, databaseLabel: string, position: NamePosition,
): QueryRefusal | null {
  const called = position === 'call';
  const parts: string[] = [];
  for (const raw of rawParts) {
    // A code point whose comparison cannot be known: unassigned, private-use or an unpaired surrogate.
    const unknown = [...raw].find((ch) => /[\p{Cn}\p{Co}\p{Cs}]/u.test(ch));
    if (unknown !== undefined) {
      return refuse(c,
        `the name part [${shownNamePart(raw)}]`,
        `it contains ${codePoint(unknown)}, which is unassigned, private-use or an unpaired surrogate, `
        + 'so how the server compares it is not known',
        'Write the name without that character. ' + c.s.selectRemediation,
      );
    }
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
  // Every part is refused when it can spell a refused name (spellsName): an ASCII part only when it IS
  // that name, a part with other characters when any reading of them spells it.
  const plain = (p: string) => /^[\x00-\x7f]*$/.test(p);
  for (const part of parts) {
    const view = firstSpelled(part, COMPATIBILITY_VIEW_TARGETS);
    if (view !== undefined) {
      const metadata = 'For table and column metadata, query INFORMATION_SCHEMA.TABLES or INFORMATION_SCHEMA.COLUMNS.';
      return plain(part)
        ? refuse(c, `the system compatibility view ${part}`, c.why.catalog, metadata)
        : refuse(c, `the name [${shownNamePart(part)}]`, readAsWhy(`the system compatibility view ${view}`, c.why.catalog),
          readAsHint(position) + metadata);
    }
  }
  for (const [k, part] of parts.entries()) {
    const temp = firstSpelled(part, ['##'], true);
    if (temp !== undefined) {
      if (plain(part)) return refuse(c, `the global temporary table ${shown}`, c.why.database);
      const name = parts.map((p, n) => (n === k ? `[${shownNamePart(p)}]` : p)).join('.');
      return refuse(c, `the name ${name}`, readAsWhy(`the global temporary table ${temp}`, c.why.database),
        readAsHint(position) + c.s.selectRemediation);
    }
  }
  // A bracketed or quoted `fn_` name called as a function; the bare word is refused earlier.
  const last = parts.length - 1;
  const fn = called ? firstSpelled(parts[last], ['fn_'], true) : undefined;
  if (fn !== undefined) {
    return plain(parts[last])
      ? refuse(c, `the system function ${parts[last]}`, c.why.admin)
      : refuse(c, `the name [${shownNamePart(parts[last])}]`, readAsWhy(`the system function ${fn}`, c.why.admin),
        readAsHint(position) + c.s.selectRemediation);
  }
  // A metadata, security, cryptographic or session function, called. Checked on the last part whatever qualifies
  // it, so `dbo.DB_NAME(…)` is refused too; a qualified call is a user-defined function the tab has
  // no need to run.
  const denied = called ? firstSpelled(parts[last], REFUSED_FUNCTIONS.keys()) : undefined;
  if (denied !== undefined) {
    const { name, kind } = REFUSED_FUNCTIONS.get(denied)!;
    const why = c.why[FUNCTION_WHY[kind]];
    return plain(parts[last])
      ? refuse(c, `the ${kind} function ${parts[last]}`, why, FUNCTION_REMEDIATION)
      : refuse(c, `the name [${shownNamePart(parts[last])}]`, readAsWhy(`the ${kind} function ${name}`, why),
        readAsHint(position) + FUNCTION_REMEDIATION);
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
    const word = unbracketedWordAt(sql, lexed.pos);
    return refuse(c,
      `the text at character ${lexed.pos + 1}`,
      `it could not be read as T-SQL (${lexed.reason})`,
      word === null ? c.s.selectRemediation : `If ${word} is a column or table name, write it in brackets, as [${word}]. `
        + c.s.selectRemediation,
    );
  }
  const tokens = lexed.tokens;
  if (tokens.length === 0) return refuse(c, 'an empty query', 'there is no statement to run');
  if (!statementStartOk(tokens[0])) {
    return refuse(c, `a statement starting with ${tokens[0].text}`, c.why.select);
  }

  const database = opts.database.trim().toLowerCase();
  const locations: string[] = [];
  // The clause word last seen at each parenthesis depth, for a refusal's remediation (NamePosition).
  const clauses: string[] = [''];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.kind === 'punct') {
      if (t.value === '(') clauses.push('');
      else if (t.value === ')' && clauses.length > 1) clauses.pop();
      if (t.value === ';') {
        clauses.length = 1;
        clauses[0] = '';
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
      if (!laterPart && CLAUSE_WORDS.has(w)) clauses[clauses.length - 1] = w;
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
      if (NILADIC_PRINCIPAL_WORDS.has(w) && !laterPart) {
        return refuse(c, `the security function ${t.text}`, c.why.security, bracketHint(c, t.text, true, FUNCTION_REMEDIATION));
      }
      // NEXT VALUE FOR is on the metadata page and is not written as a call. `FETCH NEXT 10 ROWS` and a
      // column named next are not followed by VALUE FOR.
      if (w === 'NEXT' && !laterPart && upper(tokens[i + 1]) === 'VALUE' && upper(tokens[i + 2]) === 'FOR') {
        return refuse(c, 'the metadata function NEXT VALUE FOR', c.why.metadata, FUNCTION_REMEDIATION);
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
      const position: NamePosition = isPunct(tokens[j], '(')
        ? 'call'
        : TABLE_CLAUSES.has(clauses[clauses.length - 1]) ? 'table' : 'column';
      const refused = checkName(c, parts, database, opts.database, position);
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

