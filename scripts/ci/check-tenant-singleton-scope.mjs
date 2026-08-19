#!/usr/bin/env node
/**
 * GUARDRAIL: tenant-singleton-scope  (merge-blocker, HARD ZERO — #3753)
 * ---------------------------------------------------------------------------
 * RULE. A Cosmos TENANT-SINGLETON document — one whose id is derived from the
 * SAME expression that is its partition key — must be addressed with ONE scope
 * everywhere. If any site keys it with a tenant scope (`tenantScopeId(session)`
 * = `tid || oid`), then NO site may key it with the caller's raw `claims.oid`.
 *
 * WHY (#2635, #2793, #3282, #3747, and a fourth found by this guard's own
 * sweep). The tenant domain document `tenant-settings/domains:<scope>` was keyed
 * by `tenantScopeId()` in `/api/admin/domains` (post-#3282) and by the caller's
 * raw `oid` in five other places. Same document id, two partitioning schemes, so
 * each user silently got a PRIVATE copy — auto-seeded on read with the starter
 * domain list and zero workspaces. It renders fine and means nothing, which is
 * the 0-counts shape `ux-baseline.md` G1 exists to catch. The worst sites were
 * not pages: `lib/auth/dlz-gate.ts` and `/api/admin/domains/assign-workspaces`
 * are AUTHORIZATION paths that resolved the caller's domain tier against a
 * per-user document.
 *
 * The same class had already been fixed once (#3282) WITHOUT a guard that could
 * see it recur, and it recurred twice within two sessions. `#3282`'s guard,
 * `check-domain-store-tenant-scope.mjs`, is keyed to two FUNCTION NAMES
 * (`loadTenantDomains` / `loadOrSeedDomains`) — so the five sites that built the
 * document id inline never entered its population at all. That is the specific
 * evasion this guard closes: it is keyed to the DOCUMENT, not to a function
 * name and not to a spelling of `claims.oid`.
 *
 * SCOPE — WHY "id derived from the partition key" IS THE DISCRIMINATOR.
 * It is what separates this bug class from its sibling. Two shapes exist:
 *
 *   (a) id DERIVED from the pk  — `c.item(scope, scope)` / `c.item(`k:${scope}`,
 *       scope)`. One document per scope: a tenant singleton. Keying it two ways
 *       forks the tenant's state. THIS guard.
 *   (b) id INDEPENDENT of the pk — `workspacesContainer().item(workspaceId,
 *       callerOid)`. A per-RESOURCE document in an owner-partitioned container,
 *       where an oid partition key is the DESIGN and the failure mode is the
 *       owner-only read of #2941/#2942/#2947 (a non-creator 404s). That is
 *       `check-owner-only-workspace-guard.mjs`'s job, and it ratchets ~68 of
 *       them. Folding (b) into this guard would fire on every one of those
 *       legitimate sites and get the whole rule muted.
 *
 * RESOLUTION LADDER — this guard must survive indirection, because indirection
 * is exactly what defeated its predecessor. A partition-key expression is
 * resolved through, in order:
 *   1. local `const`/`let` chains (≤12 hops), INCLUDING object destructuring
 *      (`const { oid } = s.claims`) — beats hoisting into a variable, which is
 *      repo convention (`lib/audit/audit-scope.ts`, `lib/auth/item-access.ts`);
 *   2. single-`return` helper inlining — beats `domainsDocId(t)` returning
 *      `` `domains:${t}` ``, which is how the domains doc id is really built;
 *   2b. RETURN-VALUE flow through a multi-statement local helper — beats a
 *      helper with a guard clause (`domainScopeFor`), where step 2 gives up;
 *   3. INTER-PROCEDURAL parameter flow — when the key is a parameter of the
 *      enclosing function, the guard classifies it by the union of what every
 *      call site of that function passes, recursively (≤4 hops). This is what
 *      catches #3747: the mesh route's `s.claims.oid` reached the document three
 *      frames down, through `getDomainMesh` into `loadOrSeedDomains`.
 *
 * UNJUDGED IS NOT CLEAN, AND NEITHER IS PARTIALLY READ. Two distinct blind
 * spots are counted, listed on every run, and pressed against one pinned ceiling
 * (`MAX_BLINDNESS`):
 *   • UNJUDGED     — a partition key the ladder could not take to ground.
 *   • PARTIALLY READ — a key that WAS classified, but from a conduit some of
 *     whose call sites could not be read. An absence ("no caller-oid caller was
 *     seen") is only as good as the read behind it.
 * An earlier revision tracked only the first, and only on one branch, so an
 * unreadable call site feeding a resolved conduit was counted NOWHERE. Every
 * summary line states both counts; there is no output in which "0 findings"
 * appears without its denominator.
 *
 * WHAT THIS GUARD DOES NOT SEE (stated so it is not mistaken for coverage):
 *   • WRITE paths. It matches `<handle>.item(id, pk)` only, so a singleton
 *     written via `c.items.upsert({ id: `domains:${oid}`, tenantId: oid })`
 *     never enters the population. The read-side rule still catches the
 *     resulting disagreement at the first reader, but not at the writer.
 *   • Containers reached by any binding form other than
 *     `const x = [(]await xContainer()` — e.g. a handle passed in as a parameter.
 *
 * SELF-DEFENCE. Fails if the population collapses (no documents, or no site
 * classified `scope` at all) — a matcher that has drifted off the code must not
 * report a pass on an empty population.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const CONSOLE_DIRS = ['apps/fiab-console/app', 'apps/fiab-console/lib'];

/**
 * Documents that are KNOWN to be split and are NOT fixable by a read-path
 * change — re-keying them strands the existing document, which is the migration
 * hazard #3282 called out.
 *
 * AN EXEMPTION IS A PINNED SITE LIST, NEVER A WHOLE DOCUMENT GROUP (#3753
 * review). An earlier revision exempted the group by key alone, so a brand-new
 * `tsC.item(session.claims.oid, session.claims.oid)` could be added to
 * `admin/overview` and the run still printed "Zero undeclared splits" — only an
 * internal tally moved. A document this PR itself reports as a LIVE unfixed
 * split could therefore accumulate arbitrarily many new caller-oid readers with
 * the build green, which is the accumulating-baseline failure
 * `check-owner-only-workspace-guard` avoids by pinning its 68 sites.
 *
 * So each entry names the EXACT caller-oid sites it covers. A site not in the
 * list is an undeclared split and FAILS, even inside an exempted document.
 *
 * `issue` MUST name a tracked issue — a placeholder is rejected at load time by
 * {@link assertKnownSplitIssues}, because "each entry must name a tracked issue"
 * enforced only by a comment is exactly the kind of rule this repo has watched
 * go quiet.
 */
