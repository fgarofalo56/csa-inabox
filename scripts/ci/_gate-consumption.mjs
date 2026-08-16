/**
 * SHARED ANALYZER: "did this route ACT on the guard's answer?"  (#3088 / C22)
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — the defect it is built to make impossible.
 *
 * Loom's authorization guards come in two shapes:
 *
 *   (1) STRUCTURAL — the guard IS the control flow. `withTenantAdmin(handler)`
 *       runs the check and only then calls `handler`. There is no way to keep
 *       the token and skip the enforcement: deleting the wrapper deletes the
 *       call.
 *
 *   (2) RETURNED-VALUE — the guard hands back `NextResponse | null` and the
 *       CALLER must short-circuit on it:
 *
 *           const gate = await enforceCapability(session, cap, 'Admin');
 *           if (gate) return gate;        // ← THE ENTIRE AUTHORIZATION
 *
 *       Delete that second line and the route is wide open. The call still
 *       runs, still costs a Cosmos round trip, still "looks" guarded — and
 *       every text-matching checker that searches for the NAME
 *       `enforceCapability` still passes.
 *
 * That is not hypothetical. Measured 2026-08-07 on `app/api/setup/deploy/
 * route.ts` (the route that submits SUBSCRIPTION-SCOPED ARM deployments): with
 * `if (gate) return gate;` removed and the `enforceCapability` call left in
 * place, `check-route-guards.mjs` reported `violations: 0`, and so did
 * `check-route-toolkit.mjs` and `check-credential-route-authz.mjs`. Nothing in
 * CI could see it.
 *
 * It is the SAME CLASS as #2977, where `assertOwner` survived only as a word in
 * a migration COMMENT after PR #2973 deleted the function, and 34 routes kept
 * passing a merge-blocking check on the strength of that comment. #2977 was
 * fixed for one symbol by removing `assertOwner` from the signal list. The
 * class was left live for every other symbol, because the underlying rule never
 * changed: **presence of a name was being read as proof of enforcement.**
 *
 * WHAT THIS MODULE ASSERTS INSTEAD
 *
 *   Every call to a returned-value guard must have its result CONSUMED in a
 *   control-flow short circuit — returned, thrown, or tested by an `if` whose
 *   consequent returns/throws. A call whose result goes nowhere is a violation,
 *   full stop: there is no legitimate reason to pay for an authorization
 *   decision and then discard it.
 *
 * It also strips comments and string/template literals BEFORE matching, so a
 * guard name that survives only as prose can never satisfy anything — the
 * #2977 mechanism, closed for every symbol at once rather than one at a time.
 *
 * DELIBERATELY NOT CLAIMED (the checker's own honesty boundary): consuming a
 * gate's result proves the route ACTS on an authorization decision. It does not
 * prove the decision is the RIGHT one (correct capability id, correct required
 * role) — that is what the per-route reviews and the contract tests are for.
 */

