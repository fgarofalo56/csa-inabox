#!/usr/bin/env node
/**
 * GUARDRAIL: every PostgreSQL Flexible Server deploy consults the cloud-parity
 * quota gate.  (merge-blocker — story 3449d)
 *
 * PHYSICAL-LINES-OK: judges .bicep, which has no backslash line continuation —
 * multi-line module headers are folded here by brace/paren scanning, not by \.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `platform/fiab/bicep/main.bicep` designates `postgresQuotaAvailable` as THE
 * gate for `Microsoft.DBforPostgreSQL/flexibleServers`, and both sovereign param
 * files pin it false (cited by NAME, not by line — a line number goes stale the
 * next time either file is edited, and a stale citation is a small claim that
 * has quietly stopped being true):
 *
 *     params/gcc-high.bicepparam  param postgresQuotaAvailable = bool(readEnvironmentVariable('LOOM_POSTGRES_QUOTA_AVAILABLE', 'false'))
 *     params/il5.bicepparam       (identical)
 *
 * Three of the four Postgres consumers in admin-plane/main.bicep routed through
 * it. The fourth — the Weave ontology AGE store — did not: its activation var
 * was `weaveOntologyBackendEnabled && !weavePgSuppliedByDlz`, and nothing else.
 * So a GCC-High deploy attempted a flexible server on a path that never consults
 * the gate its own param file pins false, and that leaf failed:
 *
 *     ParameterOutOfRange -> The value of the 'Version' should be in: []
 *     (resource psql-loom-weave-default-dcmt6cqoezlgs)
 *
 * RECEIPT for that string, so it is citable rather than asserted: GitHub Actions
 * run 32019775757 (`deploy-fiab-gcch`, 2026-08-17, conclusion=failure) — one of
 * three unclassified ARM leaves in that run. Per the Gov access rule a Gov
 * observation comes from an Actions run, never local `az`.
 *
 * An EMPTY permitted-version set is satisfied by no value at all, so no
 * `postgresVersion` could have cleared it — the tempting "bump 16 to 15" fix was
 * provably not a fix.
 *
 * WHY the set is empty is NOT established, here or anywhere in this repo. The
 * ARM message does not say, and that run's own failure classifier recorded the
 * leaf as `ParameterOutOfRange -> unknown` ("No cause is asserted ... Unknown
 * fails closed"). Note in particular that the two Gov param files do NOT claim a
 * quota restriction: both state, with Microsoft Learn citations, that PostgreSQL
 * Flexible Server IS available in Azure Government, and that their `false` is a
 * deliberate posture hold pending an ACR mirror of `apache/airflow` plus a
 * private endpoint for the Airflow metadata server. Any message this file prints
 * must therefore point at those files rather than supply a cause of its own
 * (deploy-integrity.md R7).
 *
 * Reading the four call sites side by side, three correct and one not, is
 * exactly the review that does not happen reliably. Hence a guard.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * R1  Every `module` invocation inside platform/fiab/bicep/** whose target
 *     (transitively, through the module graph) declares a
 *     `Microsoft.DBforPostgreSQL/flexibleServers` resource must have an
 *     activation condition whose IDENTIFIER CLOSURE — resolved through that
 *     file's own `var` declarations — reaches `postgresQuotaAvailable`.
 *     An UNCONDITIONAL invocation of such a module is a violation: it cannot
 *     consult anything.
 *
 *     R1 is satisfied at the FIRST file in the chain that gates. A parent that
 *     invokes an already-gated child is not required to re-gate — the gate lives
 *     in the child, and demanding it twice would flag every correct caller.
 *
 * R2  If a file satisfies R1 via a PARAM named `postgresQuotaAvailable` that it
 *     DECLARES ITSELF (params carry defaults — landing-zone/main.bicep defaults
 *     it `true`), then every invocation of THAT file must pass
 *     `postgresQuotaAvailable:` in its params object, AND the value passed must
 *     itself reach the gate in the CALLER's scope. Without R2 the gate is real
 *     and defaulted away: deleting one of the three forwards in main.bicep
 *     silently re-arms the failure on one topology while the other two keep the
 *     guard green. That "delete one of several, not the only one" shape is the
 *     blind spot this repo keeps paying for.
 *
 *     R2 checks the VALUE, not just the key, because `postgresQuotaAvailable:
 *     true` is runtime-identical to omitting the forward and was measurably
 *     accepted by the key-only form (rework 2026-08-18). Keying a guard to the
 *     presence of a safe-looking token rather than to the mismatch is the repo's
 *     `csa_loom_guard_keyed_to_the_unsafe_pattern` shape.
 *
 *     R2 also fails when a gated target has ZERO call sites while a resolver-
 *     independent textual scan finds some — that disagreement means the module-
 *     path resolver drifted, and a per-target zero must not be absorbed by a
 *     sibling target still having callers (the aggregate check it replaces only
 *     fired when EVERY gated target lost EVERY caller).
 *
 * R3  A module target that does not resolve to a tracked .bicep file is a HARD
 *     FAILURE, not a skip. Before this rule such an invocation was dropped in
 *     silence, so any drift in the path resolver — or a hand-written probe with
 *     one `..` too few — read as "nothing to judge" instead of "I could not
 *     tell". Every one of the 177 module invocations in the judged tree resolves
 *     today, so this rule has no legitimate population to suppress.
 *
 * ── HONESTY BOUNDARIES (what a PASS here does NOT claim) ────────────────────
 *   • PG-declaring modules are discovered REPO-WIDE, but only invocations whose
 *     CALLER lives under platform/fiab/bicep/** are judged, because
 *     `postgresQuotaAvailable` is a concept of that deploy tree and does not
 *     exist in deploy/bicep/**. Any PG-declaring bicep outside the judged tree
 *     is PRINTED on every run, never silently dropped. A judged file that
 *     invokes one of them IS judged on that invocation — measured, not asserted:
 *     an unconditional `module launderProbe
 *     '../../../../../deploy/bicep/DLZ/modules/geoanalytics.bicep'` added to
 *     landing-zone/main.bicep FAILS this guard (exit 1). Combined with R3, the
 *     seam cannot be used to launder an ungated server.
 *   • A PG module with ZERO invocations is out-of-band by construction; whether
 *     it SHOULD be wired in is check-bicep-sync.mjs's ORPHAN_ALLOWLIST, not
 *     this file's. It is printed, not judged.
 *   • Reaching the gate proves the condition CONSULTS it, and a gate reference
 *     that is NEGATED — `!postgresQuotaAvailable`, directly or through a var
 *     that resolves to it — is rejected. What is still NOT proven is the rest of
 *     the boolean algebra: a negation applied to a compound sub-expression that
 *     does not immediately precede the reference (`!(x && postgresQuotaAvailable)`)
 *     or a disjunction that makes the gate non-load-bearing
 *     (`postgresQuotaAvailable || somethingElse`) would still pass. Closing
 *     those needs an exhaustive evaluation of the resolved condition, which this
 *     file does not do.
 *
 * ── FAIL-CLOSED (a scan that stopped scanning is not a verdict) ─────────────
 * Hard failure, before any repo verdict, when: the embedded controls disagree;
 * zero bicep files are discovered; zero PG-declaring modules are found; zero
 * invocations of them are found; a module header cannot be parsed; a module
 * target does not resolve to a tracked .bicep file (R3); a forwarded
 * `postgresQuotaAvailable:` value has a shape this file cannot read whole; a
 * gated target has zero resolved call sites while a textual scan finds some; or
 * a condition names an identifier that is neither a `var` nor a `param` of its
 * file (unresolvable ⇒ refuse to guess).
 *
 * Usage:
 *   node scripts/ci/check-postgres-quota-gate.mjs              # CHECK
 *   node scripts/ci/check-postgres-quota-gate.mjs --self-test  # controls only
 *
 * Tests: node --test scripts/ci/__tests__/postgres-quota-gate.test.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The tree where `postgresQuotaAvailable` exists and invocations are judged. */
