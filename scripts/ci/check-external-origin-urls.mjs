#!/usr/bin/env node
/**
 * GUARDRAIL: external-origin-urls  (merge-blocker, RATCHETING — #3468)
 * ===========================================================================
 * RULE: a URL handed to a CLIENT must be built on the FORWARDED origin
 * (`externalOrigin(req.headers)` from `@/lib/auth/auth-breaker`), never on the
 * request's OWN origin. (refs #3442, #3443, #3467, #3468)
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * This console runs `output: 'standalone'` with `ENV HOSTNAME="0.0.0.0"` and
 * `ENV PORT=3000`. Traced through the installed next@15.5.21:
 *
 *   build/utils.js:1316   standalone template -> startServer({hostname, port})
 *   base-server.js:329    this.fetchHostname = formatHostname(this.hostname)
 *   next-server.js:1312   initURL = `${protocol}://${fetchHostname}:${port}${req.url}`
 *   web/next-url.js       NextURL has NO x-forwarded-* handling
 *
 * So `req.url` and `req.nextUrl` carry the CONTAINER's authority. Any AUTHORITY
 * (origin / host / href / protocol) derived from them and handed to a client
 * points at `0.0.0.0:3000`.
 *
 * It has bitten three times. #3442: the auth circuit breaker's terminal
 * redirect — the breaker fired correctly and then sent the browser somewhere
 * unreachable. #3443: `flightsql/connect` put that address in a copy-paste
 * snippet. #3467: `catalog/iceberg/connect` handed Spark and Trino
 * `http://0.0.0.0:3000/api/catalog/iceberg` to paste into their configs.
 *
 * ── WHY THIS GUARD WAS REWRITTEN (#3468) — IT WAS BLIND TO ITS OWN CLASS ────
 * The first version matched ONE construction with ONE regex:
 *
 *     /new URL\(\s*[^)]*?,\s*(?:req|request)\.(?:url|nextUrl\.origin)\s*\)/
 *
 * i.e. only the TWO-ARGUMENT form `new URL(x, req.url)`. #3467 was the ONE-
 * argument form, `new URL(req.url).origin`, and was structurally invisible.
 * Measured, with the live defect in the tree:
 *
 *     node scripts/ci/check-external-origin-urls.mjs
 *     0 violation(s), 5 embedded control(s) passed        EXIT=0
 *
 * The blindness extended to the guard's own controls: all five modelled the
 * two-argument form, so the control population CONFIRMED the guard worked while
 * excluding the case it missed. That is `guard_keyed_to_the_unsafe_pattern`
 * with the controls inheriting the same blind spot.
 *
 * ── WHY A SYNTACTIC PATTERN IS NOT ENOUGH, EVEN WIDENED ─────────────────────
 * Widening the regex to `new URL(req.url).origin` STILL misses the shape that
 * actually shipped, because the request value can be one indirection away.
 * `lakehouse/interop/route.ts`, live until #3500:
 *
 *     function originOf(url: string): string { return new URL(url).origin; }
 *     …
 *     catalog: catalogBlock(originOf(req.url)),
 *
 * There is no request identifier anywhere near the `new URL`. The construction
 * is generic; only the VALUE flowing into it is request-derived. So this guard
 * follows the VALUE, not the construction: a small intra-file taint analysis
 * over a string/comment/regex-aware mask of the source, propagating through
 * local variables, function PARAMETERS at their call sites, and function
 * RETURN values, to a fixpoint.
 *
 * ── WHAT THE DATAFLOW DOES *NOT* FOLLOW ────────────────────────────────────
 * Stated here because the claim above is the guard's headline and an unstated
 * limit reads as coverage. Measured, not assumed:
 *
 *   - "Local variables" means a SINGLE-IDENTIFIER `const/let/var` initialiser,
 *     plus object destructuring. It does NOT follow: a bare re-assignment with
 *     no declarator (`let o; o = new URL(req.url)` — the AUTHORITY READ is
 *     still caught at the constructor, so this only loses a later `o.origin`),
 *     a hop through a container (array/object/Map element), `String(u)`,
 *     `Object.assign`, spread, a JSON round-trip, a ternary that yields the URL
 *     itself, a default parameter value, or computed member access `u['origin']`.
 *   - CROSS-FILE laundering. An imported helper that turns a string into an
 *     origin is analysed only in ITS OWN file, where its parameter is untainted
 *     unless a caller in that same file taints it. Worse, `collect()`'s
 *     prefilter skips files containing neither `new URL(` nor `nextUrl`, so the
 *     caller is never even read. This matters for the natural triage of the
 *     baselined population: ~12 of the 35 are the same copy-pasted
 *     `try { origin = new URL(req.url).origin } catch` block, and extracting a
 *     shared helper would move all of them out of view. Mitigating, and the
 *     reason this is a documented limit rather than a silent one: a mass
 *     extraction drops the total under MIN_LIVE_SITES and the floor fires.
 *   - THE REQUEST OBJECT ITSELF passed as an untyped argument. `H.urlOf(req)`
 *     where the parameter is neither named `req`/`request` nor annotated
 *     `Request` does not make that parameter a request. Both real incidents
 *     annotated (`proxyCatalogUri(req: Request)`), and widening the NAME
 *     heuristic further is the wrong direction — see below.
 *   - `req` / `request` are treated as the inbound request BY NAME, whatever
 *     their type, file-wide. This repo already names OUTGOING payload objects
 *     `req` (`lib/azure/fabric-client.ts:972-974, 1203-1204`), so a false
 *     positive there is possible. It is the conservative direction for a guard
 *     and the ratchet surfaces it at review; it is recorded rather than fixed
 *     because narrowing it would lose `withSession(async (req) => …)`, which
 *     carries no annotation at all.
 *
 * ── WHAT COUNTS AS A VIOLATION ─────────────────────────────────────────────
 * Deriving an AUTHORITY from a request-derived URL. Specifically:
 *
 *   V-base       new URL(<anything>, <request-derived>)   — the base supplies
 *                the authority, so the whole resulting URL carries it. When a
 *                base is PRESENT AND SAFE, argument 0 is irrelevant: that is
 *                the path-preserving remediation, not a defect.
 *   V-authority  <request-derived URL>.origin|.host|.hostname|.href|.protocol
 *                |.toString()   — read directly, through optional chaining,
 *                through a local variable, through a parameter, through a
 *                helper's return value, or DESTRUCTURED out of it.
 *   V-redirect   redirect(<request-derived URL object>) — including the
 *                `req.nextUrl.clone()` idiom Next's own docs teach.
 *   V-interp     `${<request-derived URL object>}` — stringifies the authority.
 *
 * Reading the PATH half is fine and extremely common — `new URL(req.url)
 * .pathname`, `req.nextUrl.searchParams` — and is deliberately NOT flagged.
 * Flagging those would make the guard unusable and is not the defect class.
 *
 * ── WHY IT MASKS COMMENTS AND STRINGS FIRST ────────────────────────────────
 * The sweep that found #3443 returned 7 hits, of which SIX were prose: doc
 * comments quoting the bad pattern to explain it. A guard that cannot tell code
 * from a comment ABOUT code would force those explanations to be deleted.
 *
 * The first version stripped comments with `line.replace(/\/\/.*$/, '')`, which
 * TRUNCATES any line containing `//` inside a string literal — and #3468
 * measured that landing on exactly the code most worth catching, the standard
 * protocol-relative open-redirect guard (`next.startsWith('//') ? '/' : next`),
 * a line that by construction is building an outward redirect. `maskNonCode`
 * below is a real single-pass lexer: comments, string bodies, template bodies
 * (substitutions kept as CODE) and regex-literal bodies are blanked in place,
 * offsets and line numbers preserved.
 *
 * NO `PHYSICAL-LINES-OK` PRAGMA, DELIBERATELY. The old one reasoned about shell
 * BACKSLASH CONTINUATION, a concept imported from #3427 that does not exist in
 * TypeScript — a prettier-wrapped `new URL(\n  '/x',\n  req.url,\n)` continues
 * with no marker at all and was invisible. This guard does not judge lines: it
 * reads whole-file text and balanced argument lists, and computes a line number
 * from a byte offset only to REPORT. (check-guard-logical-lines classifies it
 * out-of-scope regardless — its corpus is `.ts`/`.tsx`, not shell or YAML.)
 *
 * ── RATCHET, NOT A HARD ZERO ───────────────────────────────────────────────
 * Following the value turns a 1-site regex into a real population: 35 sites
 * across 28 files under apps/fiab-console, several of which PERSIST the
 * internal address off-platform (an `.iqy` file Excel replays from disk; a
 * `redirectUrl` written into a Cosmos share record; `servers[]` in a cached,
 * unauthenticated openapi.json). Failing all of them at once would force either
 * a 28-file behaviour change inside a CI fix, or a blanket exemption — and a
 * blanket exemption is how this class became invisible the first time. So the
 * existing population is FROZEN PER FILE, exactly as check-route-toolkit.mjs
 * and check-owner-only-workspace-guard.mjs do it, including the boy-scout rule:
 * touch a baselined file and you fix it while you are there. #3468 tracks the
 * triage.
 *
 * The baseline replaces the old file-scoped `EXEMPT` map, whose `continue`
 * discarded EVERY hit in an exempt file — so a genuinely new violation added to
 * the one exempt (test) file inherited the cover silently. A per-file COUNT
 * cannot do that: the test file is pinned at 3, and a fourth fails. The old
 * map's one real virtue is kept: a baseline entry that no longer matches ANY
 * site FAILS the guard, because a drained entry is cover for the next one.
 *
 * WHAT IS IN THE POPULATION, honestly. The guard flags authority DERIVATION,
 * not proven egress. Deciding "handed to a client" needs a sink analysis, and a
 * sink analysis has blind spots of its own — which is the whole subject of
 * #3468 — so this one does not pretend to have it. Two baselined members are
 * same-origin COMPARISONS (`slate-app/[id]/query/run` lines 243–244) rather
 * than leaks, and several are `LOOM_PUBLIC_BASE_URL || req.nextUrl.origin`
 * fallbacks that only leak when the env var is unset. The triage in #3468
 * decides which are defects; the guard's job is that none of them is INVISIBLE.
 *
 * ── POPULATION FLOOR — a ratchet cannot tell "clean" from "broken" ──────────
 * A ratchet only fails on a RISE, so a detector that stops detecting reads as a
 * clean sweep — the exact failure #3468 is about, one level up. Three floors,
 * all enforced BEFORE the repo verdict:
 *   1. embedded controls, including the two REAL pre-#3500 defects byte-for-byte;
 *   2. a floor on tracked files enumerated, and on files that actually contain
 *      `new URL(` (if the mask ever blanks the world, that count collapses);
 *   3. a floor on the measured population itself: the analyzer must still find
 *      at least MIN_LIVE_SITES sites. `0 violations` and `0 files scanned` are
 *      then distinguishable, which they were not before.
 *
 * Run:    node scripts/ci/check-external-origin-urls.mjs
 * Regen:  node scripts/ci/check-external-origin-urls.mjs --update-baseline
 * Tests:  node --test scripts/ci/__tests__/external-origin-urls.test.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRatchet, gitTouchedFiles, loadBaseline } from './_ratchet-count.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCOPE = 'apps/fiab-console';
const BASELINE_FILE = path.join(REPO_ROOT, 'scripts', 'ci', 'external-origin-urls-baseline.json');

/** Tracked `.ts`/`.tsx` under SCOPE today: 5,598. A collapse means the
 *  enumeration broke, not that the app was deleted. */