/** Returned-value guards: each returns `NextResponse | null` (or `{resp}`) that
 *  the CALLER must short-circuit on. Discarding the result disables the guard
 *  while leaving its name in the file.
 *
 *  Every entry was read from its definition, not assumed:
 *    enforceCapability      lib/auth/feature-gate.ts     → Promise<NextResponse|null>
 *    requireTenantAdmin     lib/auth/feature-gate.ts     → NextResponse|null
 *    denyIfNoDlzAccess      lib/auth/dlz-gate.ts         → Promise<NextResponse|null>
 *    pdpCheck               lib/auth/pdp/enforce.ts      → Promise<NextResponse|null>
 *    authorizeItemWorkspace lib/auth/workspace-guard.ts  → Promise<NextResponse|null>
 *    authorizeWorkspace     lib/auth/workspace-guard.ts  → Promise<NextResponse|null>
 *    requireWorkspace       lib/auth/workspace-guard.ts  → {session}|{resp}
 *    authorizeNotebookItem  app/api/items/databricks-notebook/_lib/notebook-exec-scope.ts
 *                                                       → {item}|{denied}
 *    authorizeDatabricksJobItem      .../databricks-job/_lib/job-scope.ts       → {item}|{denied}
 *    authorizeDatabricksPipelineItem .../databricks-pipeline/_lib/pipeline-scope.ts → {item}|{denied}
 *    guardAdxItemRequest    app/api/items/_lib/adx-item-scope.ts → {ctx}|{res}
 *
 *  `requireWorkspace` is the destructuring shape (`const { session, resp } =
 *  await requireWorkspace(id)`), handled below. The five item-guard wrappers are
 *  the SAME shape one level up.
 *
 *  THE FOUR WRAPPERS WERE MISSING UNTIL 2026-08-16, and that was measured, not
 *  theorised. They were listed in `check-route-guards.mjs`'s GUARD_SIGNAL_RE and
 *  GUARD_WRAPPERS — so a route calling one was classified authorized — but NOT
 *  here, so the "answer is DISCARDED" check never looked at them. Deleting
 *  `if (guard.res) return guard.res;` from
 *  `items/eventhouse/[id]/database/route.ts` (whose DELETE drops a KQL database
 *  on the shared cluster) left every control green:
 *      [route-guards] gates whose answer is DISCARDED: 0
 *      [route-guards] violations: 0            CHECKER_EXIT=0
 *  That is the exact C22 defect this module exists for, reproduced on the
 *  newest wrappers. A wrapper is only a safe signal if BOTH files know it.
 *
 *  TYPE-SAFETY IS NOT A SUBSTITUTE, and the earlier claim that it was has been
 *  corrected. Dropping the check while STILL destructuring `guard.ctx` is a
 *  compile error (TS2339/TS18048) — but calling the guard and discarding the
 *  result entirely, then reading `body.database`, COMPILES CLEAN. The type only
 *  protects handlers that go on to consume the context. */
export const RETURNED_VALUE_GATES = [
  'enforceCapability',
  'requireTenantAdmin',
  'denyIfNoDlzAccess',
  'pdpCheck',
  'authorizeItemWorkspace',
  'authorizeWorkspace',
  'requireWorkspace',
  'authorizeNotebookItem',
  'authorizeDatabricksJobItem',
  'authorizeDatabricksPipelineItem',
  'guardAdxItemRequest',
];

/**
 * For the TWO-SHAPE gates — the ones that return `{success} | {denial}` rather
 * than `NextResponse | null` — the name of the DENIAL half.
 *
 * WHY THIS IS SEPARATE FROM THE GENERIC CHECK, and how it was found. The generic
 * rule is "at least one binding short-circuits", which is right for
 * `NextResponse | null` but WRONG here, because the SUCCESS half is also a
 * binding and referencing it satisfies the heuristic without refusing anybody.
 * Measured 2026-08-16 on `items/eventhouse/[id]/database/route.ts` DELETE (which
 * drops a KQL database on the shared cluster): replacing
 *     if (guard.res) return guard.res;
 *     const { item } = guard.ctx;
 * with
 *     const { item } = guard.ctx ?? { item: {} as never };
 * left `DISCARDED: 0` and `violations: 0`, because `guard.ctx ??` matches the
 * "tested in a logical position" shape in {@link bindingIsConsumed} — a fallback
 * READ of the success half looks identical to a decision. The route was fully
 * unauthorized and every control was green.
 *
 * So for these gates the DENIAL binding specifically must be returned/thrown:
 * `guard.res`, `{ denied }`, `{ resp }`. Adding this flagged nothing that was
 * already correct — every existing consumer already writes
 * `if (denied) return denied;` — so it is a tightening with no migration.
 */
const DENIAL_BINDINGS = {
  requireWorkspace: ['resp'],
  authorizeNotebookItem: ['denied'],
  authorizeDatabricksJobItem: ['denied'],
  authorizeDatabricksPipelineItem: ['denied'],
  guardAdxItemRequest: ['res'],
};

