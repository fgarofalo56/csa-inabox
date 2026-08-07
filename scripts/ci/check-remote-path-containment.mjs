/**
 * GUARDRAIL: remote-path-containment  (merge-blocker — CodeQL js/http-to-file-access)
 * ---------------------------------------------------------------------------
 * NO SHEBANG — DO NOT ADD ONE. This module exports its analysis so the self-test
 * (and, later, possibly a vitest spec) can import it, and vite-node evaluates an
 * out-of-root `.mjs` through `vm.Script`, which does NOT strip `#!` — a shebang
 * kills such a spec at COLLECTION with `SyntaxError: Invalid or unexpected
 * token`. That has already happened twice in this repo (_ratchet-count.mjs,
 * check-unity-audit-chokepoint.mjs). CI invokes it as `node scripts/ci/...`,
 * which needs no shebang.
 * ---------------------------------------------------------------------------
 * RULE
 *
 *   A value that arrived over the network must never become a filesystem path
 *   component without a containment check performed by the process that owns
 *   the filesystem.
 *
 * THE DEFECT THIS EXISTS FOR. `loom apps run-local` downloaded an app's build
 * context and wrote it out with:
 *
 *     for (const f of ctx.files) {          // ctx = await client.request(...)
 *       const p = join(dir, f.path);        // f.path came off the wire
 *       writeFileSync(p, f.content);
 *     }
 *
 * `path.join` resolves `..`, so a response carrying `../../victim.txt` wrote
 * OUTSIDE `dir`. Proven, not theorised: with the check reverted, the regression
 * suite's neighbouring file reads `PWNED` instead of `ORIGINAL`, and the first
 * mutation run left a literal `PWNED` file in the OS temp directory.
 *
 * WHY A GUARD AND NOT A COMMENT. The console's `assembleBuildContext()` already
 * sanitized these paths, and every escape vector tested against it is blocked —
 * so the CLI's missing check looked harmless right up until you notice the CLI
 * cannot observe that the peer sanitized anything. The API base URL is operator
 * supplied (`loom auth login --api-url …`). One server-side regression, one
 * typo'd host, one MITM, and every developer workstation that runs the command
 * writes wherever it is told. The next person to add a "download these files"
 * command will copy the neighbouring code, not the reasoning — so the reasoning
 * has to be a red build.
 *
 * WHAT IS CHECKED
 *
 *   A1  HELPER INTEGRITY (anti-inert). `containedJoin` still performs all three
 *       layers: a `..`-segment rejection, an absolute-path rejection, and the
 *       post-resolve `base + sep` containment comparison. Per #2729 a fix that
 *       is present but gutted is the worst outcome: it reads as protection and
 *       enforces nothing. A2 alone would happily pass against an empty helper.
 *       "Performs" is asserted in TWO parts, because presence is not
 *       enforcement: each layer's test must appear in EXECUTABLE code (not a
 *       comment — #2869 F3), and each must lead to an actual `refuse`/`throw`,
 *       with the post-resolve comparison NEGATED. An `if` that tests the right
 *       thing and does nothing satisfied the presence-only form, and — verified
 *       against the shipped tree — was invisible to the 27-test `apps/loom-cli`
 *       suite too, because the remaining layers still rejected those inputs.
 *       Nothing observed the loss of a layer, which is precisely A1's job.
 *   A2  ADOPTION. Every filesystem write whose path expression is tainted by a
 *       network read resolves through `containedJoin`.
 *   A3  NO RIVAL. Nobody hand-rolls a second containment helper, because two
 *       implementations means one of them is the stale one.
 *
 * ANTI-PATTERNS AVOIDED (per check-tid-boundary-chokepoint's three rewrites):
 * comments and string bodies are MASKED via the shared, self-tested
 * `maskCommentsAndStrings`, so a doc comment naming `containedJoin` cannot
 * satisfy A2; A1 brace-matches the function body rather than substring-testing
 * the file; taint is propagated INTO local callables through their call sites,
 * because the pre-fix defect and its fix live in different functions and a
 * per-function analysis would have reported "clean" either way.
 *
 * SHAPE COVERAGE — what the taint pass can and cannot follow. The first cut of
 * this guard claimed to close a class while recognising ONE declaration syntax
 * and ONE binding syntax (#2869 F1/F2): the identical `writeAll` logic was
 * caught as `function writeAll(…)` and invisible as `const writeAll = (…) =>`,
 * and `const { files } = await client.request(…)` — the most idiomatic way to
 * read a JSON response — recorded no binding at all. Both are fixed. So that
 * the next reader can check rather than trust, the boundary is written down.
 *
 * The boundary is itself checkable, and checking it found two more misses: the
 * first version of this list put `writeAll = (dir, files) => {}` (a class field
 * — no `const`) and `const writeAll = files => {}` (one parameter, no parens)
 * on NEITHER side, and both were in fact missed. A boundary a reader consults
 * and is misled by is the same over-claim the list exists to prevent, so treat
 * NOT FOLLOWED as the tested floor it is, not as an exhaustive census.
 *
 *   FOLLOWED   `function NAME(…) {}`; `const NAME = (…) => {}`; `= async (…) =>`;
 *              `= function (…) {}`; class/object methods `NAME(…) {}`;
 *              object-literal arrow props `NAME: (…) => {}`; binder-less
 *              assigned arrows `NAME = (…) => {}` (class fields, `this.NAME =`);
 *              paren-less single-parameter arrows `NAME = param => {}`;
 *              expression-bodied arrows (for sink attribution); `const {a, b} = …`,
 *              `const [a] = …`, `const {k: local} = …`, `{...rest}`, nested
 *              patterns, and the same destructuring in a `for (… of …)` head.
 *   NOT FOLLOWED  a callable invoked through a value rather than its name
 *              (`handlers[kind](dir, files)`, `arr.map(writeOne)`); taint stored
 *              in and read back out of a class field or module-level mutable
 *              (`this.files = …`) — as DATA; a method or arrow whose parameter
 *              list contains brackets (`f(o: {a: 1})`), or an arrow field
 *              carrying a type annotation (`w: (d: string) => void = (d) => {}`),
 *              which are skipped rather than mis-parsed; re-export/import chains
 *              across files — the pass is per-file.
 *
 * KNOWN LIMIT, stated rather than hidden: this is a textual taint pass, not a
 * type-aware one. It is deliberately conservative — it can MISS an exotic
 * laundering chain, it should not invent one. A miss is a future alert; a false
 * positive blocks unrelated PRs and gets the guard deleted. Every entry in NOT
 * FOLLOWED is a miss of that kind, not a claim of safety.
 *
 * ## PROVEN TO FAIL. Each mutation was applied and the exit code recorded.
 * A guard nobody has tried to defeat is a comment.
 *
 *   M1  run-local writes `join(dir, f.path)` again (the original defect)  exit 1
 *   M2  containedJoin keeps its shape but loses the `..` rejection        exit 1
 *   M3  containedJoin loses the post-resolve containment comparison       exit 1
 *   M4  a NEW command downloads files and writes them with a raw join     exit 1
 *   M5  a second module re-implements containment                         exit 1
 *   M6  NEGATIVE CONTROL — a doc comment naming containedJoin             exit 0
 *   M7  NEGATIVE CONTROL — a write whose path is a CLI flag, not remote   exit 0
 *   M8  the `..` rejection COMMENTED OUT rather than deleted (#2869 F3)   exit 1
 *   M9  the same defect written as an arrow function (#2869 F1)           exit 1
 *   M10 the same defect written as a class method (#2869 F1)              exit 1
 *   M11 the response destructured: `const { files } = …` (#2869 F2)       exit 1
 *   M12 the same defect in a class FIELD arrow `w = (d, f) => {}`         exit 1
 *   M13 the same defect in a paren-less arrow `const w = files => {}`     exit 1
 *   M14 the `..` layer kept but its consequent emptied (present + inert)  exit 1
 *   M15 the absolute-path layer logging instead of refusing               exit 1
 *   M16 the post-resolve layer with its `!` dropped (inverted, not gone)  exit 1
 *
 * M12-M16 also have paired NEGATIVE CONTROLS that pass BOTH ways, so "the
 * mutation reddens something" is distinguished from "the check reddens
 * everything": the contained forms of M12/M13, comparison operators ending in
 * `=` not being collected as callables, and `throw`/braced/prettier-wrapped
 * spellings of a rejection all staying silent.
 *
 * Usage: node scripts/ci/check-remote-path-containment.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskCommentsAndStrings, maskComments } from './check-unity-audit-chokepoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

/** The module that owns containment. */
const HELPER_FILE = 'apps/loom-cli/src/safe-path.ts';
const HELPER = 'containedJoin';