const MIN_TRACKED_FILES = 4500;
/** Files whose masked source still contains `new URL(`: 233 today (237 raw —
 *  the 4-file gap is prose in comments, verified file by file). This is the
 *  control on the MASK: if it ever blanks code, this number falls off a cliff. */
const MIN_FILES_WITH_URL_CTOR = 150;
/** Sites the analyzer must still find. The measured population is 35 across 28
 *  files; this leaves room for a partial triage without touching the guard, and
 *  is deliberately NOT zero — a ratchet only fails on a RISE, so a detector that
 *  stopped detecting would read as a clean sweep, which is #3468 one level up.
 *  Lower it in the SAME PR that actually removes the sites. */
const MIN_LIVE_SITES = 20;

// ───────────────────────────────────────────────────────────────────────────
// 1. MASK — blank comments, string bodies and regex bodies, keep offsets.
// ───────────────────────────────────────────────────────────────────────────

/** Blank `n` characters at `i`, preserving newlines so line numbers hold. */
function blank(out, src, from, to) {
  for (let k = from; k < to && k < src.length; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
}

/**
 * Replace every non-code region with spaces, IN PLACE (same length, same
 * newlines), so any regex run over the result reports true source offsets.
 *
 * Handled: `//` line comments, `/* *\/` block comments, '…' and "…" strings,
 * `…` templates (with `${…}` substitutions LEFT AS CODE, nested), and regex
 * literals. Quote/comment characters inside each other cannot confuse it
 * because there is exactly one pass with one state machine.
 *
 * The one deliberate heuristic is regex-vs-division: a `/` is division when the
 * previous significant character can END an expression (`identifier`, digit,
 * `)`, `]`, `$`, `_`), and starts a regex otherwise. That is the standard
 * lexer heuristic; it is required because `.replace(/\/+$/, '')` — which the
 * #3467 code itself contains — would otherwise be read as two divisions and a
 * dangling string.
 */
export function maskNonCode(src) {
  const s = String(src);
  const out = s.split('');
  let i = 0;
  let prev = ''; // last significant (non-space, non-blanked) character
  // Stack of open template literals; each entry counts the `{` depth inside a
  // `${ … }` substitution so a nested template is handled correctly.
  const tpl = [];

  const canEndExpression = (c) => /[A-Za-z0-9_$)\]]/.test(c);

  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    // Inside a `${ … }` substitution the characters are CODE — fall through to
    // the normal rules, but watch for the closing brace.
    if (tpl.length && tpl[tpl.length - 1].inSub) {
      const top = tpl[tpl.length - 1];
      if (c === '{') top.depth++;
      else if (c === '}') {
        if (top.depth === 0) {
          top.inSub = false;
          prev = '}';
          i++;
          continue;
        }
        top.depth--;
      }
      // else: fall through to the generic handling below
    } else if (tpl.length) {
      // Inside a template's TEXT: blank until ` or ${
      const top = tpl[tpl.length - 1];
      if (c === '\\') {
        blank(out, s, i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        tpl.pop();
        prev = '`';
        i++;
        continue;
      }
      if (c === '$' && c2 === '{') {
        top.inSub = true;
        top.depth = 0;
        prev = '{';
        i += 2;
        continue;
      }
      blank(out, s, i, i + 1);
      i++;
      continue;
    }

    // ── line comment. `://` is NOT one: a bare `https://…` in JSX text is not
    // a comment, and truncating there deletes real code from the scan.
    if (c === '/' && c2 === '/' && prev !== ':') {
      let j = i;
      while (j < s.length && s[j] !== '\n') j++;
      blank(out, s, i, j);
      i = j;
      continue;
    }

    // ── block comment
    if (c === '/' && c2 === '*') {
      const end = s.indexOf('*/', i + 2);
      const j = end === -1 ? s.length : end + 2;
      blank(out, s, i, j);
      i = j;
      continue;
    }

    // ── string literal
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === c || s[j] === '\n') break;
        j++;
      }
      blank(out, s, i + 1, j);
      prev = c;
      i = j < s.length && s[j] === c ? j + 1 : j;
      continue;
    }

    // ── template literal
    if (c === '`') {
      tpl.push({ inSub: false, depth: 0 });
      prev = '`';
      i++;
      continue;
    }

    // ── regex literal
    if (c === '/' && !canEndExpression(prev)) {
      let j = i + 1;
      let cls = false;
      let ok = false;
      while (j < s.length) {
        const d = s[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) {
          ok = true;
          break;
        }
        j++;
      }
      if (ok) {
        blank(out, s, i + 1, j);
        // flags
        let k = j + 1;
        while (k < s.length && /[a-z]/.test(s[k])) k++;
        blank(out, s, j + 1, k);
        prev = '/';
        i = k;
        continue;
      }
      // not a regex after all — treat as an operator
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out.join('');
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Small syntax helpers over MASKED code (brackets balance: string bodies
//    are blank, so no `(` or `)` can hide in one).
// ───────────────────────────────────────────────────────────────────────────

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/** Index of the bracket matching the one at `open`, or -1. */
export function matchBracket(code, open) {
  const want = OPEN[code[open]];
  if (!want) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) {
      depth--;
      if (depth === 0) return c === want ? i : -1;
    }
  }
  return -1;
}