/**
 * Blank out comments, string/template literals AND REGEX LITERALS, PRESERVING
 * LENGTH and line structure so byte offsets and line numbers stay exact.
 * Replacement char is a space (newlines are kept as newlines) so downstream
 * regexes see whitespace where prose used to be.
 *
 * This is what makes a name-in-a-comment (#2977) unable to satisfy any signal.
 *
 * REGEX LITERALS ARE NOT OPTIONAL. Found while building this: the console has
 * regex literals carrying an ODD number of quote characters, e.g.
 *   apps/fiab-console/app/api/items/dataflow/profile/route.ts:176
 *     tok.trim().match(/^"((?:[^"]|"")*)"$/)
 * Treat that as code and the 5th `"` opens a string state that runs on for
 * dozens of lines, blanking REAL CODE — including, in that file, the
 * `getSession()` call and the `export async function POST`. Blanked code is
 * invisible code: the route silently leaves the checker's remit and every gate
 * call inside it stops being counted. A stripper that eats code is a checker
 * that measures nothing, which is the failure mode this whole change exists to
 * end. Pinned by the "regex literal containing quotes" tests.
 *
 * @param {string} src
 * @param {{keepStrings?: boolean}} [opts]
 *   `keepStrings: true` blanks ONLY comments (and regex literals, which are
 *   still not code you can search for identifiers in). Use it when the signal
 *   you are matching legitimately LIVES in a string literal — an import
 *   specifier (`from '@/lib/azure/adf-client'`) or an error code
 *   (`code: 'not_configured'`) is data the code really carries. The distinction
 *   is the honest one: a comment is NEVER code, whereas a string literal
 *   sometimes is exactly the thing being looked for. Blanking strings for those
 *   signals silently collapses their counts — measured while wiring this into
 *   generate-route-inventory.mjs, where it took "Gated (backend config)" from
 *   531 to 308 by erasing every `'not_configured'`.
 */
export function stripCommentsAndStrings(src, opts = {}) {
  const keepStrings = opts.keepStrings === true;
  const out = Array.from(src);
  const n = src.length;
  let i = 0;
  // states: 0 code, 3 '..' 4 ".." 5 `..`
  let state = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // The last significant code character seen — decides whether `/` opens a
  // REGEX literal or is a division operator (the standard JS lexer heuristic).
  let prevSignificant = '';
  let prevWord = '';
  const REGEX_PRECEDERS = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '\n', '',
  ]);
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
    'else', 'yield', 'await', 'case', 'throw',
  ]);
  const startsRegex = () =>
    REGEX_PRECEDERS.has(prevSignificant) || REGEX_KEYWORDS.has(prevWord);
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 0) {
      if (c === '/' && d === '/') { const s = i; while (i < n && src[i] !== '\n') i++; blank(s, i); continue; }
      if (c === '/' && d === '*') {
        const s = i; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, n); blank(s, i); continue;
      }
      if (c === '/' && startsRegex()) {
        // A regex literal. `/` inside a `[...]` character class does NOT close
        // it, and `\/` is an escape — both are the reason a naive scan fails.
        const s = i; i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          const r = src[i];
          if (r === '\\') { i += 2; continue; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < n && /[dgimsuvy]/.test(src[i])) i++; // flags
        blank(s, i);
        prevSignificant = ')'; // a regex is a VALUE, so a following `/` divides
        prevWord = '';
        continue;
      }
      if (c === "'") { state = 3; if (!keepStrings) out[i] = ' '; i++; prevSignificant = ')'; prevWord = ''; continue; }
      if (c === '"') { state = 4; if (!keepStrings) out[i] = ' '; i++; prevSignificant = ')'; prevWord = ''; continue; }
      if (c === '`') { state = 5; if (!keepStrings) out[i] = ' '; i++; prevSignificant = ')'; prevWord = ''; continue; }
      if (!/\s/.test(c)) {
        if (/[\w$]/.test(c)) {
          // Building an identifier. `prevWord` must survive the WHITESPACE that
          // follows it — `return /re/` has a space between the keyword and the
          // slash, and clearing on that space is what made `return /[",\n]/`
          // lex as division and swallow the rest of the file.
          prevWord = /[\w$]/.test(prevSignificant) ? prevWord + c : c;
        } else {
          prevWord = '';
        }
        prevSignificant = c;
      }
      i++; continue;
    }
    if (state === 3 || state === 4) {
      const quote = state === 3 ? "'" : '"';
      if (c === '\\') {
        if (!keepStrings) {
          if (out[i] !== '\n') out[i] = ' ';
          if (out[i + 1] !== undefined && out[i + 1] !== '\n') out[i + 1] = ' ';
        }
        i += 2; continue;
      }
      if (c === quote) { if (!keepStrings) out[i] = ' '; state = 0; i++; continue; }
      if (!keepStrings && c !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (state === 5) {
      if (c === '\\') {
        if (!keepStrings) {
          if (out[i] !== '\n') out[i] = ' ';
          if (out[i + 1] !== undefined && out[i + 1] !== '\n') out[i + 1] = ' ';
        }
        i += 2; continue;
      }
      if (c === '$' && d === '{') {
        // Interpolations are CODE — leave them intact so a guard call inside a
        // template can still be seen. Track depth to find the closing brace.
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          if (depth === 0) break;
          i++;
        }
        i++; continue;
      }
      if (c === '`') { if (!keepStrings) out[i] = ' '; state = 0; i++; continue; }
      if (!keepStrings && c !== '\n') out[i] = ' ';
      i++; continue;
    }
  }
  return out.join('');
}