/**
 * Every surface that can read from a network AND write to a local filesystem.
 * `apps/fiab-console/{app,lib}` has ZERO filesystem writes today — it is listed
 * so that the day someone adds one driven by a request value, this fails on
 * that PR instead of on a CodeQL run three weeks later.
 */
const ROOTS = [
  'apps/loom-cli/src',
  'apps/fiab-console/app',
  'apps/fiab-console/lib',
  'apps/fiab-mcp-bridge/src',
  'apps/copilot-maf/src',
  // See check-insecure-randomness.mjs — apps/fiab-report-subscriptions was an
  // orphaned duplicate deleted 2026-08-07; the deployed job lives here.
  'azure-functions/report-subscriptions/src',
  'scripts/ci',
  'scripts/csa-loom',
  'scripts/dev',
  'scripts/codemods',
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__snapshots__']);
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs']);

/**
 * Sites where a network value legitimately reaches a path and the containment
 * lives elsewhere. Adding an entry is a security review: say why.
 * Empty today — the one real site uses the helper.
 */
const EXEMPT = new Map();

// ── source discovery ────────────────────────────────────────────────────────
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');

// ── expression helpers ──────────────────────────────────────────────────────

/** Text of the balanced argument list starting at the `(` at `open`. */
function argList(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return '';
}

/** First top-level argument of an argument-list text. */
function firstArg(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

const IDENT = /[A-Za-z_$][\w$]*/g;
const hasWord = (text, word) => new RegExp(`\\b${word}\\b`).test(text);

/** Index of the bracket matching the one at `open`. -1 when unbalanced. */
function matchBracket(masked, open) {
  const OPENERS = '([{';
  const CLOSERS = ')]}';
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (OPENERS.includes(masked[i])) depth++;
    else if (CLOSERS.includes(masked[i])) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not inside brackets. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Index of `ch` at bracket depth 0, ignoring the `=` of a `=>`. -1 when absent. */
function topLevelIndexOf(text, ch) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) {
      if (ch === '=' && (text[i + 1] === '>' || text[i + 1] === '=' || text[i - 1] === '=')) continue;
      return i;
    }
  }
  return -1;
}