const KNOWN_SPLIT = new Map([
  [
    'tenantSettingsContainer :: <S>',
    {
      issue: '#3793',
      why:
        'The tenant-settings singleton is WRITTEN by /api/admin/tenant-settings under ' +
        'the caller oid and READ by /api/admin/chargeback under tenantScopeId(), so the ' +
        '"Per-domain chargeback tagging" toggle an admin saves is never the one ' +
        'chargeback reads. Unlike the domains doc this cannot be fixed read-side: ' +
        'loadOrSeed() SEEDS defaults, so re-keying silently resets every saved toggle. ' +
        'Needs a migration, not a drive-by. Found by this guard, filed from #3753.',
      /** The caller-oid sites this exemption covers. Anything else FAILS. */
      sites: [
        'apps/fiab-console/app/api/admin/tenant-settings/route.ts',
        'apps/fiab-console/app/api/copilot/complete/route.ts',
        'apps/fiab-console/lib/apps/runtime-flag.ts',
      ],
    },
  ],
]);

/** A placeholder issue reference makes the exemption unaccountable — reject it. */
function assertKnownSplitIssues() {
  const bad = [];
  for (const [key, v] of KNOWN_SPLIT) {
    if (!/^#\d+$/.test(String(v.issue || ''))) bad.push(`${key} — issue "${v.issue}" is not a #NNNN reference`);
  }
  if (bad.length) {
    console.error(
      '::error::tenant-singleton-scope: a KNOWN_SPLIT entry does not name a tracked issue. An exemption whose ' +
        'justification cannot be looked up is an exemption nobody will ever revisit.',
    );
    for (const b of bad) console.error(`::error::  ${b}`);
    process.exit(1);
  }
}
assertKnownSplitIssues();

/**
 * Ceiling on this rule's own BLINDNESS: unclassifiable partition keys PLUS call
 * sites of a classified conduit that the parameter walk could not read.
 *
 * Pinned at the measured value, not a round number with headroom — this is a
 * shrink-only RATCHET, the same mechanic `check-owner-only-workspace-guard`
 * uses, not a budget to spend. A refactor that moves five more call sites behind
 * an unresolvable indirection fails the build instead of quietly shrinking the
 * population this rule can actually see.
 *
 * IT IS DELIBERATELY HIGH, AND THAT IS THE HONEST NUMBER. An earlier revision
 * reported 15 — but only because `classify()` was handing out a DECIDED-SAFE
 * verdict to any expression that merely lacked an identity token, so an
 * unresolved helper call (`domainScopeFor(tenantId)`) and a member expression
 * (`ctx.scope`) were counted as clean rather than as unread. Tightening that to
 * "positively established as a non-identity key, or else unread" moved 120
 * expressions out of the safe bucket and into this count. The rule did not get
 * blinder; the previous number was wrong.
 */
const MAX_BLINDNESS = 134;

const CALLER_OID = /\bclaims\s*\.\s*oid\b/;
const TENANT_SCOPE = /\btenantScopeId\s*\(/;
/** An env-supplied Entra tenant id IS a tenant scope (background workers). */
const ENV_TID = /process\s*\.\s*env\s*\.\s*AZURE_TENANT_ID\b/;
/**
 * An INLINED tenant scope: `claims.tid || claims.oid` — the literal body of
 * `tenantScopeId()`. This must be checked BEFORE {@link CALLER_OID}, or a
 * correct hand-rolled scope reads as the caller's oid and the guard cries wolf.
 * It is not hypothetical: `/api/admin/domains/sync` carried exactly this as a
 * private `tenantScope(claims)` helper, and the resolver's single-return
 * inlining (ladder step 2) surfaced its body here. (#3753 replaced that copy
 * with the shared helper, but the classifier must still be right — the next
 * hand-rolled copy must be judged on WHAT IT COMPUTES, not on whether someone
 * spelled it with the canonical name.)
 */
const INLINE_TID_FALLBACK = /\.\s*tid\b[^&|]*\|\|[^&|]*\.\s*oid\b/;

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '--', ...CONSOLE_DIRS], {
      encoding: 'utf8',
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && /\.tsx?$/.test(l) && !l.includes('__tests__'));
  } catch (e) {
    console.error(
      `::error::tenant-singleton-scope: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

/** Split a call's arguments at depth 1, respecting nesting and string literals. */
function argsOf(text, openIdx) {
  let depth = 0;
  let cur = '';
  let str = null;
  const out = [];
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (str) {
      cur += ch;
      if (ch === str && text[i - 1] !== '\\') str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        out.push(cur.trim());
        return out;
      }
    } else if (ch === ',' && depth === 1) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    if (depth >= 1) cur += ch;
  }
  return out;
}

/**
 * Ladder steps 1 + 2: local binding chains and single-`return` helper inlining.
 *
 * DESTRUCTURING IS PART OF STEP 1, not a nicety. `const { oid } = s.claims;`
 * then `f(oid)` is existing repo convention (`lib/audit/audit-scope.ts`,
 * `lib/auth/item-access.ts` — the latter an authorization module), and an
 * earlier revision of this guard resolved only `const X = <expr>`. A planted
 * destructuring of the #3747 regression therefore produced output BYTE-IDENTICAL
 * to the clean tree: not flagged, and not even counted as unjudged. Both the
 * shorthand `{ oid }` and the renaming `{ oid: scope }` forms are followed.
 */
function resolveLocal(text, expr, seen = new Set()) {
  let e = String(expr).trim();
  for (let hop = 0; hop < 12; hop++) {
    if (/^[A-Za-z_$][\w$]*$/.test(e)) {
      if (seen.has(e)) return e;
      seen.add(e);
      const m = new RegExp(`(?:const|let|var)\\s+${e}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(text);
      if (m) {
        e = m[1].trim().replace(/^await\s+/, '');
        continue;
      }
      // Object destructuring: `const { oid } = X` / `const { oid: scope } = X`.
      const d = new RegExp(
        `(?:const|let|var)\\s*\\{([^}]*)\\}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`,
        'g',
      );
      let dm;
      let bound = null;
      while ((dm = d.exec(text))) {
        for (const raw of dm[1].split(',')) {
          const part = raw.trim();
          if (!part) continue;
          const [srcRaw, aliasRaw] = part.split(':').map((x) => x.trim());
          const src = srcRaw.replace(/=.*$/, '').trim();
          const alias = (aliasRaw || src).replace(/=.*$/, '').trim();
          if (alias === e) bound = { src, from: dm[2].trim().replace(/^await\s+/, '') };
        }
      }
      if (bound) {
        e = `${bound.from}.${bound.src}`;
        continue;
      }
      return e;
    }
    const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
    if (call) {
      const fn = call[1];
      if (seen.has(`fn:${fn}`)) return e;
      seen.add(`fn:${fn}`);
      const decl = new RegExp(
        `function\\s+${fn}\\s*\\(([^)]*)\\)\\s*(?::[^{]*)?\\{\\s*return\\s+([^;]+);?\\s*\\}`,
      ).exec(text);
      if (!decl) return e;
      const params = decl[1]
        .split(',')
        .map((p) => p.replace(/[:=].*$/s, '').trim())
        .filter(Boolean);
      const args = argsOf(e, e.indexOf('('));
      let body = decl[2].trim();
      params.forEach((p, i) => {
        if (args[i] !== undefined) {
          body = body.replace(new RegExp(`(?<![\\w.$])${p}(?![\\w$])`, 'g'), args[i]);
        }
      });
      e = body;
      continue;
    }
    return e;
  }
  return e;
}