function lineOf(code, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/** End offset of the block ENCLOSING `from` (index of its closing `}`), i.e.
 *  the last offset at which a binding declared at `from` is still in scope.
 *  Operates on comment/string-stripped code, so no brace can hide in a literal. */
function enclosingBlockEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0) return i; depth--; }
  }
  return code.length;
}

/** Offset just past the matching `)` for the `(` at `open`. */
function matchParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return code.length;
}

/** The text of the statement/block that runs when an `if` test is TRUE. */
function consequentOf(code, afterTestEnd) {
  let i = afterTestEnd;
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code[i] === '{') {
    let depth = 0;
    for (let k = i; k < code.length; k++) {
      if (code[k] === '{') depth++;
      else if (code[k] === '}') { depth--; if (depth === 0) return code.slice(i, k + 1); }
    }
    return code.slice(i);
  }
  const semi = code.indexOf(';', i);
  return code.slice(i, semi === -1 ? code.length : semi + 1);
}

/** How many `(`/`[` in `s` are still open at its end. >0 means the position sits
 *  INSIDE an enclosing expression (an `if` test, an argument list, a ternary). */
function countUnclosed(s) {
  let n = 0;
  for (const c of s) {
    if (c === '(' || c === '[') n++;
    else if (c === ')' || c === ']') n--;
  }
  return n;
}

/** Index of the `{` matching the `}` at `close`, or -1. */
function matchBraceBack(code, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === '}') depth++;
    else if (code[i] === '{') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Is the binding `name`, declared at `fromIdx`, consumed in a way that can
 * change what the caller gets back, before its enclosing block ends?
 *
 * Accepted — each shape below was READ OUT OF the real routes, not invented:
 *   return NAME;  /  throw NAME;            setup/deploy, admin/env-config, …
 *   if (NAME) return …                      the dominant idiom (~34 routes)
 *   if (NAME) { …; return NAME; }           catalog/unity/governance (audits
 *                                           the denial, then returns it)
 *   NAME ? withheld : real                  items/event-grid-topic — the gate
 *                                           WITHHOLDS the access keys rather
 *                                           than rejecting the whole request
 *   !NAME && …  /  NAME ?? …                logical short-circuit forms
 *
 * REJECTED (this is the defect): a binding that is never tested and never
 * returned — `const gate = await enforceCapability(…);` and nothing else, or
 * `if (gate) { logSafe(…); }` with no return. The decision was paid for and
 * thrown away.
 *
 * HONESTY BOUNDARY: this proves the answer is CONSUMED in a decision position.
 * It does not prove the consumption is sufficient (right capability, right
 * role, right branch) — reviews and contract tests own that.
 */
