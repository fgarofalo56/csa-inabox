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
 * files pin it false:
 *
 *     params/gcc-high.bicepparam:273  param postgresQuotaAvailable = bool(readEnvironmentVariable('LOOM_POSTGRES_QUOTA_AVAILABLE', 'false'))
 *     params/il5.bicepparam:340       (identical)
 *
 * Three of the four Postgres consumers in admin-plane/main.bicep routed through
 * it. The fourth — the Weave ontology AGE store — did not: its activation var
 * was `weaveOntologyBackendEnabled && !weavePgSuppliedByDlz`, and nothing else.
 * So a GCC-High deploy attempted a flexible server in a boundary whose own param
 * file says one cannot be created there, and the deploy died on the leaf:
 *
 *     ParameterOutOfRange -> The value of the 'Version' should be in: []
 *     (resource psql-loom-weave-default-dcmt6cqoezlgs)
 *
 * An EMPTY permitted-version set is satisfied by no value at all, so no
 * `postgresVersion` could have cleared it — the tempting "bump 16 to 15" fix was
 * provably not a fix. (Why the set is empty is NOT asserted here; the message
 * does not establish it. deploy-integrity.md R7.)
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
 *     `postgresQuotaAvailable:` in its params object. Without R2 the gate is
 *     real and defaulted away: deleting one of the three forwards in main.bicep
 *     silently re-arms the failure on one topology while the other two keep the
 *     guard green. That "delete one of several, not the only one" shape is the
 *     blind spot this repo keeps paying for.
 *
 * ── HONESTY BOUNDARIES (what a PASS here does NOT claim) ────────────────────
 *   • PG-declaring modules are discovered REPO-WIDE, but only invocations under
 *     platform/fiab/bicep/** are judged, because `postgresQuotaAvailable` is a
 *     concept of that deploy tree and does not exist in deploy/bicep/**. Any
 *     PG-declaring bicep outside the judged tree is PRINTED on every run, never
 *     silently dropped — and if a judged file invokes one, that invocation IS
 *     judged, so the seam cannot be used to launder an ungated server.
 *   • A PG module with ZERO invocations is out-of-band by construction; whether
 *     it SHOULD be wired in is check-bicep-sync.mjs's ORPHAN_ALLOWLIST, not
 *     this file's. It is printed, not judged.
 *   • Reaching the gate proves the condition CONSULTS it. It does not prove the
 *     surrounding boolean algebra is what the author intended.
 *
 * ── FAIL-CLOSED (a scan that stopped scanning is not a verdict) ─────────────
 * Hard failure, before any repo verdict, when: the embedded controls disagree;
 * zero bicep files are discovered; zero PG-declaring modules are found; zero
 * invocations of them are found; a module header cannot be parsed; or a
 * condition names an identifier that is neither a `var` nor a `param` of its
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
 * Identifiers an expression READS. Property accesses (`x.y`, `x.?y`) yield only
 * the root, function names are dropped (an identifier immediately followed by
 * `(`), string content is dropped, and literals are dropped.
 *
 * @param {string} expr
 * @returns {string[]}
 */
export function identifiersOf(expr) {
  const noStrings = blankStrings(expr);
  const noProps = noStrings.replace(/\.\s*\??\s*[A-Za-z_]\w*/g, ' ');
  const out = [];
  for (const m of noProps.matchAll(/[A-Za-z_]\w*/g)) {
    const after = noProps.slice(m.index + m[0].length);
    if (/^\s*\(/.test(after)) continue; // function call
    if (LITERALS.has(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

/**
 * Does `expr` reach {@link GATE} through this file's own vars?
 *
 * @param {string} expr the module's activation condition
 * @param {Map<string,string>} vars
 * @param {Set<string>} params
 * @returns {{reached: boolean, viaParam: boolean, unresolved: string[]}}
 *   `viaParam` is true when the gate was reached as a PARAM of this file, which
 *   is what triggers R2 (a param carries a default and can be silently omitted
 *   by a caller).
 */
export function reachesGate(expr, vars, params) {
  const seen = new Set();
  const unresolved = [];
  let reached = false;
  let viaParam = false;
  const visit = (e, depth) => {
    if (depth > 24) throw new Error(`var resolution exceeded depth 24 — refusing to guess: ${e.slice(0, 80)}`);
    for (const id of identifiersOf(e)) {
      if (id === GATE) {
        reached = true;
        if (params.has(id)) viaParam = true;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      if (vars.has(id)) {
        visit(vars.get(id), depth + 1);
        continue;
      }
      if (params.has(id)) continue; // a param of this file; nothing further to resolve
      unresolved.push(id);
    }
  };
  visit(expr, 0);
  return { reached, viaParam, unresolved };
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

/** @returns {boolean} does this module invocation pass `postgresQuotaAvailable:`? */
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
    expect: { forwards: false },
  },
];

/** @returns {string[]} control failures, empty when every fixture agrees */
export function runControls() {
  const failures = [];
  if (!declaresPostgres(PG_MODULE_FIXTURE)) {
    failures.push('declaresPostgres() did not recognise a real flexibleServers resource declaration');
  }
  if (declaresPostgres("@description('deploys Microsoft.DBforPostgreSQL/flexibleServers')\nparam x bool = true")) {
    failures.push('declaresPostgres() matched a DESCRIPTION STRING — it would pass on prose');
  }
  if (declaresPostgres("// resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {")) {
    failures.push('declaresPostgres() matched a COMMENTED-OUT resource declaration');
  }
  for (const c of CONTROLS) {
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

function main() {
  const selfTestOnly = process.argv.includes('--self-test');
  const controlFailures = runControls();
  if (controlFailures.length) {
    console.error('[postgres-quota-gate] EMBEDDED CONTROLS FAILED — the analyzer is not measuring what it claims.');
    for (const f of controlFailures) console.error(`  - ${f}`);
    console.error('[postgres-quota-gate] no verdict is reported about the repo.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] embedded controls: ${CONTROLS.length + 3} checks agreed.`);
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
  for (const rel of files) sources.set(rel, readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

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
  const resolveTarget = (rel, target) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));

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

  // 4. R2 — a file gated on its OWN param must be handed that param by every caller.
  let forwardChecks = 0;
  for (const target of [...gatedFiles].sort()) {
    let callers = 0;
    for (const [rel, list] of mods) {
      for (const m of list) {
        if (resolveTarget(rel, m.target) !== target) continue;
        callers += 1;
        forwardChecks += 1;
        if (!forwardsGate(sources.get(rel), m)) {
          violations.push({
            rel,
            line: m.line,
            why: `module ${m.name} invokes ${target}, whose PG deploy is gated on its OWN \`param ${GATE}\` (which carries a default), but this call site does not pass \`${GATE}:\` — the gate is defaulted away on this path`,
          });
        }
      }
    }
    console.log(`[postgres-quota-gate] R2: ${target} gates on its own param; ${callers} call site(s) checked for the forward.`);
  }
  if (gatedFiles.size > 0 && forwardChecks === 0) {
    console.error('[postgres-quota-gate] FAIL: a file gates on its own param but ZERO call sites were found for it.');
    process.exit(1);
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
    console.error('  and forward it from every caller. Both Gov param files pin it false because those');
    console.error('  subscriptions return an EMPTY permitted-version set for flexibleServers, which no');
    console.error('  postgresVersion value can satisfy — an ungated deploy fails the whole leaf.');
    process.exit(1);
  }
  console.log(`[postgres-quota-gate] PASS — every judged PostgreSQL deploy consults ${GATE}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
