/**
 * _workflow-yaml — a minimal block-structure reader for GitHub Actions
 * workflow files, shared by the workflow-shell guards.
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT RE-ADD ONE. This module is `import`ed by
 * scripts/ci/__tests__/*.test.mjs; the sibling note on _ratchet-count.mjs
 * explains why a `#!` line breaks that (vite-node evaluates an out-of-root
 * `.mjs` through `vm.Script`, which does not strip it).
 *
 * WHY A HAND-ROLLED READER
 * ------------------------
 * The repo root has no YAML dependency and the guards run as bare `node
 * scripts/ci/*.mjs` with no install step, so a real YAML library is not
 * available to them. Every existing workflow-reading guard in this directory
 * therefore hand-rolls its scan (check-annotation-teeth.mjs, and others). This
 * module exists so the *structure* half of that is written once rather than
 * per guard: the callers here need three levels of `env:`, `defaults.run.shell`
 * and each step's `shell:`, which line-oriented regex scanning gets wrong.
 *
 * SCOPE — deliberately NOT a general YAML parser. It understands exactly the
 * subset GitHub Actions workflows use:
 *   - block mappings (`key:` / `key: value`)
 *   - block sequences (`- item`, `- key: value`)
 *   - block scalars (`key: |`, `|-`, `|+`, `>`, `>-`) kept RAW and unparsed
 *   - `#` comments on their own line, and trailing comments after a plain
 *     scalar (not inside quotes)
 * It does NOT support flow collections spanning lines, anchors, aliases, or
 * multi-document files. None of those appear in .github/workflows here, and a
 * guard that silently mis-reads one would be worse than one that does not
 * claim to handle it — so `parseWorkflow` THROWS on a construct it cannot
 * model rather than returning a half-read document.
 *
 * SHAPE — every scalar becomes `{ v, line }` (1-based line) so callers can
 * report a real file position; mappings are plain objects and sequences are
 * arrays.
 */

/** Scalars carry their source line so a finding can name a real position. */
const scalar = (v, line) => ({ v, line });

/** Strip a trailing `# comment` from a plain scalar, respecting quotes. */
function stripTrailingComment(s) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

/** Unquote a plain scalar value (single or double quoted, else as-is). */
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const indentOf = (line) => line.match(/^(\s*)/)[1].length;
const isBlank = (line) => line.trim() === '';
const isComment = (line) => /^\s*#/.test(line);

/**
 * Read a block scalar (`|`, `>`, and their chomping variants) starting after
 * `start`. Returns the raw text plus the 1-based line of its first content
 * line. Content is dedented by the block's own indentation, which is what a
 * shell analyser needs.
 */
function readBlockScalar(lines, start, parentIndent) {
  const body = [];
  let i = start + 1;
  let blockIndent = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      body.push('');
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === null) blockIndent = ind;
    body.push(line.slice(Math.min(blockIndent, ind)));
  }
  // trailing blank lines are not part of the scalar
  while (body.length && body.at(-1) === '') body.pop();
  return { text: body.join('\n'), firstLine: start + 2, next: i };
}

/**
 * Parse one nested block starting at `lines[i]` whose members are indented to
 * `indent`. Returns `{ value, next }`.
 */
function parseBlock(lines, i, indent) {
  // Decide mapping vs sequence from the first meaningful line.
  let j = i;
  while (j < lines.length && (isBlank(lines[j]) || isComment(lines[j]))) j++;
  if (j >= lines.length || indentOf(lines[j]) < indent) return { value: null, next: j };

  // The child block's indentation is DISCOVERED from its first line, not
  // assumed. Workflows in this repo nest at 2 and at 4 spaces, and a sequence
  // item's own members may sit at any deeper column.
  const childIndent = indentOf(lines[j]);
  if (/^\s*-(\s|$)/.test(lines[j])) return parseSequence(lines, j, childIndent);
  return parseMapping(lines, j, childIndent);
}

function parseMapping(lines, i, indent) {
  const map = {};
  let k = i;
  while (k < lines.length) {
    const line = lines[k];
    if (isBlank(line) || isComment(line)) {
      k++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      // A deeper line with no key above it — we cannot model this safely.
      throw new Error(`unexpected indentation at line ${k + 1}: ${line.trim().slice(0, 60)}`);
    }
    const m = line.match(/^\s*([^\s:#][^:]*?)\s*:(\s.*|)$/);
    if (!m) {
      // Not a `key:` line at this level (e.g. a sequence item) — stop and let
      // the caller decide. Prevents silently swallowing structure.
      break;
    }
    const key = unquote(m[1]);
    const rest = m[2].trim();

    if (/^[|>][-+]?\d*$/.test(rest)) {
      const { text, firstLine, next } = readBlockScalar(lines, k, ind);
      map[key] = scalar(text, firstLine);
      k = next;
      continue;
    }
    if (rest === '' || rest.startsWith('#')) {
      const { value, next } = parseBlock(lines, k + 1, ind + 1);
      // A key with nothing nested under it is an empty value, not an error.
      map[key] = value === null ? scalar('', k + 1) : value;
      k = next;
      continue;
    }
    map[key] = scalar(unquote(stripTrailingComment(rest)), k + 1);
    k++;
  }
  return { value: map, next: k };
}

function parseSequence(lines, i, indent) {
  const seq = [];
  let k = i;
  while (k < lines.length) {
    const line = lines[k];
    if (isBlank(line) || isComment(line)) {
      k++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (!/^\s*-(\s|$)/.test(line) || ind !== indent) break;

    const after = line.slice(ind + 1);
    const itemIndent = ind + 1 + (after.match(/^(\s*)/)?.[1].length ?? 0);
    const content = after.trim();

    if (content === '') {
      const { value, next } = parseBlock(lines, k + 1, indent + 1);
      seq.push(value);
      k = next;
      continue;
    }
    // Rewrite `- key: value` as a mapping line at the item's own indent so the
    // mapping parser can consume it together with its siblings.
    const rewritten = lines.slice();
    rewritten[k] = ' '.repeat(itemIndent) + content;
    if (/^([^\s:#][^:]*?)\s*:(\s|$)/.test(content)) {
      const { value, next } = parseMapping(rewritten, k, itemIndent);
      seq.push(value);
      k = next;
      continue;
    }
    seq.push(scalar(unquote(stripTrailingComment(content)), k + 1));
    k++;
  }
  return { value: seq, next: k };
}

/** Parse a workflow file's text into the block structure described above. */
export function parseWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const { value } = parseMapping(lines, 0, 0);
  return value ?? {};
}

/** Convenience: the keys of a mapping node, or [] for anything else. */
export function mapKeys(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  if ('v' in node && 'line' in node) return [];
  return Object.keys(node);
}

/** Convenience: a scalar node's string value, or undefined. */
export function scalarValue(node) {
  if (node && typeof node === 'object' && 'v' in node && 'line' in node) return node.v;
  return undefined;
}