function bindingIsConsumed(code, name, fromIdx) {
  const end = enclosingBlockEnd(code, fromIdx);
  const region = code.slice(fromIdx, end);
  const ident = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // (1) Direct short circuit on the binding (optionally via a member/optional
  //     chain — `return denied.resp`, `return gate ?? x`).
  if (new RegExp(`\\b(?:return|throw)\\s+(?:await\\s+)?${ident}\\b`).test(region)) return true;
  // (2) Tested in a ternary/logical position — the data-withholding shape.
  if (new RegExp(`(?:^|[^\\w$.])!?\\s*${ident}(?:\\?\\.[\\w$]+|\\.[\\w$]+)*\\s*(?:\\?[^.]|&&|\\|\\||\\?\\?)`).test(region)) return true;
  if (new RegExp(`[!(]\\s*${ident}\\b`).test(region) && /\b(?:return|throw)\b/.test(region)) {
    // (3) An `if` that TESTS the binding and whose consequent returns/throws.
    const ifRe = /\bif\s*\(/g;
    let m;
    while ((m = ifRe.exec(region))) {
      const open = m.index + m[0].length - 1;
      const closeAfter = matchParen(region, open);
      const test = region.slice(open, closeAfter);
      if (!new RegExp(`\\b${ident}\\b`).test(test)) continue;
      const cons = consequentOf(region, closeAfter);
      if (/\b(?:return|throw)\b/.test(cons)) return true;
    }
  }
  return false;
}

/**
 * Find every returned-value-guard call whose answer is DISCARDED.
 *
 * @param {string} src  raw route source
 * @param {string[]} [gates]  guard names (defaults to RETURNED_VALUE_GATES)
 * @returns {{gate:string,line:number,reason:string}[]}
 */
export function findDiscardedGateResults(src, gates = RETURNED_VALUE_GATES) {
  const code = stripCommentsAndStrings(src);
  const found = [];
  for (const gate of gates) {
    // A CALL, not a mention: the name followed by `(`. Comments/strings are
    // already blanked, so an import line is the only other `gate` occurrence —
    // and an import has no `(`, so it cannot reach here.
    const callRe = new RegExp(`\\b${gate}\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(code))) {
      const callStart = m.index;
      // Ignore the definition/re-export site (never in app/api/**/route.ts, but
      // keep the analyzer honest if it is ever pointed at lib/).
      const before = code.slice(Math.max(0, callStart - 40), callStart);
      if (/\b(?:function|const|export\s+async\s+function)\s*$/.test(before)) continue;
      // Walk back to the start of the enclosing STATEMENT. Parens are NOT
      // treated as boundaries: `if (await enforceCapability(…))` must keep its
      // `if (` in the prefix, which is the whole point — the test position IS
      // the enforcement. Only `;` `{` `}` end a statement — EXCEPT a `}` that
      // closes a destructuring pattern (`const { session, resp } = await …`),
      // which is part of the statement and must be kept.
      let s = callStart - 1;
      for (;;) {
        while (s >= 0 && code[s] !== ';' && code[s] !== '{' && code[s] !== '}') s--;
        if (s >= 0 && code[s] === '}') {
          const open = matchBraceBack(code, s);
          if (open >= 0 && /\b(?:const|let|var)\s*$/.test(code.slice(Math.max(0, open - 12), open))) {
            s = open - 1; // skip the pattern, keep walking for the real boundary
            continue;
          }
        }
        break;
      }
      const prefix = code.slice(s + 1, callStart);
      const line = lineOf(code, callStart);

      // (a) directly returned / thrown
      if (/\b(?:return|throw)\s+(?:await\s+)?$/.test(prefix)) continue;
      // (b) TESTED INLINE — the call's value is the condition itself:
      //       if (await authorizeWorkspace(…)) return err(…)      warp/transforms
      //       if (any && !(await authorizeWorkspace(…))) { … }    thread/kql-…
      //       cond ? await denyIfNoDlzAccess(…) : null            (ternary arm,
      //                                                            bound below)
      //     An unclosed `(` or a `!`/`&&`/`||`/`?` operator immediately before
      //     the call means its result feeds a decision, not the floor.
      if (/\bif\s*\(/.test(prefix) && countUnclosed(prefix) > 0) continue;
      if (/(?:[!?]|&&|\|\||\?\?)\s*\(?\s*(?:await\s+)?$/.test(prefix)) continue;
      // (c) the call is an ARGUMENT to another expression (composed) — the
      //     enclosing expression owns the result, e.g. `Promise.all([… , await
      //     authorizeWorkspace(…)])`. Detected by an unclosed `(`/`[` with no
      //     assignment in between.
      if (countUnclosed(prefix) > 0 && !/=\s*[^=]*$/.test(prefix)) continue;
      // (d) bound to a name (possibly through a ternary arm), then consumed
      const simple = prefix.match(
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[^;{}]*?\?\s*)?(?:await\s+)?$/,
      );
      if (simple) {
        const denials = DENIAL_BINDINGS[gate];
        if (denials) {
          // TWO-SHAPE GATE: the DENIAL half specifically must short-circuit.
          if (denials.some((d) => bindingIsConsumed(code, `${simple[1]}.${d}`, callStart))) continue;
          found.push({
            gate,
            line,
            reason:
              `result bound to \`${simple[1]}\` but \`${simple[1]}.${denials[0]}\` is never returned/thrown — ` +
              'the denial half of the gate\'s answer is discarded',
          });
          continue;
        }
        if (bindingIsConsumed(code, simple[1], callStart)) continue;
        found.push({
          gate,
          line,
          reason: `result bound to \`${simple[1]}\` but never returned/thrown — the gate's answer is discarded`,
        });
        continue;
      }
      const destructured = prefix.match(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$/);
      if (destructured) {
        const names = destructured[1]
          .split(',')
          .map((p) => p.split(':').pop().trim().replace(/^\.\.\./, ''))
          .filter(Boolean);
        // At least ONE destructured binding must short-circuit (the `resp` half
        // of `requireWorkspace`'s `{ session, resp }`).
        const denials = DENIAL_BINDINGS[gate];
        if (denials) {
          // TWO-SHAPE GATE: the SUCCESS half is not a substitute. `const { item }
          // = await authorizeNotebookItem(…)` binds only the success half, so
          // there is nothing left that can short-circuit — the denial is dropped.
          if (denials.some((d) => names.includes(d) && bindingIsConsumed(code, d, callStart))) continue;
          found.push({
            gate,
            line,
            reason:
              `destructured to {${names.join(', ')}} but the denial binding ` +
              `\`${denials[0]}\` is not bound-and-returned — the gate's refusal is discarded`,
          });
          continue;
        }
        if (names.some((nm) => bindingIsConsumed(code, nm, callStart))) continue;
        found.push({
          gate,
          line,
          reason: `destructured to {${names.join(', ')}} but no binding is returned/thrown — the gate's answer is discarded`,
        });
        continue;
      }
      // (e) bare expression statement: `await enforceCapability(...);`
      found.push({
        gate,
        line,
        reason: 'called as a bare statement — the returned 401/403 response is thrown away',
      });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}