/**
 * Split the argument list whose `(` is at `lparen` into top-level arguments.
 * @returns {{args:{text:string,start:number,end:number}[], close:number}}
 */
export function readArgs(code, lparen) {
  const close = matchBracket(code, lparen);
  if (close === -1) return { args: [], close: -1 };
  const args = [];
  let depth = 0;
  let start = lparen + 1;
  for (let i = lparen + 1; i < close; i++) {
    const c = code[i];
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) depth--;
    else if (c === ',' && depth === 0) {
      args.push({ text: code.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  const tail = code.slice(start, close);
  if (tail.trim() || args.length) args.push({ text: tail, start, end: close });
  return { args, close };
}

/** 1-based line number of a byte offset. */
function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. TAINT ANALYSIS
// ───────────────────────────────────────────────────────────────────────────

/** Properties of a URL that carry the AUTHORITY — the half that leaks. */
const AUTHORITY_PROPS = new Set(['origin', 'host', 'hostname', 'href', 'protocol', 'toString', 'toJSON']);
/** The PATH half. Reading these off a request URL is correct and common. */
const PATH_PROPS = new Set(['pathname', 'search', 'searchParams', 'hash', 'port', 'username', 'password']);
/**
 * Members that return ANOTHER URL carrying the same authority. `clone()` is the
 * canonical Next.js redirect idiom — `const u = req.nextUrl.clone(); u.pathname
 * = '/x'; return NextResponse.redirect(u)` — and it is the shape of #3442. It
 * was in neither table, so `kindOf`'s nextUrl branch fell through to `'str'`
 * and the clone was never tracked as a URL. Zero occurrences in the tree today;
 * this is forward-looking, because it is what Next's own docs teach.
 */
const URL_PRODUCING_PROPS = new Set(['clone']);

/** Identifiers conventionally holding the inbound request, plus typed params. */
function requestIdents(code) {
  const set = new Set(['req', 'request']);
  for (const m of code.matchAll(/(\w+)\s*:\s*(?:Next)?Request\b/g)) set.add(m[1]);
  return set;
}

/**
 * Keywords that take a parenthesised head followed by a brace block. Without
 * this list the method-shorthand matcher below would register `if (cond) {` as
 * a one-parameter function named `if` and taint its "parameter" everywhere the
 * block reaches.
 */
const NOT_A_FUNCTION_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'do', 'else', 'try', 'finally',
  'return', 'typeof', 'void', 'delete', 'new', 'await', 'yield', 'in', 'of',
  'function', 'class', 'extends', 'import', 'export', 'default', 'case', 'super', 'this',
]);

/**
 * Locally declared callables, so taint can flow into a PARAMETER at its call
 * sites and out of a RETURN. Four declaration forms, because "follows the value
 * through helpers" is this guard's headline claim and #3500 WAS a helper — so a
 * gap here sits directly on the incident class:
 *
 *   function name(…) { … }
 *   const name = (…) => { … }   /   => expr
 *   const name = function (…) { … }
 *   { name(…) { … } }            (object-literal / class method shorthand)
 *
 * Body detection is deliberately TIGHT — the `{` (or `=>`) must follow the
 * parameter list with nothing between but whitespace and a return-type
 * annotation. The looser "first `{` before the first `;`" it replaced would
 * register `const x = (a || b) ? { y: 1 } : null;` as a function.
 */
function localFunctions(code) {
  const fns = [];
  const push = (name, lparen, form) => {
    if (NOT_A_FUNCTION_NAME.has(name)) return;
    const close = matchBracket(code, lparen);
    if (close === -1) return;
    const params = readArgs(code, lparen).args.map((a) =>
      // strip type annotations, defaults and destructuring noise
      (a.text.split(':')[0].split('=')[0].replace(/[{}[\].\s]/g, '') || '').trim(),
    );
    const after = code.slice(close + 1, close + 400);
    let bodyStart = -1;
    let bodyEnd = -1;
    if (form === 'arrow') {
      const am = after.match(/^\s*(?::[^=;{]*)?=>\s*/);
      if (!am) return;
      const at = close + 1 + am[0].length;
      if (code[at] === '{') {
        bodyStart = at;
        bodyEnd = matchBracket(code, at);
      } else {
        // expression body — to the next `;` at depth 0
        let depth = 0;
        let i = at;
        for (; i < code.length; i++) {
          const c = code[i];
          if (OPEN[c]) depth++;
          else if (CLOSE[c]) {
            if (depth === 0) break;
            depth--;
          } else if (c === ';' && depth === 0) break;
        }
        bodyStart = at;
        bodyEnd = i;
      }
    } else {
      const bm = after.match(/^\s*(?::[^;={]*)?\{/);
      if (!bm) return;
      const at = close + 1 + bm[0].length - 1;
      bodyStart = at;
      bodyEnd = matchBracket(code, at);
    }
    if (bodyStart === -1 || bodyEnd === -1 || bodyEnd <= bodyStart) return;
    fns.push({ name, params, bodyStart, bodyEnd, form });
  };

  for (const m of code.matchAll(/(?:^|[^\w.$])function\s*\*?\s*(\w+)\s*\(/g))
    push(m[1], m.index + m[0].length - 1, 'function');
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?\(/g))
    push(m[1], m.index + m[0].length - 1, 'arrow');
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*(?::[^=;\n]*)?=\s*(?:async\s+)?function\s*\*?\s*\w*\s*\(/g))
    push(m[1], m.index + m[0].length - 1, 'function');
  // method shorthand — only where a member can START: after `{`, `,`, `;` or a
  // line break. `.catch(` and `foo.bar(` are excluded by the leading class.
  for (const m of code.matchAll(/(?:^|[{,;\n])\s*(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/g))
    push(m[1], m.index + m[0].length - 1, 'method');

  return fns;
}

/** The innermost function body containing `offset`, or null (file scope). */
function enclosing(fns, offset) {
  let best = null;
  for (const f of fns) {
    if (offset > f.bodyStart && offset < f.bodyEnd) {
      if (!best || f.bodyStart > best.bodyStart) best = f;
    }
  }
  return best;
}

/**
 * The whole analysis. Returns violations plus the internal sets, which the
 * tests assert on directly (a detector whose intermediate state is unobservable
 * can only be tested end-to-end, and then a silent regression looks like a
 * clean file).
 */
export function analyze(src) {
  const code = maskNonCode(src);
  const req = requestIdents(code);
  const fns = localFunctions(code);
  const reqAlt = [...req].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  /**
   * How a callable is invoked. A method shorthand is reached through its owner
   * (`H.originOf(req.url)`), so the usual "no `.` before the name" guard — which
   * exists to stop `foo.parse(x)` matching a local `parse` — would make every
   * object-literal helper uncallable and therefore untaintable.
   */
  const methodNames = new Set(fns.filter((f) => f.form === 'method').map((f) => f.name));
  const callRe = (name, flags = 'g') =>
    new RegExp(
      methodNames.has(name)
        ? `(?:^|[^\\w$])(?:[A-Za-z_$][\\w$]*\\s*\\??\\.\\s*)?${name}\\s*\\(`
        : `(?:^|[^\\w.$])${name}\\s*\\(`,
      flags,
    );

  // `<req>.url` (a string) / `<req>.nextUrl` (a URL object) — the roots.
  //
  // `\??\.` EVERYWHERE, not `\.`. One character defeated the whole analysis:
  // `req?.url` and `req?.nextUrl?.origin` returned ZERO hits while
  // `req.nextUrl?.origin` was caught, so it was an oversight, not a decision.
  // And it is live house style in the scanned tree — `monitor/alerts:79` uses
  // `req?.url`; `monitor/{health,diagnostics,inventory}` and `foundry/agents`
  // use `req?.nextUrl?.`. Every one is a path-half read TODAY, i.e. one word
  // away from invisible.
  const DOT = '\\s*\\??\\.\\s*';
  const ROOT_STR = new RegExp(`\\b(?:${reqAlt})${DOT}url\\b`);
  const ROOT_URL = new RegExp(`\\b(?:${reqAlt})${DOT}nextUrl\\b`);

  /** ident -> [{from,to}] spans in which it holds a request-derived value. */
  const taintedStr = new Map();
  const taintedUrl = new Map();
  /** local function names whose RETURN value is request-derived. */
  const returnsStr = new Set();
  const returnsUrl = new Set();

  const addSpan = (map, name, from, to) => {
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return false;
    const list = map.get(name) ?? [];
    if (list.some((s) => s.from === from && s.to === to)) return false;
    list.push({ from, to });
    map.set(name, list);
    return true;
  };
  const inSpan = (map, name, at) =>
    (map.get(name) ?? []).some((s) => at >= s.from && at <= s.to);

  /** Does this expression text carry a request-derived value anywhere in it? */
  function isTainted(text, absStart) {
    if (ROOT_STR.test(text) || ROOT_URL.test(text)) return true;
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const at = absStart + m.index;
      const name = m[0];
      if (inSpan(taintedStr, name, at) || inSpan(taintedUrl, name, at)) return true;
      if ((returnsStr.has(name) || returnsUrl.has(name)) && /^\s*\(/.test(text.slice(m.index + name.length)))
        return true;
    }
    return false;
  }

  /** 'url' | 'str' | null — the OUTERMOST shape of an expression. */
  function kindOf(text, absStart) {
    let t = text;
    let off = absStart;
    // unwrap `await`, `(…)`, leading whitespace
    for (;;) {
      const lead = t.match(/^\s*(await\s+)?/);
      if (lead && lead[0].length) {
        t = t.slice(lead[0].length);
        off += lead[0].length;
      }
      if (t.startsWith('(') && matchBracket(t, 0) === t.trimEnd().length - 1) {
        t = t.slice(1, t.trimEnd().length - 1);
        off += 1;
        continue;
      }
      break;
    }

    const ctor = t.match(/^new\s+URL\s*\(/);
    if (ctor) {
      const lp = ctor[0].length - 1;
      const { args, close } = readArgs(t, lp);
      const base = args.length >= 2 ? args[1] : args[0];
      if (!base || !isTainted(base.text, off + base.start)) return null;
      const rest = t.slice(close + 1);
      const prop = rest.match(/^\s*\??\.\s*(\w+)/);
      if (!prop) return 'url';
      if (URL_PRODUCING_PROPS.has(prop[1])) return 'url';
      if (AUTHORITY_PROPS.has(prop[1])) return 'str';
      if (PATH_PROPS.has(prop[1])) return null;
      return 'url';
    }

    let m = t.match(new RegExp(`^\\s*(?:${reqAlt})${DOT}nextUrl\\s*(?:\\??\\.\\s*(\\w+))?`));
    if (m) {
      if (!m[1]) return 'url';
      if (URL_PRODUCING_PROPS.has(m[1])) return 'url';
      if (AUTHORITY_PROPS.has(m[1])) return 'str';
      if (PATH_PROPS.has(m[1])) return null;
      return 'str';
    }
    if (new RegExp(`^\\s*(?:${reqAlt})${DOT}url\\s*$`).test(t)) return 'str';

    // a call to a local helper — `originOf(x)` or, for a method shorthand,
    // `H.originOf(x)`. Gated on the name actually being a tainted-returning
    // local, so an unrelated `foo.parse(x)` cannot match.
    m = t.match(/^\s*(?:[A-Za-z_$][\w$]*\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*\(/);
    if (m) {
      if (returnsUrl.has(m[1])) return 'url';
      if (returnsStr.has(m[1])) return 'str';
    }
    m = t.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\??\.\s*(\w+))?/);
    if (m) {
      const at = off + t.indexOf(m[1]);
      if (inSpan(taintedUrl, m[1], at)) {
        if (!m[2]) return 'url';
        if (URL_PRODUCING_PROPS.has(m[2])) return 'url';
        if (AUTHORITY_PROPS.has(m[2])) return 'str';
        if (PATH_PROPS.has(m[2])) return null;
        return 'url';
      }
      if (inSpan(taintedStr, m[1], at)) return 'str';
    }
    return isTainted(t, off) ? 'str' : null;
  }

  /** Text of the initialiser / returned expression starting at `from`. */
  function exprAt(from, limit) {
    let depth = 0;
    for (let i = from; i < limit; i++) {
      const c = code[i];
      if (OPEN[c]) depth++;
      else if (CLOSE[c]) {
        if (depth === 0) return code.slice(from, i);
        depth--;
      } else if (depth === 0 && (c === ';' || c === '\n')) {
        // a newline only ends the expression when brackets are balanced AND the
        // next non-blank is not a continuation of the same expression
        const rest = code.slice(i + 1, i + 400);
        if (!/^\s*[.?:)|&+,]/.test(rest)) return code.slice(from, i);
      }
    }
    return code.slice(from, limit);
  }

  // ── fixpoint ─────────────────────────────────────────────────────────────
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;

    // (a) `const x = <request-derived>` — variables carry the taint.
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*/g)) {
      const from = m.index + m[0].length;
      const fn = enclosing(fns, from);
      const scopeTo = fn ? fn.bodyEnd : code.length;
      const init = exprAt(from, scopeTo);
      const k = kindOf(init, from);
      if (k === 'url') changed = addSpan(taintedUrl, m[1], from, scopeTo) || changed;
      else if (k === 'str') changed = addSpan(taintedStr, m[1], from, scopeTo) || changed;
    }

    // (b) a local function CALLED with a request-derived argument taints that
    //     PARAMETER inside its body — this is the indirection #3500 fixed and
    //     the reason a syntactic pattern cannot be enough.
    for (const f of fns) {
      if (!f.params.length) continue;
      const call = callRe(f.name);
      for (const m of code.matchAll(call)) {
        const lp = m.index + m[0].length - 1;
        if (lp > f.bodyStart && lp < f.bodyEnd) continue; // recursion
        const { args } = readArgs(code, lp);
        for (let i = 0; i < args.length && i < f.params.length; i++) {
          const k = kindOf(args[i].text, args[i].start);
          const p = f.params[i];
          if (k === 'url') changed = addSpan(taintedUrl, p, f.bodyStart, f.bodyEnd) || changed;
          else if (k === 'str' || isTainted(args[i].text, args[i].start))
            changed = addSpan(taintedStr, p, f.bodyStart, f.bodyEnd) || changed;
        }
      }
    }

    // (c) a function that RETURNS a request-derived value taints its call sites.
    for (const f of fns) {
      for (const m of code.slice(f.bodyStart, f.bodyEnd).matchAll(/\breturn\s+/g)) {
        const from = f.bodyStart + m.index + m[0].length;
        const k = kindOf(exprAt(from, f.bodyEnd), from);
        if (k === 'url' && !returnsUrl.has(f.name)) {
          returnsUrl.add(f.name);
          changed = true;
        } else if (k === 'str' && !returnsStr.has(f.name)) {
          returnsStr.add(f.name);
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  // ── violations ───────────────────────────────────────────────────────────
  const seen = new Set();
  const hits = [];
  const record = (at, kind, note) => {
    const key = `${at}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ offset: at, line: lineOf(src, at), kind, note, text: srcLine(src, at) });
  };

  // V-base / V-authority on an explicit `new URL(…)`
  for (const m of code.matchAll(/new\s+URL\s*\(/g)) {
    const lp = m.index + m[0].length - 1;
    const { args, close } = readArgs(code, lp);
    if (close === -1 || !args.length) continue;
    if (args.length >= 2 && isTainted(args[1].text, args[1].start)) {
      record(m.index, 'base', 'the BASE argument is the request\'s own URL, so the whole result carries the container authority');
      continue;
    }
    // When a BASE argument is present and SAFE, it — not argument 0 — supplies
    // the authority, so the one-argument rule below must not run. Without this
    // line the guard flagged `new URL(new URL(req.url).pathname,
    // externalOrigin(req.headers))`, which is exactly the shape a path-
    // preserving FIX takes: the guard would have punished the remediation it
    // asks for, and the boy-scout rule makes 28 files write it. `kindOf` at the
    // ctor branch already picked `args[1]` as the base; these two halves of the
    // analysis had disagreed.
    if (args.length >= 2) continue;
    if (!isTainted(args[0].text, args[0].start)) continue;
    const rest = code.slice(close + 1, close + 40);
    const prop = rest.match(/^\s*\??\.\s*(\w+)/);
    if (prop && AUTHORITY_PROPS.has(prop[1]))
      record(close + 1 + rest.indexOf(prop[1]), 'authority', `reads .${prop[1]} off a URL built on the request`);
  }

  // V-authority through `<req>.nextUrl.<authority>`
  for (const m of code.matchAll(new RegExp(`\\b(?:${reqAlt})${DOT}nextUrl\\s*\\??\\.\\s*(\\w+)`, 'g'))) {
    if (AUTHORITY_PROPS.has(m[1])) record(m.index, 'authority', `reads .${m[1]} off req.nextUrl`);
  }

  // V-authority through DESTRUCTURING — `const { origin } = new URL(req.url)`.
  // This is already the house idiom for the SAFE half: `const { searchParams }
  // = new URL(req.url)` appears in ten files (copilot-studio-*, eventhouse,
  // kql-database/follower, onelake/catalog, setup/regions). One identifier
  // turns a caught construction into an invisible one, and the declaration
  // matcher in the fixpoint requires an identifier after `const`, so an object
  // pattern never tainted anything.
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}\s*(?::[^=;\n]*)?=\s*/g)) {
    const from = m.index + m[0].length;
    const fn = enclosing(fns, from);
    if (kindOf(exprAt(from, fn ? fn.bodyEnd : code.length), from) !== 'url') continue;
    const patternAt = m.index + m[0].indexOf('{') + 1;
    for (const p of m[1].matchAll(/(\w+)\s*(?::\s*\w+)?/g)) {
      if (!AUTHORITY_PROPS.has(p[1])) continue;
      record(
        patternAt + p.index,
        'authority',
        `destructures .${p[1]} out of a URL built on the request`,
      );
    }
  }

  // V-authority through a local variable / parameter holding such a URL
  for (const [name, spans] of taintedUrl) {
    const re = new RegExp(`(?:^|[^\\w.$])${name}\\s*\\??\\.\\s*(\\w+)`, 'g');
    for (const m of code.matchAll(re)) {
      const at = m.index + m[0].indexOf(name);
      if (!spans.some((s) => at >= s.from && at <= s.to)) continue;
      if (AUTHORITY_PROPS.has(m[1])) record(at, 'authority', `\`${name}\` holds a URL built on the request; .${m[1]} is its authority`);
    }
    // `${u}` stringifies the authority just as surely as `.href` does
    const interp = new RegExp(`\\$\\{\\s*${name}\\s*\\}`, 'g');
    for (const m of code.matchAll(interp)) {
      if (spans.some((s) => m.index >= s.from && m.index <= s.to))
        record(m.index, 'interp', `interpolating \`${name}\` stringifies the request's own origin`);
    }
  }

  // V-authority through a HELPER'S RETURN VALUE — `urlOf(req).origin`, where
  // the constructor lives in the helper and the authority read at the call site.
  for (const name of returnsUrl) {
    const re = callRe(name);
    for (const m of code.matchAll(re)) {
      const lp = m.index + m[0].length - 1;
      const close = matchBracket(code, lp);
      if (close === -1) continue;
      const rest = code.slice(close + 1, close + 40);
      const prop = rest.match(/^\s*\??\.\s*(\w+)/);
      if (prop && AUTHORITY_PROPS.has(prop[1]))
        record(
          close + 1 + rest.indexOf(prop[1]),
          'authority',
          `\`${name}()\` returns a URL built on the request; .${prop[1]} is its authority`,
        );
    }
  }

  // V-redirect — handing a request-derived URL object straight to a redirect
  for (const m of code.matchAll(/\.\s*redirect\s*\(/g)) {
    const lp = m.index + m[0].length - 1;
    const { args } = readArgs(code, lp);
    if (!args.length) continue;
    if (kindOf(args[0].text, args[0].start) === 'url')
      record(m.index, 'redirect', 'redirects to a URL built on the request\'s own origin');
  }

  hits.sort((a, b) => a.offset - b.offset);
  return { violations: hits, taintedStr, taintedUrl, returnsStr, returnsUrl, code };
}

/** The original 1-arg API the tests use: source -> [{line, text}]. */
export function findViolations(src) {
  return analyze(src).violations.map((v) => ({ line: v.line, kind: v.kind, text: v.text }));
}

/** Trimmed source line containing `offset`, for the annotation body. */
function srcLine(src, offset) {
  const from = src.lastIndexOf('\n', offset) + 1;
  let to = src.indexOf('\n', offset);
  if (to === -1) to = src.length;
  return src.slice(from, to).trim().slice(0, 160);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. EMBEDDED CONTROLS — run BEFORE the repo is judged.
//
// The first two are the REAL pre-#3500 defects, byte-for-byte. #3468 exists
// because the previous five controls all modelled the two-argument form, so
// they passed on a tree carrying a live one-argument defect. A control set that
// does not contain the incident cannot prove a guard would have caught it.
// ───────────────────────────────────────────────────────────────────────────

/** `catalog/iceberg/connect/route.ts` as it stood at 2dda97b4^ (#3467). */
const PRE_3500_ICEBERG_CONNECT = `function proxyCatalogUri(req: Request): string {
  let origin = '';
  try {
    origin = new URL(req.url).origin;
  } catch {
    origin = '';
  }
  if (!origin) origin = (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\\/+$/, '');
  return \`\${origin}/api/catalog/iceberg\`;
}`;

/** `lakehouse/interop/route.ts` as it stood at 2dda97b4^ — the LAUNDERED form:
 *  no request identifier is anywhere near the `new URL`. */
const PRE_3500_LAKEHOUSE_INTEROP = `function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\\/+$/, ''); }
}

export const GET = withSession(async (req) => {
  return NextResponse.json({ catalog: catalogBlock(originOf(req.url)) });
});`;

export const CONTROLS = [
  // ── MUST FLAG ──────────────────────────────────────────────────────────
  {
    name: 'INCIDENT #3467 — single-argument new URL(req.url).origin (the shape the old guard could not see)',
    src: PRE_3500_ICEBERG_CONNECT,
    expect: true,
  },
  {
    name: 'INCIDENT #3500 — laundered through a helper: originOf(req.url) with the ctor on a plain string param',
    src: PRE_3500_LAKEHOUSE_INTEROP,
    expect: true,
  },
  { name: 'bad: two-argument new URL(x, req.url)', src: "const u = new URL('/x', req.url);", expect: true },
  { name: 'bad: two-argument on req.nextUrl.origin', src: "const u = new URL('/x', req.nextUrl.origin);", expect: true },
  { name: 'bad: bare req.nextUrl.origin', src: 'const o = req.nextUrl.origin;', expect: true },
  { name: 'bad: req.nextUrl.host', src: 'const h = req.nextUrl.host;', expect: true },
  {
    name: 'bad: `//` INSIDE A STRING on the same line — the old line-truncating stripper deleted this exact code',
    src: "const u = new URL(next.startsWith('//') ? '/' : next, req.url);",
    expect: true,
  },
  {
    name: 'bad: a `)` inside the first argument — the old `[^)]*?` matcher stopped at it',
    src: "const u = new URL(buildPath(id), req.url);",
    expect: true,
  },
  {
    name: 'bad: prettier-wrapped across lines — TypeScript needs no continuation marker, which is why the shell-derived PHYSICAL-LINES-OK reasoning did not transfer',
    src: "const u = new URL(\n  '/auth/blocked',\n  req.url,\n);",
    expect: true,
  },
  {
    name: 'bad: through a local variable — `const u = new URL(req.url); … u.origin`',
    src: 'const u = new URL(req.url);\nconst o = u.origin;',
    expect: true,
  },
  // ── #3468 review round 2 — shapes that evaded the first rewrite ─────────
  {
    name: 'bad: OPTIONAL CHAINING on the root — `new URL(req?.url).origin` (live house style: monitor/alerts:79)',
    src: 'const o = new URL(req?.url).origin;',
    expect: true,
  },
  {
    name: 'bad: optional chaining on nextUrl — `req?.nextUrl.origin`',
    src: 'const o = req?.nextUrl.origin;',
    expect: true,
  },
  {
    name: 'bad: optional chaining BOTH hops — `request?.nextUrl?.href` (live in monitor/{health,diagnostics,inventory}, foundry/agents)',
    src: 'const h = request?.nextUrl?.href;',
    expect: true,
  },
  {
    name: 'bad: DESTRUCTURED authority — `const { origin } = new URL(req.url)`, one identifier from the safe idiom used in ten files',
    src: 'const { origin } = new URL(req.url);',
    expect: true,
  },
  {
    name: 'bad: destructured off req.nextUrl',
    src: 'const { origin } = req.nextUrl;',
    expect: true,
  },
  {
    name: 'bad: helper declared as `const name = function (…)`',
    src: 'const originOf = function (url) { return new URL(url).origin; };\nconst o = originOf(req.url);',
    expect: true,
  },
  {
    name: 'bad: helper as an object-literal METHOD SHORTHAND, called through its owner',
    src: 'const H = { originOf(url) { return new URL(url).origin; } };\nconst o = H.originOf(req.url);',
    expect: true,
  },
  {
    name: 'bad: `req.nextUrl.clone()` then redirect — the canonical Next idiom and the shape of #3442',
    src: "const u = req.nextUrl.clone();\nu.pathname = '/x';\nreturn NextResponse.redirect(u);",
    expect: true,
  },
  {
    name: 'bad: through a helper PARAMETER typed Request',
    src: 'function base(r: Request) { return new URL(r.url).origin; }\nconst o = base(incoming);',
    expect: true,
  },
  {
    name: 'bad: interpolating a request-derived URL object stringifies the authority',
    src: 'const u = new URL(req.url);\nconst s = `${u}/api/x`;',
    expect: true,
  },
  {
    name: 'bad: redirect straight to req.nextUrl',
    src: 'return NextResponse.redirect(req.nextUrl);',
    expect: true,
  },
  // ── MUST NOT FLAG ──────────────────────────────────────────────────────
  // THE REMEDIATION ITSELF. When a base argument is present and SAFE, IT
  // supplies the authority — argument 0 being request-derived is the whole
  // point of a path-preserving fix. The first rewrite fell through to the
  // one-argument rule and flagged both of these, so the guard punished the
  // change it asks for — and the boy-scout rule makes 28 files write it.
  {
    name: 'good: REMEDIATION SHAPE — request path re-based onto externalOrigin()',
    src: 'const u = new URL(new URL(req.url).pathname, externalOrigin(req.headers)).href;',
    expect: false,
  },
  {
    name: 'good: REMEDIATION SHAPE — path + search re-based onto externalOrigin()',
    src: 'const v = new URL(req.nextUrl.pathname + req.nextUrl.search, externalOrigin(req.headers)).toString();',
    expect: false,
  },
  { name: 'good: externalOrigin(req.headers) as the base', src: "const u = new URL('/x', externalOrigin(req.headers));", expect: false },
  { name: 'good: externalOrigin in a template', src: 'const s = `${externalOrigin(req.headers)}/api/catalog/iceberg`;', expect: false },
  { name: 'good: reading the PATH half is not an authority leak', src: 'const p = new URL(req.url).pathname;', expect: false },
  { name: 'good: the PATH half through optional chaining too', src: 'const p = new URL(req?.url).pathname;', expect: false },
  { name: 'good: req.nextUrl.searchParams', src: "const q = req.nextUrl.searchParams.get('id');", expect: false },
  { name: 'good: req?.nextUrl?.searchParams', src: "const q = req?.nextUrl?.searchParams.get('id');", expect: false },
  {
    name: 'good: DESTRUCTURED path half — the idiom in ten files, one identifier away from the flagged one',
    src: 'const { searchParams } = new URL(req.url);',
    expect: false,
  },
  { name: 'good: destructured pathname + searchParams off nextUrl', src: 'const { pathname, searchParams } = req.nextUrl;', expect: false },
  { name: 'good: a URL built on a configured public base', src: "const u = new URL('/x', process.env.LOOM_PUBLIC_BASE_URL);", expect: false },
  {
    name: 'good: a helper called ONLY with a safe value is not tainted by existing',
    src: 'function originOf(url: string) { return new URL(url).origin; }\nconst safe = originOf(externalOrigin(req.headers));',
    expect: false,
  },
  {
    name: 'good: an unrelated member call must not match a same-named local',
    src: 'const s = JSON.parse(raw);\nconst p = new URL(req.url).pathname;',
    expect: false,
  },
  { name: 'prose in a // comment', src: "// never build new URL('/x', req.url) here", expect: false },
  { name: 'prose in a block comment', src: '/**\n * see new URL(path, req.url) and new URL(req.url).origin\n */\nconst a = 1;', expect: false },
  {
    name: 'prose mentioning the pattern must not hide CODE on a later line',
    src: "// explains new URL(p, req.url)\nconst u = new URL('/y', req.url);",
    expect: true,
  },
  {
    name: 'a string that merely CONTAINS the construction is not code',
    src: "const doc = 'do not write new URL(x, req.url) in a handler';",
    expect: false,
  },
];

export function selfTest() {
  const failures = [];
  for (const c of CONTROLS) {
    const got = findViolations(c.src).length > 0;
    if (got !== c.expect) failures.push(`${c.name} — expected violation=${c.expect}, got ${got}`);
  }
  // The prose control also has to land on the RIGHT line, or a comment-aware
  // stripper that silently shifts offsets would report the wrong file position.
  const mixed = findViolations("// explains new URL(p, req.url)\nconst u = new URL('/y', req.url);");
  if (mixed.length !== 1 || mixed[0].line !== 2)
    failures.push(`line mapping drifted — expected 1 hit on line 2, got ${JSON.stringify(mixed)}`);
  return failures;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. MAIN
// ───────────────────────────────────────────────────────────────────────────

const META = {
  owner: 'CSA Loom platform / security',
  why:
    "A client-facing URL built on `req.url` / `req.nextUrl` carries the CONTAINER's authority under " +
    "`output: 'standalone'` with HOSTNAME=0.0.0.0, so clients are handed https://0.0.0.0:3000/… " +
    'Use externalOrigin(req.headers) from @/lib/auth/auth-breaker, which reads the forwarded host this ' +
    'app already trusts for the OAuth redirect_uri. Bit three times: #3442, #3443, #3467. The baseline ' +
    'is the pre-existing population #3468 is triaging — several members PERSIST the address off-platform ' +
    '(an .iqy file Excel replays from disk, a redirectUrl written into a Cosmos share record, servers[] ' +
    'in a cached unauthenticated openapi.json). It only shrinks.',
  unblock:
    'node scripts/ci/check-external-origin-urls.mjs --update-baseline (run in the blocked PR with a one-line justification)',
};

/**
 * Touched-file (boy-scout) escape hatch: repo-relative path -> one-line reason a
 * PR may modify a baselined file WITHOUT fixing its sites.
 */
export const TOUCH_EXEMPT = new Map([
  [
    'apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts',
    "evaluates the pre-#3442 construction inline as a CONTROL, asserting it yields 0.0.0.0:3000 — the mutation proof lives here, so 'fixing' it would delete the evidence. Pinned by COUNT in the baseline, not exempted as a file (#3468): a genuinely new violation added to it still fails the ratchet.",
  ],
]);

export function collect() {
  const files = execFileSync('git', ['ls-files', SCOPE], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));

  const current = {};
  const detail = [];
  let withCtor = 0;
  for (const f of files) {
    const src = readFileSync(path.join(REPO_ROOT, f), 'utf8');
    if (!/new\s+URL\s*\(|nextUrl/.test(src)) continue;
    const { violations, code } = analyze(src);
    if (/new\s+URL\s*\(/.test(code)) withCtor++;
    if (!violations.length) continue;
    current[f] = violations.length;
    for (const v of violations) detail.push({ f, ...v });
  }
  return { files, current, detail, withCtor };
}

function main() {
  // 1. controls first — a verdict from a scanner that has stopped scanning is
  //    not a verdict.
  const failures = selfTest();
  if (failures.length) {
    for (const f of failures) console.error(`::error::external-origin-urls: EMBEDDED CONTROL FAILED — ${f}`);
    console.error(
      '::error::external-origin-urls: the detector has drifted; a clean scan from it would mean nothing. ' +
        'This is the #3468 failure exactly — five controls passed on a tree carrying a live defect.',
    );
    return 1;
  }
  return judge(collect());
}

/**
 * The floors + the ratchet, over an ALREADY-MEASURED population. Split out of
 * main() so the ratchet's properties can be proven against a synthetic
 * `current` map instead of by mutating tracked source files in a checkout that
 * ~90 other suites are running against — a SIGKILL mid-test (CI timeout or OOM,
 * both with precedent here) would otherwise leave the tree corrupted.
 *
 * @param {{files:string[], current:Record<string,number>, detail:object[], withCtor:number}} measured
 * @param {{argv?:string[], baselineFile?:string, touchedFiles?:Set<string>|null}} [opts]
 * @returns {number} exit code
 */
export function judge(
  { files, current, detail = [], withCtor },
  { argv = process.argv, baselineFile = BASELINE_FILE, touchedFiles } = {},
) {
  const regen = argv.includes('--update-baseline');

  // 2. population floors — `0 violations` must be distinguishable from
  //    `0 files scanned` and from `the mask blanked everything`.
  if (files.length < MIN_TRACKED_FILES) {
    console.error(
      `::error::external-origin-urls: enumerated only ${files.length} tracked .ts/.tsx under ${SCOPE} ` +
        `(floor ${MIN_TRACKED_FILES}). \`git ls-files\` sees only TRACKED files — the scan is broken, ` +
        'FAILING rather than reporting a clean sweep of nothing.',
    );
    return 1;
  }
  if (withCtor < MIN_FILES_WITH_URL_CTOR) {
    console.error(
      `::error::external-origin-urls: only ${withCtor} file(s) still contain \`new URL(\` AFTER masking ` +
        `(floor ${MIN_FILES_WITH_URL_CTOR}). maskNonCode is eating code — every downstream zero is meaningless.`,
    );
    return 1;
  }
  const total = Object.values(current).reduce((a, b) => a + b, 0);
  if (total < MIN_LIVE_SITES && !regen) {
    console.error(
      `::error::external-origin-urls: the analyzer found only ${total} site(s) (floor ${MIN_LIVE_SITES}). ` +
        'The measured population is 35 and a ratchet only fails on a RISE, so a detector that stopped ' +
        'detecting would read as a clean sweep — #3468 one level up. If the sites were genuinely fixed, ' +
        'lower MIN_LIVE_SITES in the same PR that removes them.',
    );
    return 1;
  }

  console.log(
    `external-origin-urls: ${files.length} tracked file(s), ${withCtor} containing \`new URL(\` after masking, ` +
      `${total} site(s) across ${Object.keys(current).length} file(s), ${CONTROLS.length} embedded control(s) passed.`,
  );

  // 3. Report. A GitHub `::error` annotation is reserved for sites ABOVE the
  //    baseline — annotating all 35 on a green run would decorate 28 innocent
  //    files on every unrelated PR, and an annotation that fires when nothing is
  //    wrong trains reviewers to ignore it. The full population still prints to
  //    the log, so the baselined sites are readable rather than hidden.
  const { entries: baseline } = loadBaseline(baselineFile);

  // A baselined file with ZERO current sites is a dead entry, and a dead entry
  // is cover: the next real violation in that file inherits it silently. The
  // guard this replaced failed on a stale EXEMPT for exactly this reason and
  // that property is worth keeping. A PARTIAL fix (2 -> 1) is fine and is the
  // ratchet working; only a fully-drained key must be removed. Not enforced
  // under --update-baseline, or the regen that REMOVES the stale key could
  // never run.
  const stale = Object.keys(baseline).filter((k) => !(k in current));
  if (stale.length && !regen) {
    console.error(
      `::error::external-origin-urls: ${stale.length} baseline entr(ies) no longer contain ANY site: ` +
        `${stale.join(', ')}. A drained entry is cover for the next violation in that file — regen with ` +
        '`node scripts/ci/check-external-origin-urls.mjs --update-baseline` (the ratchet then tightens).',
    );
    return 1;
  }

  console.log(`external-origin-urls: full population (baselined sites are informational):`);
  for (const b of detail) {
    const overBaseline = (current[b.f] ?? 0) > (baseline[b.f] ?? 0);
    const body =
      `external-origin-urls [${b.kind}]: ${b.note}. Under \`output: 'standalone'\` with HOSTNAME=0.0.0.0 ` +
      "that authority is the container's own listen address, so clients get https://0.0.0.0:3000/… " +
      'Use externalOrigin(req.headers) from @/lib/auth/auth-breaker. See #3442, #3443, #3467, #3468.';
    if (overBaseline) console.error(`::error file=${b.f},line=${b.line}::${body}\n  ${b.text}`);
    else console.log(`  ${b.f}:${b.line} [${b.kind}] ${b.text}`);
  }

  return runRatchet({
    name: 'external-origin-urls',
    baselineFile,
    meta: META,
    current,
    argv,
    touched: {
      files: touchedFiles !== undefined ? touchedFiles : gitTouchedFiles({ cwd: REPO_ROOT }),
      exempt: TOUCH_EXEMPT,
      message: () =>
        'build this URL on externalOrigin(req.headers) (@/lib/auth/auth-breaker) while you are in the file — ' +
        'see app/api/flightsql/connect/route.ts and app/api/catalog/iceberg/overview/route.ts for the shape',
    },
  });
}

// Run as a script, not as an import side effect (#3436).
if (process.argv[1] && process.argv[1].endsWith('check-external-origin-urls.mjs')) {
  process.exitCode = main();
}
