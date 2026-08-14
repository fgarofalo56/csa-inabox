import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readLogicalLines,
  continuesToNextLine,
  isCommentLine,
} from '../_logical-lines.mjs';

const texts = (t) => readLogicalLines(t).map((l) => l.text);
const lines = (t) => readLogicalLines(t).map((l) => l.line);

test('a file with no continuations is returned unchanged, one entry per line', () => {
  const src = 'a\nb\nc';
  assert.deepEqual(texts(src), ['a', 'b', 'c']);
  assert.deepEqual(lines(src), [1, 2, 3]);
});

test('a backslash continuation is folded into one logical line', () => {
  const src = 'curl -sS \\\n  --max-time 5 \\\n  "$URL"';
  assert.deepEqual(texts(src), ['curl -sS   --max-time 5   "$URL"']);
});

test('the reported line number is the FIRST physical line of the invocation', () => {
  const src = '#!/bin/sh\nset -e\ncurl \\\n  "$URL"\necho done';
  assert.deepEqual(lines(src), [1, 2, 3, 5]);
});

test('THE REGRESSION (#3417): a token on the continuation is visible', () => {
  // This is the exact shape that hid eleven live `|| echo` sites: the probe
  // token is on line 1 and the fallback is on the last continuation.
  const src = 'CODE=$(curl -sS -w \'%{http_code}\' \\\n  --max-time 5 \\\n  "$URL" || echo 000)';
  const [logical] = readLogicalLines(src);
  assert.match(logical.text, /%\{http_code\}/);
  assert.match(logical.text, /\|\|\s*echo/, 'the fallback must be on the SAME logical line as the probe');
  assert.equal(logical.line, 1);
});

test('CRLF input folds the same as LF', () => {
  assert.deepEqual(texts('curl \\\r\n  "$URL"\r\necho x'), texts('curl \\\n  "$URL"\necho x'));
});

test('trailing whitespace after the backslash still continues', () => {
  assert.deepEqual(texts('a \\   \n  b'), ['a   b']);
});

test('an EVEN run of trailing backslashes is an escaped backslash, NOT a splice', () => {
  // `printf 'x\\'` ends there; the next line is its own command. Splicing it
  // would merge two commands and let a matcher judge them as one.
  assert.equal(continuesToNextLine('printf "x\\\\"'), false);
  assert.deepEqual(texts('printf "x\\\\"\naz acr login --name x'), ['printf "x\\\\"', 'az acr login --name x']);
});

test('an ODD run of three trailing backslashes IS a splice', () => {
  assert.equal(continuesToNextLine('a \\\\\\'), true);
});

test('a comment does not swallow the line below it', () => {
  // Without this, a one-line comment ending in `\` hides the next line from
  // every guard that skips logical lines starting with `#`.
  const src = "# example: curl -w '%{http_code}' \\\nCODE=$(curl -sS \"$URL\" || echo 000)";
  const out = readLogicalLines(src);
  assert.equal(out.length, 2);
  assert.ok(isCommentLine(out[0].text));
  assert.match(out[1].text, /\|\|\s*echo/);
  assert.equal(out[1].line, 2);
});

test('an indented comment also does not swallow the line below it', () => {
  const src = '    # note \\\n    az acr login --name x';
  const out = readLogicalLines(src);
  assert.equal(out.length, 2);
  assert.match(out[1].text, /az acr login/);
});

test('a comment INSIDE an open splice is joined, and ENDS the logical line', () => {
  // Shell semantics: `curl \` + `  # foo` splices to `curl   # foo`, the `#`
  // opens a comment, and the comment ends at the newline that terminates
  // PHYSICAL line 2. So `"$URL"` on line 3 is a separate command, not an
  // argument to curl.
  const src = 'curl \\\n  # not a leading comment of the logical line\n  "$URL"';
  const out = readLogicalLines(src);
  assert.equal(out.length, 2);
  assert.match(out[0].text, /^curl\s+# not a leading comment/);
  assert.equal(out[1].text.trim(), '"$URL"');
  assert.equal(out[1].line, 3);
});

test('a trailing backslash on the LAST line does not drop it', () => {
  assert.deepEqual(texts('a\nb \\'), ['a', 'b  ']);
});

test('empty input yields one empty logical line, never undefined', () => {
  assert.deepEqual(readLogicalLines(''), [{ line: 1, text: '' }]);
});

test('blank lines are preserved so line numbering stays true', () => {
  assert.deepEqual(lines('a\n\n\nb'), [1, 2, 3, 4]);
});

test('continuation indentation is dropped; the seam becomes whitespace', () => {
  // The backslash becomes a space and the join adds one, so a seam is
  // whitespace of unspecified WIDTH. Matchers must use `\s+`, never a literal
  // single space, across a seam. Pinned here so the contract is explicit.
  assert.deepEqual(texts('a \\\n\t\t   b'), ['a   b']);
  assert.match(readLogicalLines('az acr repository show \\\n  --query digest')[0].text, /show\s+--query digest/);
});

test('folding is idempotent on already-folded text', () => {
  const once = texts('a \\\n  b').join('\n');
  assert.deepEqual(texts(once), ['a   b']);
});
