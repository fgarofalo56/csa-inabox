/**
 * SHARED ANALYZER: what AUTHORIZES a route — derived from the tree, not listed.
 * ===========================================================================
 * `generate-route-inventory.mjs` publishes an **Auth scope** column
 * (`public` / `session-only` / `owner-scoped` / `admin`) for every
 * `apps/fiab-console/app/api/**\/route.ts`. This module decides the
 * `owner-scoped` half of that verdict.
 *
 * ── THE DEFECT THIS REPLACES (#3625) ───────────────────────────────────────
 * `OWNER_RE` was a list of NAMES, and one of them was the bare token
 * `claims\.oid`. The caller's object id is load-bearing in three unrelated
 * roles and only one of them is authorization:
 *
 *   1. an AUTHORIZATION argument — `loadOwnedItem(id, type, session.claims.oid)`
 *   2. a Cosmos PARTITION KEY — scopes the query, not the caller's right to it
 *   3. a LOG / METRIC / ATTRIBUTION field — no security meaning at all
 *
 * A regex cannot separate them, so role 3 published as `owner-scoped`.
 * Measured on `main` at 9cc1a397: **271 of 773 `owner-scoped` rows rested on a
 * `claims.*` token and nothing else.** Four were confirmed by hand:
 *
 *   items/warehouse/[id]/query                    — no item authz at all; the
 *     only owner token was `recordQueryRun({ userOid: session.claims.oid })`,
 *     a FinOps attribution field (GHSA-v2g8-gp3r-rg4r fixed the route later).
 *   items/synapse-dedicated-sql-pool/[id]/query   — same shape.
 *   items/databricks-sql-warehouse/[id]/query     — same shape.
 *   items/azure-sql-database/[id]/mirroring       — published `owner-scoped`
 *     while it was an ACTIVE P0 data-exfiltration primitive. The column an
 *     operator would scan reported the hole as fixed.
 *
 * And the inverse, which is the nastier demonstration: stripping EVERY
 * code-level owner token out of `azure-sql-database/[id]/query` left the
 * generated inventory BYTE-IDENTICAL, because `loadOwnedItem` occurs twice in
 * that file and both occurrences are inside comments. A no-change diff is the
 * output nobody scrutinises.
 *
 * ── WHAT THIS DOES INSTEAD ─────────────────────────────────────────────────
 * Three properties, each of which was a separate failure in this repo's history:
 *
 * 1. **THE RESOLVER SET IS DERIVED FROM THE TREE, NOT HAND-LISTED.** A hand
 *    list misses the local wrappers — `databricks-{job,notebook,pipeline}/_lib/
 *    *-scope.ts`, `items/_lib/{adx,synapse}-item-scope.ts`,
 *    `items/_lib/sql-server-scope.ts`, `storage/_lib/authorize.ts`,
 *    `notebook/_lib/notebook-access.ts`, `lakebase-postgres/[id]/_shared::authItem`,
 *    `sqldb/_shared::guardSqlDbRequest`, `git-integration/_lib/ctx::loadGitCtx`
 *    — and every one of the first five had to be added to `OWNER_RE` by hand
 *    AFTER a route using it published the wrong scope (see that file's own four
 *    lockstep notes). The last three never were, so 27 routes that DO authorize
 *    published as `public`. Here, a function is an authorization resolver iff
 *    its body reaches a seeded ROOT primitive through the import graph and acts
 *    on the answer, or makes the same owner comparison itself. Same shape as
 *    #3639's `SQL_EDITOR_ITEM_TYPES` control: derive, don't transcribe.
 *
 * 2. **A NAME IN A COMMENT CANNOT AUTHORIZE ANYTHING.** Everything is matched
 *    over `stripCommentsAndStrings()` output, and only in CALL form. Import
 *    specifiers are read from the `keepStrings: true` variant, because a module
 *    path genuinely lives in a string.
 *
 * 3. **AN UNKNOWN FAILS; IT DOES NOT GUESS.** Per `deploy-integrity.md` R7 a
 *    generator that cannot establish a route's auth scope says so. Two triggers,
 *    both of which name the module in the failure:
 *      U1  the caller's oid flows into a call the analyzer cannot resolve to any
 *          definition — first-party import that does not resolve, or a bare
 *          identifier that is neither imported, declared, nor a known global.
 *      U2  the route calls an authorization-SHAPED symbol (`authorize*`,
 *          `require*`, `guard*`, `assert*`, `admit*`, `*Scope`, `*Authz`, …)
 *          imported from a first-party module that the derivation did NOT find
 *          to be a resolver. That is exactly "someone added an authorization
 *          helper the generator does not know about": it fails naming the
 *          module instead of silently downgrading the route to `session-only`.
 *
 * ── WHAT IS DELIBERATELY *NOT* CLAIMED ─────────────────────────────────────
 * Stated because an unstated limit reads as coverage.
 *
 *   - **Scope is per FILE, not per METHOD.** A file whose GET is owner-scoped
 *     and whose POST is not publishes one row, as it always has. The reachable-
 *     set walk starts from every exported verb and unions them.
 *   - **"Reaches an authorization call" is not "authorizes the RIGHT thing."**
 *     A route that owner-checks item A and then acts on caller-supplied item B
 *     is `owner-scoped` here. That is the class GHSA-v2g8-gp3r-rg4r is about and
 *     it needs a per-route read, not a taxonomy column.
 *   - **Consumption is asserted through `findDiscardedGateResults`**, which
 *     proves the answer reaches a control-flow decision — not that the decision
 *     is the right one (`_gate-consumption.mjs`'s own honesty boundary). It is
 *     applied at TWO different strengths, and the difference was measured, not
 *     chosen: STRICT inside the derivation (a function is only an authorization
 *     primitive if it ACTS on the answer — relaxing it there swept business
 *     logic in and took the resolver set from 170 to 650), and NARROWED at the
 *     route level to resolvers that signal refusal BY VALUE (`returnsRefusal`)
 *     plus a rescue for two shapes that analyzer misses (`answerRescued`).
 *     Without the narrowing, 99 routes fell to `session-only` on helpers that
 *     authorize internally and return nothing to short-circuit on; with it, 2
 *     remain and BOTH were read by hand and are genuinely best-effort
 *     (`thread/build-powerbi-model` — `void src; // no longer a hard gate`;
 *     `landing-zones/[id]/attach` — `.catch(() => null)` inside a
 *     `/* best-effort *\/` try).
 *   - **Dynamic dispatch is invisible.** A resolver reached through a value in a
 *     map, a `Promise.all` of thunks, or a re-export renamed twice through a
 *     barrel that also `export *`s is followed only as far as the static rules
 *     below go. Where the analyzer cannot follow, U1/U2 make it SAY so rather
 *     than assume the reassuring answer.
 *   - **`export *` is followed, but a name exported by two star-barrels resolves
 *     to whichever is found first.** Both would have to be resolvers for the
 *     verdict to be certain; in practice the console has no such collision (a
 *     control asserts the resolver set has no name bound to two different
 *     modules with different verdicts).
 *
 * Run the controls:  node --test scripts/ci/__tests__/route-auth-scope.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { stripCommentsAndStrings, findDiscardedGateResults } from './_gate-consumption.mjs';

export const CONSOLE_ROOT = 'apps/fiab-console';

// ───────────────────────────────────────────────────────────────────────────
// 0. SEEDS — the primitives that actually MAKE the owner / workspace-ACL
//    decision. Everything else in the resolver set is derived from these.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Each entry was read from its definition, not assumed:
 *
 *   resolveWorkspaceAccessByOid  lib/auth/workspace-access.ts
 *     The chokepoint: owner fast-path → workspace-roles ACL → cross-tenant
 *     `tid` boundary → tenant-admin open. `loadOwnedItem`, `listOwnedItems`,
 *     `resolveItemAccessByOid`, `authorizeWorkspace`, `authorizeItemWorkspace`
 *     and every `_lib/*-scope.ts` wrapper bottom out here.
 *
 *   resolveItemGrantAccess       lib/auth/item-access.ts (via the above)
 *     NOT seeded — it derives, and that is the point of the derivation.
 *
 * SEEDS ARE ASSERTED TO EXIST. `assertSeedsExist()` fails when a seeded module
 * or symbol is absent, because that is exactly how #2977 happened: PR #2973
 * DELETED `assertOwner` and the name survived in a migration comment, so 34
 * routes kept classifying `owner-scoped` on prose. A seed that no longer names
 * a real exported function must break the build loudly, not degrade quietly.
 */
