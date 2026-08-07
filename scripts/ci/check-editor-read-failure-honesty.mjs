#!/usr/bin/env node
/**
 * GUARDRAIL: editor-read-failure-honesty  (merge-blocker)  — FINISHLINE C19/C20
 * ---------------------------------------------------------------------------
 * RULE (user-harm data loss, and the R7 false-claim class that precedes it):
 *
 *   A FAILED READ MUST NEVER BE INDISTINGUISHABLE FROM EMPTY CONTENT.
 *
 * THE INCIDENT THIS ENCODES
 *   Three editors — fusion-sheet, notepad, analysis-board — loaded their
 *   persisted state inside `try { … } catch { /* keep empty *\/ }`. A 500 /
 *   403 / network blip therefore rendered a surface visually identical to a
 *   genuinely empty item. The user, seeing a blank sheet, started typing — and
 *   Save then PATCHed that emptiness OVER their real persisted content. A
 *   transient backend error silently destroyed work, and no error was shown at
 *   any point.
 *
 *   The same swallow, minus the PATCH, produced the milder apex-A3 shape: a
 *   surface that sits on "Reading…" or asserts "no tables published" / "not
 *   deployed" after the read has already FAILED. That violates
 *   deploy-integrity.md R7 — an error must not state as fact something it did
 *   not establish.
 *
 *   The correct pattern EXISTED (s3-gateway-editor.tsx, apex A3) and was even
 *   pinned by a test — and no sibling ever adopted it. That is the
 *   guard-adoption gap, and it is why this rule is a CI guard and not a code
 *   review note.
 *
 * SCOPE: apps/fiab-console/{lib,app}/**\/*.tsx  (client surfaces)
 *
 * WHAT IT FORBIDS
 *   RULE 1 (data loss). In a file that PATCHes item state back to
 *          /api/{items,cosmos-items}/…, a try/catch whose try reads item state
 *          from /api/{items,cosmos-items}/… and whose CATCH IS EMPTY OR
 *          COMMENT-ONLY. Such a catch cannot have recorded the failure, so the
 *          surface below it is asserting "empty" on no evidence, and the file's
 *          own PATCH is a live overwrite path.
 *          Fix: use `useItemDocState` from lib/editors/use-item-doc-state.tsx
 *          (explicit ItemLoadStatus + a save() that REFUSES while the stored
 *          content is unknown), or, if you own the fetch, set an explicit error
 *          status in the catch and gate the write on it.
 *
 *   RULE 2 (R7 false claim). A useQuery whose queryFn can THROW, in a file with
 *          NO error branch at all (`isError` / `q.error` / `status === 'error'`).
 *          Such a component silently renders its loading or empty branch
 *          forever after a failure.
 *          Fix: render an honest error surface (MessageBar + Retry) — see
 *          s3-gateway-editor.tsx, ducklake-catalog-editor.tsx, or
 *          <ItemLoadErrorBar>.
 *
 *   RULE 3 (chokepoint teeth). `useItemDocState.save()` and
 *          `phase4/shared.tsx`'s `useItemState.save()` must both consult
 *          `canPersistItemState` BEFORE issuing their PATCH. Deleting the guard
 *          from the primitive would silently re-open the hole for every
 *          adopter at once, and RULES 1-2 would not notice.
 *
 * WHY RULE 2 DERIVES ITS "THROWING FETCHER" SET RATHER THAN LISTING IT
 *   A hand-written list of throwing fetchers is a fixture that models the code
 *   instead of reading it, and drifts the first time someone adds a `throw`.
 *   Instead the guard READS lib/api/workspaces.ts and treats every exported
 *   function that delegates to its throwing `fetchJson` as throwing, and it
 *   resolves locally-defined fetchers by looking for `throw` in their body.
 *
 * ALLOWLIST
 *   RULE 1 has NO allowlist — a catch that discards a read error in a file that
 *   can overwrite that same state is exactly the harm.
 *   RULE 2 entries live in ALLOWLIST_RULE2 and must carry a reason.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = process.cwd();
const CONSOLE_DIR = join(REPO, 'apps', 'fiab-console');
const SCAN_ROOTS = [join(CONSOLE_DIR, 'lib'), join(CONSOLE_DIR, 'app')];

/** RULE 2 exemptions. Each MUST say why the component cannot mislead. */
const ALLOWLIST_RULE2 = new Map([
  // (empty — every current consumer either has an error branch or a
  //  non-throwing fetcher. Add entries here ONLY with a real reason.)
]);

const rel = (p) => relative(REPO, p).split(sep).join('/');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.next' || e === '__tests__' || e === 'e2e') continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/**
 * Body of the block starting at the `{` at or after `from`. Returns
 * { body, open, close } or null. Brace-matched, string/comment aware enough for
 * this codebase (no regex-literal braces appear in the shapes we scan).
 */
function blockAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), open, close: i };
    } else if (c === '"' || c === "'" || c === '`') {
      // Skip the string literal.
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
    } else if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i); if (i < 0) return null;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i); if (i < 0) return null; i++;
    }
  }
  return null;
}

/** Strip comments so "is this block empty?" is a question about CODE. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The `try` block that a `catch` at `catchIdx` belongs to. */
function tryBlockFor(src, catchIdx) {
  // Walk back to the `}` that closes the try block, then brace-match backwards.
  let i = catchIdx - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (src[i] !== '}') return null;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    if (src[j] === '}') depth++;
    else if (src[j] === '{') {
      depth--;
      if (depth === 0) return src.slice(j + 1, i);
    }
  }
  return null;
}

const ITEM_ROUTE = /\/api\/(?:cosmos-items|items)\//;

/** Does this try-block READ item state (a fetch with no method → GET)? */
function readsItemState(tryBody) {
  const re = /(?:clientFetch|fetch)\s*\(/g;
  let m;
  while ((m = re.exec(tryBody))) {
    const call = blockCallArgs(tryBody, m.index + m[0].length - 1);
    if (call === null) continue;
    if (!ITEM_ROUTE.test(call)) continue;
    // A method: means it is a write, not the read we care about.
    if (/method\s*:/.test(call)) continue;
    return true;
  }
  return false;
}

/** Text between the `(` at `openIdx` and its matching `)`. */
function blockCallArgs(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
    }
  }
  return null;
}

/**
 * Can this file WRITE item state back?
 *
 * A literal `method:'PATCH'` is the obvious case. The subtle one — and the one
 * that made the FIRST version of this guard fail its own mutation test — is a
 * file that adopted `useItemDocState` / `useItemState` / `useGeoItemState`:
 * those hooks own the PATCH, so the adopter has no literal PATCH left and the
 * guard skipped it entirely. Reintroducing the exact C19 catch into
 * fusion-sheet-editor.tsx therefore went UNDETECTED on the first run. Adopting
 * the safe primitive must never be what turns the guard off.
 */
