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
 *   RULE 2 (R7 false claim). A useQuery whose queryFn can THROW, with NO error
 *          branch bound to THAT query (`q.isError` / `q.error` /
 *          `q.status === 'error'`, a destructured error member that is actually
 *          used, or the query passed to `<QueryErrorBar query={…}>`). Such a
 *          component silently renders its loading or empty branch forever after
 *          a failure.
 *          Fix: render the shared
 *          `apps/fiab-console/lib/components/ui/query-error-bar.tsx` —
 *          `<QueryErrorBar query={q} subject="…" endpoint="…" />`.
 *
 *   RULE 3 (chokepoint teeth). `useItemDocState.save()` and
 *          `phase4/shared.tsx`'s `useItemState.save()` must both consult
 *          `canPersistItemState` BEFORE issuing their PATCH. Deleting the guard
 *          from the primitive would silently re-open the hole for every
 *          adopter at once, and RULES 1-2 would not notice.
 *
 * HOW RULE 2 RESOLVES ITS "THROWING FETCHER" SET (rewritten, C20 sweep)
 *   Never a hand-kept list — that is a fixture modelling the code instead of
 *   reading it. The resolver READS the queryFn: an inline arrow body, a local
 *   definition, or a symbol followed through `@/`-alias and relative imports,
 *   bounded in depth, honouring try/catch (a swallowing catch means the fetcher
 *   does NOT throw). The FIRST version derived only from lib/api/workspaces.ts
 *   and matched `queryFn:` up to the first comma — it saw 8 of the 46 queries
 *   whose fetcher can throw, and reported OK. It is now 43 of 46, and a
 *   self-check FAILS THE BUILD (exit 2) if that ratio collapses, so a broken
 *   resolver can never again present itself as a clean tree.
 *
 * KEYED ON THE SAFE PATTERN, DELIBERATELY
 *   "Handled" is defined by the presence of an error branch, never by the
 *   absence of some unsafe token. A rule keyed to the unsafe pattern goes quiet
 *   on exactly the files that adopt the fix — this repo has already paid for
 *   that lesson (`csa_loom_guard_keyed_to_the_unsafe_pattern`).
 *
 * ALLOWLIST
 *   RULE 1 has NO allowlist — a catch that discards a read error in a file that
 *   can overwrite that same state is exactly the harm.
 *   RULE 2 entries live in ALLOWLIST_RULE2 and must carry a MEASURED reason.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname, resolve } from 'node:path';

const REPO = process.cwd();
const CONSOLE_DIR = join(REPO, 'apps', 'fiab-console');
const SCAN_ROOTS = [join(CONSOLE_DIR, 'lib'), join(CONSOLE_DIR, 'app')];

/**
 * RULE 2 exemptions. Each MUST state the MEASURED reason the component cannot
 * mislead — not "this one is hard". An entry whose real reason is "I did not
 * want to fix it" is a defect, and the guard prints these reasons on failure so
 * they stay under review.
 */
