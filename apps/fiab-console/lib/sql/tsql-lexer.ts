/**
 * A small T-SQL lexer for classifying caller-authored SQL before it runs.
 *
 * It splits text into the tokens the SQL Server parser sees, with comments
 * removed. Its job is to feed a REFUSE-BY-DEFAULT classifier (see
 * `app/api/items/lakehouse/_lib/query-scope.ts`), so every choice below leans
 * the same way: when this lexer and the server could disagree about where a
 * token starts or ends, the lexer reports MORE code than the server would —
 * which can only produce a refusal, never an acceptance of something the
 * server would read differently.
 *
 *   - `--` comments end at ANY line break the server might honour (`\n`, `\r`,
 *     `\v`, `\f`, U+0085, U+2028, U+2029). If the server keeps a comment going
 *     past one of these, the lexer has reported comment text as code.
 *   - `/* … *\/` comments NEST, as they do in T-SQL.
 *   - `'…'` and `N'…'` strings double `'` to escape it; `[…]` doubles `]`;
 *     `"…"` doubles `"`. An unterminated string, comment or identifier is an
 *     error, not end of input.
 *   - Outside strings, comments and quoted identifiers, only ASCII is accepted.
 *     Any other character, and any character with no T-SQL meaning here
 *     (`` ` ``, `\`, `{`, `}`, `?`, `$` at the start of a token), is an error
 *     that names the character.
 *
 * It is a lexer, not a parser: it does not decide what the tokens mean.
 */

export type TsqlTokenKind = 'word' | 'quoted-ident' | 'string' | 'number' | 'variable' | 'punct';

export interface TsqlToken {
  kind: TsqlTokenKind;
  /** The token's text as written, including quotes and brackets. */
  text: string;
  /**
   * The token's meaning: a string's unescaped content, a quoted identifier's
   * unescaped name, and the text itself for every other kind.
   */
  value: string;
  /** Offset of the token's first character in the input. */
  pos: number;
}

export type TsqlLexResult =
  | { ok: true; tokens: TsqlToken[] }
  | { ok: false; reason: string; pos: number };

/** Characters that end a `--` comment. See the header for why this list is broad. */
const LINE_BREAKS = new Set(['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']);
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\v', '\f']);
const PUNCT = new Set(['(', ')', ',', ';', '.', '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', ':']);

function isWordStart(c: string): boolean {
  return /^[A-Za-z_#]$/.test(c);
}

function isWordPart(c: string): boolean {
  return /^[A-Za-z0-9_#@$]$/.test(c);
}

function describeChar(c: string): string {
  const code = c.codePointAt(0) ?? 0;
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return code >= 0x21 && code <= 0x7e ? `'${c}' (${hex})` : hex;
}

/**
 * Read a quoted run starting at `start` (the opening character), where `close`
 * doubled is an escaped `close`. Returns the end offset (one past the closing
 * character) and the unescaped content, or null when it never closes.
 */
function readQuoted(sql: string, start: number, close: string): { end: number; value: string } | null {
  let i = start + 1;
  let value = '';
  while (i < sql.length) {
    const c = sql[i];
    if (c === close) {
      if (sql[i + 1] === close) {
        value += close;
        i += 2;
        continue;
      }
      return { end: i + 1, value };
    }
    value += c;
    i += 1;
  }
  return null;
}

export function lexTsql(sql: string): TsqlLexResult {
  const tokens: TsqlToken[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];

    if (WHITESPACE.has(c)) {
      i += 1;
      continue;
    }

    // Line comment.
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && !LINE_BREAKS.has(sql[i])) i += 1;
      continue;
    }

    // Block comment, nesting.
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) return { ok: false, reason: 'unterminated /* comment', pos: start };
      continue;
    }

    // National string N'…' (the N must touch the quote).
    if ((c === 'N' || c === 'n') && sql[i + 1] === "'") {
      const q = readQuoted(sql, i + 1, "'");
      if (!q) return { ok: false, reason: "unterminated N'…' string", pos: i };
      tokens.push({ kind: 'string', text: sql.slice(i, q.end), value: q.value, pos: i });
      i = q.end;
      continue;
    }

    if (c === "'") {
      const q = readQuoted(sql, i, "'");
      if (!q) return { ok: false, reason: "unterminated '…' string", pos: i };
      tokens.push({ kind: 'string', text: sql.slice(i, q.end), value: q.value, pos: i });
      i = q.end;
      continue;
    }

    if (c === '[') {
      const q = readQuoted(sql, i, ']');
      if (!q) return { ok: false, reason: 'unterminated [identifier]', pos: i };
      tokens.push({ kind: 'quoted-ident', text: sql.slice(i, q.end), value: q.value, pos: i });
      i = q.end;
      continue;
    }

    if (c === '"') {
      const q = readQuoted(sql, i, '"');
      if (!q) return { ok: false, reason: 'unterminated "identifier"', pos: i };
      tokens.push({ kind: 'quoted-ident', text: sql.slice(i, q.end), value: q.value, pos: i });
      i = q.end;
      continue;
    }

    if (c === '@') {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j += 1;
      const text = sql.slice(i, j);
      tokens.push({ kind: 'variable', text, value: text, pos: i });
      i = j;
      continue;
    }

    if (/^[0-9]$/.test(c)) {
      const m = /^(?:0[xX][0-9A-Fa-f]*|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?)/.exec(sql.slice(i));
      const text = m ? m[0] : c;
      tokens.push({ kind: 'number', text, value: text, pos: i });
      i += text.length;
      continue;
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j += 1;
      const text = sql.slice(i, j);
      tokens.push({ kind: 'word', text, value: text, pos: i });
      i = j;
      continue;
    }

    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', text: c, value: c, pos: i });
      i += 1;
      continue;
    }

    return { ok: false, reason: `unrecognised character ${describeChar(c)}`, pos: i };
  }
  return { ok: true, tokens };
}