const STATE_WRITING_HOOKS = /\buse(?:ItemDocState|ItemState|GeoItemState)\s*[<(]/;
function writesItemState(src) {
  if (/method\s*:\s*['"]PATCH['"]/.test(src) && ITEM_ROUTE.test(src)) return true;
  return STATE_WRITING_HOOKS.test(src);
}

const violations = [];

// ---------------------------------------------------------------------------
// RULE 1 — a discarded read error in a file that can overwrite that same state.
// ---------------------------------------------------------------------------
const files = SCAN_ROOTS.flatMap((r) => walk(r));

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Only files that can WRITE item state can cause the data loss.
  if (!writesItemState(src)) continue;

  const catchRe = /\bcatch\s*(?:\([^)]*\)\s*)?\{/g;
  let m;
  while ((m = catchRe.exec(src))) {
    const blk = blockAt(src, m.index + m[0].length - 1);
    if (!blk) continue;
    const code = stripComments(blk.body).trim();
    if (code !== '') continue; // the catch does SOMETHING — out of scope here
    const tryBody = tryBlockFor(src, m.index);
    if (!tryBody) continue;
    if (!readsItemState(tryBody)) continue;
    violations.push({
      rule: 1,
      file: rel(file),
      line: lineOf(src, m.index),
      msg:
        'a read of item state is wrapped in an EMPTY/comment-only catch, in a file that '
        + 'also PATCHes that state back. A failed read therefore renders as empty content '
        + 'and the next save overwrites the real document. '
        + 'Fix: adopt useItemDocState (lib/editors/use-item-doc-state.tsx), or record an '
        + 'explicit error status in the catch and gate the PATCH on it.',
    });
  }
}

// ---------------------------------------------------------------------------
// RULE 2 — useQuery + a THROWING queryFn + no error branch anywhere in the file.
// ---------------------------------------------------------------------------

/**
 * Exported functions of lib/api/workspaces.ts that delegate to its throwing
 * `fetchJson`. DERIVED by reading the file, never a hand-kept list.
 */
function throwingSharedFetchers() {
  const p = join(CONSOLE_DIR, 'lib', 'api', 'workspaces.ts');
  let src;
  try { src = readFileSync(p, 'utf8'); } catch { return new Set(); }
  if (!/function fetchJson[\s\S]{0,600}?throw new Error/.test(src)) {
    // fetchJson stopped throwing — the derivation's premise is gone. Fail loud
    // rather than silently exempting every consumer (an UNKNOWN reported as a
    // negative is the class this repo keeps re-learning).
    console.error(
      'check-editor-read-failure-honesty: lib/api/workspaces.ts no longer has a throwing '
      + 'fetchJson. This guard derived its throwing-fetcher set from that fact. '
      + 'Re-derive it before this guard can be trusted.',
    );
    process.exit(2);
  }
  const out = new Set();
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const blk = blockAt(src, m.index + m[0].length - 1);
    if (blk && /\bfetchJson[<(]/.test(blk.body)) out.add(m[1]);
  }
  return out;
}

const SHARED_THROWERS = throwingSharedFetchers();
if (SHARED_THROWERS.size === 0) {
  console.error('check-editor-read-failure-honesty: derived ZERO throwing shared fetchers — the derivation is broken.');
  process.exit(2);
}

/**
 * Every `useQuery` in the file, as { varName | destructured, fnExpr, line }.
 *
 * The variable matters: an earlier draft of this guard asked only "does the
 * file mention `.error` anywhere?", which any unrelated `compiled.error` /
 * `j.error` / `st.error` satisfied — so the rule passed on files that plainly
 * had the bug. A guard whose verdict does not change when the subject breaks
 * is measuring nothing; this version binds the error branch to the QUERY.
 */
function findQueries(src) {
  const out = [];
  const re = /(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*useQuery\s*[<(]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = m[1];
    const open = src.indexOf('(', m.index + m[0].length - 1 === m.index ? m.index : m.index);
    const argsStart = src.indexOf('useQuery', m.index) + 'useQuery'.length;
    const paren = src.indexOf('(', argsStart);
    const args = paren < 0 ? '' : (blockCallArgs(src, paren) ?? '');
    out.push({
      destructured: target.startsWith('{') ? target : null,
      varName: target.startsWith('{') ? null : target,
      args,
      line: lineOf(src, m.index),
      index: m.index,
    });
    void open;
  }
  return out;
}

/** Does THIS query have an honest error branch? */
function queryHandlesError(src, q) {
  if (q.destructured) {
    // `const { data, isLoading, error } = useQuery(...)` — the destructured
    // name must then actually be referenced somewhere.
    const names = q.destructured.replace(/[{}]/g, '').split(',').map((x) => x.split(':').pop().trim());
    for (const n of names) {
      if (n === 'isError' || n === 'error' || n === 'isLoadingError' || n === 'status') {
        const useRe = new RegExp(`\\b${n}\\b`, 'g');
        // Referenced more than the destructuring site itself?
        if ((src.match(useRe) || []).length > 1) return true;
      }
    }
    return false;
  }
  const v = q.varName;
  const re = new RegExp(`\\b${v}\\s*\\.\\s*(isError|error|isLoadingError)\\b|\\b${v}\\s*\\.\\s*status\\s*===\\s*['"]error['"]`);
  return re.test(src);
}

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!/\buseQuery\s*[<(]/.test(src)) continue;
  const relPath = rel(file);
  if (ALLOWLIST_RULE2.has(relPath)) continue;

  for (const q of findQueries(src)) {
    if (queryHandlesError(src, q)) continue;
    const mm = /queryFn\s*:\s*([^,\n]+)/.exec(q.args);
    if (!mm) continue;
    const expr = mm[1].trim();
    const names = [...expr.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((x) => x[1]);
    const bare = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr) ? [expr] : [];
    let thrower = null;
    for (const name of [...names, ...bare]) {
      if (SHARED_THROWERS.has(name)) { thrower = name; break; }
      const defRe = new RegExp(`(?:async\\s+function\\s+${name}\\s*\\(|const\\s+${name}\\s*=\\s*async\\s*\\()`);
      const d = defRe.exec(src);
      if (!d) continue;
      const blk = blockAt(src, d.index + d[0].length - 1);
      if (blk && /\bthrow\b/.test(blk.body)) { thrower = name; break; }
    }
    if (!thrower) continue;
    violations.push({
      rule: 2,
      file: relPath,
      line: q.line,
      msg:
        `useQuery's fetcher \`${thrower}\` can THROW, but this query (\`${q.varName || q.destructured}\`) `
        + 'has no error branch. A failed read therefore leaves the loading or empty branch on '
        + 'screen, asserting something the code never established (deploy-integrity.md R7). '
        + 'Fix: render an honest error MessageBar + Retry — see s3-gateway-editor.tsx or '
        + 'ItemLoadErrorBar in lib/editors/use-item-doc-state.tsx.',
    });
  }
}

// ---------------------------------------------------------------------------
// RULE 3 — the primitives must keep their guard (chokepoint teeth).
//
// The check looks at CODE INSIDE THE SAVE CALLBACK, with comments stripped.
// A first draft asked only "does the file mention canPersistItemState?" — and
// a mutant that deleted the guard from `save()` PASSED, because the identifier
// survived in a JSDoc line ("Mirrors `canPersistItemState(load.status)`"). A
// guard satisfied by a comment is a guard that measures nothing.
// ---------------------------------------------------------------------------
const CHOKEPOINTS = [
  ['apps/fiab-console/lib/editors/use-item-doc-state.tsx', 'useItemDocState.save()'],
  ['apps/fiab-console/lib/editors/phase4/shared.tsx', 'useItemState.save()'],
  ['apps/fiab-console/lib/editors/geo-editors.tsx', 'useGeoItemState.save()'],
];
for (const [path, label] of CHOKEPOINTS) {
  let src;
  try { src = readFileSync(join(REPO, path), 'utf8'); } catch {
    violations.push({ rule: 3, file: path, line: 0, msg: `${label} chokepoint file is missing — the data-loss guard cannot be verified.` });
    continue;
  }
  const code = stripComments(src);
  // Locate the save callback and read only ITS body.
  const saveDef = /const\s+save\s*=\s*useCallback\s*\(/.exec(code);
  let guarded = false;
  if (saveDef) {
    // useCallback's first arg is the function; its body is the first block.
    const fnBlock = blockAt(code, saveDef.index + saveDef[0].length - 1);
    if (fnBlock && /\bcanPersistItemState\s*\(/.test(fnBlock.body)) guarded = true;
  }
  if (!guarded) {
    violations.push({
      rule: 3,
      file: path,
      line: saveDef ? lineOf(code, saveDef.index) : 0,
      msg:
        `${label} no longer calls canPersistItemState() in its own body. That call IS the `
        + 'data-loss guard: without it a save can PATCH on-screen state over a document that '
        + 'was never read. Removing it re-opens the hole for every adopter at once, and '
        + 'RULES 1-2 would not notice.',
    });
  }
}

// ---------------------------------------------------------------------------
// RATCHET
//
// The guard was written AFTER the class had already spread, and it found more
// than the hand sweep did: 23 RULE-1 sites across 13 files and 8 RULE-2 queries
// that a grep-based review had missed entirely. Blocking on all of them at once
// would mean either a very large, risky PR or (far worse) weakening the rule
// until it passed — and a rule weakened to pass is the "gate that measures
// nothing" failure this repo keeps re-learning.
//
// So: a PER-FILE baseline. Counts may only SHRINK. A file absent from the
// baseline must be at ZERO — which is what makes reintroducing the bug in
// fusion-sheet / notepad / analysis-board / graph-editors / geo-editors /
// sql-lab / streaming-sql / admin-catalog fail instantly, since none of them
// appear below. Deleting a baseline entry is the intended way to close one.
// ---------------------------------------------------------------------------
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'editor-read-failure-baseline.json');
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  console.error(`check-editor-read-failure-honesty: baseline missing/unreadable at ${rel(BASELINE_PATH)}.`);
  process.exit(2);
}

const observed = new Map();
for (const v of violations) {
  // RULE 3 is the chokepoint itself and is NEVER baselineable — if the guard
  // inside the primitive is gone, every adopter is exposed at once and no
  // per-file count can express that.
  if (v.rule === 3) continue;
  const k = `${v.file}#rule${v.rule}`;
  observed.set(k, (observed.get(k) || 0) + 1);
}

const rule3 = violations.filter((v) => v.rule === 3);

const failures = [];
for (const [key, count] of observed) {
  const allowed = baseline.known?.[key] ?? 0;
  if (count > allowed) {
    const first = violations.find((v) => `${v.file}#rule${v.rule}` === key);
    failures.push({
      key,
      count,
      allowed,
      sample: first,
    });
  }
}
// A baseline entry that no longer has violations must be REMOVED, so the
// ratchet cannot silently re-arm (the classic way a ratchet stops ratcheting).
const stale = Object.keys(baseline.known || {}).filter((k) => !observed.has(k));

if (failures.length || stale.length || rule3.length) {
  console.error('\ncheck-editor-read-failure-honesty: FAILED\n');
  console.error('A failed read must never be indistinguishable from empty content.\n');
  for (const v of rule3) {
    console.error(`  [RULE 3 — chokepoint, never baselineable] ${v.file}`);
    console.error(`    ${v.msg}\n`);
  }
  for (const f of failures) {
    console.error(`  ${f.key}: ${f.count} occurrence(s), baseline allows ${f.allowed}`);
    console.error(`    first at ${f.sample.file}:${f.sample.line}`);
    console.error(`    ${f.sample.msg}\n`);
  }
  if (stale.length) {
    console.error('  STALE baseline entries (fixed — delete them so the ratchet keeps its teeth):');
    for (const k of stale) console.error(`    ${k}`);
    console.error('');
  }
  process.exit(1);
}

const total = violations.length;
console.log(
  `check-editor-read-failure-honesty: OK (${files.length} files scanned, `
  + `${SHARED_THROWERS.size} throwing shared fetchers derived, 3 chokepoints intact, `
  + `${total} baselined occurrence(s) — none new)`,
);