/** Every named function/arrow declaration in a file, with its parameter names. */
function functionsOf(text) {
  const out = [];
  let m;
  const fnRe = /(?:(export)\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
  while ((m = fnRe.exec(text))) {
    out.push({
      name: m[2],
      exported: !!m[1],
      params: argsOf(text, m.index + m[0].length - 1).map((p) =>
        p.replace(/[:=].*$/s, '').trim().replace(/^\.\.\./, ''),
      ),
      start: m.index,
    });
  }
  const arrowRe = /(?:(export)\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g;
  while ((m = arrowRe.exec(text))) {
    out.push({
      name: m[2],
      exported: !!m[1],
      params: argsOf(text, m.index + m[0].length - 1).map((p) =>
        p.replace(/[:=].*$/s, '').trim().replace(/^\.\.\./, ''),
      ),
      start: m.index,
    });
  }
  // OBJECT-LITERAL AND CLASS METHODS — `async getGroup(id) {` (#3753 review).
  // Without these, a partition key that is a METHOD parameter has no enclosing
  // function the walk can attribute it to, so every one of its call sites lands
  // in the unreadable bucket. `lib/scim/store.ts` and `lib/azure/domains-client.ts`
  // are written this way, and they alone accounted for most of the blindness.
  const RESERVED = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else',
    'try', 'with', 'typeof', 'await', 'new', 'delete', 'void', 'yield', 'import',
  ]);
  const methodRe = /(?:^|\n)[ \t]+(?:(?:public|private|protected|static)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = methodRe.exec(text))) {
    if (RESERVED.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    // A method declaration's `)` is followed by `{` (optionally via a return type).
    const after = text.slice(open);
    const close = after.indexOf(')');
    if (close === -1) continue;
    if (!/^\s*(?::[^{;]*)?\{/.test(after.slice(close + 1))) continue;
    out.push({
      name: m[1],
      exported: true, // reachable through the object/class it belongs to
      params: argsOf(text, open).map((p) => p.replace(/[:=].*$/s, '').trim().replace(/^\.\.\./, '')),
      start: m.index,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

const enclosing = (fns, pos) => {
  let best = null;
  for (const f of fns) {
    if (f.start < pos) best = f;
    else break;
  }
  return best;
};

/** The `{ … }` body text of the declaration starting at `declStart`. */
function bodyOf(text, declStart) {
  const open = text.indexOf('{', declStart);
  if (open === -1) return '';
  let depth = 0;
  let str = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (str) {
      if (ch === str && text[i - 1] !== '\\') str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

/**
 * Ladder step 2b — RETURN-VALUE flow through a MULTI-statement local function.
 *
 * Step 2 inlines only a `function f(x) { return <expr>; }` one-liner. A helper
 * with a guard clause defeats it, and that is not hypothetical: `item-crud.ts`'s
 * `domainScopeFor` is exactly that shape, so `loadTenantDomains(await
 * domainScopeFor(tenantId))` was unreadable — meaning a REVERT of the very fix
 * #3753 made there produced output identical to the fixed tree. A rule that
 * cannot see its own PR being undone is the #3282 failure it exists to end.
 *
 * Every `return` in the callee is classified; a returned PARAMETER is mapped to
 * the actual argument at this call site and re-resolved (recursing into
 * parameter flow when that argument is itself a parameter). `null`/`undefined`
 * returns are ignored — declining to produce a key is not a key.
 */
function classifyLocalCall(file, expr, sitePos, depth, seen) {
  const empty = { classes: new Set(), unresolved: 1, witness: new Map() };
  if (depth > 4) return empty;
  const e = String(expr).trim().replace(/^await\s+/, '');
  const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (!m) return empty;
  const fn = m[1];
  const key = `call:${file}::${fn}`;
  if (seen.has(key)) return { classes: new Set(), unresolved: 0, witness: new Map() };
  seen.add(key);

  const text = SRC.get(file);
  const decl = (FNS.get(file) || []).find((f) => f.name === fn);
  if (!text || !decl) return empty;

  const body = bodyOf(text, decl.start);
  const returns = [...body.matchAll(/\breturn\s+([^;\n]+)/g)].map((r) => r[1].trim());
  if (returns.length === 0) return empty;

  const args = argsOf(e, e.indexOf('('));
  const classes = new Set();
  const witness = new Map();
  let unresolved = 0;
  for (const raw of returns) {
    if (/^(?:null|undefined)\b/.test(raw)) continue; // no key produced
    let r = resolveLocal(text, raw);
    const pi = decl.params.indexOf(r);
    if (pi >= 0 && args[pi] !== undefined) r = resolveLocal(text, args[pi]);
    const c = classify(r);
    if (c) {
      classes.add(c);
      if (!witness.has(c)) witness.set(c, `${file}:${text.slice(0, decl.start).split('\n').length}`);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(r)) {
      // The callee returned one of ITS parameters and the actual argument is
      // itself a parameter of the function containing THIS CALL SITE. Resolve
      // from the call site's position — using the callee's own position instead
      // (an earlier revision did) walks back into the callee's parameter list,
      // finds nothing, and silently drops the chain.
      const enc = enclosing(FNS.get(file) || [], sitePos);
      const j = enc ? enc.params.indexOf(r) : -1;
      if (enc && j >= 0) {
        const sub = classifyParam(file, enc.name, j, depth + 1, seen);
        for (const x of sub.classes) {
          classes.add(x);
          if (!witness.has(x)) witness.set(x, sub.witness.get(x) || `${file}`);
        }
        unresolved += sub.unresolved;
        continue;
      }
    }
    unresolved++;
  }
  return { classes, unresolved, witness };
}

/** Local handle variable -> the `xxxContainer()` accessor it was awaited from. */
function containerBindings(text) {
  const map = new Map();
  // The optional `(` and type annotation matter: `const c = (await xContainer())
  // as unknown as T;` is already in the tree (access-governance/repartition), and
  // without them that handle is not recognised as a container at all — so every
  // `.item()` on it silently leaves the population (#3753 review, nit 7).
  const re =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\(?\s*await\s+([A-Za-z_$][\w$]*Container)\s*\(/g;
  let m;
  while ((m = re.exec(text))) map.set(m[1], m[2]);
  return map;
}

/**
 * 'scope' | 'oid' | 'other' | null for a fully-resolved expression.
 *
 * 'other' means DECIDED-SAFE, and it is deliberately NARROW. An earlier revision
 * decided 'other' for anything that merely lacked an identity token, which made
 * the guard affirmatively judge two unresolvable shapes SAFE:
 *
 *     const ctx = { scope: s.claims.oid };  c.item(id, ctx.scope)   // member expr
 *     c.item(id, domainScopeFor(tenantId))                          // helper call
 *
 * Both produced output byte-identical to a clean tree — not flagged, and not
 * even counted as unjudged. The second is worse than hypothetical: it is the
 * exact shape of a site THIS guard's own PR fixed, so a revert of that fix would
 * have gone unnoticed. That is the #3282 failure mode (a rule that cannot see
 * its own regression) reproduced inside the rule written to end it.
 *
 * So 'other' is now granted ONLY to expressions whose value is positively
 * established as a non-identity key: a plain literal, a generated id, or a value
 * rooted in the REQUEST (a route param / body / query field). Anything the
 * ladder could not take to ground — a bare identifier, a member expression, an
 * un-inlined call — is `null`, i.e. UNJUDGED: counted, printed, and pressed
 * against the ceiling.
 */
const REQUEST_ROOTED = /^(?:await\s+)?(?:params|body|json|searchParams|req|request|ctx)\b[.[]/;
const LITERAL_OR_GENERATED =
  /^(?:['"`]|crypto\s*\.|Date\s*\.|`[^`]*`$|String\s*\(|Number\s*\()/;

function classify(expr) {
  const e = String(expr).trim();
  if (TENANT_SCOPE.test(e) || ENV_TID.test(e) || INLINE_TID_FALLBACK.test(e)) return 'scope';
  if (CALLER_OID.test(e)) return 'oid';
  // Any residual identity token keeps it unjudged rather than silently clearing.
  if (/\b(?:oid|tid|claims|tenantScope|principalId|userId|scope)\b/i.test(e)) return null;
  // Positively-established non-identity keys.
  if (REQUEST_ROOTED.test(e) || LITERAL_OR_GENERATED.test(e)) return 'other';
  if (/^process\s*\.\s*env\s*\./.test(e)) return 'other';
  // A bare identifier the ladder could not follow, a member expression, or an
  // un-inlined call: NOT decided. The caller may still try parameter flow.
  return null;
}

/**
 * TENANT-SINGLETON test. Returns the normalized doc-id template when the id is
 * derived from the SAME expression as the partition key, else null.
 *
 * BOTH SIDES ARE RESOLVED BEFORE COMPARISON, and that is load-bearing. An
 * earlier revision compared the id's `${…}` interpolations verbatim against the
 * RESOLVED partition key, and a planted mutation walked straight through it:
 *
 *     const who = s.claims.oid;
 *     c.item(mkDomainsId(who), who)     // mkDomainsId(t) => `domains:${t}`
 *
 * The id inlined to `` `domains:${who}` `` while the key resolved to
 * `s.claims.oid`; `who !== s.claims.oid`, so the site was judged "not a
 * singleton" and SKIPPED — silently, with the guard reporting a clean tree.
 * That is the same failure the rule exists to prevent (a defect that is not
 * flagged because it is not looked at), so the interpolations get the full
 * resolution ladder too.
 */
function singletonTemplate(text, idExpr, pkExpr, pkResolved) {
  const norm = (s) => String(s).replace(/\s+/g, '');
  const pkForms = new Set([norm(pkExpr), norm(pkResolved)]);
  if (pkForms.has(norm(idExpr))) return '<S>';

  const lit = /^`([^`]*)`$/.exec(String(idExpr).trim());
  if (!lit) return null;
  const interps = [...lit[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
  if (interps.length === 0) return null;
  const sameAsKey = (raw) => pkForms.has(norm(raw)) || pkForms.has(norm(resolveLocal(text, raw)));
  if (!interps.every(sameAsKey)) return null;
  return lit[1].replace(/\$\{[^}]*\}/g, '<S>');
}

// ---------------------------------------------------------------------------
// Load the tree
// ---------------------------------------------------------------------------
const files = trackedFiles();
const SRC = new Map();
for (const rel of files) {
  try {
    SRC.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
  } catch {
    /* unreadable file — skipped; the population self-check below catches a collapse */
  }
}
const FNS = new Map();
for (const [rel, text] of SRC) FNS.set(rel, functionsOf(text));

/**
 * Files whose call sites of `fnName` may legitimately be attributed to the
 * declaration in `declFile`.
 *
 * MODULE-AWARE ON PURPOSE. An earlier revision searched every file for
 * `fnName(`, which is wrong for any common helper name and produced a FALSE
 * POSITIVE immediately: three separate private `loadDoc` helpers exist
 * (`function-registry-store.ts`, `attribute-groups/route.ts`,
 * `lakehouse/interop/route.ts`). Two are caller-oid scoped, so the third — whose
 * four real call sites all pass `tenantScopeId(s)` — was reported as split. A
 * guard that cries wolf on correct code is a guard that gets muted, which is the
 * failure mode this whole file exists to avoid.
 *
 *   - a NON-exported function is visible only in its own file;
 *   - an exported one is visible in its own file plus any file importing that
 *     identifier from a specifier whose basename matches the declaring module.
 */
function callerFilesFor(declFile, fnName, exported) {
  if (!exported) return [declFile];
  const base = declFile.replace(/^.*\//, '').replace(/\.tsx?$/, '');
  const out = [declFile];
  const importRe = new RegExp(
    `import\\s*(?:type\\s*)?\\{[^}]*(?<![\\w$])${fnName}(?![\\w$])[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
  );
  for (const [f, t] of SRC) {
    if (f === declFile) continue;
    const m = importRe.exec(t);
    if (m && m[1].replace(/^.*\//, '').replace(/\.tsx?$/, '') === base) out.push(f);
  }
  return out;
}

/**
 * Ladder step 3 — classify a function PARAMETER by the union of what its call
 * sites pass, recursively.
 *
 * Returns the set of classes, how many call-site arguments could not be
 * classified, and a WITNESS per class: the `file:line` of a call site that
 * actually supplied it. Without the witness the finding names only the shared
 * helper (`domain-registry.ts:194`) and not the route that fed it the wrong
 * scope, which is the line an engineer has to change.
 */
function classifyParam(declFile, fnName, paramIdx, depth, seen) {
  if (depth > 4) return { classes: new Set(), unresolved: 1, witness: new Map() };
  const key = `${declFile}::${fnName}#${paramIdx}`;
  if (seen.has(key)) return { classes: new Set(), unresolved: 0, witness: new Map() };
  seen.add(key);

  const decl = (FNS.get(declFile) || []).find((f) => f.name === fnName);
  const classes = new Set();
  const witness = new Map();
  let unresolved = 0;
  let callSites = 0;
  const callRe = new RegExp(`(?<![\\w.$])${fnName}\\s*\\(`, 'g');
  for (const cf of callerFilesFor(declFile, fnName, decl ? decl.exported : true)) {
    const ct = SRC.get(cf);
    if (!ct) continue;
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(ct))) {
      // Skip the declaration itself.
      if (/\b(?:function|const|let|var)\s+$/.test(ct.slice(Math.max(0, m.index - 30), m.index))) continue;
      const args = argsOf(ct, m.index + m[0].length - 1);
      if (args.length <= paramIdx) continue;
      callSites++;
      const at = `${cf}:${ct.slice(0, m.index).split('\n').length}`;
      const a = resolveLocal(ct, args[paramIdx]);
      const c = classify(a);
      if (c) {
        classes.add(c);
        if (!witness.has(c)) witness.set(c, at);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(a)) {
        const enc = enclosing(FNS.get(cf) || [], m.index);
        const j = enc ? enc.params.indexOf(a) : -1;
        if (enc && j >= 0) {
          const sub = classifyParam(cf, enc.name, j, depth + 1, seen);
          for (const x of sub.classes) {
            classes.add(x);
            if (!witness.has(x)) witness.set(x, sub.witness.get(x) || at);
          }
          unresolved += sub.unresolved;
          continue;
        }
      }
      // Ladder step 2b — the argument is a call to a local helper with a guard
      // clause (`await domainScopeFor(tenantId)`), which step 2's single-`return`
      // inlining cannot flatten. Classify by the helper's RETURNS.
      if (/^(?:await\s+)?[A-Za-z_$][\w$]*\s*\(/.test(a)) {
        // A FRESH `seen` for the return-flow walk. The outer set is keyed by
        // (file, fn, paramIdx) and is already populated with the conduit chain
        // we arrived through; reusing it makes the callee's own chain look
        // already-visited and silently returns "no classes", which downgrades a
        // real finding to an unreadable site. Depth still bounds the recursion.
        const sub = classifyLocalCall(cf, a, m.index, depth + 1, new Set());
        if (sub.classes.size > 0 || sub.unresolved === 0) {
          for (const x of sub.classes) {
            classes.add(x);
            if (!witness.has(x)) witness.set(x, sub.witness.get(x) || at);
          }
          unresolved += sub.unresolved;
          continue;
        }
      }
      unresolved++;
    }
  }
  if (callSites === 0) unresolved++;
  return { classes, unresolved, witness };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
const docs = new Map();
let judged = 0;
let unjudged = 0;
/**
 * Call sites of a resolved conduit that the parameter-flow walk could NOT read
 * (#3753 review). These are not sites in the sweep's own population — they are
 * holes in the evidence BEHIND a site that did get classified. Counted and
 * printed separately, and pressed against the same ceiling, so an absence
 * ("no caller-oid caller was seen") can never rest on a read that silently
 * skipped callers.
 */
let partialReads = 0;
const partialSites = [];

for (const [rel, text] of SRC) {
  const binds = containerBindings(text);
  if (binds.size === 0) continue;
  const fns = FNS.get(rel) || [];
  const re = /([A-Za-z_$][\w$]*)\.item\(/g;
  let m;
  while ((m = re.exec(text))) {
    const container = binds.get(m[1]);
    if (!container) continue;
    const args = argsOf(text, m.index + m[1].length + '.item'.length);
    if (args.length < 2) continue;

    const pkR = resolveLocal(text, args[1]);
    const idR = resolveLocal(text, args[0]);
    const tpl = singletonTemplate(text, idR, args[1], pkR);
    if (tpl === null) continue; // per-resource doc — owner-only ratchet's job

    const key = `${container} :: ${tpl}`;
    if (!docs.has(key)) docs.set(key, { scope: [], oid: [], other: [], unknown: [] });
    const bucket = docs.get(key);
    const row = {
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      pk: args[1],
      pkR,
    };

    let cls = classify(pkR);
    if (!cls && /^[A-Za-z_$][\w$]*$/.test(pkR)) {
      const enc = enclosing(fns, m.index);
      const j = enc ? enc.params.indexOf(pkR) : -1;
      if (enc && j >= 0) {
        const r = classifyParam(rel, enc.name, j, 0, new Set());
        row.via = `${enc.name}#${j}`;
        row.witness = r.witness;
        // WHAT THE PARAMETER UNION MEANS (#3753 review).
        //
        // `oid` / `both` are CONCLUSIONS — a caller-oid call site was actually
        // observed, so an additionally-unreadable sibling cannot un-find it.
        //
        // `scope` / `other` are ABSENCES — "no caller-oid site was seen" — which
        // is only as good as the read behind it. An earlier revision consulted
        // `r.unresolved` on the `'other'` branch ALONE, so a conduit with one
        // resolved tenant-scoped caller and one UNREADABLE caller was recorded as
        // fully tenant-scoped and the unreadable caller was counted NOWHERE:
        // neither judged nor unjudged. That made this file's own headline promise
        // — "UNJUDGED IS NOT CLEAN … there is no output in which '0 findings'
        // appears without its denominator" — false at the inter-procedural layer,
        // i.e. the layer that exists because #3747's caller oid sat three frames
        // from the document.
        //
        // The fix COUNTS the unread callers; it does not discard the positive
        // evidence. Dropping the whole site to unjudged was tried and is WORSE:
        // the disagreement rule needs a tenant-scoped anchor to have something to
        // disagree WITH, so erasing every partially-read `scope` site would have
        // stopped the guard detecting the #3747 regression it already catches.
        // Both facts are true and both are reported: a tenant-scoped caller was
        // observed, AND n sibling callers could not be read.
        const hasScope = r.classes.has('scope');
        const hasOid = r.classes.has('oid');
        if (r.unresolved > 0) {
          partialReads += r.unresolved;
          partialSites.push({ file: rel, line: row.line, via: row.via, n: r.unresolved, key });
        }
        if (hasScope && hasOid) cls = 'both';
        else if (hasOid) cls = 'oid';
        else if (hasScope) cls = 'scope';
        else if (r.classes.has('other') && r.unresolved === 0) cls = 'other';
      }
    }

    if (cls === 'scope') {
      bucket.scope.push(row);
      judged++;
    } else if (cls === 'oid') {
      bucket.oid.push(row);
      judged++;
    } else if (cls === 'other') {
      bucket.other.push(row);
      judged++;
    } else if (cls === 'both') {
      // One conduit reached by BOTH scopes — a split all by itself.
      bucket.scope.push(row);
      bucket.oid.push(row);
      judged++;
    } else {
      bucket.unknown.push(row);
      unjudged++;
    }
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
const findings = [];
const knownSplits = [];
for (const [key, b] of [...docs].sort()) {
  if (!(b.scope.length && b.oid.length)) continue;
  const exempt = KNOWN_SPLIT.get(key);
  if (!exempt) {
    findings.push([key, b]);
    continue;
  }
  // An exemption covers ONLY its pinned sites. A caller-oid reader that is not
  // on the list is an undeclared split even inside an exempted document — which
  // is what stops a live, unfixed split from quietly accumulating new readers.
  const allowed = new Set(exempt.sites);
  const undeclared = b.oid.filter((r) => !allowed.has(r.file));
  if (undeclared.length > 0) findings.push([key, { ...b, oid: undeclared, unlisted: true }]);
  knownSplits.push([key, b, exempt]);
}

// --- self-defence: a matcher that drifted off the code must not pass ---------
if (docs.size === 0) {
  console.error(
    '::error::tenant-singleton-scope: found ZERO tenant-singleton documents. This repo has dozens, so the matcher ' +
      'has drifted off the code (container accessors renamed? .item() call shape changed?). Refusing to report a ' +
      'pass on an empty population.',
  );
  process.exit(1);
}
if (judged === 0) {
  console.error(
    '::error::tenant-singleton-scope: classified ZERO partition keys across ' +
      `${docs.size} document group(s). The resolution ladder is no longer resolving anything — refusing to report ` +
      'a pass.',
  );
  process.exit(1);
}
const scopeSites = [...docs.values()].reduce((n, b) => n + b.scope.length, 0);
const otherSites = [...docs.values()].reduce((n, b) => n + b.other.length, 0);
if (scopeSites === 0) {
  console.error(
    '::error::tenant-singleton-scope: not a single site was classified as tenant-scoped. `tenantScopeId()` is the ' +
      'signal this rule is built on; if nothing matches it, the rule cannot detect a disagreement. Refusing to ' +
      'report a pass.',
  );
  process.exit(1);
}

for (const [key, b, exempt] of knownSplits) {
  console.log(`::warning::tenant-singleton-scope: KNOWN SPLIT (not clean) ${key} — ${exempt.issue}: ${exempt.why}`);
  for (const r of b.oid) {
    const w = r.witness?.get('oid');
    const pinned = exempt.sites.includes(r.file) ? 'pinned' : 'NOT PINNED';
    console.log(`    caller-oid keyed [${pinned}]: ${r.file}:${r.line}${w ? ` (supplied at ${w})` : ''}`);
  }
}

const blindness = unjudged + partialReads;
if (blindness > MAX_BLINDNESS) {
  console.error(
    `::error::tenant-singleton-scope: ${blindness} expression(s) this rule could not read (${unjudged} unclassifiable ` +
      `partition keys + ${partialReads} unreadable call site(s) behind a classified conduit), above the pinned ` +
      `ceiling of ${MAX_BLINDNESS}. Sites this rule cannot read are sites it cannot police, so a GROWING ` +
      'un-readable population is itself the failure — it is how a rule ends up reporting "no findings" over a ' +
      'population it no longer covers. Either restore the resolvability (thread the scope explicitly instead of ' +
      'through an unresolvable indirection) or raise the ceiling deliberately, in a PR that says why.',
  );
  for (const [key, b] of [...docs].sort()) {
    for (const r of b.unknown) console.error(`::error file=${r.file},line=${r.line}::UNJUDGED ${key} — pk=${r.pk}`);
  }
  for (const p of partialSites) {
    console.error(
      `::error file=${p.file},line=${p.line}::PARTIALLY READ ${p.key} — ${p.n} call site(s) of ${p.via} unreadable`,
    );
  }
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `::error::tenant-singleton-scope: ${findings.length} tenant-singleton document(s) are addressed with BOTH the ` +
      "tenant scope and the CALLER's raw object id. Same document id, two partitions: every user silently gets a " +
      'PRIVATE copy, and any authorization that reads it decides on a per-user document. Use tenantScopeId(session) ' +
      'everywhere, or read through the document\'s own store helper. See #3282, #3747, #3751, #3753.',
  );
  for (const [key, b] of findings) {
    console.error(`::error::  ${key}`);
    for (const r of b.scope) {
      const w = r.witness?.get('scope');
      console.error(
        `::error file=${r.file},line=${r.line}::  tenant-scoped   ${key}` +
          `${r.via ? ` (via ${r.via}${w ? `, e.g. from ${w}` : ''})` : ''}`,
      );
    }
    for (const r of b.oid) {
      const w = r.witness?.get('oid');
      console.error(
        `::error file=${r.file},line=${r.line}::  CALLER-OID keyed ${key} — pk=${r.pk}` +
          `${r.via ? ` (via ${r.via})` : ''}` +
          `${w ? ` — the raw oid is supplied at ${w}; THAT is the line to change` : ''}`,
      );
    }
    for (const r of b.unknown) {
      console.error(`::error file=${r.file},line=${r.line}::  UNJUDGED in a SPLIT document ${key} — pk=${r.pk}`);
    }
  }
  process.exit(1);
}

// Everything this rule could NOT read is printed on EVERY run, pass or fail. A
// count in a summary line is easy to stop reading; the list is what lets a
// reviewer check that these really are per-resource keys and not findings
// hiding in the gap.
for (const [key, b] of [...docs].sort()) {
  for (const r of b.unknown) {
    console.log(`::notice file=${r.file},line=${r.line}::UNJUDGED (not clean, not a finding) ${key} — pk=${r.pk}`);
  }
}
for (const p of partialSites) {
  console.log(
    `::notice file=${p.file},line=${p.line}::PARTIALLY READ (not clean) ${p.key} — ` +
      `${p.n} call site(s) of ${p.via} unreadable; the classification below rests on the callers that WERE read`,
  );
}

console.log(
  `tenant-singleton-scope OK — ${docs.size} tenant-singleton document group(s) across ${files.length} tracked ` +
    `file(s). Partition keys: ${judged} judged (${scopeSites} tenant-scoped, ` +
    `${[...docs.values()].reduce((n, b) => n + b.oid.length, 0)} caller-oid, ${otherSites} per-resource) + ` +
    `${unjudged} UNJUDGED = ${judged + unjudged} total; plus ${partialReads} unreadable call site(s) behind ` +
    `classified conduits. Blindness ${blindness}/${MAX_BLINDNESS}. ` +
    `${knownSplits.length} known-split document(s) carried with a pinned site list. Zero undeclared splits.`,
);