export const ROOT_AUTHORIZERS = [
  { module: `${CONSOLE_ROOT}/lib/auth/workspace-access.ts`, symbol: 'resolveWorkspaceAccessByOid' },
];

/**
 * The SESSION root, derived the same way and for the same reason.
 *
 * This was not in the original scope of #3625 and is here because the fix
 * FORCED it. `SESSION_RE` in generate-route-inventory.mjs is a hand list of
 * wrapper names, and it does not know `guardAdxRequest` — which calls
 * `getSession()` and returns 401. Under the old `OWNER_RE` those 13
 * `app/api/adx/*` routes published `owner-scoped` on their `claims.oid` token,
 * so the session gap was invisible. Remove the bogus owner token and they fall
 * to **public** — a NEW false claim, in the column that matters most, created by
 * the fix. Deriving "does this route reach `getSession()`" closes the gap for
 * every wrapper at once instead of adding a fourteenth name to the list.
 *
 * No consumption requirement, deliberately: `SESSION_RE` matches a bare
 * `getSession(` today, so requiring more here would move rows for a reason
 * unrelated to this change. This signal only ever ADDS to `SESSION_RE`; it
 * cannot take a route out of the session tier.
 */
export const SESSION_ROOTS = [
  { module: `${CONSOLE_ROOT}/lib/auth/session.ts`, symbol: 'getSession' },
];

/**
 * A route can also make the decision INLINE, with no helper at all:
 *
 *   const ws = await readWorkspace(id);
 *   if (!ws || ws.tenantId !== session.claims.oid) return apiNotFound();
 *
 * That IS an owner check — it is the shape `createOwnedItem` itself uses — and
 * dropping it would swap this file's defect for its mirror image: under-
 * reporting protection, which `generate-route-inventory.mjs`'s own header warns
 * "trains readers to ignore the `public` column".
 *
 * Recognised NARROWLY, and only as a decision: the caller's oid/tid COMPARED
 * (`===` / `!==`) against a stored owner-ish field, inside a condition whose
 * consequent returns or throws. A comparison whose result is discarded is not a
 * check, and an oid merely PASSED to something is handled by the resolver path.
 */
export const OWNER_FIELDS = [
  'tenantId', 'ownerOid', 'ownerId', 'createdByOid', 'createdBy', 'oid', 'owner', 'userOid', 'principalId',
];

// ───────────────────────────────────────────────────────────────────────────
// 1. SOURCE MASKING + SMALL SYNTAX HELPERS (offset-preserving)
// ───────────────────────────────────────────────────────────────────────────

/** `{ code, dataCode }` — comments+strings blanked, and comments-only blanked.
 *  Both preserve offsets, so a match in one indexes the other. */
export function maskSource(raw) {
  return { code: stripCommentsAndStrings(raw), dataCode: stripCommentsAndStrings(raw, { keepStrings: true }) };
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };

/** Index of the bracket matching the one at `open`, or -1. */
export function matchBracket(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) {
      depth--;
      if (depth === 0) return c === OPEN[code[open]] ? i : -1;
    }
  }
  return -1;
}

/** 1-based line of a byte offset. */
export function lineOf(src, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/**
 * Where a function BODY starts, given the index just past its parameter `)`.
 *
 * The naive `first { after )` is wrong in TypeScript and wrong in a way that
 * silently truncates every annotated function to nothing: `createOwnedItem`'s
 * return type is `Promise<{ ok: true; item: WorkspaceItem } | { ok: false; … }>`,
 * whose FIRST `{` is inside the annotation. Measured while building this — with
 * the naive rule the derivation found 1 resolver instead of 97, because
 * `item-crud.ts`'s exported functions all carry object return types and every
 * body came back empty.
 *
 * So: walk forward tracking the previous significant character. A `{` opens a
 * TYPE object when the previous significant char is one of `: < , | & ( [` —
 * i.e. it sits in type position — and is skipped whole. The first `{` in any
 * other position is the body. `): Promise<{…}|{…}> {` and `): { a: string } {`
 * both land on the right brace.
 */
export function findBodyStart(code, afterParen) {
  let prev = '';
  for (let i = afterParen; i < code.length; i++) {
    const c = code[i];
    if (/\s/.test(c)) continue;
    if (c === '{') {
      // `prev !== ''` is load-bearing: `''.includes` is TRUE for the empty
      // string, so an unguarded `':<,|&(['.includes(prev)` treated the FIRST
      // brace of an unannotated `function POST(req) {` as a type object and
      // returned no body at all. Measured: every `export async function POST`
      // in app/api vanished from the declaration table and the route
      // classifier saw an empty file.
      if (prev !== '' && ':<,|&(['.includes(prev)) {
        const close = matchBracket(code, i);
        if (close === -1) return -1;
        i = close;
        prev = '}';
        continue;
      }
      return i;
    }
    if (c === ';' || c === '=') return -1; // an overload signature / an assignment
    prev = c;
  }
  return -1;
}

/** End of a depth-0 expression starting at `from` (arrow expression bodies). */
function expressionEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (OPEN[c]) depth++;
    else if (CLOSE[c]) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === ';') return i;
    else if (depth === 0 && c === '\n') {
      const rest = code.slice(i + 1, i + 200);
      if (!/^\s*[.?:)|&+,]/.test(rest)) return i;
    }
  }
  return code.length;
}

const FN_DECL_RE =
  /(?:^|[\n;{}])\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/g;
/** `const NAME = <function-ish>` — the lookahead is what stops `const item =
 *  await loadOwnedItem(…)` being registered as a CALLABLE named `item`. Without
 *  it, every local variable holding an authorized item became a "resolver" and
 *  the derived set was 1481 entries of noise instead of 97. */
