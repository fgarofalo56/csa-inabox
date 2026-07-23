/**
 * tokenizer.ts — the DAX lexer (A1).
 *
 * Turns DAX source text into a flat token stream the Pratt parser consumes.
 * Pure, dependency-free, fully deterministic.
 *
 * DAX lexical rules handled:
 *   - Numbers: 123, 1.5, .5, 1e6, 1.2E-3
 *   - Strings: "double-quoted", with "" as an embedded quote
 *   - Bracketed identifiers: [Column Name] (spaces allowed; ]] escapes ])
 *   - Single-quoted table names: 'Fact Sales' ('' escapes ')
 *   - Bare identifiers: letters/digits/underscore (table + function names)
 *   - Operators: + - * / ^ & = <> < <= > >= && || ( ) , { }
 *   - Line (//, --) and block (/* *​/) comments are skipped
 *   - Keywords are recognised case-insensitively by the parser, not here
 */

export type TokenType =
  | 'number'
  | 'string'
  | 'ident'        // bare identifier (table / function / keyword)
  | 'bracket'      // [Column] — value is the inner name
  | 'quoted'       // 'Table'  — value is the inner name
  | 'op'           // operator or punctuation (value is the literal operator)
  | 'eof';

export interface Token {
  type: TokenType;
  /** For number: numeric string. For string/bracket/quoted: the decoded text.
   *  For ident/op: the literal source. */
  value: string;
  /** Parsed number (number tokens only). */
  num?: number;
  /** 0-based source offset of the token start (for error messages). */
  pos: number;
}

export class DaxLexError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = 'DaxLexError';
  }
}

const TWO_CHAR_OPS = new Set(['<>', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', '{', '}']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isIdentPart(c: string): boolean {
  // DAX bare identifiers allow letters, digits, underscore. (Spaces require
  // quoting/bracketing, handled separately.)
  return /[A-Za-z0-9_]/.test(c);
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export function tokenize(input: string): Token[] {
  const src = String(input ?? '');
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    // comments
    if (c === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '-' && src[i + 1] === '-') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= n) throw new DaxLexError('Unterminated block comment.', i);
      i += 2;
      continue;
    }

    const start = i;

    // string literal
    if (c === '"') {
      i++;
      let s = '';
      let closed = false;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++; closed = true; break;
        }
        s += src[i++];
      }
      if (!closed) throw new DaxLexError('Unterminated string literal.', start);
      tokens.push({ type: 'string', value: s, pos: start });
      continue;
    }

    // bracketed identifier [Column]
    if (c === '[') {
      i++;
      let s = '';
      let closed = false;
      while (i < n) {
        if (src[i] === ']') {
          if (src[i + 1] === ']') { s += ']'; i += 2; continue; }
          i++; closed = true; break;
        }
        s += src[i++];
      }
      if (!closed) throw new DaxLexError('Unterminated bracketed identifier.', start);
      tokens.push({ type: 'bracket', value: s, pos: start });
      continue;
    }

    // single-quoted table name 'Fact Sales'
    if (c === "'") {
      i++;
      let s = '';
      let closed = false;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++; closed = true; break;
        }
        s += src[i++];
      }
      if (!closed) throw new DaxLexError('Unterminated quoted table name.', start);
      tokens.push({ type: 'quoted', value: s, pos: start });
      continue;
    }

    // number (including leading-dot form .5)
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let s = '';
      while (i < n && isDigit(src[i])) s += src[i++];
      if (src[i] === '.') { s += src[i++]; while (i < n && isDigit(src[i])) s += src[i++]; }
      if (src[i] === 'e' || src[i] === 'E') {
        s += src[i++];
        if (src[i] === '+' || src[i] === '-') s += src[i++];
        if (!isDigit(src[i])) throw new DaxLexError('Malformed number exponent.', start);
        while (i < n && isDigit(src[i])) s += src[i++];
      }
      tokens.push({ type: 'number', value: s, num: Number(s), pos: start });
      continue;
    }

    // bare identifier / keyword
    if (isIdentStart(c)) {
      let s = '';
      while (i < n && isIdentPart(src[i])) s += src[i++];
      tokens.push({ type: 'ident', value: s, pos: start });
      continue;
    }

    // operators
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ type: 'op', value: two, pos: start }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(c)) { tokens.push({ type: 'op', value: c, pos: start }); i++; continue; }

    throw new DaxLexError(`Unexpected character "${c}".`, i);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}