/**
 * Local names bound by a destructuring pattern — the INSIDE of the `{…}`/`[…]`.
 *
 * `{ files }` → `files`; `{ path: p }` → `p` (the local, not the key);
 * `{ a = 1 }` → `a`; `{ ...rest }` → `rest`; `{ a: { b } }` → `b`.
 */
function patternNames(text, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const part of splitTopLevel(text)) {
    let p = part.trim().replace(/^\.\.\./, '').trim();
    if (!p) continue;
    // `key: local` — the LOCAL is what gets bound, and it may itself be a pattern.
    const colon = topLevelIndexOf(p, ':');
    if (colon >= 0) p = p.slice(colon + 1).trim();
    const eq = topLevelIndexOf(p, '=');
    if (eq >= 0) p = p.slice(0, eq).trim();
    if (p.startsWith('{') || p.startsWith('[')) {
      out.push(...patternNames(p.slice(1, -1), depth + 1));
      continue;
    }
    const id = p.match(/^[A-Za-z_$][\w$]*/);
    if (id) out.push(id[0]);
  }
  return out;
}

/** Parameter names from an argument-list text. */
const paramNames = (text) =>
  splitTopLevel(text)
    .map((p) => {
      const t = p.trim().replace(/^\.\.\./, '').trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        const close = matchBracket(t, 0);
        return close > 0 ? patternNames(t.slice(1, close), 1) : [];
      }
      return (t.match(/^[A-Za-z_$][\w$]*/) || [''])[0];
    })
    .flat()
    .filter(Boolean);

/**
 * Words that can sit immediately before `(…) {` without being a function.
 * Without this, `if (x) {` and `catch (e) {` become "functions" named `if`/
 * `catch` and every call to a same-named identifier propagates taint into them.
 */
const NOT_A_FUNCTION = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'try', 'finally',
  'function', 'return', 'typeof', 'instanceof', 'void', 'delete', 'new', 'await',
  'yield', 'case', 'default', 'in', 'of', 'class', 'extends', 'super', 'import',
  'export', 'const', 'let', 'var', 'throw', 'as', 'is', 'satisfies',
]);


// ── callables ───────────────────────────────────────────────────────────────

/**
 * Every locally-declared callable in a masked file, as
 * `{ name, params, start, end, taintedParams }` where `start`/`end` bracket the
 * body.
 *
 * SIX SHAPES, because the first cut recognised only the first one and #2869 F1
 * is exactly that: `writeAll` written as an arrow function or a class method
 * broke the call-site taint chain, so the guard reported a clean file while the
 * identical logic in `function writeAll(…)` form was caught. A guard that
 * depends on which of six interchangeable syntaxes the author picked is not
 * closing a class.
 *
 *   1. `function NAME(…) {`                       — declaration / named expression
 *   2. `const NAME = (…) => {` and `= function (…) {`
 *   3. `NAME(…) {`                                — class + object-literal methods
 *   4. `NAME: (…) => {`                           — object-literal arrow properties
 *   5. `NAME = (…) => {` with NO binder            — class fields, `this.NAME = …`
 *   6. `NAME = param => {`                        — paren-LESS single-parameter arrow
 *
 * Shapes 5 and 6 are the residual of the same defect. #2872 fixed the three
 * shapes #2869 named and wrote a FOLLOWED / NOT FOLLOWED boundary — but the
 * boundary listed neither `writeAll = (dir, files) => {}` (a class field, which
 * has no `const`) nor `const writeAll = files => {}` (one parameter, no
 * parens). Both were missed, and being missed while absent from NOT FOLLOWED is
 * the same over-claim in miniature: a reader checking the boundary would have
 * concluded they were covered. Verified by probe before and after.
 *
 * KNOWN LIMITS, stated rather than hidden (this stays a textual pass):
 *   - An EXPRESSION-bodied arrow (`const w = (d, f) => writeFileSync(…)`) has no
 *     block to bracket, so it gets the enclosing statement as its range — good
 *     enough to attribute a sink, and it is not treated as a call target.
 *   - A callable reached only through a value (`handlers[kind](dir, files)`,
 *     `arr.map(writeOne)`) is not resolved to its declaration.
 *   - A method whose parameter list contains brackets (`f(o: { a: 1 })`) is
 *     skipped by shape 3 rather than mis-parsed. Shape 5 skips an arrow field
 *     carrying a TYPE annotation (`w: (d: string) => void = (d) => {…}`) for the
 *     same reason — the annotation contains both `=` and `=>`.
 * Each is a MISS — a future alert — never a false positive, which is the trade
 * this guard is designed around.
 */