const CONST_FN_DECL_RE =
  /(?:^|[\n;{}])\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*(?=(?:async\s+)?(?:function\b|\(|<|[A-Za-z_$][\w$]*\s*=>))/g;

/**
 * Every named callable declared in a file → `{ start, end }` covering its body.
 * Overloads collapse onto the longest body (TypeScript's implementation
 * signature is the one with a body; the declarations have none).
 */
export function parseDeclarations(code) {
  const decls = new Map();
  const put = (name, start, end, lparen = -1, rparen = -1) => {
    if (end <= start) return;
    const prev = decls.get(name);
    if (!prev || end - start > prev.end - prev.start) decls.set(name, { start, end, lparen, rparen });
  };

  for (const m of code.matchAll(FN_DECL_RE)) {
    const lparen = m.index + m[0].length - 1;
    const rparen = matchBracket(code, lparen);
    if (rparen === -1) continue;
    const bodyStart = findBodyStart(code, rparen + 1);
    if (bodyStart === -1) continue;
    const bodyEnd = matchBracket(code, bodyStart);
    if (bodyEnd === -1) continue;
    put(m[1], m.index, bodyEnd, lparen, rparen);
  }

  for (const m of code.matchAll(CONST_FN_DECL_RE)) {
    const from = m.index + m[0].length;
    // arrow / function-expression: find the parameter list, then the body
    let i = from;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code.startsWith('async', i)) {
      i += 5;
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    if (code.startsWith('function', i)) {
      const lparen = code.indexOf('(', i);
      const rparen = lparen === -1 ? -1 : matchBracket(code, lparen);
      if (rparen === -1) continue;
      const bodyStart = findBodyStart(code, rparen + 1);
      if (bodyStart === -1) continue;
      const bodyEnd = matchBracket(code, bodyStart);
      if (bodyEnd === -1) continue;
      put(m[1], m.index, bodyEnd, lparen, rparen);
      continue;
    }
    if (code[i] === '<') {
      const close = matchAngle(code, i);
      if (close === -1) continue;
      i = close + 1;
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    let rparen;
    let lparen = -1;
    if (code[i] === '(') {
      lparen = i;
      rparen = matchBracket(code, i);
      if (rparen === -1) continue;
    } else {
      // `ident => …`
      const im = code.slice(i).match(/^[A-Za-z_$][\w$]*/);
      if (!im) continue;
      lparen = i - 1;
      rparen = i + im[0].length - 1;
    }
    // The `=>` must follow the parameter list IMMEDIATELY (modulo whitespace and
    // a return-type annotation). Searching the rest of the file for one — which
    // an earlier draft did — turned `const sqlText = (body?.sql || '').trim();`
    // into a "function" whose body ran to the next arrow anywhere below it.
    const arrowM = code.slice(rparen + 1, rparen + 400).match(/^\s*(?::[^=;\n{]*)?=>\s*/);
    if (!arrowM) continue;
    const b = rparen + 1 + arrowM[0].length;
    const end = code[b] === '{' ? matchBracket(code, b) : expressionEnd(code, b);
    if (end === -1) continue;
    put(m[1], m.index, end, lparen, rparen);
  }

  // The WS-D1 toolkit export style: `export const GET = withWorkspaceOwner(
  // 'agent-flow', handler)`. The initialiser is a CALL, not a function literal,
  // so the rule above deliberately skips it — but this is precisely where the
  // authorization lives for 34 routes. Restricted to the HTTP verb names so the
  // general `const x = f()` case cannot re-open the "every local variable is a
  // callable" hole that the lookahead above exists to close.
  const VERB_DECL_RE = new RegExp(
    `(?:^|[\\n;{}])\\s*(?:export\\s+)?(?:const|let|var)\\s+(${HTTP_METHODS.join('|')})\\s*(?::[^=;\\n]*)?=\\s*`,
    'g',
  );
  for (const m of code.matchAll(VERB_DECL_RE)) {
    if (decls.has(m[1])) continue;
    put(m[1], m.index, expressionEnd(code, m.index + m[0].length));
  }
  return decls;
}

/** Index of the `>` matching the `<` at `open`, or -1. */
function matchAngle(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '<') depth++;
    else if (code[i] === '>') {
      depth--;
      if (depth === 0) return i;
    } else if (code[i] === ';' || code[i] === '{') return -1;
  }
  return -1;
}

/**
 * Bare-identifier CALL sites in `code[from,to)` → `[{ name, at }]`.
 * `(?:^|[^\w.$])` excludes `obj.method(` — a member call cannot be resolved to
 * an import without type information, and pretending otherwise is how a guard
 * starts guessing.
 */
const CALL_RE = /(?:^|[^\w.$])([A-Za-z_$][\w$]*)\s*(?:<[^(<>]*>)?\s*\(/g;
export function callSites(code, from = 0, to = code.length) {
  const out = [];
  for (const m of code.slice(from, to).matchAll(CALL_RE))
    out.push({ name: m[1], at: from + m.index + m[0].indexOf(m[1]) });
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. MODULE GRAPH
// ───────────────────────────────────────────────────────────────────────────

const IMPORT_RE = /import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
/**
 * `const { a, b } = await import('…')` — the DYNAMIC form. Not an exotic case:
 * `catalog/browse` and `catalog/search` reach `listOwnedWorkspaces` /
 * `listAllOwnedItems` this way and no other, so without this rule those two
 * routes' only ownership signal resolved to nothing and they were reported as
 * UNKNOWN. A resolution gap that lands on real authorization is exactly what
 * this analyzer must not have silently.
 */
const DYNAMIC_IMPORT_RE =
  /(?:const|let|var)\s*\{([^{}]*)\}\s*(?::[^=;\n]*)?=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)/g;
const REEXPORT_RE = /export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const STAR_RE = /export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*['"]([^'"]+)['"]/g;

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/**
 * The module graph over TRACKED console sources.
 *
 * `git ls-files` (not a directory walk) for the same reason
 * check-external-origin-urls gives: an untracked scratch file must not be able
 * to change a published security taxonomy, and ~370 stale worktrees under
 * `.claude/` make a root walk unusable anyway.
 */
export function buildGraph({ repoRoot, files, readFile } = {}) {
  const root = repoRoot ?? process.cwd();
  const readSource =
    readFile ?? ((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  const list =
    files ??
    execFileSync('git', ['ls-files', CONSOLE_ROOT], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => !/(?:^|\/)(?:__tests__|__mocks__|__fixtures__)\//.test(f))
      .filter((f) => !/\.(?:test|spec)\.tsx?$/.test(f));

  const fileSet = new Set(list);
  const resolveSpec = (spec, fromFile) => {
    let base;
    if (spec.startsWith('@/')) base = `${CONSOLE_ROOT}/${spec.slice(2)}`;
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    else return { external: spec };
    for (const e of EXTS) if (fileSet.has(base + e)) return { file: base + e };
    if (fileSet.has(base)) return { file: base };
    return { unresolved: base, spec };
  };

  const modules = new Map();
  for (const f of list) {
    const raw = readSource(f);
    const { code, dataCode } = maskSource(raw);
    const imports = new Map();
    for (const m of dataCode.matchAll(IMPORT_RE)) {
      if (m[1]) continue; // `import type { … }` — erased, never a runtime call
      const clause = m[2];
      const target = resolveSpec(m[3], f);
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(',')) {
          const p = part.trim();
          if (!p || /^type\s/.test(p)) continue;
          const [impRaw, localRaw] = p.split(/\s+as\s+/);
          const imported = impRaw.trim();
          const local = (localRaw ?? impRaw).trim();
          if (/^[A-Za-z_$][\w$]*$/.test(local)) imports.set(local, { spec: m[3], imported, target });
        }
      }
      const rest = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/g, '');
      for (const d of rest.split(',')) {
        const name = d.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) imports.set(name, { spec: m[3], imported: 'default', target });
      }
    }
    for (const m of dataCode.matchAll(DYNAMIC_IMPORT_RE)) {
      const target = resolveSpec(m[2], f);
      for (const part of m[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const [impRaw, localRaw] = p.split(':');
        const imported = impRaw.trim();
        const local = (localRaw ?? impRaw).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(local) && !imports.has(local))
          imports.set(local, { spec: m[2], imported, target });
      }
    }
    const reexports = [];
    for (const m of dataCode.matchAll(REEXPORT_RE)) {
      if (m[1]) continue;
      const target = resolveSpec(m[3], f);
      for (const part of m[2].split(',')) {
        const p = part.trim();
        if (!p || /^type\s/.test(p)) continue;
        const [impRaw, localRaw] = p.split(/\s+as\s+/);
        reexports.push({ imported: impRaw.trim(), exported: (localRaw ?? impRaw).trim(), target });
      }
    }
    const stars = [...dataCode.matchAll(STAR_RE)].map((m) => resolveSpec(m[1], f));
    const decls = parseDeclarations(code);
    // Computed once: the fixpoint below re-reads every module's call list on
    // every pass, and re-scanning 4,131 masked files 5 times is most of the run.
    modules.set(f, {
      file: f, raw, code, dataCode, imports, reexports, stars, decls, allCalls: callSites(code),
    });
  }

  /**
   * Local name used in `file` → `{file,name}` | `{external,name}` | null.
   * Memoised: the derivation fixpoint asks the same questions on every pass and
   * the graph is immutable, so without this the walk re-resolves the whole
   * console once per pass (measured: 25s → 8s over 4,131 files).
   */
  const localCache = new Map();
  function resolveLocal(file, name, seen = new Set()) {
    const ck = `${file}::${name}`;
    if (localCache.has(ck)) return localCache.get(ck);
    const v = resolveLocalUncached(file, name, seen);
    localCache.set(ck, v);
    return v;
  }
  function resolveLocalUncached(file, name, seen) {
    const mod = modules.get(file);
    if (!mod) return null;
    const imp = mod.imports.get(name);
    if (imp) {
      if (imp.target.external) return { external: imp.target.external, name: imp.imported };
      if (imp.target.unresolved) return { unresolvedModule: imp.target.spec, name: imp.imported };
      return resolveExport(imp.target.file, imp.imported, seen);
    }
    if (mod.decls.has(name)) return { file, name };
    return null;
  }

  /** Exported name of `file` → its defining `{file,name}`, through re-exports. */
  function resolveExport(file, name, seen = new Set()) {
    const key = `${file}::${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const mod = modules.get(file);
    if (!mod) return null;
    if (mod.decls.has(name)) return { file, name };
    const imp = mod.imports.get(name);
    if (imp) {
      if (imp.target.external) return { external: imp.target.external, name: imp.imported };
      if (imp.target.unresolved) return { unresolvedModule: imp.target.spec, name: imp.imported };
      return resolveExport(imp.target.file, imp.imported, seen);
    }
    for (const rx of mod.reexports) {
      if (rx.exported !== name) continue;
      if (rx.target.external) return { external: rx.target.external, name: rx.imported };
      if (rx.target.unresolved) return { unresolvedModule: rx.target.spec, name: rx.imported };
      const r = resolveExport(rx.target.file, rx.imported, seen);
      if (r) return r;
    }
    for (const st of mod.stars) {
      if (!st.file) continue;
      const r = resolveExport(st.file, name, seen);
      if (r) return r;
    }
    return null;
  }

  return { files: list, modules, resolveLocal, resolveExport, resolveSpec };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. DERIVATION — who is an authorization resolver
// ───────────────────────────────────────────────────────────────────────────

export const keyOf = (file, name) => `${file}::${name}`;

/** Caller-identity roots. NOT an owner signal by themselves — that is #3625. */
const CLAIM_ROOT_RE = /\bclaims\s*\??\.\s*(?:oid|tid|tenantId)\b/;
const CLAIM_DESTRUCTURE_RE =
  /(?:const|let|var)\s*\{([^{}]*)\}\s*(?::[^=;\n]*)?=\s*[^;\n]*?\bclaims\b/g;
/**
 * Parameter names this codebase uses for "the caller's Entra object id". The
 * legacy spelling is `tenantId` — `loadOwnedItem(itemId, itemType, tenantId)`
 * takes the caller's OID under that name, and its own doc says so. A helper's
 * parameter is the only way the caller identity enters `loadKustoItem`,
 * `assertOwnedItem` and friends, so without this the inline-check rule below
 * would see no identity and none of them would derive.
 */
const IDENTITY_PARAM_RE = /^(?:oid|tid|tenantId|callerOid|callerTid|userOid|ownerOid|principalId|sessionOid)$/;

/** Local identifiers bound from a caller-identity claim, within `code`. */
export function taintedIdentifiers(code) {
  const set = new Set();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=\s*([^;\n]*)/g)) {
    if (CLAIM_ROOT_RE.test(m[2])) set.add(m[1]);
  }
  for (const m of code.matchAll(CLAIM_DESTRUCTURE_RE)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const [src, alias] = p.split(':').map((s) => s.trim());
      if (['oid', 'tid', 'tenantId'].includes(src)) set.add(alias || src);
    }
  }
  return set;
}

/** Identity-carrying parameter names of one declaration. */
function identityParams(code, span) {
  const out = new Set();
  if (span.lparen < 0 || span.rparen <= span.lparen) return out;
  for (const m of code.slice(span.lparen, span.rparen).matchAll(/[A-Za-z_$][\w$]*/g))
    if (IDENTITY_PARAM_RE.test(m[0])) out.add(m[0]);
  return out;
}

/**
 * THE SECOND ROOT FORM — an owner decision made INLINE, with no helper at all:
 *
 *     const { resource } = await ws.item(item.workspaceId, tenantId).read();
 *     if (!resource || resource.tenantId !== tenantId) return null;   // ← this
 *
 * That is a real authorization check and it is how `loadKustoItem`,
 * `createOwnedItem` and half a dozen `_lib`/`_shared` helpers do it. Refusing to
 * recognise it would swap this issue's defect for its mirror image — under-
 * reporting protection, which `generate-route-inventory.mjs`'s own header warns
 * "trains readers to ignore the `public` column".
 *
 * Recognised NARROWLY: the caller's identity (a `claims.{oid,tid,tenantId}`
 * read, a local bound from one, or an identity-named PARAMETER) compared with
 * `===`/`!==` against a stored owner-ish field, where a `return`/`throw` follows
 * within the same neighbourhood. A comparison whose result goes nowhere is not a
 * check — that is the C22 rule, applied to the inline shape.
 */
export function hasInlineOwnerCheck(code, identity, from = 0, to = code.length) {
  const fields = OWNER_FIELDS.join('|');
  // The RAW claim read is always an identity, whether or not anyone bound it to
  // a local first. `workspace-guard.ts::resolveAdminWorkspace` compares
  // `resource.tenantId === session.claims.oid` with no intermediate variable and
  // no identity parameter, so an idents list built only from bindings saw no
  // identity there and the whole admin-workspace family stopped deriving.
  const idents = ['claims\\s*\\??\\.\\s*(?:oid|tid|tenantId)']
    .concat([...identity].map((t) => `${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`))
    .join('|');
  const region = code.slice(from, to);
  const cmp = new RegExp(
    `(?:\\.(?:${fields})\\s*(?:!==|===|!=|==)\\s*[^;\\n]{0,80}?(?:${idents}))` +
      `|(?:(?:${idents})\\s*(?:!==|===|!=|==)\\s*[^;\\n]{0,80}?\\.(?:${fields})(?![\\w$]))`,
    'g',
  );
  for (const m of region.matchAll(cmp)) {
    const before = region.slice(Math.max(0, m.index - 300), m.index);
    if (!/\b(?:if|return|throw)\b[^;{}]*$/.test(before) && !/[?&|!(]\s*[^;{}]*$/.test(before)) continue;
    if (/\b(?:return|throw)\b/.test(region.slice(m.index, m.index + 400))) return true;
  }
  return false;
}

/**
 * Seeds must NAME REAL EXPORTED FUNCTIONS. Returns the failures; empty is good.
 * This is the #2977 control: `assertOwner` was deleted and its name lived on in
 * a comment, and nothing failed.
 */
export function assertSeedsExist(graph) {
  const bad = [];
  for (const { module: mod, symbol } of [...ROOT_AUTHORIZERS, ...SESSION_ROOTS]) {
    const m = graph.modules.get(mod);
    if (!m) bad.push(`${mod} — seeded module is not a tracked console source`);
    else if (!m.decls.has(symbol)) bad.push(`${mod}::${symbol} — seeded symbol is not a function declared in that module`);
  }
  return bad;
}

/**
 * Functions that (transitively) reach `getSession()`. Same import-closure walk
 * as `deriveResolvers`, minus the consumption requirement — see SESSION_ROOTS
 * for why. Route files are excluded for the same reason they are there.
 */
export function deriveSessionFns(graph) {
  const fns = new Set(SESSION_ROOTS.map((r) => keyOf(r.module, r.symbol)));
  for (let pass = 0; pass < 25; pass++) {
    let changed = false;
    for (const mod of graph.modules.values()) {
      if (!mod.decls.size || /(?:^|\/)route\.ts$/.test(mod.file)) continue;
      const names = new Set();
      for (const site of mod.allCalls) {
        if (names.has(site.name)) continue;
        const r = graph.resolveLocal(mod.file, site.name);
        if (r && r.file && fns.has(keyOf(r.file, r.name))) names.add(site.name);
      }
      if (!names.size) continue;
      for (const [name, span] of mod.decls) {
        const k = keyOf(mod.file, name);
        if (fns.has(k)) continue;
        for (const site of callSites(mod.code, span.start, span.end)) {
          if (site.name === name || !names.has(site.name)) continue;
          fns.add(k);
          changed = true;
          break;
        }
      }
    }
    if (!changed) return fns;
  }
  throw new Error('[route-auth-scope] session derivation did not reach a fixpoint in 25 passes');
}

/**
 * A declaration is a RESOLVER when it calls a resolver (or a root) and the
 * answer is CONSUMED — returned, thrown, or tested in a control-flow decision.
 *
 * Consumption is delegated to `_gate-consumption.mjs::findDiscardedGateResults`,
 * the module the C22 work built for exactly this question, rather than
 * re-implemented. Mapping is by LINE (that analyzer reports lines); two calls to
 * the SAME callee on one physical line would be conflated, and the conflation is
 * conservative — the site is treated as discarded, so the caller does NOT become
 * a resolver. Under-claiming here is visible (a route drops to `session-only`
 * and a reviewer asks why); over-claiming is the defect that made #3625.
 */
/**
 * Does this resolver signal refusal by a VALUE the caller must act on?
 *
 * The consumption rule (`_gate-consumption.mjs`) was built for the returned-
 * value gate — `NextResponse | null`, where dropping the answer disables the
 * authorization. Applying it to EVERY resolver is category-wrong, and the error
 * is not small: measured over the tree, 99 routes fell to `session-only` on a
 * "DISCARDED" verdict, and most were mutating or data-returning helpers that
 * authorize INTERNALLY and hand back nothing to short-circuit on —
 * `setClonePublished`, `revokeEmbedCode`, `toggleOrgVisual`,
 * `updateMcpServerTestResult`, `getAssetRegistry` (which returns an
 * already-partition-filtered snapshot), `listOwnedItems` (which returns `[]`,
 * itself the safe answer). Demanding a short-circuit there would under-report
 * protection on ~60 routes, which is the mirror-image defect.
 *
 * So consumption is required only where refusal IS the return value:
 *   `return null` / `return undefined`  — `loadOwnedItem`, `loadKustoItem`
 *   `return { res | resp | denied … }`  — every `_lib/*-scope.ts` guard
 * Derived from the resolver's own body, not listed.
 */
export function returnsRefusal(graph, file, name) {
  const mod = graph.modules.get(file);
  const span = mod?.decls.get(name);
  if (!span) return false;
  const body = mod.code.slice(span.start, span.end);
  return (
    /\breturn\s+null\b/.test(body) ||
    /\breturn\s+undefined\b/.test(body) ||
    /\breturn\s*\{\s*(?:res|resp|denied)\s*[:,}]/.test(body)
  );
}

/**
 * A NARROW SECOND OPINION on a site `findDiscardedGateResults` called discarded.
 *
 * That analyzer is authoritative for the twelve returned-value GATES it was
 * built and tuned for (`RETURNED_VALUE_GATES`). Pointed at the wider derived
 * resolver set it produces FALSE demotions, and a false demotion here is the
 * mirror image of #3625 — under-reporting protection in a security column. Two
 * shapes were MEASURED on the tree, not imagined:
 *
 *   (a) BARE RE-ASSIGNMENT. `items/data-agent/[id]/deploy`:
 *         let item: WorkspaceItem | null;
 *         try { item = await loadOwnedItem(params.id, ITEM_TYPE, oid); } catch { … }
 *         if (!item) return 404;
 *       The prefix carries no declarator, so that analyzer's case (d) misses and
 *       it falls through to "bare expression statement — thrown away". The
 *       answer is consumed two lines later.
 *
 *   (b) RETURNED INSIDE AN OBJECT LITERAL. `workspaces/[id]/image`:
 *         const access = await resolveWorkspaceAccessByOid(oid, id, …);
 *         return { access, session };            // caller: if (!access) 404
 *       `return {` is not `return access`, so the regex does not fire.
 *
 * This rescues ONLY those two shapes, only for sites already flagged, and only
 * inside the enclosing block. It cannot rescue the C22 defect it exists beside:
 * a call whose binding is never mentioned again stays discarded.
 */
function answerRescued(code, callAt, calleeName, limit = code.length) {
  // Walk back to the start of the statement.
  let s = callAt - 1;
  while (s >= 0 && code[s] !== ';' && code[s] !== '{' && code[s] !== '}') s--;
  const prefix = code.slice(s + 1, callAt);
  const m = prefix.match(/([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?$/);
  if (!m) return false;
  const name = m[1];
  // Enclosing block end, so the search cannot wander into another handler.
  const region = code.slice(callAt + calleeName.length, limit);
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\b(?:return|throw)\\s+(?:await\\s+)?${id}\\b`).test(region)) return true;
  if (new RegExp(`[!(]\\s*${id}\\b`).test(region) && /\b(?:return|throw)\b/.test(region)) return true;
  if (new RegExp(`(?:^|[^\\w$.])${id}\\s*(?:\\?[^.]|&&|\\|\\||\\?\\?)`).test(region)) return true;
  // returned as a property of an object literal
  if (new RegExp(`\\breturn\\s*\\{[^{}]*\\b${id}\\b`).test(region)) return true;
  return false;
}

export function deriveResolvers(graph) {
  const resolvers = new Set(ROOT_AUTHORIZERS.map((r) => keyOf(r.module, r.symbol)));
  const discardedCache = new Map(); // `${file}` -> { names:Set, lines:Map<name,Set<line>> }

  const discardedLines = (mod, names) => {
    const wanted = [...names].sort().join(',');
    const hit = discardedCache.get(mod.file);
    if (hit && hit.wanted === wanted) return hit.lines;
    const lines = new Map();
    if (names.size) {
      for (const d of findDiscardedGateResults(mod.raw, [...names])) {
        if (!lines.has(d.gate)) lines.set(d.gate, new Set());
        lines.get(d.gate).add(d.line);
      }
    }
    discardedCache.set(mod.file, { wanted, lines });
    return lines;
  };

  for (let pass = 0; pass < 25; pass++) {
    let changed = false;
    for (const mod of graph.modules.values()) {
      if (!mod.decls.size) continue;
      // A route handler is never imported BY anything, so it can never be a
      // resolver for someone else — and letting `POST` join the set makes the
      // route classifier "resolve" its own declaration site as a call to itself.
      // Route-local helpers still count: the classifier walks the reachable
      // spans INSIDE the route file, so a helper's guard call is seen there.
      if (/(?:^|\/)route\.ts$/.test(mod.file)) continue;

      // (a) the INLINE root form — computed once, on the first pass only,
      //     because it depends on nothing that the fixpoint changes.
      if (pass === 0) {
        const fileTaint = taintedIdentifiers(mod.code);
        for (const [name, span] of mod.decls) {
          const k = keyOf(mod.file, name);
          if (resolvers.has(k)) continue;
          const identity = new Set([...fileTaint, ...identityParams(mod.code, span)]);
          if (hasInlineOwnerCheck(mod.code, identity, span.start, span.end)) {
            resolvers.add(k);
            changed = true;
          }
        }
      }

      // (b) the TRANSITIVE form — calls a resolver and consumes its answer.
      // Local names in this module that currently resolve to a resolver, and
      // whether each SIGNALS REFUSAL BY VALUE (only those need consuming).
      const resolverNames = new Set();
      for (const site of mod.allCalls) {
        if (resolverNames.has(site.name)) continue;
        const r = graph.resolveLocal(mod.file, site.name);
        if (r && r.file && resolvers.has(keyOf(r.file, r.name))) resolverNames.add(site.name);
      }
      if (!resolverNames.size) continue;
      const discarded = discardedLines(mod, resolverNames);
      for (const [name, span] of mod.decls) {
        const k = keyOf(mod.file, name);
        if (resolvers.has(k)) continue;
        for (const site of callSites(mod.code, span.start, span.end)) {
          if (site.name === name || !resolverNames.has(site.name)) continue;
          if (discarded.get(site.name)?.has(lineOf(mod.code, site.at))) continue;
          resolvers.add(k);
          changed = true;
          break;
        }
      }
    }
    if (!changed) return resolvers;
  }
  throw new Error('[route-auth-scope] resolver derivation did not reach a fixpoint in 25 passes');
}

// ───────────────────────────────────────────────────────────────────────────
// 4. ROUTE CLASSIFICATION
// ───────────────────────────────────────────────────────────────────────────

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Names whose SHAPE says "I am an authorization check". A call to one of these
 * that the derivation did not recognise is the U2 unknown: either it authorizes
 * (and must reach a root, or a root must be seeded) or it is misnamed. Guessing
 * `session-only` there is how a new local wrapper silently downgrades a whole
 * route family — which is the inverted form of this issue's own defect.
 */
export const AUTH_SHAPED_NAME_RE =
  /^(?:authorize|authorise|assertOwn|assertAccess|requireOwner|requireWorkspace|requireItem|guard[A-Z]|admit|loadOwned|loadAccessible|resolveItemAccess|resolveWorkspaceAccess|enforceOwner)|(?:ItemScope|AuthzCheck)$/;

/**
 * Names that LOOK authorization-shaped and provably are not — each read at its
 * definition. Kept tiny and justified; a growing list here would be the hand
 * list this module exists to delete.
 */
export const AUTH_SHAPED_EXEMPT = new Map([
  // Admin / capability gates. Real authorization, but the ADMIN column already
  // publishes them; they make no per-ITEM owner claim.
  ['requireTenantAdmin', 'tenant-admin gate — classified by the admin column'],
  ['enforceCapability', 'capability gate — classified by the admin column'],
  ['requireDomainRole', 'domain-role gate — classified by the admin column'],
  // ── read at their definitions while landing #3625 ─────────────────────────
  [
    'guardAdxRequest',
    'app/api/adx/_shared.ts — RETAINED FOR THE EMBEDDED CONTROL, not for the real helper. ' +
      'HISTORY, because this entry asserted the opposite until 2026-08-17 and the generated inventory ' +
      'repeated it to humans: the real wrapper used to resolve its database with ' +
      '`loadKustoItem(itemId, kql-database, oid)` -> `resolveDatabase(item)` and NEVER null-checked, so a ' +
      'caller naming an item they could not reach silently proceeded against the deployment default DB. ' +
      'That was GHSA-v2g8-gp3r-rg4r finding 1, and it is FIXED — the wrapper now runs `authorizeItemWorkspace` ' +
      'and fails closed with a 404. The derivation therefore reaches a seeded root authorizer through its ' +
      'BODY and resolves before U2 is ever consulted, which is why the eleven adx/* navigator routes now ' +
      'publish `owner-scoped` on evidence rather than on this name. This entry is consequently INERT for ' +
      'the shipped code and is kept only because the exempt list is keyed by NAME: the embedded control ' +
      '"session reached through an unnamed wrapper" builds a SYNTHETIC same-named wrapper that performs no ' +
      'authorization, and deleting this entry fails that control as `unknown`.',
  ],
  [
    'admit',
    'lib/azure/capacity-broker-client.ts — CAPACITY admission (an LCU budget broker POST /admit), not caller ' +
      'authorization. The name collides with the `admit*` family in items/_lib/sql-server-scope.ts, which ' +
      'bounds a TARGET rather than a caller and is likewise not an owner check.',
  ],
  [
    'authorizeTrinoCatalogs',
    'lib/azure/trino-authz.ts — a pure decision over (referenced, allowed, configured) catalog sets. It ' +
      'authorizes WHICH FEDERATION CATALOGS a statement may touch, a different axis from item ownership; ' +
      "the caller's allowed set is computed by the route. Real authorization, but not the owner/workspace-ACL " +
      'check this column reports.',
  ],
]);

/** A call whose argument list carries a caller-identity value. */
function argsCarryCallerIdentity(code, lparen, tainted) {
  const close = matchBracket(code, lparen);
  if (close === -1) return false;
  const args = code.slice(lparen + 1, close);
  if (CLAIM_ROOT_RE.test(args)) return true;
  for (const t of tainted) if (new RegExp(`(?:^|[^\\w.$])${t}(?![\\w$])`).test(args)) return true;
  return false;
}

/** Globals a bare call may legitimately name without being importable. */
const KNOWN_GLOBALS = new Set([
  'require', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise', 'Error', 'TypeError', 'RangeError',
  'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'JSON', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'URL', 'URLSearchParams', 'Response', 'Request', 'Headers', 'Blob', 'FormData', 'AbortController',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'atob', 'btoa', 'crypto', 'console', 'process', 'Buffer', 'Intl',
  'import', 'super', 'this', 'typeof', 'void', 'await', 'return', 'if', 'for', 'while', 'switch',
  'catch', 'function', 'new', 'delete', 'yield', 'in', 'of', 'do', 'else', 'try', 'finally', 'case',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'Math', 'globalThis', 'performance', 'AggregateError', 'EvalError',
]);

/**
 * Spans of a route reachable from an exported HTTP verb, through the file's own
 * call graph. A resolver call inside a helper the route never calls is not
 * authorization — and `export const GET = withWorkspaceOwner('x', h)` puts the
 * call inside GET's own declaration, so the wrapper form is covered by the same
 * walk rather than by a special case.
 */
function reachableSpans(mod) {
  const spans = [];
  const seen = new Set();
  const stack = [];
  for (const m of HTTP_METHODS) if (mod.decls.has(m)) stack.push(m);
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const span = mod.decls.get(name);
    if (!span) continue;
    spans.push(span);
    for (const site of callSites(mod.code, span.start, span.end))
      if (mod.decls.has(site.name) && !seen.has(site.name)) stack.push(site.name);
  }
  return spans;
}

const inSpans = (spans, at) => spans.some((s) => at >= s.start && at <= s.end);
/** End of the innermost reachable span containing `at` — the search limit for
 *  `answerRescued`. The immediately-enclosing BLOCK is not enough: the measured
 *  case (`items/data-agent/[id]/deploy`) puts the call inside a `try { … }` and
 *  the `if (!item) return 404` after it. */
const spanEndAt = (spans, at) =>
  spans.filter((s) => at >= s.start && at <= s.end).reduce((best, s) => Math.min(best, s.end), Infinity);

/**
 * Offsets of calls that ARE the control flow rather than a value handed back to
 * it — `export const POST = withBoundSqlServer({…}, handler)`.
 *
 * `findDiscardedGateResults` is built for the RETURNED-VALUE shape and reports a
 * binding whose value is never returned or tested. A verb export is exactly that
 * shape textually and the opposite of it semantically: `POST` is not "an answer
 * the handler ignored", it IS the handler, and the wrapper cannot be bypassed
 * without deleting the call.
 *
 * ITS LIVE POPULATION IS ZERO TODAY, and that is stated rather than left to be
 * discovered. Measured: disabling this function changes 0 of 1,680 route
 * verdicts, because the discard test now runs only on refusal-carrying
 * resolvers (`returnsRefusal`) and no toolkit wrapper returns `null` / `{res}` —
 * `withWorkspaceOwner` ends in `apiNotFound()`, not `null`. A check with no
 * population verifies nothing, so the population lives in an EMBEDDED CONTROL
 * (`STRUCTURAL WRAPPER that is ALSO refusal-carrying`) instead. The day a
 * wrapper gains a `return null`, this is what stops its whole route family
 * reading `session-only`.
 */
function structuralWrapperOffsets(mod) {
  const out = new Set();
  for (const verb of HTTP_METHODS) {
    const span = mod.decls.get(verb);
    if (!span) continue;
    const eq = mod.code.indexOf('=', span.start);
    if (eq === -1 || eq > span.end) continue;
    const m = mod.code.slice(eq + 1, span.end).match(/^\s*(?:await\s+)?/);
    const at = eq + 1 + (m ? m[0].length : 0);
    if (/^[A-Za-z_$]/.test(mod.code[at] ?? '')) out.add(at);
  }
  return out;
}

/**
 * Classify ONE route file.
 *
 * @returns {{ owner:boolean, why:string[], unknowns:{kind:string,name:string,module:string,line:number,note:string}[] }}
 */
export function classifyRouteOwnership(graph, resolvers, file, sessionFns = new Set()) {
  const mod = graph.modules.get(file);
  if (!mod) throw new Error(`[route-auth-scope] ${file} is not in the module graph`);
  const spans = reachableSpans(mod);
  const structural = structuralWrapperOffsets(mod);
  const tainted = taintedIdentifiers(mod.code);
  const why = [];
  const unknowns = [];

  // Which local names resolve to a derived resolver?
  const sites = mod.allCalls;
  const resolverNames = new Set();
  const resolved = new Map();
  for (const site of sites) {
    if (resolved.has(site.name)) continue;
    resolved.set(site.name, graph.resolveLocal(file, site.name));
  }
  for (const [name, r] of resolved) if (r && r.file && resolvers.has(keyOf(r.file, r.name))) resolverNames.add(name);
  // Only resolvers that signal refusal BY VALUE have an answer to discard.
  const mustConsume = new Set(
    [...resolverNames].filter((n) => {
      const r = resolved.get(n);
      return returnsRefusal(graph, r.file, r.name);
    }),
  );

  // Does the route reach `getSession()` through anything at all?
  let session = false;
  let sessionVia = '';
  for (const site of sites) {
    if (session || !inSpans(spans, site.at)) continue;
    const r = resolved.get(site.name);
    if (r && r.file && sessionFns.has(keyOf(r.file, r.name))) {
      session = true;
      sessionVia = `${site.name}() at :${lineOf(mod.code, site.at)} → ${r.file}::${r.name}`;
    }
  }

  const discarded = new Map();
  if (mustConsume.size) {
    for (const d of findDiscardedGateResults(mod.raw, [...mustConsume])) {
      if (!discarded.has(d.gate)) discarded.set(d.gate, new Set());
      discarded.get(d.gate).add(d.line);
    }
  }

  for (const site of sites) {
    const line = lineOf(mod.code, site.at);
    const reachable = inSpans(spans, site.at);
    const r = resolved.get(site.name);

    if (resolverNames.has(site.name)) {
      if (!reachable) continue;
      if (
        !structural.has(site.at) &&
        discarded.get(site.name)?.has(line) &&
        !answerRescued(mod.code, site.at, site.name, spanEndAt(spans, site.at))
      ) {
        why.push(`${site.name}() at :${line} — answer DISCARDED, not an authorization`);
        continue;
      }
      why.push(`${site.name}() at :${line} → ${r.file}::${r.name}`);
      continue;
    }

    // U2 — an authorization-SHAPED helper the derivation does not know.
    // A helper declared IN THIS ROUTE FILE is exempt: its body is inside the
    // reachable spans, so whatever authorization it performs is judged in place
    // rather than by its name. `external-shares/route.ts` declares its own local
    // `loadOwnedItem` doing exactly the inline tenant check.
    if (
      reachable &&
      !mod.decls.has(site.name) &&
      AUTH_SHAPED_NAME_RE.test(site.name) &&
      !AUTH_SHAPED_EXEMPT.has(site.name) &&
      (r?.file || r?.unresolvedModule)
    ) {
      unknowns.push({
        kind: 'unknown-auth-helper',
        name: site.name,
        module: r.file ?? r.unresolvedModule,
        line,
        note:
          `calls \`${site.name}()\` — an authorization-shaped name from a first-party module — but the ` +
          'derivation does not reach a seeded root authorizer through it. Either it authorizes (make it ' +
          `consume ${ROOT_AUTHORIZERS[0].symbol}, or seed a new ROOT_AUTHORIZER) or it does not (rename it, ` +
          'or add it to AUTH_SHAPED_EXEMPT with the reason you read at its definition).',
      });
      continue;
    }

    // U1 — the caller's oid flows into a call this analyzer cannot resolve.
    if (!reachable) continue;
    const lparen = mod.code.indexOf('(', site.at + site.name.length);
    if (lparen === -1) continue;
    if (!argsCarryCallerIdentity(mod.code, lparen, tainted)) continue;
    if (r || mod.decls.has(site.name) || KNOWN_GLOBALS.has(site.name)) continue;
    unknowns.push({
      kind: 'unresolvable-callee',
      name: site.name,
      module: '(unresolved)',
      line,
      note:
        `passes the caller's identity into \`${site.name}()\`, which resolves to no import, no local ` +
        'declaration and no known global — so whether the oid reaches an authorization decision cannot be ' +
        'established. Per deploy-integrity.md R7 this is reported as UNKNOWN rather than guessed.',
    });
  }

  let owner = why.some((w) => w.includes('→'));
  if (!owner) {
    // The route (or a helper it declares) makes the decision itself. Identity =
    // the file's claim-derived locals plus any identity-named parameter of a
    // reachable declaration.
    const identity = new Set(tainted);
    for (const [, span] of mod.decls) for (const p of identityParams(mod.code, span)) identity.add(p);
    for (const span of spans) {
      if (!hasInlineOwnerCheck(mod.code, identity, span.start, span.end)) continue;
      owner = true;
      why.push(
        `inline owner comparison at :${lineOf(mod.code, span.start)} — the caller identity is tested ` +
          'against a stored owner field and the route refuses',
      );
      break;
    }
  }

  // An unknown only MATTERS where it would change the published verdict. A route
  // whose ownership is already established by a derived resolver cannot be
  // "silently downgraded" by an unfamiliar helper name, and failing the whole
  // generator on those would train the reader to ignore the failure — the exact
  // habit `check-external-origin-urls` records under "an annotation that fires
  // when nothing is wrong". So unknowns are reported only for routes the
  // analyzer could NOT otherwise classify as owner-scoped.
  return { owner, session, sessionVia, why, unknowns: owner ? [] : unknowns };
}

// ───────────────────────────────────────────────────────────────────────────
// 5. EMBEDDED CONTROLS — run BEFORE the repo is judged.
//
// A verdict from a scanner that has stopped scanning is not a verdict. The
// controls that matter most here are the NEGATIVE ones: the three roles
// `claims.oid` plays that are NOT authorization. #3625 exists because nothing
// distinguished them, so a control set without them would pass on the very tree
// that produced the defect — which is `guard_keyed_to_the_unsafe_pattern` with
// the controls inheriting the blind spot (#3468 records the same shape).
// ───────────────────────────────────────────────────────────────────────────

/** Stubs for the seeded roots, so a synthetic graph derives exactly as the tree does. */
const STUB_ROOTS = {
  'apps/fiab-console/lib/auth/workspace-access.ts':
    'export async function resolveWorkspaceAccessByOid(oid, workspaceId, opts) { return null; }',
  'apps/fiab-console/lib/auth/session.ts':
    'export function getSession() { return null; }',
  // A canonical resolver one hop from the root — `item-crud.ts`'s real shape.
  'apps/fiab-console/app/api/items/_lib/item-crud.ts': [
    "import { resolveWorkspaceAccessByOid } from '@/lib/auth/workspace-access';",
    'export async function loadOwnedItem(itemId, itemType, tenantId, opts = {}) {',
    '  const item = await readItem(itemId, itemType);',
    '  if (!item) return null;',
    '  const access = await resolveWorkspaceAccessByOid(tenantId, item.workspaceId, opts);',
    '  if (!access) return null;',
    '  return item;',
    '}',
  ].join('\n'),
  // A returned-value item guard — the `_lib/*-scope.ts` shape.
  'apps/fiab-console/app/api/items/_lib/scope.ts': [
    "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
    "import { getSession } from '@/lib/auth/session';",
    'export async function guardItemRequest({ itemId, itemType }) {',
    '  const session = getSession();',
    '  if (!session) return { res: unauthenticated() };',
    '  const item = await loadOwnedItem(itemId, itemType, session.claims.oid, { session });',
    '  if (!item) return { res: notFound() };',
    '  return { ctx: { session, item } };',
    '}',
  ].join('\n'),
  // A structural HOC — the route-toolkit shape.
  'apps/fiab-console/lib/api/route-toolkit.ts': [
    "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
    "import { getSession } from '@/lib/auth/session';",
    'export function withSession(handler) {',
    '  return async (req, ctx) => {',
    '    const session = getSession();',
    '    if (!session) return unauthorized();',
    '    return handler(req, { ...ctx, session });',
    '  };',
    '}',
    'export function withWorkspaceOwner(itemType, optsOrHandler, maybeHandler) {',
    "  const handler = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;",
    '  return withSession(async (req, sctx) => {',
    '    const item = await loadOwnedItem(sctx.params.id, itemType, sctx.session.claims.oid, {});',
    '    if (!item) return notFound();',
    '    return handler(req, { ...sctx, item });',
    '  });',
    '}',
  ].join('\n'),
  // A pure telemetry sink taking the caller oid — role 3, the #3625 defect.
  'apps/fiab-console/lib/finops/query-run.ts':
    'export async function recordQueryRun(input) { await writeMetric(input); }',
};

const CONTROL_ROUTE = 'apps/fiab-console/app/api/items/control/[id]/route.ts';

/** Build a synthetic graph and classify one route in it. */
export function analyzeSynthetic(files, route = CONTROL_ROUTE) {
  const all = { ...STUB_ROOTS, ...files };
  const graph = buildGraph({ repoRoot: '/synthetic', files: Object.keys(all), readFile: (f) => all[f] });
  const seedFailures = assertSeedsExist(graph);
  const resolvers = deriveResolvers(graph);
  const sessionFns = deriveSessionFns(graph);
  return { seedFailures, resolvers, sessionFns, ...classifyRouteOwnership(graph, resolvers, route, sessionFns) };
}

const L = (...lines) => lines.join('\n');

export const CONTROLS = [
  // ── MUST NOT be owner-scoped: the roles of `oid` that are not authorization
  {
    name:
      'INCIDENT #3625 — items/warehouse/[id]/query as it stood on main: the ONLY owner token was a FinOps ' +
      'attribution field (recordQueryRun({ userOid: session.claims.oid })) and nothing authorized the caller',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { recordQueryRun } from '@/lib/finops/query-run';",
        'export async function POST(req, ctx) {',
        '  const { id } = await ctx.params;',
        '  const session = getSession();',
        '  const result = await executeQuery(target, sqlText);',
        "  void recordQueryRun({ userOid: session.claims.oid, itemId: id, itemType: 'warehouse' });",
        '  return json({ ok: true, ...result });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  {
    name: 'oid as a COSMOS PARTITION KEY scopes the query, not the caller’s right to it',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function GET(req, ctx) {',
        '  const session = getSession();',
        '  const c = await container();',
        '  const { resource } = await c.item(ctx.params.id, session.claims.oid).read();',
        '  return json({ ok: true, resource });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  {
    name: 'oid in a LOG line is not an authorization',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function GET(req) {',
        '  const session = getSession();',
        "  console.log('query by', session.claims.oid);",
        '  return json({ ok: true });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  {
    name:
      'PROSE ONLY — the route IMPORTS loadOwnedItem (so the name resolves to a real resolver) and mentions it ' +
      'only in COMMENTS. This is #3639’s measurement byte-for-byte: `azure-sql-database/[id]/query` moved off ' +
      'every code-level owner token and the published row did not change, because both occurrences were in a ' +
      'comment. The import is what makes this control bite — an unimported name resolves to nothing and would ' +
      'pass even with the masking removed',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
        '/**',
        ' * Was loadOwnedItem(id, type, oid); see loadOwnedItem(x, y, z) for the ladder.',
        ' */',
        'export async function GET(req) {',
        '  const session = getSession();',
        '  // historical: loadOwnedItem(id, type, session.claims.oid)',
        '  return json({ ok: !!session });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  {
    name: 'a resolver whose ANSWER IS DISCARDED is not an authorization (C22, one level up)',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
        'export async function POST(req, ctx) {',
        '  const session = getSession();',
        "  const item = await loadOwnedItem(ctx.params.id, 'warehouse', session.claims.oid, {});",
        '  return json({ ok: true });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  {
    name: 'a resolver call inside a helper the route NEVER calls is not the route’s authorization',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
        'async function unusedHelper(id, oid) {',
        "  const item = await loadOwnedItem(id, 'warehouse', oid, {});",
        '  if (!item) return null;',
        '  return item;',
        '}',
        'export async function GET(req) {',
        '  const session = getSession();',
        '  return json({ ok: !!session });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: false },
  },
  // ── MUST be owner-scoped ────────────────────────────────────────────────
  {
    name: 'canonical: loadOwnedItem() with the answer short-circuited',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
        'export async function POST(req, ctx) {',
        '  const session = getSession();',
        "  const item = await loadOwnedItem(ctx.params.id, 'warehouse', session.claims.oid, {});",
        '  if (!item) return notFound();',
        '  return json({ ok: true, item });',
        '}',
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  {
    name:
      'STRUCTURAL WRAPPER — export const GET = withWorkspaceOwner(...). To the returned-value analyzer this ' +
      'looks like a binding nobody consumes; it is the opposite, the wrapper IS the control flow',
    files: {
      [CONTROL_ROUTE]: L(
        "import { withWorkspaceOwner } from '@/lib/api/route-toolkit';",
        "export const GET = withWorkspaceOwner('warehouse', async (req, { item }) => json({ ok: true, item }));",
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  {
    name:
      'STRUCTURAL WRAPPER that is ALSO refusal-carrying — the only shape in which the exemption is ' +
      'load-bearing. THIS CONTROL EXISTS BECAUSE THE LIVE POPULATION IS ZERO: measured on the tree, disabling ' +
      'structuralWrapperOffsets() changes 0 route verdicts, because no toolkit wrapper currently returns ' +
      '`null`/`{res}`. A check with no population verifies nothing (guard_with_zero_population), so the ' +
      'population lives here instead — the day a wrapper gains a `return null`, the exemption is what stops ' +
      'its whole route family reading session-only',
    files: {
      'apps/fiab-console/lib/api/strict-toolkit.ts': L(
        "import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';",
        "import { getSession } from '@/lib/auth/session';",
        'export function withStrictOwner(itemType, handler) {',
        '  return async (req, ctx) => {',
        '    const session = getSession();',
        '    if (!session) return null;',
        '    const item = await loadOwnedItem(ctx.params.id, itemType, session.claims.oid, {});',
        '    if (!item) return null;',
        '    return handler(req, { ...ctx, item });',
        '  };',
        '}',
      ),
      [CONTROL_ROUTE]: L(
        "import { withStrictOwner } from '@/lib/api/strict-toolkit';",
        "export const GET = withStrictOwner('warehouse', async (req, { item }) => json({ ok: true, item }));",
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  {
    name: 'TWO-SHAPE item guard with the denial half returned',
    files: {
      [CONTROL_ROUTE]: L(
        "import { guardItemRequest } from '@/app/api/items/_lib/scope';",
        'export async function POST(req, ctx) {',
        "  const guard = await guardItemRequest({ itemId: ctx.params.id, itemType: 'warehouse' });",
        '  if (guard.res) return guard.res;',
        '  const { item } = guard.ctx;',
        '  return json({ ok: true, item });',
        '}',
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  {
    name: 'INLINE owner comparison in the route — the shape createOwnedItem and loadKustoItem use',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function GET(req, ctx) {',
        '  const session = getSession();',
        '  const ws = await readWorkspace(ctx.params.id);',
        '  if (!ws || ws.tenantId !== session.claims.oid) return notFound();',
        '  return json({ ok: true, ws });',
        '}',
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  {
    name: 'DYNAMIC import of a resolver — the shape catalog/browse and catalog/search use',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function GET(req, ctx) {',
        '  const session = getSession();',
        "  const { loadOwnedItem } = await import('../../_lib/item-crud');",
        "  const item = await loadOwnedItem(ctx.params.id, 'warehouse', session.claims.oid, {});",
        '  if (!item) return notFound();',
        '  return json({ ok: true });',
        '}',
      ),
    },
    expect: { owner: true, session: true, unknown: false },
  },
  // ── SESSION through a wrapper SESSION_RE does not name ──────────────────
  {
    name:
      'session reached through an unnamed wrapper (the guardAdxRequest shape). Without this signal the #3625 ' +
      'fix ITSELF dropped 13 adx/* routes to `public` — a new false claim in the column that matters most',
    files: {
      'apps/fiab-console/app/api/adx/_shared.ts': L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function guardAdxRequest(req) {',
        '  const session = getSession();',
        '  if (!session) return { res: unauthenticated() };',
        '  return { ctx: { oid: session.claims.oid } };',
        '}',
      ),
      [CONTROL_ROUTE]: L(
        "import { guardAdxRequest } from '@/app/api/adx/_shared';",
        'export async function GET(req) {',
        '  const g = await guardAdxRequest(req);',
        '  if (g.res) return g.res;',
        '  return json({ ok: true });',
        '}',
      ),
    },
    // `guardAdxRequest` is auth-SHAPED, so U2 would fire — except it is recorded
    // in AUTH_SHAPED_EXEMPT. So this control also proves the exempt list is
    // wired: delete that entry and this control fails as `unknown`.
    //
    // THE WRAPPER ABOVE IS SYNTHETIC AND DELIBERATELY DOES NOT AUTHORIZE. Do not
    // read it as a description of the shipped helper. The real
    // `app/api/adx/_shared.ts::guardAdxRequest` used to degrade to the default
    // database rather than refusing — that was GHSA-v2g8-gp3r-rg4r finding 1 —
    // and it now runs `authorizeItemWorkspace` and fails closed. What this
    // control fixes in place is the SESSION signal reaching a route through a
    // wrapper `SESSION_RE` does not name; the no-authorization body is what
    // makes it a clean test of that one axis.
    expect: { owner: false, session: true, unknown: false },
  },
  // ── UNKNOWN, not a guess ────────────────────────────────────────────────
  {
    name:
      'U2 — a NEW authorization helper the derivation does not know must FAIL naming its module rather than ' +
      'silently downgrade the route to session-only',
    files: {
      'apps/fiab-console/app/api/items/_lib/brand-new-scope.ts':
        'export async function authorizeBrandNewThing(id) { return { ok: true }; }',
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        "import { authorizeBrandNewThing } from '@/app/api/items/_lib/brand-new-scope';",
        'export async function POST(req, ctx) {',
        '  const session = getSession();',
        '  const a = await authorizeBrandNewThing(ctx.params.id);',
        '  if (!a.ok) return forbidden();',
        '  return json({ ok: true, oid: session.claims.oid });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: true },
  },
  {
    name: 'U1 — the caller oid flows into a callee that resolves to nothing at all',
    files: {
      [CONTROL_ROUTE]: L(
        "import { getSession } from '@/lib/auth/session';",
        'export async function POST(req, ctx) {',
        '  const session = getSession();',
        '  const ok = await mysteryCheck(ctx.params.id, session.claims.oid);',
        '  if (!ok) return forbidden();',
        '  return json({ ok: true });',
        '}',
      ),
    },
    expect: { owner: false, session: true, unknown: true },
  },
];

/** Run every control; returns the failures (empty is good). */
export function selfTest() {
  const failures = [];
  for (const c of CONTROLS) {
    let got;
    try {
      got = analyzeSynthetic(c.files);
    } catch (e) {
      failures.push(`${c.name} — threw ${e.message}`);
      continue;
    }
    if (got.seedFailures.length) {
      failures.push(`${c.name} — the control's own seed stubs did not resolve: ${got.seedFailures.join('; ')}`);
      continue;
    }
    if (got.owner !== c.expect.owner) failures.push(`${c.name} — expected owner=${c.expect.owner}, got ${got.owner}`);
    if (c.expect.session !== undefined && got.session !== c.expect.session)
      failures.push(`${c.name} — expected session=${c.expect.session}, got ${got.session}`);
    const unknown = got.unknowns.length > 0;
    if (c.expect.unknown !== undefined && unknown !== c.expect.unknown)
      failures.push(
        `${c.name} — expected unknown=${c.expect.unknown}, got ${unknown} ` +
          `(${got.unknowns.map((u) => u.name).join(', ') || 'none'})`,
      );
  }
  return failures;
}
