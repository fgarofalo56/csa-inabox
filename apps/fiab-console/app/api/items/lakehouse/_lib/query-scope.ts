/**
 * Confine the lakehouse SQL tab (`POST /api/items/lakehouse/[id]/query`) to the
 * item's own storage root.
 *
 * The SQL tab runs on the shared Synapse Serverless endpoint as the console's
 * identity, so the query TEXT decides which storage it reads. For a caller who
 * is not a tenant admin the text therefore passes this classifier first, and it
 * is REFUSE-BY-DEFAULT: a query is accepted only when every token is one the
 * classifier understands and every storage location it names is a literal URL
 * inside the item's container and root.
 *
 * What is accepted:
 *   - One or more SELECT statements (a statement may start with `WITH` for a
 *     CTE, or with `(`), separated by `;`.
 *   - `OPENROWSET(BULK '<url>' | ('<url>', …), <option> = <value>, …)` where
 *     each `<url>` is a LITERAL `https://` or `abfss://` URL on the item's own
 *     storage account, in its container, strictly under its root
 *     (`confineQueryLocation`), and each option is on the read-only list below.
 *   - Names with one or two parts, and three-part names whose database is the
 *     item's own database.
 *
 * What is refused, with the construct named in the message:
 *   - Anything the lexer (`lib/sql/tsql-lexer.ts`) cannot read.
 *   - Dynamic SQL (`EXEC`, `EXECUTE`, `sp_executesql` and other `sp_`/`xp_`
 *     procedures), every DDL and data-change verb, permissions, `USE`,
 *     variables and session options, control flow, transactions, cursors, and
 *     server administration — the statement words in `REFUSED_WORDS`.
 *   - `OPENDATASOURCE`, `OPENQUERY`, `OPENXML`, `BULK` outside `OPENROWSET`,
 *     `OPENROWSET` without `BULK`, a `BULK` location that is not a literal
 *     string, `DATA_SOURCE` and the error-file options.
 *   - Names with four parts, and three-part names naming another database.
 *   - A string that holds a storage URL anywhere other than a `BULK` location.
 *   - `sys.fn_*` file and trace functions and global temporary tables.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: objects inside the
 * item's own database (views, external tables) run as whatever they were
 * defined to read. The durable form of this boundary is a per-item serverless
 * database whose external data source is rooted at the item root, with
 * relative `BULK` paths only; that is tracked separately.
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
  'Write a single SELECT (optionally with a WITH clause) that reads this lakehouse through '
  + "OPENROWSET(BULK 'https://<account>.dfs.<suffix>/<container>/<lakehouse root>/…'). "
  + 'A tenant admin can run other statements.';

function refuse(construct: string, why: string, remediation = SELECT_REMEDIATION): QueryRefusal {
  return {
    ok: false,
    status: 400,
    code: 'query_construct_not_accepted',
    construct,
    error: `${LEAD}${construct} is not accepted: ${why}.`,
    remediation,
  };
}

const WHY = {
  dynamic: 'dynamic SQL is not run from this tab',
  ddl: 'statements that create, change or remove objects are not run from this tab',
  dml: 'statements that change data are not run from this tab',
  perms: 'permission statements are not run from this tab',
  database: 'the query runs against the database bound to this lakehouse',
  session: 'variables and session options are not accepted in this tab',
  external: 'external data access goes through OPENROWSET(BULK …) on this lakehouse\'s files only',
  admin: 'server administration is not run from this tab',
  control: 'control flow and transactions are not accepted in this tab',
  cursor: 'cursors are not accepted in this tab',
} as const;

/**
 * Statement words refused wherever they appear outside a string, comment or
 * quoted identifier. Every T-SQL statement other than SELECT begins with one of
 * these, so a second statement without a `;` cannot start with anything else
 * either (an unreserved word there is read by the server as an alias).
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
};

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

/** A string that names a storage location. */
function looksLikeLocation(value: string): boolean {
  return value.includes('://') || value.startsWith('\\\\');
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
    const v = tokens[j];
    const valueOk = !!v && (
      v.kind === 'number'
      || (v.kind === 'string' && !looksLikeLocation(v.value))
      || (v.kind === 'word' && (upper(v) === 'TRUE' || upper(v) === 'FALSE'))
    );
    if (!valueOk) {
      return refuse(`the value of OPENROWSET option ${name}`, 'an option value is a literal string, number, TRUE or FALSE, and never a storage location');
    }
    j += 1;
  }
}

/**
 * Classify caller-authored T-SQL for the lakehouse SQL tab. `database` is the
 * database the query runs against (the item's own).
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

    if (t.kind === 'string' || t.kind === 'quoted-ident') {
      if (looksLikeLocation(t.value)) {
        return refuse(
          `the storage location ${t.text}`,
          'a storage location is accepted only as the literal BULK argument of OPENROWSET',
        );
      }
    }

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
        if (prev !== 'ROW' && prev !== 'ROWS') return refuse('FETCH', WHY.cursor);
        i += 1;
        continue;
      }
      const why = REFUSED_WORDS[w];
      if (why) return refuse(t.text, why);
      if (/^(SP|XP)_/.test(w)) return refuse(`the system procedure ${t.text}`, WHY.dynamic);
      if (/^FN_/.test(w)) return refuse(`the system function ${t.text}`, WHY.admin);
      if (w.startsWith('##')) return refuse(`the global temporary table ${t.text}`, WHY.database);
    }

    // Multi-part names: collect the chain that starts here.
    if (isNamePart(t) && !isPunct(tokens[i - 1], '.')) {
      const parts: string[] = [t.value];
      let j = i + 1;
      while (isPunct(tokens[j], '.')) {
        if (isNamePart(tokens[j + 1])) { parts.push(tokens[j + 1].value); j += 2; continue; }
        if (isPunct(tokens[j + 1], '.')) { parts.push(''); j += 1; continue; }
        break;
      }
      if (parts.length >= 4) {
        return refuse(`the four-part name ${parts.join('.')}`, 'names that reach another server are not accepted');
      }
      if (parts.length === 3 && parts[0].toLowerCase() !== database) {
        return refuse(
          `the three-part name ${parts.join('.')}`,
          `the query runs against the database bound to this lakehouse (${opts.database}), and other databases are not reached from this tab`,
        );
      }
    }
    i += 1;
  }
  return { ok: true, locations };
}

/**
 * Confine one `OPENROWSET(BULK …)` location to the item's storage: its own
 * account (dfs or blob endpoint of the binding's cloud suffix), its container,
 * and strictly under its root — through the same `scopePathToRoot` (strict)
 * the lakehouse routes use. `*` wildcards are accepted only below the root.
 * Percent-encoding, backslashes, `?`, `#`, ports, user info, empty segments and
 * `.`/`..` segments are refused rather than normalised.
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
      + 'Open the lakehouse that owns the other location and query it there.',
  });

  if (/[%\\?#\s]/.test(raw) || /[^\x21-\x7e]/.test(raw)) {
    return outside('it contains percent-encoding, a backslash, a query string, a fragment, whitespace or a non-ASCII character');
  }
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