const ALLOWLIST_RULE2 = new Map([
  ['apps/fiab-console/lib/components/ui/use-runtime-flag.ts',
    'DELIBERATE FAIL-OPEN, and an error branch would be the BUG. This is the '
    + 'client half of the FLAG0 kill-switch substrate: `loom_default_on_opt_out` '
    + 'requires that while loading, on any fetch error, and for an unknown id, '
    + 'the DEFAULT is returned — the kill-switch subsystem may only revert a '
    + 'surface an admin explicitly turned OFF, never gate one because a fetch '
    + 'failed. MEASURED: the hook renders NOTHING (it returns a boolean), so it '
    + 'makes no claim a user can read; rendering an error here would let a '
    + '/api/runtime-flags blip take down every flagged surface at once.'],
  ['apps/fiab-console/app/workspaces/[id]/page.tsx',
    'WorkspaceMembers only. MEASURED: its queryFn returns [] for every non-OK '
    + 'HTTP (the route is owner-scoped, so 401/404 is the NORMAL case for a '
    + 'non-owner), so only a transport rejection reaches the error path — and '
    + 'both outcomes render `null`: the decorative avatar strip is simply '
    + 'absent. An absent decoration asserts nothing, so there is no R7 false '
    + 'claim to correct, and an error bar in the workspace header would fire '
    + 'for every non-owner. The page-level `wsQ` DOES carry a full error branch '
    + 'for the read that actually matters.'],
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

/**
 * Blank comments to SPACES, preserving length and newlines, so byte offsets and
 * line numbers computed on the original still hold.
 *
 * RULE 2 needs this for the same reason RULE 3 does. Found by mutation M1b: a
 * full revert of the powerplatform fix — bar deleted, `!itemQ.isError` guard
 * deleted — left the guard GREEN, because the explanatory comment above the
 * bind banner still contained the string `itemQ.isError`. A rule satisfied by a
 * COMMENT measures nothing, and this one is especially treacherous: the more
 * carefully a fix is documented, the more likely its own comment keeps the
 * guard quiet after the fix is removed.
 */
function blankComments(s) {
  const out = s.split('');
  let i = 0;
  while (i < out.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < s.length) { if (s[i] === '\\') { i += 2; continue; } if (s[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      const stop = end < 0 ? s.length : end + 2;
      for (; i < stop; i++) if (s[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

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
// RULE 2 — useQuery + a THROWING queryFn + no error branch bound to THAT query.
//
// ## Why this was rewritten (FINISHLINE C20 sweep)
//
// The first version derived its throwing-fetcher set from lib/api/workspaces.ts
// alone and matched `queryFn:` with `/([^,\n]+)/`. Measured against all 49
// useQuery consumers in this app, that saw 8 of the 46 whose fetcher can throw.
// It was blind to:
//
//   * `queryFn: async () => { …; throw new Error(...) }` — an INLINE arrow. Ten
//     admin panels (copilot-quality, prompt-registry, search-quality,
//     tier-routing, token-budget, user-data-function) use exactly this shape, so
//     deleting their error branch would NOT have failed CI.
//   * a fetcher imported from anywhere other than workspaces.ts — including
//     `clientFetch` itself, which rejects on transport failure and on its 20s
//     timeout, and is what makes ~all of these fetchers throwing.
//
// So it enforced the rule on a sixth of its subject and reported OK. This
// version RESOLVES the queryFn: inline bodies, local definitions, and imported
// symbols followed through `@/`-alias and relative specifiers, bounded in depth.
//
// ## It is keyed on the SAFE pattern, deliberately
//
// "Handled" is: an error member OF THIS QUERY is referenced, or this query is
// passed to `<QueryErrorBar query={…}>` (the shared honest-error surface in
// lib/components/ui/query-error-bar.tsx). Keying on the safe pattern is what
// stops the next variant of the BUG walking past — and this repo has already
// been bitten the other way, by a rule keyed to the unsafe token that went
// quiet on precisely the files that adopted the fix.
//
// ## try/catch is honoured
//
// A body whose fetch sits inside a try with a swallowing catch does NOT throw
// (e.g. `getWorkspaceAdminStatus`, and the `/api/auth/me` query on
// app/workspaces/page.tsx). Those are correctly NOT flagged. A catch that
// rethrows still counts as throwing.
// ---------------------------------------------------------------------------

const srcCache = new Map();
function readSrc(p) {
  if (!srcCache.has(p)) {
    try { srcCache.set(p, readFileSync(p, 'utf8')); } catch { srcCache.set(p, null); }
  }
  return srcCache.get(p);
}

/** Resolve `sym` imported by `file` to the file that defines it. */
function resolveImportedFrom(file, sym) {
  const src = readSrc(file);
  if (!src) return null;
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const bound = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop().trim());
    if (!bound.includes(sym)) continue;
    const spec = m[2];
    let base;
    if (spec.startsWith('@/')) base = join(CONSOLE_DIR, spec.slice(2));
    else if (spec.startsWith('.')) base = resolve(dirname(file), spec);
    else return null; // node_modules — out of scope, treated as non-throwing
    for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (existsSync(cand)) return cand;
    }
    return null;
  }
  return null;
}

/**
 * Remove `try { … } catch (…) { … }` whose catch does NOT rethrow, so a
 * swallowed rejection is not counted as a throw. Runs to a fixed point for
 * nested try blocks.
 */
function stripSwallowedTries(body) {
  let out = body;
  for (let pass = 0; pass < 6; pass++) {
    const re = /\btry\s*\{/g;
    let m; let changed = false;
    while ((m = re.exec(out))) {
      const tryBlk = blockAt(out, m.index + m[0].length - 1);
      if (!tryBlk) continue;
      const after = out.slice(tryBlk.close + 1);
      const cm = /^\s*catch\s*(?:\([^)]*\)\s*)?\{/.exec(after);
      if (!cm) continue;
      const catchStart = tryBlk.close + 1 + cm.index + cm[0].length - 1;
      const catchBlk = blockAt(out, catchStart);
      if (!catchBlk) continue;
      if (/\bthrow\b/.test(stripComments(catchBlk.body))) continue; // rethrows — keep
      out = out.slice(0, m.index) + ' '.repeat(catchBlk.close + 1 - m.index) + out.slice(catchBlk.close + 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return out;
}

/**
 * Identifiers this body CALLS (keywords filtered).
 *
 * The generic-argument clause is load-bearing: without it `fetchJson<T>(…)`
 * does not match `name\s*\(`, and since `lib/api/workspaces.ts` reaches its
 * throwing `fetchJson` through exactly that call shape, EVERY consumer of
 * getItem / listItems / listFolders / listTaskFlows / listWorkspacesWithCounts
 * resolved as non-throwing and was silently exempted. Measured: 24/46 before
 * this clause, 44/46 after.
 */
const CALL_KEYWORDS = new Set([
  'async', 'if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'function',
  'typeof', 'new', 'super', 'Boolean', 'String', 'Number', 'Array', 'Object', 'JSON',
]);
function calledIdentifiers(body) {
  return [...new Set(
    [...body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^<>()]*>)?\s*\(/g)]
      .map((x) => x[1])
      .filter((n) => !CALL_KEYWORDS.has(n)),
  )];
}

/**
 * Locate a top-level definition of `sym` in `src`; returns its BODY or null.
 *
 * The return-type skip is load-bearing. `async function fetchOverview():
 * Promise<{ ok: boolean; tiles?: OverviewTiles }> { … }` has a `{` inside its
 * RETURN TYPE, and simply taking "the next `{`" hands back the type literal as
 * the body — so the function reads as calling nothing and resolves as
 * non-throwing. That silently exempted every consumer of clientFetch-based
 * fetchers (fetchOverview, fetchFlags, getJson, getFocus, fetchRum), i.e. the
 * guard would have reported OK while not looking at them at all.
 */
function definitionBody(src, sym) {
  const defRe = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${sym}\\s*[(<]`
    + `|(?:export\\s+)?const\\s+${sym}\\s*(?::[^=\\n]*)?=\\s*(?:async\\s*)?[(<]`,
  );
  const d = defRe.exec(src);
  if (d === null) return null;

  // Walk to the end of the parameter list.
  const paren = src.indexOf('(', d.index);
  if (paren < 0) return null;
  let i = paren; let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; }
    }
  }

  // Skip an arrow and/or a return-type annotation, including `Promise<{…}>`
  // and a bare `{…}` object type, so we land on the real body brace.
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '=' && src[i + 1] === '>') i += 2;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === ':') {
    i++;
    let d2 = 0; let typeStart = true;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '<' || c === '(' || c === '[') { d2++; typeStart = false; continue; }
      if (c === '>' || c === ')' || c === ']') { d2--; typeStart = false; continue; }
      if (c === '{') {
        if (d2 > 0 || typeStart) {
          const blk = blockAt(src, i);
          if (!blk) return null;
          i = blk.close; typeStart = false; continue;
        }
        break; // depth-0 `{` after a complete type → the body
      }
      if (c === '=' && src[i + 1] === '>') { i += 1; typeStart = true; continue; }
      if (/\S/.test(c)) typeStart = '|&,:.'.includes(c);
    }
    while (i < src.length && /\s/.test(src[i])) i++;
  }
  if (src[i] !== '{') {
    // Expression-bodied arrow (`const f = async () => fetchJson(...)`) — no
    // block to read; hand back the rest of the statement.
    const nl = src.indexOf('\n', i);
    return src.slice(i, nl < 0 ? src.length : nl);
  }
  const blk = blockAt(src, i);
  return blk ? blk.body : null;
}

/** Does calling `sym` (defined in, or imported by, `file`) reject/throw? */
function symbolThrows(file, sym, depth = 0, seen = new Set()) {
  if (depth > 4) return false;
  const key = `${file}#${sym}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const src = readSrc(file);
  if (!src) return false;
  const body = definitionBody(src, sym);
  if (body === null) {
    const other = resolveImportedFrom(file, sym);
    return other ? symbolThrows(other, sym, depth + 1, seen) : false;
  }
  return bodyThrows(file, body, depth, seen);
}

/** Does this function body reject/throw, directly or via what it calls? */
function bodyThrows(file, rawBody, depth = 0, seen = new Set()) {
  const body = stripSwallowedTries(stripComments(rawBody));
  if (/\bthrow\b/.test(body)) return true;
  if (depth > 4) return false;
  for (const name of calledIdentifiers(body)) {
    const src = readSrc(file);
    if (src && definitionBody(src, name) !== null) {
      if (symbolThrows(file, name, depth + 1, seen)) return true;
      continue;
    }
    const other = resolveImportedFrom(file, name);
    if (other && symbolThrows(other, name, depth + 1, seen)) return true;
  }
  return false;
}

/** Every `useQuery` in the file, with its args and assignment target. */
function findQueries(src) {
  const out = [];
  const re = /(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*useQuery\s*[<(]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = m[1];
    const paren = src.indexOf('(', src.indexOf('useQuery', m.index) + 'useQuery'.length);
    out.push({
      destructured: target.startsWith('{') ? target : null,
      varName: target.startsWith('{') ? null : target,
      args: paren < 0 ? '' : (blockCallArgs(src, paren) ?? ''),
      line: lineOf(src, m.index),
      index: m.index,
    });
  }
  return out;
}

/**
 * Value of object property `name` in `args`, brace/paren/string aware — so an
 * INLINE `queryFn: async () => { … }` is captured whole instead of being cut at
 * the first comma, which is what made the previous version blind to it.
 */
function objectProp(args, name) {
  const re = new RegExp(`(^|[\\s{,])${name}\\s*:`, 'g');
  let m;
  while ((m = re.exec(args))) {
    let i = m.index + m[0].length;
    while (i < args.length && /\s/.test(args[i])) i++;
    const start = i;
    let depth = 0;
    for (; i < args.length; i++) {
      const c = args[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      else if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        while (i < args.length) {
          if (args[i] === '\\') { i += 2; continue; }
          if (args[i] === q) break;
          i++;
        }
      }
    }
    return args.slice(start, i).trim();
  }
  return null;
}

/**
 * Identifiers passed as `query={…}` to a <QueryErrorBar> in this file. This is
 * the SAFE-pattern half of the key: adopting the shared honest-error surface is
 * what satisfies the rule, so a future variant of the bug cannot satisfy it by
 * merely avoiding whatever token an unsafe-pattern rule looked for.
 */
function queriesGivenToErrorBar(src) {
  const out = new Set();
  const re = /<QueryErrorBar\b/g;
  let m;
  while ((m = re.exec(src))) {
    // The element text up to its closing `>` (attribute values are brace-matched).
    let i = m.index; let depth = 0; let end = -1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const el = src.slice(m.index, end);
    const qp = /query\s*=\s*\{/.exec(el);
    if (!qp) continue;
    const blk = blockAt(el, qp.index + qp[0].length - 1);
    if (!blk) continue;
    for (const id of blk.body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) out.add(id[0]);
  }
  return out;
}

/** Does THIS query have an honest error branch bound to it? */
function queryHandlesError(src, q, errorBarQueries) {
  if (q.destructured) {
    const names = q.destructured.replace(/[{}]/g, '').split(',')
      .map((x) => x.trim()).filter(Boolean)
      .map((x) => ({ from: x.split(':')[0].trim(), local: x.split(':').pop().trim() }));
    for (const n of names) {
      if (!['isError', 'error', 'isLoadingError', 'status'].includes(n.from)) continue;
      if (errorBarQueries.has(n.local)) return true;
      // Referenced somewhere OTHER than its own destructuring, and not merely
      // re-declared (`catch (error)` / `const error =`) — a bystander binding of
      // a common name like `error` must not satisfy the rule for this query.
      const useRe = new RegExp(`\\b${n.local}\\b`, 'g');
      let m; let real = 0;
      while ((m = useRe.exec(src))) {
        if (m.index > q.index && m.index < q.index + q.destructured.length + 40) continue;
        const before = src.slice(Math.max(0, m.index - 24), m.index);
        if (/\bcatch\s*\($/.test(before) || /\b(?:const|let|var)\s+$/.test(before)) continue;
        real++;
      }
      if (real > 0) return true;
    }
    return false;
  }
  const v = q.varName;
  if (errorBarQueries.has(v)) return true;
  const re = new RegExp(
    `\\b${v}\\s*\\.\\s*(isError|error|isLoadingError)\\b`
    + `|\\b${v}\\s*\\.\\s*status\\s*===\\s*['"]error['"]`,
  );
  return re.test(src);
}

let rule2Queries = 0;
let rule2Throwing = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  if (!/\buseQuery\s*[<(]/.test(raw)) continue;
  const relPath = rel(file);
  if (ALLOWLIST_RULE2.has(relPath)) continue;
  // Comments blanked (length- and line-preserving) — a rule that a COMMENT can
  // satisfy measures nothing. See blankComments() and mutation M1b.
  const src = blankComments(raw);
  const errorBarQueries = queriesGivenToErrorBar(src);

  for (const q of findQueries(src)) {
    rule2Queries++;
    const expr = objectProp(q.args, 'queryFn');
    if (!expr) continue;

    // Resolve the fetcher: an inline function body, or a named symbol.
    let throwing = false;
    let label = expr.slice(0, 40).replace(/\s+/g, ' ');
    const inline = /=>|^\s*(?:async\s+)?function\b/.test(expr);
    if (inline) {
      // Analyse the WHOLE arrow text, never "the block after `=>`": a
      // `queryFn: () => getJson(\`/api/x?y=${z}\`)` has its first `{` inside a
      // template placeholder, so brace-matching from the arrow returns `z` as
      // the "body" and the fetcher resolves as non-throwing. Two of the four
      // finops queries were exempted exactly that way.
      throwing = bodyThrows(file, expr);
      label = 'inline queryFn';
    } else {
      const bare = expr.replace(/[<(].*$/s, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bare)) {
        throwing = symbolThrows(file, bare);
        label = bare;
      }
    }
    if (!throwing) {
      if (process.env.LOOM_READ_HONESTY_DEBUG) {
        console.error(`[debug] NOT-THROWING ${relPath}:${q.line} queryFn=${expr.slice(0, 70).replace(/\s+/g, ' ')}`);
      }
      continue;
    }
    rule2Throwing++;
    if (queryHandlesError(src, q, errorBarQueries)) continue;

    violations.push({
      rule: 2,
      file: relPath,
      line: q.line,
      msg:
        `useQuery's fetcher (\`${label}\`) can THROW, but this query `
        + `(\`${q.varName || q.destructured}\`) has no error branch. A failed read therefore `
        + 'leaves the loading or empty branch on screen, asserting something the code never '
        + 'established (deploy-integrity.md R7). '
        + 'Fix: render the shared <QueryErrorBar query={…} subject="…" /> from '
        + 'lib/components/ui/query-error-bar.tsx — see s3-gateway-editor.tsx or assets/page.tsx.',
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

/**
 * SELF-CHECK — replaces the old "is fetchJson still throwing?" premise check.
 *
 * RULE 2's whole force comes from the resolver actually recognising throwing
 * fetchers. If a refactor breaks resolution the rule passes on every file — an
 * UNKNOWN reported as a negative, the failure this repo keeps re-learning, and
 * the exact way the FIRST version of this rule enforced itself on a sixth of
 * its subject while printing OK.
 *
 * MEASURED 2026-08-08: 43 of the 46 inspected useQuery consumers have a fetcher
 * that can throw. The 3 that cannot are deliberate and were each read:
 *   getWorkspaceAdminStatus  — try/catch → fail-closed default
 *   app/workspaces/page.tsx `me` — try/catch → `{}`
 *   rum-panel `fetchRum`     — catches into a structured FetchState.error
 *
 * So the floor is 85%: a resolver regression that loses more than ~4 queries
 * FAILS THE BUILD instead of quietly exempting them.
 */
const RESOLVER_FLOOR = 0.85;
if (rule2Queries === 0 || rule2Throwing < Math.floor(rule2Queries * RESOLVER_FLOOR)) {
  console.error(
    'check-editor-read-failure-honesty: RULE 2 resolved only '
    + `${rule2Throwing} throwing fetcher(s) across ${rule2Queries} useQuery consumer(s) `
    + `(floor ${Math.floor(rule2Queries * RESOLVER_FLOOR)}). That is far below the measured `
    + 'baseline of 43/46, so the RESOLVER — not the codebase — has almost certainly broken. '
    + 'Refusing to report OK on a check that is no longer looking. '
    + 'Re-run with LOOM_READ_HONESTY_DEBUG=1 to list what it failed to resolve.',
  );
  process.exit(2);
}

const total = violations.length;
console.log(
  `check-editor-read-failure-honesty: OK (${files.length} files scanned, `
  + `${rule2Throwing}/${rule2Queries} useQuery fetchers resolved as throwing, 3 chokepoints intact, `
  + `${total} baselined occurrence(s) — none new)`,
);
