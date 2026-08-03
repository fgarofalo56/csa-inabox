#!/usr/bin/env node
/**
 * check-prototype-pollution — closes the "a caller-supplied string becomes an
 * object key" class (CodeQL js/remote-property-injection + js/prototype-pollution-utility).
 *
 * WHY A GREP AND NOT JUST CODEQL. Reviewing the four alerts open on
 * b4ce338e produced two findings that matter more than the alerts:
 *
 *   1. CodeQL CANNOT SEE THE FIX THIS REPO USES. `RemotePropertyInjectionQuery.qll`
 *      declares exactly two barriers — an `abstract class Sanitizer` with zero
 *      library subclasses, and a constant-string concatenation root. It never
 *      consults `PropertyInjection::isPrototypeLessObject`, even though CodeQL's
 *      own `PropertyInjectionShared.qll` defines that predicate for
 *      `Object.create(null)` and the sibling `js/unsafe-dynamic-method-access`
 *      query uses it. So `safeRecord()` — the STRUCTURAL fix, which closes more
 *      of the class than any denylist — leaves the alert open forever. Three of
 *      the four alerts are that. Dismissing them is correct; leaving the
 *      dismissal unguarded is not, because a revert to `{}` would never
 *      re-trigger a dismissed alert. RULE C is that guard.
 *
 *   2. CodeQL MISSED live instances the same review found by hand.
 *      `lib/azure/object-dataset-sync.ts` wrote source-column names and an
 *      editor-supplied `columnMap` into three object literals behind
 *      `/^[A-Za-z_][\w]{0,62}$/` — a filter that reads as a strict identifier
 *      check and ACCEPTS `__proto__`, `constructor`, `prototype`, `toString`,
 *      `valueOf` and `hasOwnProperty`, because `_` is `\w`. Its two siblings
 *      (the ontology objects/links routes) had already been moved onto
 *      `safeRecord()` in #2657 with the reasoning written out; this file never
 *      adopted it. That is the repo's recurring guard-adoption gap, and only a
 *      grep closes it. RULE B is that grep.
 *
 * RULES
 *   A  A dotted-path WRITER — a function that turns a string into tokens with
 *      `.split('.')` (directly, or through a local tokenizer) and then uses a
 *      token AS AN OBJECT KEY — must either write onto a prototype-less target
 *      or carry a LOCAL literal denylist. #2773 expressed the identical rule as
 *      `toks.some(isDangerousKey)` behind an import; it shipped and alert #374
 *      stayed open on the same head commit, because the query's only denylist
 *      barrier (`DenyListEqualityGuard`) matches an equality test whose operand
 *      is the literal string. Local literals or a null-prototype target; an
 *      imported predicate does not count.
 *   B  A computed-key write gated by an identifier-shaped regex that ADMITS `_`
 *      must land on `safeRecord()` / `Object.create(null)` / a `Map`.
 *   C  Dismissal register: each CodeQL alert dismissed as a false positive
 *      because of a null-prototype target names the construct the dismissal
 *      relied on. Delete the construct and this goes red with the alert number.
 *
 * Usage: node scripts/ci/check-prototype-pollution.mjs
 *        node scripts/ci/check-prototype-pollution.mjs --self-test   (guard's own fixtures)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const SCAN = ['apps/fiab-console/lib', 'apps/fiab-console/app'];
const SKIP_DIR = new Set([
  'node_modules', '.next', 'dist', 'build', '__tests__', '__mocks__', 'coverage',
  // Content bundles embed Python / DAX / SQL source as string literals; `df[col] = …`
  // in a Python heredoc is not a JavaScript property write.
  'content-bundles',
]);

/** The three keys that reach a prototype slot on a plain object. */
const SLOT_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Constructs that make a computed-key write safe by construction. */
const SAFE_TARGET = /safeRecord\s*[<(]|safeRecordFrom\s*[<(]|Object\.create\s*\(\s*null\s*\)|new Map\s*[<(]|toSafeStringMap\s*\(/;

// ───────────────────────────────────────────────────────────────────────────
// RULE C — the prototype-less register.
//
// Two kinds of row, both needing the same grep:
//
//   kind:'dismissal' — a CodeQL alert dismissed as "false positive" ON THE
//     GROUND that the write target has no prototype. The dismissal is only true
//     while the construct is there, and a DISMISSED ALERT NEVER RE-FIRES, so
//     nothing else would notice a revert. Removing a row means re-opening the
//     alert, not editing this file.
//
//   kind:'adoption' — a site CodeQL never reported, fixed by hand, and not
//     covered by RULE A or RULE B. Without a row here the fix is one careless
//     revert away from gone, with no signal anywhere.
// ───────────────────────────────────────────────────────────────────────────
const DISMISSAL_REGISTER = [
  {
    kind: 'dismissal',
    alert: 627,
    rule: 'js/remote-property-injection',
    file: 'apps/fiab-console/app/api/workspaces/bulk-delete/route.ts',
    requires: /const teardown = safeRecord</,
    why: 'per-workspace teardown receipts keyed by a request-supplied workspace id',
  },
  {
    kind: 'dismissal',
    alert: 578,
    rule: 'js/remote-property-injection',
    file: 'apps/fiab-console/app/api/items/report/[id]/data-source/route.ts',
    requires: /const out = safeRecord<TableStorageMap\[string\]>\(\)/,
    why: 'state.tableStorage keyed by client-supplied table names',
  },
  {
    kind: 'dismissal',
    alert: 730,
    rule: 'js/remote-property-injection',
    file: 'apps/fiab-console/lib/azure/mdm-store.ts',
    requires: /const out = safeRecord<CrosswalkPair\[\]>\(\)/,
    why: 'crosswalk byModel keyed by a request-supplied modelId (also assertSafeKey at the write)',
  },
  {
    kind: 'adoption',
    alert: null,
    rule: 'unreported sibling',
    file: 'apps/fiab-console/app/api/items/report/[id]/refresh/route.ts',
    requires: /const out = safeRecord<\{ mode: StorageMode \}>\(\)/,
    why:
      'THIRD copy of parseTableStorage. The write side (data-source route) and report-model-resolver' +
      ' both use safeRecord; this reader was missed, so the map one route stored safely was read back' +
      ' into a prototype-bearing object. No identifier regex here, so RULE B does not see it',
  },
  {
    kind: 'adoption',
    alert: null,
    rule: 'unreported sibling',
    file: 'apps/fiab-console/lib/auth/msal.ts',
    requires: /const buckets = safeRecord<Record<string, Record<string, unknown>>>\(\)/,
    why:
      'MSAL cache buckets keyed by home_account_id.split(".")[0]. On a literal, ensure("constructor")' +
      ' saw the INHERITED Object.prototype.constructor as an existing bucket. Entra issues the value,' +
      ' so this is a shape fix rather than a live bug — but a revert must not be silent',
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Scanning helpers.
// ───────────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** True for a line that is entirely a comment — those never execute a write. */
const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

/**
 * `IDENT[expr] = …` with a non-literal key.
 *
 * Excludes `a['lit'] = …` and `a[0] = …` (a constant key is not injectable) and
 * array destructuring `const [a, b] = …`, where the `[` is a binding pattern
 * rather than an index — without the keyword check the matcher reported
 * `const[a, b]` as a write to a base named `const`.
 */
const COMPUTED_WRITE = /(?:^|[^\w.$'"`\]])([A-Za-z_$][\w$]*)\s*\[\s*([^\]]+?)\s*\]\s*=(?!=)/;

/** Words that can precede `[` without being an object being written to. */
const NOT_A_BASE = new Set([
  'const', 'let', 'var', 'return', 'case', 'typeof', 'await', 'of', 'in',
  'new', 'else', 'do', 'yield', 'delete', 'void', 'export', 'default',
]);

function computedWriteOn(line) {
  if (isCommentLine(line)) return null;
  const m = COMPUTED_WRITE.exec(line);
  if (!m) return null;
  if (NOT_A_BASE.has(m[1])) return null;
  const key = m[2].trim();
  if (/^['"`]/.test(key) || /^-?\d+$/.test(key)) return null;
  return { base: m[1], key };
}

// ───────────────────────────────────────────────────────────────────────────
// RULE A — dotted-path writers need a LOCAL literal denylist.
// ───────────────────────────────────────────────────────────────────────────

/** `<expr>.split('.')` — the source of every path token. */
const SPLIT_ON_DOT = /\.split\(\s*(['"`])\.\1\s*\)/;

/**
 * Split a file into brace-balanced function bodies, cheaply.
 *
 * We only need "the text between a `function`/arrow header and its matching
 * closing brace" so the denylist and the write can be required to live in the
 * same function. A mis-parse can only MERGE two functions, which makes the rule
 * fire less often, never more; the self-test pins the shapes that matter.
 */
function functionSpans(src) {
  const spans = [];
  const HEADER = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = HEADER.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    spans.push({ name: m[1] || m[2], start: m.index, end: i, text: src.slice(m.index, i + 1) });
  }
  return spans;
}

/**
 * Names of functions in this file that RETURN path tokens — i.e. whose body
 * splits on `.`. `setPath` in activity-forms.tsx reaches its tokens through
 * `tokenize(path)`, so following one level of this indirection is required for
 * the guard to cover the very site it was written for.
 */
function tokenizerNames(spans) {
  const names = new Set();
  for (const s of spans) if (s.name && SPLIT_ON_DOT.test(s.text)) names.add(s.name);
  return names;
}

/**
 * Local names bound to a token array/element inside `text`:
 *   const toks = path.split('.')          → toks
 *   for (const t of path.split('.'))      → t
 *   const toks = tokenize(path)           → toks   (tokenize splits on '.')
 *   const t = toks[i]  /  for (const t of toks)    → t   (element of the above)
 *
 * The last form is not optional. `setPath` — the site this rule exists for —
 * writes `cur[t]` where `const t = toks[i]`, so a version that only tracked
 * `toks` reported NOTHING when the guard was mutated away. That was caught by
 * mutation-testing this script, not by reading it.
 */
function tokenBindings(text, tokenizers) {
  const names = new Set();
  const direct = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*[^;\n]*\.split\(\s*(['"`])\.\2\s*\)/g;
  const loop = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+[^)\n]*\.split\(\s*(['"`])\.\2\s*\)/g;
  let m;
  while ((m = direct.exec(text))) names.add(m[1]);
  while ((m = loop.exec(text))) names.add(m[1]);
  for (const fn of tokenizers) {
    const viaFn = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;\\n]+)?=\\s*${fn}\\s*\\(`, 'g');
    while ((m = viaFn.exec(text))) names.add(m[1]);
  }
  // Fixpoint: an element read off a token array is itself a token.
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of [...names]) {
      const elem = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;\\n]+)?=\\s*${n}\\s*\\[`, 'g');
      const forOf = new RegExp(`\\bfor\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${n}\\b`, 'g');
      for (const re of [elem, forOf]) {
        let hit;
        while ((hit = re.exec(text))) if (!names.has(hit[1])) { names.add(hit[1]); grew = true; }
      }
    }
  }
  return names;
}

/**
 * Every computed write in `text` whose KEY mentions one of `tokens` —
 * `cur[t] = …`, `cur[toks[i]] = …`, `cur[toks[toks.length - 1]] = …`.
 *
 * Requiring the token IN THE KEY is what separates a path WRITER from the
 * unrelated `const [a, b] = s.split('.')` destructure that happens to sit in a
 * function which also writes some other computed key. Without it this rule
 * reported 15 sites, 14 of them destructures.
 */
function writesATokenKey(text, tokens) {
  const hits = [];
  for (const line of text.split('\n')) {
    const w = computedWriteOn(line);
    if (!w) continue;
    for (const t of tokens) {
      if (new RegExp(`(?:^|[^\\w$])${t}(?:$|[^\\w$])`).test(w.key)) { hits.push({ line, ...w }); break; }
    }
  }
  return hits;
}

/**
 * True when `base` is declared prototype-less inside `text`.
 *
 * Follows plain aliases up to 3 hops, because the canonical shape is
 * `const root = safeRecord(); let cur = root;` and the write happens on `cur`.
 * Without the walk this reported the null-prototype fixture as a violation —
 * the guard would have pushed a correctly-fixed site back to a denylist.
 *
 * A null-prototype target is the STRONGER fix: it also closes `toString` /
 * `valueOf` / `hasOwnProperty`, which the 3-key denylist leaves open (see
 * lib/security/__tests__/request-key-sinks.test.ts). Either satisfies RULE A.
 */
function baseIsPrototypeLess(text, base) {
  let name = base;
  for (let hop = 0; hop < 3 && name; hop++) {
    const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^\\n;=]*=\\s*([^\\n;]*)`).exec(text);
    if (!m) return false;
    if (SAFE_TARGET.test(m[1])) return true;
    const alias = /^([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(m[1].trim());
    name = alias ? alias[1] : null;
  }
  return false;
}

function ruleAOnSource(src) {
  const out = [];
  if (!SPLIT_ON_DOT.test(src)) return out;
  const spans = functionSpans(src);
  const tokenizers = tokenizerNames(spans);
  for (const span of spans) {
    const tokens = tokenBindings(span.text, tokenizers);
    if (!tokens.size) continue;
    const unsafeWrites = writesATokenKey(span.text, tokens).filter((h) => !baseIsPrototypeLess(span.text, h.base));
    if (!unsafeWrites.length) continue;
    const missing = SLOT_KEYS.filter((k) => !span.text.includes(`'${k}'`) && !span.text.includes(`"${k}"`));
    if (missing.length) out.push({ span, missing, hit: unsafeWrites[0] });
  }
  return out;
}

function ruleA(files) {
  const failures = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const { span, missing, hit } of ruleAOnSource(src)) {
      const line = src.slice(0, span.start).split('\n').length;
      failures.push(
        `${relative(ROOT, file)}:${line} (${span.name || 'anonymous'}) — dotted-path writer \`${hit.base}[${hit.key}]\` on a prototype-bearing object, with no LOCAL literal denylist (missing ${missing.join(', ')}).\n` +
        `      Either declare \`${hit.base}\` with safeRecord() (stronger — also closes toString / valueOf),\n` +
        `      or write the denylist inline: if (t === '__proto__' || t === 'constructor' || t === 'prototype') return …\n` +
        `      A shared predicate behind an import is invisible to CodeQL's DenyListEqualityGuard (see #2773 / alert #374).`,
      );
    }
  }
  return failures;
}

// ───────────────────────────────────────────────────────────────────────────
// RULE B — identifier-regex-gated writes need a prototype-less target.
// ───────────────────────────────────────────────────────────────────────────

/**
 * An anchored character-class regex whose first class contains `_`, so every
 * prototype-slot key matches it. `/^[A-Za-z_][\w]{0,62}$/` is the repo's copy.
 */
const ADMITS_UNDERSCORE_RE = /\/\^\[[^\]]*_[^\]]*\][^/\n]*\//;

/** How many lines above the write we look for the gating regex. */
const GATE_WINDOW = 3;

/**
 * The declaration of `base` NEAREST ABOVE line `i`, or '' if none.
 *
 * Nearest-above, not first-in-file: two functions in `object-dataset-sync.ts`
 * both call their local map `props`, and a first-in-file lookup blamed both
 * whenever either regressed.
 */
function nearestDecl(lines, i, base) {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${base}\\b[^\\n;]*=`);
  for (let j = i; j >= 0; j--) if (decl.test(lines[j])) return lines[j];
  return '';
}

function ruleB(files) {
  const failures = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!ADMITS_UNDERSCORE_RE.test(src)) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const w = computedWriteOn(lines[i]);
      if (!w) continue;
      const window = lines
        .slice(Math.max(0, i - GATE_WINDOW), i + 1)
        .filter((l) => !isCommentLine(l))
        .join('\n');
      if (!ADMITS_UNDERSCORE_RE.test(window)) continue;
      if (SAFE_TARGET.test(nearestDecl(lines, i, w.base))) continue;
      failures.push(
        `${relative(ROOT, file)}:${i + 1} — \`${w.base}[${w.key}] = …\` is gated by an identifier regex that ACCEPTS __proto__ (\`_\` is \`\\w\`), but \`${w.base}\` is a prototype-bearing object.\n` +
        `      Declare it with safeRecord() from lib/security/safe-object (or Object.create(null) / a Map).`,
      );
    }
  }
  return failures;
}

// ───────────────────────────────────────────────────────────────────────────
// RULE C — dismissal register.
// ───────────────────────────────────────────────────────────────────────────

function ruleC() {
  const failures = [];
  for (const row of DISMISSAL_REGISTER) {
    const tag = row.alert ? `CodeQL alert #${row.alert} (${row.rule})` : `an unreported sibling fix in ${row.file}`;
    const remedy = row.alert
      ? `A dismissed alert never re-fires, so this grep IS the control. Restore the prototype-less target, or re-open #${row.alert}.`
      : 'CodeQL never reported this site, so this grep is the ONLY control. Restore the prototype-less target.';
    const abs = join(ROOT, row.file);
    if (!existsSync(abs)) {
      failures.push(
        `${row.file} — file is gone, but ${tag} depends on this file's null-prototype target.\n` +
        '      Update DISMISSAL_REGISTER in this script and say where the write moved to.',
      );
      continue;
    }
    if (row.requires.test(readFileSync(abs, 'utf8'))) continue;
    failures.push(
      `${row.file} — the construct that justifies ${tag} is gone.\n` +
      `      Expected to match: ${row.requires}\n` +
      `      Context: ${row.why}.\n` +
      `      ${remedy}`,
    );
  }
  return failures;
}

// ───────────────────────────────────────────────────────────────────────────
// Exposed to scripts/ci/__tests__/prototype-pollution-guard.test.mjs so each
// rule can be shown to FAIL on a violating fixture and PASS on the fixed one.
// A rule that has never been seen red is not a control.
// ───────────────────────────────────────────────────────────────────────────
export const _internals = {
  ruleAOnSource,
  ruleBOnSource,
  ruleC,
  computedWriteOn,
  functionSpans,
  DISMISSAL_REGISTER,
  SAFE_TARGET,
  ADMITS_UNDERSCORE_RE,
};

/** RULE B against a source string (used by the unit test). */
function ruleBOnSource(src) {
  const out = [];
  if (!ADMITS_UNDERSCORE_RE.test(src)) return out;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const w = computedWriteOn(lines[i]);
    if (!w) continue;
    const window = lines.slice(Math.max(0, i - GATE_WINDOW), i + 1).filter((l) => !isCommentLine(l)).join('\n');
    if (!ADMITS_UNDERSCORE_RE.test(window)) continue;
    if (SAFE_TARGET.test(nearestDecl(lines, i, w.base))) continue;
    out.push(`${i + 1}:${w.base}`);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────

function main() {
  const files = SCAN.flatMap((d) => walk(join(ROOT, d)));
  const failures = [...ruleC(), ...ruleA(files), ...ruleB(files)];

  if (failures.length) {
    console.error('\nprototype-pollution guard FAILED\n');
    for (const f of failures) console.error(`  ✗ ${f}\n`);
    console.error(
      `${failures.length} violation(s). Background: lib/security/safe-object.ts, .claude/rules/no-vaporware.md,\n` +
      'and lib/security/__tests__/request-key-sinks.test.ts (which proves the identifier regex admits __proto__).\n',
    );
    process.exit(1);
  }
  console.log(
    `prototype-pollution guard OK — ${files.length} files scanned; ` +
    `${DISMISSAL_REGISTER.filter((r) => r.kind === 'dismissal').length} dismissal(s) still justified, ` +
    `${DISMISSAL_REGISTER.filter((r) => r.kind === 'adoption').length} unreported-sibling fix(es) still in place.`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/'))) main();