export const JUDGED_PREFIX = 'platform/fiab/bicep/';

/** The gate every PG deploy must reach. */
export const GATE = 'postgresQuotaAvailable';

/** A real resource declaration, not a mention in a description string. */
const PG_RESOURCE = /^[^\S\n]*resource\s+\w+\s+'Microsoft\.DBforPostgreSQL\/flexibleServers@/m;

/** Bicep reserved words / literals that are never a var or param reference. */
const LITERALS = new Set(['true', 'false', 'null', 'if', 'for', 'in', 'toLower', 'toUpper']);

/**
 * Read a bicep file with CRLF normalised to LF.
 *
 * `platform/fiab/bicep/**` is pinned `text eol=lf` in .gitattributes, but the
 * repo-wide PG discovery also reads trees that are NOT pinned, and those arrive
 * CRLF on a Windows checkout with `core.autocrlf=true`. Several patterns here end
 * in `$`, and JS `.` does not match `\r` — so on a CRLF source `var X = …$` would
 * fail to match and the declaration would silently vanish from the parse. A
 * matcher that goes quiet on a line-ending difference is precisely the
 * `csa_loom_crlf_makes_mutation_needles_silently_noop` shape. Normalising once,
 * at the single read point, keeps every offset this file computes consistent.
 *
 * @param {string} abs
 * @returns {string}
 */