export function collectFunctions(masked) {
  const fns = [];
  const seen = new Set();
  const push = (name, params, open) => {
    if (open == null || open < 0 || masked[open] !== '{') return;
    const close = matchBracket(masked, open);
    const key = `${name}@${open}`;
    if (seen.has(key)) return;
    seen.add(key);
    fns.push({
      name,
      params,
      start: open,
      end: close < 0 ? masked.length : close,
      taintedParams: new Set(),
    });
  };
  /** First `{` after `from`, provided only whitespace/type-ish text precedes it. */
  const blockAfter = (from) => {
    const m = masked.slice(from).match(/^[^{;()]*\{/);
    return m ? from + m[0].length - 1 : -1;
  };

  // 1 — `function NAME(params) { … }`
  for (const m of masked.matchAll(
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    push(m[1], paramNames(masked.slice(open + 1, close)), blockAfter(close + 1));
  }

  // 2 — `const NAME = (params) => { … }` / `= async (…) => {` / `= function (…) {`
  for (const m of masked.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$][\w$]*\s*)?(?:<[^>(\n]*>\s*)?\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const after = masked.slice(close + 1);
    const arrow = after.match(/^\s*(?::[^=>{;\n]*)?=>\s*/);
    const params = paramNames(masked.slice(open + 1, close));
    if (arrow) {
      const bodyStart = close + 1 + arrow[0].length;
      if (masked[bodyStart] === '{') push(m[1], params, bodyStart);
      // Expression-bodied arrow: range = to the end of the statement, so a sink
      // written as a one-liner is still ATTRIBUTED to a callable.
      else {
        const rest = masked.slice(bodyStart);
        const stop = rest.search(/;|\n\s*\n/);
        fns.push({
          name: m[1],
          params,
          start: bodyStart,
          end: bodyStart + (stop < 0 ? rest.length : stop),
          taintedParams: new Set(),
        });
      }
      continue;
    }
    // `= function (params) { … }` — the arrow-less form.
    if (/function/.test(m[0])) push(m[1], params, blockAfter(close + 1));
  }

  // 3 — class and object-literal METHODS: `NAME(params) { … }` on its own line.
  for (const m of masked.matchAll(
    /(?:^|\n)[ \t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(\n]*>)?\s*\(([^()[\]{}]*)\)\s*(?::[^{;\n]*)?\{/g,
  )) {
    if (NOT_A_FUNCTION.has(m[1])) continue;
    push(m[1], paramNames(m[2]), m.index + m[0].length - 1);
  }

  // 4 — object-literal properties: `NAME: (params) => { … }` / `: function (…) {`
  for (const m of masked.matchAll(
    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?(?:function\s*\*?\s*)?\(([^()[\]{}]*)\)\s*(?::[^=>{;\n]*)?=>\s*\{/g,
  )) {
    if (NOT_A_FUNCTION.has(m[1])) continue;
    push(m[1], paramNames(m[2]), m.index + m[0].length - 1);
  }

  // 5 — arrows assigned with NO `const|let|var` binder: a class FIELD
  //     (`writeAll = (dir, files) => { … }`) or a property assignment
  //     (`this.writeAll = (…) => { … }`, `obj.writeAll = (…) => { … }`).
  //     Shape 2 requires a binder, so both were invisible. The `const` form
  //     also matches here and is deduplicated by `push`'s `name@open` key.
  //     The lookaround keeps `==`, `===`, `!=`, `<=`, `>=`, `+=` … out.
  for (const m of masked.matchAll(
    /([A-Za-z_$][\w$]*)\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*(?:async\s+)?\(([^()[\]{}]*)\)\s*(?::[^=>{;\n]*)?=>\s*\{/g,
  )) {
    if (NOT_A_FUNCTION.has(m[1])) continue;
    push(m[1], paramNames(m[2]), m.index + m[0].length - 1);
  }

  // 6 — PAREN-LESS single-parameter arrows: `const writeAll = files => { … }`,
  //     `writeAll = files => { … }`. Shapes 2 and 5 both anchor on a `(`, so the
  //     one syntax prettier leaves alone in plain `.mjs`/`.js` was unreachable.
  for (const m of masked.matchAll(
    /([A-Za-z_$][\w$]*)\s*(?<![=!<>+\-*/%&|^])=(?!=)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*/g,
  )) {
    if (NOT_A_FUNCTION.has(m[1]) || NOT_A_FUNCTION.has(m[2])) continue;
    const bodyStart = m.index + m[0].length;
    if (masked[bodyStart] === '{') {
      push(m[1], [m[2]], bodyStart);
      continue;
    }
    // Expression-bodied, same treatment as shape 2: range to end of statement.
    const rest = masked.slice(bodyStart);
    const stop = rest.search(/;|\n\s*\n/);
    fns.push({
      name: m[1],
      params: [m[2]],
      start: bodyStart,
      end: bodyStart + (stop < 0 ? rest.length : stop),
      taintedParams: new Set(),
    });
  }

  return fns;
}

// ── taint ───────────────────────────────────────────────────────────────────

/** `await client.request<T>(…)`, `await fetch(…)`, `await res.json()`, … */
const NET_CALL = String.raw`await\s+[\w.$]*\b(?:request|fetch|json|arrayBuffer|text|download|getJson|blob)\s*[(<]`;

/**
 * Analyze one masked source file.
 *
 * POSITION-SCOPED, deliberately. The first cut of this guard resolved each
 * identifier to the FIRST binding of that name anywhere in the file, and that
 * made it a gate that could be satisfied by accident: in apps.ts the arrow
 * parameter `p` of an unrelated one-line lambda collided with the `for (const p
 * of planned)` binding, so expanding `resolve(out)` in the `export` case
 * dragged `containedJoin` in from a different function and the site reported
 * "contained" when nothing contained it. Same shape as the defect this whole
 * guard exists for: it reported success while measuring nothing.
 *
 * So every identifier now resolves to the NEAREST PRECEDING binding of that
 * name, and taint is a property of the expanded expression (does it reach a
 * network call?) rather than of a file-wide name set.
 */
function analyze(masked) {
  // Every binding, with its source offset, so lookups can be positional.
  const bindings = [];
  for (const m of masked.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    bindings.push({ name: m[1], init: m[2], pos: m.index });
  }
  // DESTRUCTURED bindings. `const { files } = await client.request(…)` — the
  // most idiomatic way to read a JSON response — recorded NO binding under the
  // identifier-only pattern above, so the taint chain died at the very first
  // hop for the shape the guard exists to catch (#2869 F2). Every name bound by
  // the pattern inherits the SAME initializer: for a taint pass that is the
  // conservative-correct answer, because any of them may carry the value.
  for (const m of masked.matchAll(/(?:const|let|var)\s*([{[])/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const eq = masked.slice(close + 1).match(/^\s*=\s*/);
    if (!eq) continue; // a `for (const [k, v] of …)` head, or a type position
    const init = masked.slice(close + 1 + eq[0].length).split(/[;\n]/)[0];
    for (const name of patternNames(masked.slice(open + 1, close))) {
      bindings.push({ name, init, pos: m.index });
    }
  }
  for (const m of masked.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]+)\)/g)) {
    bindings.push({ name: m[1], init: m[2], pos: m.index });
  }
  // `for (const { path, content } of files)` — same gap, in the loop head.
  for (const m of masked.matchAll(/for\s*\(\s*(?:const|let|var)\s*([{[])/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    const rest = masked.slice(close + 1).match(/^\s*of\s+([^)]+)\)/);
    if (!rest) continue;
    for (const name of patternNames(masked.slice(open + 1, close))) {
      bindings.push({ name, init: rest[1], pos: m.index });
    }
  }
  bindings.sort((a, b) => a.pos - b.pos);

  const nearestInit = (name, pos) => {
    let best = null;
    for (const b of bindings) {
      if (b.pos >= pos) break;
      if (b.name === name) best = b;
    }
    return best ? best.init : null;
  };

  /** Replace identifiers with their nearest preceding initializer. */
  const expandAt = (text, pos, depth = 0, seen = new Set(), maxDepth = 4) => {
    if (depth >= maxDepth) return text;
    let out = text;
    for (const name of new Set(text.match(IDENT) || [])) {
      if (seen.has(name)) continue;
      const init = nearestInit(name, pos);
      if (init == null) continue;
      const next = new Set(seen);
      next.add(name);
      out = out.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${expandAt(init, pos, depth + 1, next, maxDepth)})`);
    }
    return out;
  };

  /**
   * The expression at `pos`, substituted to EACH depth — shallowest first.
   *
   * Testing only the deepest form is unsound in both directions, and the bug it
   * caused is instructive: once `const { client, output } = await requireAuth()`
   * became a recorded binding (the F2 fix), `ctx.files` expanded `client` too,
   * and `await client.request(` — which the network pattern matches — became
   * `await (await requireAuth(opts)).request(`, which it does not. A correct fix
   * to the binding collector silently BLINDED the guard to the two real sites it
   * was written for; the run went from "2 network-derived" to "0" while still
   * printing OK. So every depth is a candidate haystack, and the first one that
   * shows taint is the form the containment answer is read from.
   */
  const formsAt = (expr, pos) => {
    const forms = [expr];
    for (let d = 1; d <= 4; d++) {
      const e = expandAt(expr, pos, 0, new Set(), d);
      if (e !== forms[forms.length - 1]) forms.push(e);
    }
    return forms;
  };

  // Local callables with their body ranges, so a sink can be attributed to the
  // callable it sits in. Four declaration shapes, not one: the first cut only
  // matched `function NAME(…)`, so a tainted path flowing through an arrow
  // function or a class method was invisible (#2869 F1).
  const fns = collectFunctions(masked);

  const reachesNetwork = (text) => new RegExp(NET_CALL).test(text);

  // A tainted ARGUMENT at a call site taints the corresponding PARAMETER — the
  // pre-fix defect fetched in `runApps` and the fix writes in
  // `writeBuildContext`, so a purely intra-procedural pass would call both
  // clean and enforce nothing.
  for (const fn of fns) {
    if (!fn.params.length) continue;
    for (const m of masked.matchAll(new RegExp(String.raw`\b${fn.name}\s*\(`, 'g'))) {
      const callPos = m.index;
      if (callPos >= fn.start && callPos <= fn.end) continue; // recursion
      const args = argList(masked, callPos + m[0].length - 1);
      const parts = [];
      let depth = 0;
      let cur = '';
      for (const c of args) {
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += c;
      }
      parts.push(cur);
      for (let i = 0; i < parts.length && i < fn.params.length; i++) {
        if (formsAt(parts[i], callPos).some(reachesNetwork)) fn.taintedParams.add(fn.params[i]);
      }
    }
  }

  const enclosing = (pos) => {
    let best = null;
    for (const fn of fns) {
      if (pos > fn.start && pos < fn.end && (!best || fn.start > best.start)) best = fn;
    }
    return best;
  };

  /**
   * Is the expression at `pos` derived from a network read?
   *
   * `full` is the form that SHOWED the taint, not the deepest one, because that
   * is the form whose containment answer is meaningful: a deeper substitution
   * can paste in text from an unrelated nearest-preceding binding, and reading
   * `containedJoin` out of that would be the accidental pass this guard's own
   * header warns about.
   */
  const isTaintedAt = (expr, pos) => {
    const forms = formsAt(expr, pos);
    const deepest = forms[forms.length - 1];
    for (const form of forms) if (reachesNetwork(form)) return { tainted: true, full: form };
    const fn = enclosing(pos);
    if (fn) {
      for (const form of forms) {
        for (const p of fn.taintedParams) if (hasWord(form, p)) return { tainted: true, full: form };
      }
    }
    return { tainted: false, full: deepest };
  };

  return { isTaintedAt };
}

// ── sinks ───────────────────────────────────────────────────────────────────
const BARE_SINKS =
  'writeFileSync|appendFileSync|createWriteStream|mkdirSync|cpSync|copyFileSync|renameSync|rmSync|symlinkSync|truncateSync|writeFile|appendFile|outputFile|outputFileSync|ensureDirSync|ensureFileSync';
const QUALIFIED_SINKS =
  String.raw`(?:fs|fsp|fsPromises|promises)\s*\.\s*(?:mkdir|open|cp|rename|rm|unlink|writeFile|appendFile|copyFile|symlink|truncate)`;
const SINK_RE = new RegExp(String.raw`(?:\b(?:${BARE_SINKS})|${QUALIFIED_SINKS})\s*\(`, 'g');

/**
 * Find every filesystem write in `src` whose path is derived from a network
 * read. EXPORTED so `scripts/ci/__tests__/remote-path-containment.test.mjs`
 * can prove the guard is capable of failing without editing the real tree —
 * a guard whose only evidence is "it was green today" is the gate-that-cannot-
 * fail class this repo keeps rediscovering.
 *
 * @returns Array<{ line, sink, arg, contained }> — one entry per tainted sink.
 */
export function findRemotePathWrites(src) {
  const masked = maskCommentsAndStrings(src);
  const { isTaintedAt } = analyze(masked);
  const hits = [];
  const re = new RegExp(SINK_RE.source, 'g');
  for (const m of masked.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const arg = firstArg(argList(masked, open));
    const { tainted, full } = isTaintedAt(arg, m.index);
    if (!tainted) continue;
    hits.push({
      line: src.slice(0, m.index).split('\n').length,
      sink: m[0].replace(/\s*\($/, '').trim(),
      arg: arg.trim(),
      contained: hasWord(full, HELPER),
    });
  }
  return hits;
}

/**
 * TRUE when some `if (…)` whose CONDITION matches `condRe` actually REJECTS —
 * i.e. its consequent calls `refuse(` or `throw`s.
 *
 * WHY THIS EXISTS. Layers 1-3 used to be satisfied by the mere PRESENCE of
 * their test text anywhere in the executable body, so an `if` that tested the
 * right thing and then did nothing read as an intact layer. Reproduced against
 * the shipped tree: replacing the `..` rejection's consequent with an empty
 * block left this check silent AND the whole 27-test `apps/loom-cli` suite
 * green, because the post-resolve layer still caught those inputs — a layer
 * enforcing nothing while every control called it intact. That is the #2729
 * inert-fix shape one level below the comment case #2869 F3 named, and A1's
 * claim is "still performs all three layers", not "still mentions them".
 *
 * `condRe` must NOT carry the `g` flag: a global regex is stateful across
 * `.test()` calls and would skip matches.
 */
function rejectsWhen(body, condRe) {
  for (const m of body.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(body, open);
    if (close < 0) continue;
    if (!condRe.test(body.slice(open + 1, close))) continue;
    const after = body.slice(close + 1);
    const block = after.match(/^\s*\{/);
    let consequent;
    if (block) {
      const bOpen = close + block[0].length;
      const bClose = matchBracket(body, bOpen);
      consequent = body.slice(bOpen, bClose < 0 ? body.length : bClose);
    } else {
      consequent = after.split(';')[0];
    }
    if (/\brefuse\s*\(|\bthrow\b/.test(consequent)) return true;
  }
  return false;
}

/** Assert the containment helper still has all three layers. EXPORTED for the self-test. */
export function checkHelperIntegrity(hsrc) {
  const problems = [];
  const hmask = maskCommentsAndStrings(hsrc);
  const decl = hmask.search(new RegExp(String.raw`export\s+function\s+${HELPER}\s*\(`));
  if (decl < 0) return [`${HELPER_FILE} no longer exports ${HELPER}().`];

  const open = hmask.indexOf('{', hmask.indexOf(')', decl));
  let depth = 0;
  let close = -1;
  for (let i = open; i < hmask.length; i++) {
    if (hmask[i] === '{') depth++;
    else if (hmask[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = close > 0 ? hmask.slice(open, close) : hmask.slice(open);
  // Layers 1 and 2 compare against string VALUES (`'..'`, `'/'`), which the
  // full mask blanks — so they need a haystack where strings survive. That used
  // to be the RAW body, and a raw body still contains COMMENTS: commenting a
  // rejection out left containment genuinely gone while this check reported no
  // problem (#2869 F3). Deleting the line fired; disabling it did not, which is
  // the more likely edit and the more dangerous one. `maskComments` keeps the
  // string values and blanks the comments, so only executable code can satisfy
  // a layer — the same rule A2 already applies to adoption.
  const codeBody = close > 0 ? maskComments(hsrc).slice(open, close) : maskComments(hsrc).slice(open);

  // Each layer is asserted SEPARATELY, and in TWO parts: the test must be
  // present in executable code, and it must lead to an actual rejection. A
  // helper that keeps its name, its signature and two of its three checks is
  // the #2729 "inert fix" shape: it reads as protection and enforces less than
  // it claims. So is one that keeps all three `if`s and empties a consequent.
  const DOTDOT = /===\s*['"`]\.\.['"`]|includes\s*\(\s*['"`]\.\.['"`]\s*\)/;
  const ABSOLUTE = /startsWith\s*\(\s*['"`]\//;
  // The post-resolve layer must be NEGATED. `if (abs.startsWith(base + sep))
  // refuse(…)` inverts containment — it rejects everything inside the base and
  // admits everything outside — while satisfying a presence-only check.
  const CONTAINED = /!\s*[\w.]*\bstartsWith\s*\(\s*base\s*\+\s*sep\s*\)/;

  if (!DOTDOT.test(codeBody)) {
    problems.push(`${HELPER_FILE}: ${HELPER}() no longer rejects ".." segments — containment is inert.`);
  } else if (!rejectsWhen(codeBody, DOTDOT)) {
    problems.push(
      `${HELPER_FILE}: ${HELPER}() still TESTS for ".." segments but no longer refuses on one — ` +
        'the layer is present and inert. Guard it with `if (…) refuse(…)`.',
    );
  }
  if (!ABSOLUTE.test(codeBody)) {
    problems.push(`${HELPER_FILE}: ${HELPER}() no longer rejects absolute paths — containment is inert.`);
  } else if (!rejectsWhen(codeBody, ABSOLUTE)) {
    problems.push(
      `${HELPER_FILE}: ${HELPER}() still TESTS for absolute paths but no longer refuses on one — ` +
        'the layer is present and inert. Guard it with `if (…) refuse(…)`.',
    );
  }
  if (!/startsWith\s*\(\s*base\s*\+\s*sep\s*\)/.test(body)) {
    problems.push(
      `${HELPER_FILE}: ${HELPER}() no longer performs the post-resolve \`base + sep\` containment ` +
        'comparison — the syntactic checks alone are not the chokepoint.',
    );
  } else if (!rejectsWhen(body, CONTAINED)) {
    problems.push(
      `${HELPER_FILE}: ${HELPER}() performs the post-resolve \`base + sep\` comparison but does not ` +
        'refuse on the NEGATED result — containment is inert or inverted. Expected ' +
        '`if (!abs.startsWith(base + sep)) refuse(…)`.',
    );
  }
  return problems;
}

/** Rival containment helpers, so two implementations cannot drift apart. */
export function findRivalHelpers(src) {
  const masked = maskCommentsAndStrings(src);
  const m = masked.match(/(?:export\s+)?function\s+(containedJoin|safeJoin|securePathJoin|joinContained)\s*\(/);
  return m ? [m[1]] : [];
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const failures = [];
  const staleExempt = new Set(EXEMPT.keys());
  /** `--verbose` prints every network-derived write site and how it is contained. */
  const VERBOSE = process.argv.includes('--verbose');

  let scanned = 0;
  let sinkCount = 0;
  let taintedSinkCount = 0;

  // A2: adoption
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO, root))) {
      const key = rel(abs);
      if (key === HELPER_FILE) continue;
      const src = fs.readFileSync(abs, 'utf8');
      const probe = new RegExp(SINK_RE.source, 'g');
      if (!probe.test(src)) continue;
      scanned++;
      sinkCount += (src.match(new RegExp(SINK_RE.source, 'g')) || []).length;

      for (const hit of findRemotePathWrites(src)) {
        taintedSinkCount++;
        if (hit.contained) {
          if (VERBOSE) console.log(`[remote-path-containment] ok   ${key}:${hit.line} ${hit.arg.slice(0, 40)} → ${HELPER}`);
          continue;
        }
        if (EXEMPT.has(key)) {
          staleExempt.delete(key);
          continue;
        }
        failures.push(
          `${key}:${hit.line} — ${hit.sink}() writes to a path built from a network response ` +
            `(\`${hit.arg.slice(0, 60)}\`) without ${HELPER}().`,
        );
      }
    }
  }

  // A1: helper integrity (anti-inert)
  const helperAbs = path.join(REPO, HELPER_FILE);
  if (!fs.existsSync(helperAbs)) {
    failures.push(`${HELPER_FILE} is missing — ${HELPER}() is the containment chokepoint.`);
  } else {
    failures.push(...checkHelperIntegrity(fs.readFileSync(helperAbs, 'utf8')));
  }

  // A3: no rival implementation
  for (const root of ROOTS) {
    for (const abs of walk(path.join(REPO, root))) {
      const key = rel(abs);
      if (key === HELPER_FILE) continue;
      for (const name of findRivalHelpers(fs.readFileSync(abs, 'utf8'))) {
        failures.push(`${key} defines a rival containment helper \`${name}\` — import ${HELPER} from ${HELPER_FILE} instead.`);
      }
    }
  }

  const tag = '[remote-path-containment]';
  console.log(`${tag} scanned ${scanned} file(s) with filesystem writes across ${ROOTS.length} roots`);
  console.log(`${tag} ${sinkCount} write site(s); ${taintedSinkCount} with a network-derived path`);

  for (const key of staleExempt) {
    console.warn(`${tag} WARNING: stale exemption for ${key} — it no longer violates. Remove it.`);
  }

  if (failures.length) {
    console.error(`\n${tag} FAIL — ${failures.length} violation(s):`);
    for (const f of failures) console.error(`   - ${f}`);
    console.error(
      `\n${tag} fix: build the path with ${HELPER}(baseDir, untrustedRelPath) from ${HELPER_FILE}. ` +
        'It refuses "..", absolute paths, Windows drives, NUL and backslashes, and then asserts the ' +
        'resolved path is still inside baseDir. Do not re-implement it.',
    );
    return 1;
  }
  console.log(`${tag} OK — every network-derived filesystem path is contained, and the helper is intact.`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
