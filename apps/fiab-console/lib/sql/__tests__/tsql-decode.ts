/**
 * A minimal T-SQL reader for tests. It decodes a single-quoted literal or a
 * bracketed identifier at a position the way the SQL parser does (`''` → `'`,
 * `]]` → `]`), so a test can recover the value a nested statement actually
 * carries, and where the literal really ends. Nothing else is parsed.
 */

export interface Decoded {
  value: string;
  /** Index just past the closing quote / bracket. */
  end: number;
}

/** Decode the `'…'` literal whose opening quote is at `s[open]`. */
export function readLiteral(s: string, open: number): Decoded {
  if (s[open] !== "'") throw new Error(`expected ' at ${open}, found ${JSON.stringify(s[open])}`);
  let value = '';
  let i = open + 1;
  for (;;) {
    if (i >= s.length) throw new Error('unterminated literal');
    if (s[i] === "'") {
      if (s[i + 1] === "'") { value += "'"; i += 2; continue; }
      return { value, end: i + 1 };
    }
    value += s[i++];
  }
}

/** Decode the `[…]` identifier whose opening bracket is at `s[open]`. */
export function readBracket(s: string, open: number): Decoded {
  if (s[open] !== '[') throw new Error(`expected [ at ${open}, found ${JSON.stringify(s[open])}`);
  let value = '';
  let i = open + 1;
  for (;;) {
    if (i >= s.length) throw new Error('unterminated identifier');
    if (s[i] === ']') {
      if (s[i + 1] === ']') { value += ']'; i += 2; continue; }
      return { value, end: i + 1 };
    }
    value += s[i++];
  }
}

function at(s: string, marker: string): number {
  const i = s.indexOf(marker);
  if (i < 0) throw new Error(`marker ${JSON.stringify(marker)} not found in ${JSON.stringify(s)}`);
  return i + marker.length;
}

/** The literal that opens immediately after `marker`. */
export function literalAfter(s: string, marker: string): Decoded {
  return readLiteral(s, at(s, marker));
}

/** The bracketed identifier that opens immediately after `marker`. */
export function bracketAfter(s: string, marker: string): Decoded {
  return readBracket(s, at(s, marker));
}