export function readSource(abs) {
  return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS (exported for the unit test)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Blank out `//` and block comments, preserving byte offsets and line count so
 * every later index still points at the real source position.
 *
 * String literals are NOT removed — the resource TYPE is itself a quoted string
 * (`resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@…'`) — but they are
 * skipped over, so a `//` inside a string cannot start a comment and a comment
 * that mentions the gate cannot satisfy anything. That second half is the #2977
 * mechanism (a guard satisfied by a name surviving only as prose).
 *
 * @param {string} src
 * @returns {string} same length as `src`
 */
export function blankComments(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (src.startsWith("'''", i)) {
      const end = src.indexOf("'''", i + 3);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[i] === "'") {
      i += 1;
      while (i < src.length && src[i] !== "'" && src[i] !== '\n') {
        i += src[i] === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i += 1) if (out[i] !== '\n') out[i] = ' ';
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Blank single-quoted string CONTENT, preserving offsets. Used before brace and
 * paren scanning, because bicep interpolation (`'${take(x, 63)}.${suffix}'`)
 * puts real braces and parens inside string literals.
 *
 * @param {string} src
 * @returns {string} same length as `src`
 */
export function blankStrings(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src[i] !== "'") {
      i += 1;
      continue;
    }
    i += 1;
    while (i < src.length && src[i] !== "'" && src[i] !== '\n') {
      const step = src[i] === '\\' ? 2 : 1;
      for (let k = 0; k < step && i + k < src.length; k += 1) out[i + k] = ' ';
      i += step;
    }
    i += 1;
  }
  return out.join('');
}

/** @returns {boolean} does this bicep source DECLARE a PG flexible server? */
export function declaresPostgres(src) {
  return PG_RESOURCE.test(blankComments(src));
}

/**
 * Every top-level `var NAME = <body>` in a bicep file. A body runs to the next
 * top-level declaration, so multi-line ternaries and objects are captured whole.
 *
 * @param {string} clean comment-blanked source
 * @returns {Map<string,string>}
 */
export function parseVars(clean) {
  const lines = clean.split('\n');
  const isTopLevelDecl = (l) =>
    /^(?:var|param|output|resource|module|type|func|import|targetScope|metadata|extension|@)/.test(l);
  const vars = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^var\s+([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[2];
    for (let j = i + 1; j < lines.length && !isTopLevelDecl(lines[j]); j += 1) body += `\n${lines[j]}`;
    vars.set(m[1], body);
  }
  return vars;
}

/**
 * Every top-level `param NAME` in a bicep file.
 *
 * @param {string} clean comment-blanked source
 * @returns {Set<string>}
 */
export function parseParams(clean) {
  const names = new Set();
  for (const m of clean.matchAll(/^param\s+([A-Za-z_]\w*)\s/gm)) names.add(m[1]);
  return names;
}

/**
 * Identifiers an expression READS, each with whether a logical NOT applies to it.
 *
 * Property accesses (`x.y`, `x.?y`) yield only the root, function names are
 * dropped (an identifier immediately followed by `(`), string content is
 * dropped, and literals are dropped.
 *
 * `negated` is computed by scanning BACKWARDS from the identifier over
 * whitespace and open parens, counting `!`. That reads `!gate`, `! gate` and
 * `!(gate && x)` as negated, and an even count (`!!gate`) as not. A negation
 * applied to a compound sub-expression that does not immediately precede the
 * identifier — `!(x && gate)` — is NOT detected; that limitation is stated in
 * the honesty boundaries rather than papered over.
 *
 * @param {string} expr
 * @returns {{name: string, negated: boolean}[]}
 */
export function identifierReads(expr) {
  const noStrings = blankStrings(expr);
  const noProps = noStrings.replace(/\.\s*\??\s*[A-Za-z_]\w*/g, (m) => ' '.repeat(m.length));
  const out = [];
  for (const m of noProps.matchAll(/[A-Za-z_]\w*/g)) {
    const after = noProps.slice(m.index + m[0].length);
    if (/^\s*\(/.test(after)) continue; // function call
    if (LITERALS.has(m[0])) continue;
    let k = m.index - 1;
    let bangs = 0;
    while (k >= 0 && /[\s(!]/.test(noProps[k])) {
      if (noProps[k] === '!') bangs += 1;
      k -= 1;
    }
    out.push({ name: m[0], negated: bangs % 2 === 1 });
  }
  return out;
}

/**
 * Identifiers an expression READS (names only).
 *
 * @param {string} expr
 * @returns {string[]}
 */
export function identifiersOf(expr) {
  return identifierReads(expr).map((r) => r.name);
}

/**
 * Does `expr` reach {@link GATE} through this file's own vars?
 *
 * @param {string} expr the module's activation condition
 * @param {Map<string,string>} vars
 * @param {Set<string>} params
 * @returns {{reached: boolean, viaParam: boolean, negatedOnly: boolean, unresolved: string[]}}
 *   `viaParam` is true when the gate was reached as a PARAM of this file, which
 *   is what triggers R2 (a param carries a default and can be silently omitted
 *   by a caller). `negatedOnly` is true when the gate WAS reached but every path
 *   that reaches it applies a logical NOT — i.e. the module deploys precisely
 *   when the gate says not to, which is the one-character inversion a
 *   presence-only check cannot tell from a correct gate.
 */
export function reachesGate(expr, vars, params) {
  const seen = new Set();
  const unresolved = [];
  let reached = false;
  let viaParam = false;
  let positiveReach = false;
  const visit = (e, depth, negated) => {
    if (depth > 24) throw new Error(`var resolution exceeded depth 24 — refusing to guess: ${e.slice(0, 80)}`);
    for (const { name: id, negated: here } of identifierReads(e)) {
      const eff = negated !== here; // XOR: nested NOTs cancel
      if (id === GATE) {
        reached = true;
        if (!eff) positiveReach = true;
        if (params.has(id)) viaParam = true;
        continue;
      }
      const key = `${id}|${eff ? '1' : '0'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (vars.has(id)) {
        visit(vars.get(id), depth + 1, eff);
        continue;
      }
      if (params.has(id)) continue; // a param of this file; nothing further to resolve
      unresolved.push(id);
    }
  };
  visit(expr, 0, false);
  return { reached, viaParam, negatedOnly: reached && !positiveReach, unresolved };
}

/**
 * Every `module NAME 'path' = …` in a file, with its activation condition and
 * the source offsets of its params body.
 *
 * The header is folded by scanning to the `{` that opens the body, so a header
 * split across lines is read whole rather than half-read. A header that cannot
 * be parsed THROWS — an unparsed shape is a hard failure, never a skip.
 *
 * @param {string} src raw bicep source
 * @param {string} rel repo-relative path, for error messages
 * @returns {{name: string, target: string, condition: string|null, line: number, bodyStart: number, bodyEnd: number}[]}
 */
export function parseModules(src, rel) {
  const clean = blankStrings(blankComments(src));
  const out = [];
  for (const m of blankComments(src).matchAll(/^[^\S\n]*module\s+([A-Za-z_]\w*)\s+'([^'\n]+)'\s*=/gm)) {
    const name = m[1];
    const target = m[2];
    const line = src.slice(0, m.index).split('\n').length;
    // Fold the header: scan from the `=` to the `{` that opens the params body.
    let i = m.index + m[0].length;
    let depthParen = 0;
    let depthBracket = 0;
    let bodyStart = -1;
    while (i < clean.length) {
      const c = clean[i];
      if (c === '(') depthParen += 1;
      else if (c === ')') depthParen -= 1;
      else if (c === '[') depthBracket += 1;
      else if (c === ']') depthBracket -= 1;
      else if (c === '{' && depthParen === 0) {
        bodyStart = i;
        break;
      }
      i += 1;
    }
    if (bodyStart === -1) {
      throw new Error(`${rel}:${line}: cannot find the params body of module ${name} — unparsed shape, refusing to skip it`);
    }
    const header = clean.slice(m.index, bodyStart);
    let condition = null;
    const ifAt = /\bif\s*\(/.exec(header);
    if (ifAt) {
      let k = ifAt.index + ifAt[0].length;
      let d = 1;
      const start = k;
      while (k < header.length && d > 0) {
        if (header[k] === '(') d += 1;
        else if (header[k] === ')') d -= 1;
        k += 1;
      }
      if (d !== 0) {
        throw new Error(`${rel}:${line}: unbalanced if(...) on module ${name} — unparsed shape, refusing to skip it`);
      }
      condition = header.slice(start, k - 1);
    }
    // Balanced-brace scan for the params body (strings already blanked).
    let d = 0;
    let j = bodyStart;
    for (; j < clean.length; j += 1) {
      if (clean[j] === '{') d += 1;
      else if (clean[j] === '}') {
        d -= 1;
        if (d === 0) break;
      }
    }
    if (d !== 0) {
      throw new Error(`${rel}:${line}: unbalanced params body on module ${name} — unparsed shape, refusing to skip it`);
    }
    out.push({ name, target, condition, line, bodyStart, bodyEnd: j + 1, depthBracket });
  }
  return out;
}

/**
 * The value a module invocation passes for `postgresQuotaAvailable:`, or null
 * when the key is absent.
 *
 * The value runs to the end of its line, extended while parens/brackets/braces
 * are unbalanced so a `union(...)` or object value is read whole. If the NEXT
 * line continues the expression (a leading `?`, `:`, or a binary operator — the
 * multi-line-ternary shape), the value cannot be read whole and this THROWS
 * rather than judging a truncated expression. An unparsed shape is a hard
 * failure here for the same reason it is in {@link parseModules}.
 *
 * @param {string} src raw bicep source of the CALLER
 * @param {{name: string, bodyStart: number, bodyEnd: number, line: number}} mod
 * @param {string} rel repo-relative path, for error messages
 * @returns {string|null}
 */
export function forwardedGateValue(src, mod, rel = '<src>') {
  const clean = blankComments(src);
  const body = clean.slice(mod.bodyStart, mod.bodyEnd);
  const m = new RegExp(`^[^\\S\\n]*${GATE}\\s*:`, 'm').exec(body);
  if (!m) return null;
  const lines = body.slice(m.index + m[0].length).split('\n');
  let value = lines[0];
  let i = 0;
  const depth = (s) => {
    let d = 0;
    for (const c of blankStrings(s)) {
      if (c === '(' || c === '[' || c === '{') d += 1;
      else if (c === ')' || c === ']' || c === '}') d -= 1;
    }
    return d;
  };
  while (depth(value) > 0 && i + 1 < lines.length) {
    i += 1;
    value += `\n${lines[i]}`;
  }
  const next = (lines[i + 1] ?? '').trim();
  if (/^(\?|:|&&|\|\||==|!=|\?\?|\+)/.test(next)) {
    throw new Error(
      `${rel}:${mod.line}: the ${GATE}: value passed to module ${mod.name} continues on the next line ` +
        `(${JSON.stringify(next.slice(0, 40))}) — this file cannot read that shape whole, and judging a ` +
        'truncated expression would be a guess. Refusing to skip it.',
    );
  }
  return value;
}

/**
 * Does this module invocation pass `postgresQuotaAvailable:` AT ALL?
 *
 * Kept separate from the VALUE check so the two failure modes report
 * differently: an omitted forward and a hardcoded one are both violations, but
 * they are different mistakes and a reviewer needs to know which they made.
 *
 * @param {string} src
 * @param {{name: string, bodyStart: number, bodyEnd: number, line: number}} mod
 * @returns {boolean}
 */
export function forwardsGate(src, mod) {
  const body = blankComments(src).slice(mod.bodyStart, mod.bodyEnd);
  return new RegExp(`^[^\\S\\n]*${GATE}\\s*:`, 'm').test(body);
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDED CONTROLS — proven on every run, BEFORE the repo is judged.
// The repo can legitimately be clean; a matcher that has drifted off bicep
// produces the same empty result, so the analyzer is exercised on fixtures
// whose verdict is known (`guard_with_zero_population_needs_embedded_control`).
// ─────────────────────────────────────────────────────────────────────────────

const PG_MODULE_FIXTURE = [
  "param location string",
  "resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {",
  '  name: 3449',
  '}',
].join('\n');

export const CONTROLS = [
  {
    name: 'gated through a var chain -> clean',
    src: [
      'param postgresQuotaAvailable bool = true',
      "var ov = toLower(string(loomBackends.?weavePostgres ?? ''))",
      "var allowed = ov == 'enabled' ? true : (ov == 'disabled' ? false : postgresQuotaAvailable)",
      'var active = enabledFlag && allowed',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['loomBackends', 'enabledFlag'],
    expect: { reached: true, viaParam: true },
  },
  {
    name: 'the 3449d defect: condition never reaches the gate -> flagged',
    src: [
      'param postgresQuotaAvailable bool = true',
      'var active = enabledFlag && !suppliedByDlz',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag', 'suppliedByDlz'],
    expect: { reached: false },
  },
  {
    name: 'the gate named only in a COMMENT -> flagged (#2977 shape)',
    src: [
      'param postgresQuotaAvailable bool = true',
      '// gated on postgresQuotaAvailable, honest, reviewed',
      'var active = enabledFlag',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag'],
    expect: { reached: false },
  },
  {
    name: 'the gate named only in a STRING -> flagged',
    src: [
      'param postgresQuotaAvailable bool = true',
      "var note = 'postgresQuotaAvailable'",
      'var active = enabledFlag',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag'],
    expect: { reached: false },
  },
  {
    name: 'unconditional invocation -> flagged',
    src: ["module pg 'pg.bicep' = {", '  params: {}', '}'].join('\n'),
    extraParams: [],
    expect: { unconditional: true },
  },
  {
    name: 'multi-line header with a for-loop and interpolated name -> parsed, gated',
    src: [
      'param postgresQuotaAvailable bool = true',
      "module pg 'pg.bicep' = [for (id, i) in subs: if (useMulti && postgresQuotaAvailable) {",
      "  name: 'dlz-${i}-pg'",
      '  params: {',
      '    postgresQuotaAvailable: postgresQuotaAvailable',
      '  }',
      '}]',
    ].join('\n'),
    extraParams: ['subs', 'useMulti'],
    expect: { reached: true, viaParam: true, forwards: true },
  },
  {
    name: 'a caller that OMITS the forward -> R2 flags it',
    src: [
      "module lz 'lz.bicep' = if (deployLandingZones) {",
      '  params: {',
      '    weaveOntologyEnabled: weaveOntologyEnabled',
      '  }',
      '}',
    ].join('\n'),
    extraParams: ['deployLandingZones', 'weaveOntologyEnabled'],
    expect: { forwards: false, forwardedValue: null },
  },
  {
    // The rework finding: `postgresQuotaAvailable: true` is runtime-identical to
    // omitting the forward, and the key-only check accepted it. Measured on the
    // real repo before the fix: mutating main.bicep:1824 to a literal `true`
    // printed PASS, exit 0, with R2 still reporting "3 call site(s) checked".
    name: 'a caller that HARDCODES the forward to true -> the value does not reach the gate',
    src: [
      'param postgresQuotaAvailable bool = true',
      "module lz 'lz.bicep' = if (deployLandingZones) {",
      '  params: {',
      '    postgresQuotaAvailable: true',
      '  }',
      '}',
    ].join('\n'),
    extraParams: ['deployLandingZones'],
    expect: { forwards: true, forwardedValue: ' true', valueReaches: false },
  },
  {
    name: 'a caller that forwards the real param -> the value reaches the gate',
    src: [
      'param postgresQuotaAvailable bool = true',
      "module lz 'lz.bicep' = if (deployLandingZones) {",
      '  params: {',
      '    postgresQuotaAvailable: postgresQuotaAvailable',
      '  }',
      '}',
    ].join('\n'),
    extraParams: ['deployLandingZones'],
    expect: { forwards: true, valueReaches: true },
  },
  {
    // The polarity inversion the honesty boundary used to only disclose. One
    // character re-arms the Gov break AND strips the server from Commercial.
    name: 'a condition that NEGATES the gate -> reached, but negatedOnly',
    src: [
      'param postgresQuotaAvailable bool = true',
      'var active = enabledFlag && !postgresQuotaAvailable',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag'],
    expect: { reached: true, viaParam: true, negatedOnly: true },
  },
  {
    name: 'negation THROUGH a var chain is still negation',
    src: [
      'param postgresQuotaAvailable bool = true',
      'var allowed = postgresQuotaAvailable',
      'var active = enabledFlag && !allowed',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag'],
    expect: { reached: true, viaParam: true, negatedOnly: true },
  },
  {
    name: 'a DOUBLE negation is not a negation',
    src: [
      'param postgresQuotaAvailable bool = true',
      'var allowed = !postgresQuotaAvailable',
      'var active = enabledFlag && !allowed',
      "module pg 'pg.bicep' = if (active) {",
      '  params: {}',
      '}',
    ].join('\n'),
    extraParams: ['enabledFlag'],
    expect: { reached: true, viaParam: true, negatedOnly: false },
  },
];

/**
 * How many control checks the last {@link runControls} actually executed.
 * Reported instead of a hard-coded literal so the "N checks agreed" line cannot
 * drift into claiming a count nobody counted (deploy-integrity.md R7).
 */
export const CONTROL_STATS = { ran: 0 };

/** @returns {string[]} control failures, empty when every fixture agrees */export function runControls() {
  const failures = [];
  CONTROL_STATS.ran = 0;
  const check = (ok, msg) => {
    CONTROL_STATS.ran += 1;
    if (!ok) failures.push(msg);
  };
  if (!declaresPostgres(PG_MODULE_FIXTURE)) {
    check(false, 'declaresPostgres() did not recognise a real flexibleServers resource declaration');
  } else check(true);
  if (declaresPostgres("@description('deploys Microsoft.DBforPostgreSQL/flexibleServers')\nparam x bool = true")) {
    check(false, 'declaresPostgres() matched a DESCRIPTION STRING — it would pass on prose');
  } else check(true);
  if (declaresPostgres("// resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {")) {
    check(false, 'declaresPostgres() matched a COMMENTED-OUT resource declaration');
  } else check(true);
  // The CRLF control. `parseVars` ends in `$`, and `.` does not match `\r`, so an
  // un-normalised CRLF source loses its var declarations silently — the parse
  // reports nothing rather than reporting a problem. This proves the hazard is
  // real (raw CRLF loses the var) AND that readSource()'s normalisation closes it.
  //
  // The fixture deliberately carries a line AFTER the var: the first draft ended
  // ON the var line, which therefore had no trailing `\r`, parsed fine, and the
  // control failed by being unable to reproduce the hazard at all. That failure
  // is the whole point of running controls before judging anything.
  const crlfSrc = [`param ${GATE} bool = true`, `var active = flag && ${GATE}`, 'output x bool = active'].join('\r\n');
  check(
    !parseVars(blankComments(crlfSrc)).has('active'),
    'the CRLF control did not reproduce the hazard — it can no longer prove the normalisation matters',
  );
  const lfSrc = crlfSrc.replace(/\r\n/g, '\n');
  const normalised = parseVars(blankComments(lfSrc));
  check(
    normalised.has('active') && reachesGate('active', normalised, new Set([GATE, 'flag'])).reached,
    'normalising CRLF did NOT restore the parse — readSource() does not close the hazard',
  );
  // The resolver control. A drifted resolver used to produce a path matching no
  // tracked file, and the invocation was then dropped in silence; R3 now hard-
  // fails on that, so the resolver itself must be proven on a known pair.
  check(
    resolveModuleTarget('platform/fiab/bicep/modules/landing-zone/main.bicep', '../../../../../deploy/bicep/DLZ/modules/geoanalytics.bicep')
      === 'deploy/bicep/DLZ/modules/geoanalytics.bicep',
    'resolveModuleTarget() no longer resolves a cross-tree relative path — R3 would fire on correct paths',
  );
  check(
    resolveModuleTarget('platform/fiab/bicep/main.bicep', 'modules/landing-zone/main.bicep')
      === 'platform/fiab/bicep/modules/landing-zone/main.bicep',
    'resolveModuleTarget() no longer resolves a sibling module path',
  );
  // The unreadable-forward control. A `postgresQuotaAvailable:` value split
  // across lines by a ternary cannot be read whole, and judging the truncated
  // first line would be a guess dressed as a measurement.
  {
    const multiline = [
      'param postgresQuotaAvailable bool = true',
      "module lz 'lz.bicep' = {",
      '  params: {',
      '    postgresQuotaAvailable: someCondition',
      '      ? postgresQuotaAvailable',
      '      : false',
      '  }',
      '}',
    ].join('\n');
    let threw = false;
    try {
      forwardedGateValue(multiline, parseModules(multiline, '<control:multiline-forward>')[0], '<control:multiline-forward>');
    } catch {
      threw = true;
    }
    check(threw, 'forwardedGateValue() silently truncated a multi-line forwarded value instead of refusing to guess');
  }
  for (const c of CONTROLS) {
    CONTROL_STATS.ran += 1;
    let mods;
    try {
      mods = parseModules(c.src, `<control:${c.name}>`);
    } catch (err) {
      failures.push(`${c.name}: parseModules threw — ${err.message}`);
      continue;
    }
    if (mods.length !== 1) {
      failures.push(`${c.name}: expected 1 module invocation, parsed ${mods.length}`);
      continue;
    }
    const mod = mods[0];
    const clean = blankComments(c.src);
    const vars = parseVars(clean);
    const params = new Set([...parseParams(clean), ...c.extraParams]);
    if ('unconditional' in c.expect) {
      if ((mod.condition === null) !== c.expect.unconditional) {
        failures.push(`${c.name}: condition detection disagreed (got ${JSON.stringify(mod.condition)})`);
      }
      continue;
    }
    if ('forwards' in c.expect && forwardsGate(c.src, mod) !== c.expect.forwards) {
      failures.push(`${c.name}: forwardsGate() returned ${!c.expect.forwards}, expected ${c.expect.forwards}`);
    }
    if ('forwardedValue' in c.expect) {
      CONTROL_STATS.ran += 1;
      let got;
      try {
        got = forwardedGateValue(c.src, mod, `<control:${c.name}>`);
      } catch (err) {
        failures.push(`${c.name}: forwardedGateValue threw — ${err.message}`);
        continue;
      }
      if (got !== c.expect.forwardedValue) {
        failures.push(`${c.name}: forwardedGateValue=${JSON.stringify(got)}, expected ${JSON.stringify(c.expect.forwardedValue)}`);
      }
    }
    if ('valueReaches' in c.expect) {
      CONTROL_STATS.ran += 1;
      let value;
      try {
        value = forwardedGateValue(c.src, mod, `<control:${c.name}>`);
      } catch (err) {
        failures.push(`${c.name}: forwardedGateValue threw — ${err.message}`);
        continue;
      }
      if (value === null) {
        failures.push(`${c.name}: expected a forwarded value, found none`);
      } else {
        const vr = reachesGate(value, vars, params);
        if (vr.reached !== c.expect.valueReaches) {
          failures.push(
            `${c.name}: the forwarded VALUE ${JSON.stringify(value.trim())} reached=${vr.reached}, expected ${c.expect.valueReaches}`,
          );
        }
      }
    }
    if (!('reached' in c.expect)) continue;
    if (mod.condition === null) {
      failures.push(`${c.name}: expected a condition, parsed none`);
      continue;
    }
    let res;
    try {
      res = reachesGate(mod.condition, vars, params);
    } catch (err) {
      failures.push(`${c.name}: reachesGate threw — ${err.message}`);
      continue;
    }
    if (res.unresolved.length) {
      failures.push(`${c.name}: unexpected unresolved identifiers ${res.unresolved.join(', ')}`);
    }
    if (res.reached !== c.expect.reached) {
      failures.push(`${c.name}: reachesGate=${res.reached}, expected ${c.expect.reached}`);
    }
    if ('viaParam' in c.expect && res.viaParam !== c.expect.viaParam) {
      failures.push(`${c.name}: viaParam=${res.viaParam}, expected ${c.expect.viaParam}`);
    }
    if ('negatedOnly' in c.expect) {
      CONTROL_STATS.ran += 1;
      if (res.negatedOnly !== c.expect.negatedOnly) {
        failures.push(`${c.name}: negatedOnly=${res.negatedOnly}, expected ${c.expect.negatedOnly}`);
      }
    }
  }
  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCAN
// ─────────────────────────────────────────────────────────────────────────────

function trackedBicep() {
  const out = execFileSync('git', ['ls-files', '--', '*.bicep'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\\/g, '/'));
}

/**
 * Repo-relative path a `module NAME '<target>'` statement points at.
 *
 * Exported so the embedded controls can prove the resolver on a known pair
 * instead of trusting it — a drifted resolver used to produce a path that
 * matched no tracked file, and the invocation was then dropped in SILENCE.
 * {@link main} now treats that as a hard failure (R3).
 *
 * @param {string} rel repo-relative path of the CALLER
 * @param {string} target the quoted module path
 * @returns {string}
 */
export function resolveModuleTarget(rel, target) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
}

function main() {
  const selfTestOnly = process.argv.includes('--self-test');
  const controlFailures = runControls();
  if (controlFailures.length) {
    console.error('[postgres-quota-gate] EMBEDDED CONTROLS FAILED — the analyzer is not measuring what it claims.');
    for (const f of controlFailures) console.error(`  - ${f}`);
    console.error('[postgres-quota-gate] no verdict is reported about the repo.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] embedded controls: ${CONTROL_STATS.ran} checks agreed.`);
  if (selfTestOnly) {
    console.log('[postgres-quota-gate] --self-test only; repo not scanned.');
    return;
  }

  const files = trackedBicep();
  if (files.length === 0) {
    console.error('[postgres-quota-gate] FAIL: git ls-files matched ZERO .bicep files — the corpus drifted.');
    process.exit(1);
  }
  const sources = new Map();
  for (const rel of files) sources.set(rel, readSource(path.join(REPO_ROOT, rel)));

  // 1. PG-declaring modules, repo-wide.
  const pgDeclaring = files.filter((rel) => declaresPostgres(sources.get(rel)));
  if (pgDeclaring.length === 0) {
    console.error('[postgres-quota-gate] FAIL: ZERO bicep files declare Microsoft.DBforPostgreSQL/flexibleServers.');
    console.error('  That is matcher drift, not a clean repo — the tree has always carried several.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] ${files.length} tracked .bicep files; ${pgDeclaring.length} declare a PG flexible server.`);

  // 2. Parse every module invocation in the judged tree, then close the module
  //    graph: a file that (transitively) reaches a PG declaration is itself a
  //    PG provisioner for R1 purposes.
  const judged = files.filter((rel) => rel.startsWith(JUDGED_PREFIX));
  const mods = new Map();
  for (const rel of judged) {
    try {
      mods.set(rel, parseModules(sources.get(rel), rel));
    } catch (err) {
      console.error(`[postgres-quota-gate] FAIL: ${err.message}`);
      process.exit(1);
    }
  }
  const resolveTarget = resolveModuleTarget;

  // 2a. R3 — every module target must resolve to a tracked .bicep file. Before
  //     this, an unresolvable target hit `!provisions.has(target)` and was
  //     skipped without a word, so a drifted resolver (or a probe path with one
  //     `..` too few) read as "nothing to judge". A guard that goes quiet on its
  //     own drift is the `csa_loom_gates_that_measure_nothing` shape.
  const unresolvedTargets = [];
  for (const [rel, list] of mods) {
    for (const m of list) {
      const target = resolveTarget(rel, m.target);
      if (!sources.has(target)) unresolvedTargets.push({ rel, line: m.line, name: m.name, raw: m.target, target });
    }
  }
  if (unresolvedTargets.length) {
    console.error('[postgres-quota-gate] FAIL: module target(s) that resolve to no tracked .bicep file:');
    for (const u of unresolvedTargets) {
      console.error(`  ${u.rel}:${u.line}: module ${u.name} -> '${u.raw}' resolves to ${u.target}, which git does not track.`);
    }
    console.error('  Either the path is wrong or this resolver drifted. Both mean the invocation cannot be judged,');
    console.error('  and an unjudged PG deploy must not read as a clean one.');
    process.exit(1);
  }

  const provisions = new Set(pgDeclaring);
  for (let pass = 0; pass < 20; pass += 1) {
    let grew = false;
    for (const [rel, list] of mods) {
      if (provisions.has(rel)) continue;
      for (const m of list) {
        if (provisions.has(resolveTarget(rel, m.target))) {
          provisions.add(rel);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }

  // 3. R1 — judge every invocation of a PG-provisioning target, EXCEPT where the
  //    target already gates itself (the gate lives in the child).
  const violations = [];
  const gatedFiles = new Set(); // files that satisfy R1 via their OWN param -> R2 applies
  let judgedInvocations = 0;
  const gatesItself = new Map();

  const evaluate = (rel) => {
    if (gatesItself.has(rel)) return gatesItself.get(rel);
    gatesItself.set(rel, false); // cycle guard
    const clean = blankComments(sources.get(rel));
    const vars = parseVars(clean);
    const params = parseParams(clean);
    let any = false;
    for (const m of mods.get(rel) || []) {
      const target = resolveTarget(rel, m.target);
      if (!provisions.has(target)) continue;
      if (evaluate(target)) continue; // the child gates; this caller need not
      judgedInvocations += 1;
      if (m.condition === null) {
        violations.push({
          rel,
          line: m.line,
          why: `module ${m.name} deploys a PostgreSQL flexible server (via ${m.target}) with NO activation condition, so it cannot consult ${GATE}`,
        });
        continue;
      }
      let res;
      try {
        res = reachesGate(m.condition, vars, params);
      } catch (err) {
        console.error(`[postgres-quota-gate] FAIL: ${rel}:${m.line}: ${err.message}`);
        process.exit(1);
      }
      if (res.unresolved.length) {
        console.error(
          `[postgres-quota-gate] FAIL: ${rel}:${m.line}: condition of module ${m.name} names ` +
            `${res.unresolved.join(', ')}, which is neither a var nor a param of this file — ` +
            'cannot determine whether the gate is consulted, so this is a hard failure rather than a skip.',
        );
        process.exit(1);
      }
      if (!res.reached) {
        violations.push({
          rel,
          line: m.line,
          why: `module ${m.name} deploys a PostgreSQL flexible server (via ${m.target}) but its condition \`${m.condition.trim()}\` never reaches ${GATE}`,
        });
        continue;
      }
      if (res.negatedOnly) {
        violations.push({
          rel,
          line: m.line,
          why:
            `module ${m.name} deploys a PostgreSQL flexible server (via ${m.target}) and its condition ` +
            `\`${m.condition.trim()}\` reaches ${GATE} only under a logical NOT — it deploys precisely when ` +
            'the gate says not to. A reference is not a gate if its polarity is inverted.',
        });
        continue;
      }
      any = true;
      if (res.viaParam) gatedFiles.add(rel);
    }
    gatesItself.set(rel, any);
    return any;
  };

  for (const rel of judged) evaluate(rel);

  if (judgedInvocations === 0) {
    console.error('[postgres-quota-gate] FAIL: ZERO invocations of a PG-provisioning module were judged.');
    console.error('  The module-path resolver drifted; a zero here is not evidence of a clean tree.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] judged ${judgedInvocations} invocation(s) that deploy a PG flexible server.`);

  // 4. R2 — a file gated on its OWN param must be handed that param by every
  //    caller, AND the value handed over must itself reach the gate.
  for (const target of [...gatedFiles].sort()) {
    let callers = 0;
    for (const [rel, list] of mods) {
      const callerClean = blankComments(sources.get(rel));
      const callerVars = parseVars(callerClean);
      const callerParams = parseParams(callerClean);
      for (const m of list) {
        if (resolveTarget(rel, m.target) !== target) continue;
        callers += 1;
        if (!forwardsGate(sources.get(rel), m)) {
          violations.push({
            rel,
            line: m.line,
            why: `module ${m.name} invokes ${target}, whose PG deploy is gated on its OWN \`param ${GATE}\` (which carries a default), but this call site does not pass \`${GATE}:\` — the gate is defaulted away on this path`,
          });
          continue;
        }
        let value;
        try {
          value = forwardedGateValue(sources.get(rel), m, rel);
        } catch (err) {
          console.error(`[postgres-quota-gate] FAIL: ${err.message}`);
          process.exit(1);
        }
        let vr;
        try {
          vr = reachesGate(value, callerVars, callerParams);
        } catch (err) {
          console.error(`[postgres-quota-gate] FAIL: ${rel}:${m.line}: ${err.message}`);
          process.exit(1);
        }
        if (vr.unresolved.length) {
          console.error(
            `[postgres-quota-gate] FAIL: ${rel}:${m.line}: the ${GATE}: value passed to module ${m.name} names ` +
              `${vr.unresolved.join(', ')}, which is neither a var nor a param of this file — cannot determine ` +
              'whether the forwarded value carries the gate, so this is a hard failure rather than a skip.',
          );
          process.exit(1);
        }
        if (!vr.reached || vr.negatedOnly) {
          violations.push({
            rel,
            line: m.line,
            why:
              `module ${m.name} invokes ${target}, whose PG deploy is gated on its OWN \`param ${GATE}\`, and it ` +
              `passes \`${GATE}: ${value.trim()}\` — a value that ${vr.reached ? `reaches ${GATE} only NEGATED` : `never reaches ${GATE}`}. ` +
              'Forwarding a constant is runtime-identical to omitting the forward: the gate is defaulted away on this path.',
          });
        }
      }
    }
    // A per-target zero must not be absorbed by a sibling target that still has
    // callers. Cross-check against a scan that does NOT use resolveTarget, so a
    // drifted resolver cannot make a target look like a root.
    const suffix = target.split('/').slice(-2).join('/');
    let textualCallers = 0;
    for (const [rel, list] of mods) {
      if (rel === target) continue;
      for (const m of list) if (m.target.replace(/\\/g, '/').endsWith(suffix)) textualCallers += 1;
    }
    console.log(
      `[postgres-quota-gate] R2: ${target} gates on its own param; ${callers} call site(s) checked for the forward ` +
        `(textual cross-check on '${suffix}': ${textualCallers}).`,
    );
    if (callers === 0 && textualCallers > 0) {
      console.error(
        `[postgres-quota-gate] FAIL: ${target} gates on its own param and resolved ZERO call sites, but a ` +
          `resolver-independent scan finds ${textualCallers} invocation(s) ending in '${suffix}'. The module-path ` +
          'resolver disagrees with the source; a zero here is drift, not a root.',
      );
      process.exit(1);
    }
    if (callers === 0) {
      console.log(
        `[postgres-quota-gate] R2: ${target} has no callers by either method — a deployment ENTRYPOINT, so no ` +
          'caller can default the param away. Its value comes from the .bicepparam.',
      );
    }
  }

  // 5. Disclosure — what was found but deliberately NOT judged.
  const unjudged = pgDeclaring.filter((rel) => !rel.startsWith(JUDGED_PREFIX));
  for (const rel of unjudged) {
    console.log(`[postgres-quota-gate] NOT JUDGED (outside ${JUDGED_PREFIX}, where ${GATE} does not exist): ${rel}`);
  }
  const uninvoked = pgDeclaring.filter((rel) => {
    if (!rel.startsWith(JUDGED_PREFIX)) return false;
    for (const [caller, list] of mods) {
      for (const m of list) if (resolveTarget(caller, m.target) === rel) return false;
    }
    return true;
  });
  for (const rel of uninvoked) {
    console.log(`[postgres-quota-gate] NOT JUDGED (no module invocation — out-of-band entrypoint, owned by check-bicep-sync.mjs): ${rel}`);
  }

  if (violations.length) {
    console.error(`[postgres-quota-gate] FAIL — ${violations.length} PostgreSQL deploy(s) do not consult ${GATE}:`);
    for (const v of violations) console.error(`  ${v.rel}:${v.line}: ${v.why}`);
    console.error('');
    console.error(`  FIX: put ${GATE} in the activation condition (directly or through a var chain),`);
    console.error(`  and forward the PARAM ITSELF from every caller (not a literal). Both Gov param`);
    console.error('  files pin it false, so an ungated PG deploy fails the whole leaf there — the');
    console.error('  observed failure was ParameterOutOfRange, "The value of the \'Version\' should be');
    console.error('  in: []", on psql-loom-weave-default-* (GitHub Actions run 32019775757,');
    console.error('  deploy-fiab-gcch, 2026-08-17).');
    console.error('');
    console.error('  WHY those files pin it false is NOT asserted here, and it is NOT a quota finding');
    console.error('  this check made. Each param file records its own reason in-file — read it there');
    console.error('  before concluding anything about the boundary:');
    console.error('    platform/fiab/bicep/params/gcc-high.bicepparam  (search postgresQuotaAvailable)');
    console.error('    platform/fiab/bicep/params/il5.bicepparam       (search postgresQuotaAvailable)');
    console.error('  Both state that PostgreSQL Flexible Server IS available in Azure Government and');
    console.error('  that their false is a deliberate posture hold, not a service gap. Do not "fix"');
    console.error('  this by flipping the flag without reading them.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] PASS — every judged PostgreSQL deploy consults ${GATE}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
