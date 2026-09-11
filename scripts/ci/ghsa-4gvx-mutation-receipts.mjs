#!/usr/bin/env node
/**
 * GHSA-4gvx-9p49-p43g — MUTATION RECEIPTS for the same-origin fix and its guard.
 *
 * WHY THIS IS COMMITTED RATHER THAN PASTED INTO A PR BODY. A mutation table in
 * prose is an unreproducible assertion, and the claim being made here is the one
 * that most needs an artifact: "the guard that missed four sites now catches
 * their whole class". Its sibling `ghsa-v2g8-mutation-receipts.mjs` exists for
 * the same reason and this file follows its shape deliberately.
 *
 * WHAT IT DOES. For each mutation: apply an EXACT string replacement to a real
 * source file, run the WHOLE named test file(s), read the runner's own summary,
 * then restore the file byte-for-byte from the pre-mutation buffer. A mutation
 * that turns its suite RED is a control that works; one that stays GREEN is a
 * test that proves nothing.
 *
 * ── FIVE VERDICTS. THE THREE THAT ARE NOT RED/GREEN ARE THE POINT. ─────────
 *
 *   RED         the suite failed. The control is real.
 *   GREEN       the suite passed WITH the mutation live. The test is decoration.
 *   SKIPPED     the `find` string was not present, so nothing was mutated.
 *   AMBIGUOUS   the `find` string matched MORE THAN ONCE. `String.replace`
 *               rewrites only the first, so the mutation applied is not the one
 *               written down — and a RED from it is evidence about a site nobody
 *               chose. Refused rather than scored.
 *   NO-SUMMARY  the runner produced no `Tests …` line, so it never reported on a
 *               test. Its exit code is then a statement about the RUNNER (a
 *               config error, a collect failure, a crash), not about the code
 *               under mutation. Reading it as RED would manufacture a receipt
 *               out of a broken harness — the exact "green over nothing" shape
 *               `deploy-integrity.md` R7 is about. Refused rather than scored.
 *
 * SKIPPED is never a pass: on the first run of the v2g8 harness 13 of 21
 * mutations came back SKIPPED because the checkout is CRLF and the multi-line
 * `find` strings are LF. Had "did not apply" been scored as "the test survived
 * it", that receipt table would have been fiction. Source is LF-normalised
 * before matching and the byte-exact original is always restored.
 *
 * SELF-TESTING. Every mutation declares the verdict it EXPECTS and the harness
 * fails when any differs — including four controls that make each refusal state
 * live in every run rather than merely described in this comment:
 *
 *   C0  a `find` that cannot match          -> MUST be SKIPPED
 *   C1  an inert (comment-only) change      -> MUST be GREEN
 *   C2  a `find` that matches twice         -> MUST be AMBIGUOUS
 *   C3  a suite path that does not exist    -> MUST be NO-SUMMARY
 *
 * NO `-t` FILTERS ANYWHERE. A regex metacharacter in a test name silently
 * matches nothing and exits 0 with the mutation live — the same false-green this
 * advisory is about. Whole files only.
 *
 * Usage (from anywhere in the repo):
 *   node scripts/ci/ghsa-4gvx-mutation-receipts.mjs           # all
 *   node scripts/ci/ghsa-4gvx-mutation-receipts.mjs M1 G3     # a subset
 *
 * Not wired into the default CI lane: it rewrites source files while running, so
 * it must never race another job in the same checkout. Run it on demand, and on
 * any PR that touches these clients, the resolver, or the guard.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONSOLE_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

const GUARD = 'lib/util/__tests__/credential-url-origin-guard.test.ts';
const ARM = 'lib/azure/__tests__/arm-client-same-origin.test.ts';
const CLIENTS = 'lib/azure/__tests__/credential-url-same-origin.test.ts';
const RESOLVER = 'lib/util/__tests__/same-origin-url.test.ts';

/**
 * C0 — the did-not-apply control. Its `find` cannot match any source in the
 * repo, so it MUST report SKIPPED. If it ever reports RED or GREEN the harness
 * is mutating something it did not intend to and every other row is suspect.
 */
const CONTROL_NO_MATCH = {
  id: 'C0',
  desc: 'CONTROL — a find string that cannot match; MUST be SKIPPED, never a pass',
  file: 'lib/util/same-origin-url.ts',
  find: '/* THIS STRING DOES NOT EXIST IN ANY SOURCE FILE — ghsa-4gvx harness control */',
  replace: '/* unreachable */',
  suites: [RESOLVER],
  expect: 'SKIPPED',
};

/**
 * C1 — the INERT control. It applies cleanly and changes nothing a test could
 * observe, so it MUST report GREEN. Without a deliberate survivor, a run showing
 * only RED rows does not demonstrate the harness can DETECT a survivor — which
 * is the failure mode that matters most, because a surviving mutation means the
 * test is decoration.
 */
const CONTROL_INERT = {
  id: 'C1',
  desc: 'CONTROL — an INERT change (comment only); MUST be GREEN, proving survivors are detected',
  file: 'lib/util/same-origin-url.ts',
  find: '/** Why a candidate URL was refused. */',
  replace: '/** (inert harness control: this comment was rewritten; nothing observable changed) */',
  suites: [RESOLVER],
  expect: 'GREEN',
};

/**
 * C2 — the AMBIGUOUS control. `credentialLabel = 'a credential'` is the default
 * parameter on three exported functions in the resolver, so this `find` matches
 * more than once. `String.replace` would rewrite only the first and the receipt
 * would name a mutation that did not happen at the other two.
 */
const CONTROL_AMBIGUOUS = {
  id: 'C2',
  desc: 'CONTROL — a find string that matches MORE THAN ONCE; MUST be AMBIGUOUS, never scored',
  file: 'lib/util/same-origin-url.ts',
  find: "credentialLabel = 'a credential',",
  replace: "credentialLabel = 'a credential', /* ambiguity control */",
  suites: [RESOLVER],
  expect: 'AMBIGUOUS',
};

/**
 * C3 — the NO-SUMMARY control. The suite path does not exist, so vitest exits
 * non-zero having reported on no test at all. Scored as RED that would be a
 * receipt manufactured from a harness error.
 */
const CONTROL_NO_SUMMARY = {
  id: 'C3',
  desc: 'CONTROL — a suite that does not exist; the runner emits no summary; MUST be NO-SUMMARY, never RED',
  file: 'lib/util/same-origin-url.ts',
  find: '/** True when `raw` looks like an absolute http(s) URL rather than a path. */',
  replace: '/** (no-summary control) */',
  suites: ['lib/util/__tests__/this-suite-does-not-exist.test.ts'],
  expect: 'NO-SUMMARY',
};

/** @type {{id:string,desc:string,file:string,find:string,replace:string,suites:string[],expect:string}[]} */
const MUTATIONS = [
  CONTROL_NO_MATCH,
  CONTROL_INERT,
  CONTROL_AMBIGUOUS,
  CONTROL_NO_SUMMARY,

  // ── The four sites the review found unguarded ────────────────────────────
  {
    id: 'M1',
    desc: 'arm-client — RESTORE the passthrough (the shared ARM fetcher returns an absolute path verbatim)',
    file: 'lib/azure/arm-client.ts',
    find: '  const rel = isAbsoluteHttpUrl(path) || path.startsWith(\'/\') ? path : `/${path}`;\n  return resolveSameOriginUrl(rel, armBase(), \'the ARM token\');',
    replace: '  if (/^https?:\\/\\//i.test(path)) return path;\n  return `${armBase()}${path.startsWith(\'/\') ? \'\' : \'/\'}${path}`;',
    suites: [ARM, GUARD],
    expect: 'RED',
  },
  {
    id: 'M2',
    desc: 'fabric-client — RESTORE the Location-header passthrough',
    file: 'lib/azure/fabric-client.ts',
    find: "  if (isAbsoluteHttpUrl(v)) return assertSameOrigin(v, FABRIC_BASE, 'the Fabric token');",
    replace: '  if (/^https?:\\/\\//i.test(v)) return v;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'M3',
    desc: 'power-platform-auth — RESTORE the Operation-Location passthrough in the shared transport',
    file: 'lib/azure/power-platform-auth.ts',
    find: '  const rel = isAbsoluteHttpUrl(t) || t.startsWith(\'/\') ? t : `/${t}`;\n  return resolveSameOriginUrl(rel, base, credentialLabel);',
    replace: '  void credentialLabel;\n  return /^https?:\\/\\//i.test(t) ? t : `${base}${t.startsWith(\'/\') ? \'\' : \'/\'}${t}`;',
    suites: [GUARD],
    expect: 'RED',
  },

  // ── The guard's own detection, one mechanism per row ─────────────────────
  {
    id: 'G1',
    desc: 'guard — DELETE the regex-literal arm of the lexer (the mask eats /^https?:\\/\\// again)',
    file: `${GUARD}`,
    find: '        if (closed) {\n          let k = j + 1;',
    replace: '        if (false) {\n          let k = j + 1;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G2',
    desc: 'guard — narrow the spellings back to `startsWith` only (the review\'s finding 1)',
    file: `${GUARD}`,
    find: '  /\\bisAbsoluteHttpUrl\\(\\s*([A-Za-z_$][\\w$.?![\\]\']*)\\s*\\)/g,',
    replace: '',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G3',
    desc: 'guard — score the passthrough on ONE line at a time (a multiline ternary walks through)',
    file: `${GUARD}`,
    find: "  if (yieldsAfter(code.slice(site.end, stmtEnd), site.subject, '\\\\?')) return !negated;",
    replace: "  if (yieldsAfter(code.slice(site.end, stmtEnd).split('\\n')[0], site.subject, '\\\\?')) return !negated;",
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G4',
    desc: 'guard — drop the token-acquisition arm of CREDENTIALED (a credential one module away hides again)',
    file: `${GUARD}`,
    find: "|\\.getToken\\s*\\(|\\bacquireToken\\s*\\(|[Ss]cope\\s*\\(\\s*\\)/;",
    replace: '/;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G5',
    desc: 'guard — narrow the walk back to apps/fiab-console/{lib,app} (azure-functions leaves the population)',
    file: `${GUARD}`,
    find: "const REPO_ROOT = path.resolve(CONSOLE_ROOT, '..', '..');",
    replace: 'const REPO_ROOT = CONSOLE_ROOT;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G6',
    desc: 'guard — accept a declaration ANYWHERE in the file (the escape hatch becomes a rubber stamp)',
    file: `${GUARD}`,
    find: "    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) break;",
    replace: '    /* mutated: no longer stops at the first non-comment line */',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G7',
    desc: 'guard — accept a bare marker with no channel and no reason',
    file: `${GUARD}`,
    find: 'const EXEMPT_DECLARATION = /SAME-ORIGIN-EXEMPT\\(([a-z-]+)\\)\\s*:\\s*(\\S[^\\n]*)/;',
    replace: 'const EXEMPT_DECLARATION = /SAME-ORIGIN-EXEMPT()()/;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G8',
    desc: 'guard — drop the response-HEADER channel entirely (the review\'s "different input channel")',
    file: `${GUARD}`,
    find: '  /\\.headers\\.get\\(\\s*([\'"`])(?:operation-location|location|azure-asyncoperation|content-location)\\1\\s*\\)/gi;',
    replace: '  /\\.headers\\.get\\(\\s*([\'"`])(?:this-header-does-not-exist)\\1\\s*\\)/gi;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'G9',
    desc: 'guard — COLLAPSE the population to 5 files (a scanner that stops scanning must not read as clean)',
    file: `${GUARD}`,
    find: 'const SCANNED = scanAll();',
    replace: 'const SCANNED = scanAll().slice(0, 5);',
    suites: [GUARD],
    expect: 'RED',
  },

  // ── Evasions the review did NOT list, invented here ──────────────────────
  //
  // The review's three (regex spelling, multiline ternary, 31-line separation)
  // are G1/G2/G3/G4 above. These four are ones I looked for because "what has
  // nobody tried?" is the only question that finds the next one. Two of them
  // were LIVE — E1 and E4 both came back GREEN on the first run of this harness
  // and are the reason `lexSource` has a regex arm and `callsBoundaryPrimitive`
  // exists at all.
  {
    id: 'E1',
    desc: 'EVASION — self-satisfying marker: a function whose NAME is a guard marker (M3\'s mechanism, generalised)',
    file: `${GUARD}`,
    find: '      if (!/\\b(?:function|class|interface|type)\\s+$/.test(before)) out.push(i);',
    replace: '      out.push(i);',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'E2',
    desc: 'EVASION — the credential is attached in a DIFFERENT top-level block from the URL builder',
    file: `${GUARD}`,
    find: 'const CREDENTIALED_FILES = SCANNED.filter((f) => CREDENTIALED.test(f.code));',
    replace: 'const CREDENTIALED_FILES = SCANNED.filter((f) => CREDENTIALED.test(f.code.slice(0, 200)));',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'E3',
    desc: 'EVASION — an escaped `/` inside a character class runs the regex scanner past the literal',
    file: `${GUARD}`,
    find: "          if (inClass) { if (d === ']') inClass = false; j++; continue; }",
    replace: '          if (inClass) { inClass = false; j++; continue; }',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    // Also the control for the round-2 nit "a marker inside a STRING LITERAL is
    // not a boundary decision": compliance is scored off `structural`, so
    // leaving literal bodies in it makes an error MESSAGE that merely names the
    // primitive mark a file compliant. One mutation, two rows it must kill.
    id: 'E4',
    desc: 'EVASION — hide the passthrough inside a template literal so the STRUCTURAL mask skews brace depth',
    file: `${GUARD}`,
    find: '      blankStructural(i + 1, Math.max(i + 1, end - 1));',
    replace: '      /* mutated: string bodies are left in the structural mask */',
    suites: [GUARD],
    expect: 'RED',
  },

  // ── The three shapes the ROUND-2 review planted, one row each ────────────
  //
  // Independent re-review of #4454 wrote three ORDINARY credentialed clients
  // under lib/azure — absolute-URL passthrough, `credential.getToken(…)`,
  // `` authorization: `Bearer ${tok}` `` — and ran the guard unmodified:
  // `GUARD_RC_WITH_EVASIVE_CLIENTS=0`, 29/29 passed. Two were not in the
  // population at all and the third was scored GUARDED. Each row below reverts
  // exactly one of the three widenings that closed them, so the claim "the
  // guard now catches these" is a receipt rather than an assertion.
  {
    id: 'N1',
    desc: 'ROUND-2 EVASION — assign-then-return is no longer a yield (`if (isAbs(p)) u = p; return u;` vanishes)',
    file: `${GUARD}`,
    find: "  if (assign && yieldsAfter(code.slice(cons[1], be), assign[1], '(?:return|=>)')) return !negated;",
    replace: '  if (false) return !negated;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'N2',
    desc: 'ROUND-2 EVASION — `guarded` goes back to PRESENCE (a primitive called on a DIFFERENT value scores compliant)',
    file: `${GUARD}`,
    find: '    for (const a of aliases) if (mentionsIdentifier(stmt, a)) return true;',
    replace: '    void stmt; void aliases; return true;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'N3',
    desc: 'ROUND-2 EVASION — restore the {0,40} character budget (an inline comment pushes the `?` out of reach)',
    file: `${GUARD}`,
    find: '  const [, stmtEnd] = statementBounds(structural, site.end, 0, be);',
    replace: '  const stmtEnd = site.end + 40;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'X5',
    desc: 'ROUND-2 NIT — `sameOriginAs:` back to a bare substring (an interface FIELD marks a file compliant)',
    file: `${GUARD}`,
    find: "  /\\bsameOriginAs\\s*:(?!\\s*(?:string|number|boolean|any|unknown|null|undefined)\\s*[;,}\\n])\\s*/g;",
    replace: '  /\\bsameOriginAs\\s*:/g;',
    suites: [GUARD],
    expect: 'RED',
  },
  {
    id: 'X6',
    desc: 'ROUND-2 NIT — DIVERGE the console resolver from its azure-functions copy (the equivalence row must see it)',
    file: 'lib/util/same-origin-url.ts',
    find: "  return /^https?:\\/\\//i.test((raw || '').trim());",
    replace: "  return /^https?:\\/\\//i.test(String(raw ?? '').trim());",
    suites: [GUARD],
    expect: 'RED',
  },

  // ── The resolver itself ──────────────────────────────────────────────────
  {
    id: 'R1',
    desc: 'resolver — compare by PREFIX instead of by ORIGIN (the suffix impostor gets through)',
    file: 'lib/util/same-origin-url.ts',
    find: '  if (target.origin !== baseOrigin) throw new OffOriginUrlError(\'off-origin\', credentialLabel);\n  return target.toString();',
    replace: '  if (!raw.startsWith(base)) throw new OffOriginUrlError(\'off-origin\', credentialLabel);\n  return raw;',
    suites: [RESOLVER, CLIENTS, ARM],
    expect: 'RED',
  },
  {
    id: 'R2',
    desc: 'resolver — treat an unparseable candidate as "probably a path" (fails OPEN)',
    file: 'lib/util/same-origin-url.ts',
    find: "  } catch {\n    throw new OffOriginUrlError('unparseable', credentialLabel);\n  }\n  if (target.origin !== baseOrigin)",
    replace: "  } catch {\n    return raw;\n  }\n  if (target.origin !== baseOrigin)",
    suites: [RESOLVER],
    expect: 'RED',
  },
  {
    id: 'R3',
    desc: 'resolver — let an opaque origin match another opaque origin',
    file: 'lib/util/same-origin-url.ts',
    find: "  if (!u.origin || u.origin === 'null') return null;",
    replace: '  if (!u.origin) return null;',
    suites: [RESOLVER],
    expect: 'RED',
  },
  {
    id: 'R4',
    desc: 'resolver — assertSameOrigin returns the UNTRIMMED input (the review\'s NIT 5)',
    file: 'lib/util/same-origin-url.ts',
    find: '  return new URL(trimmed).toString();',
    replace: '  return candidate;',
    suites: [RESOLVER],
    expect: 'RED',
  },
];

const only = process.argv.slice(2);
const results = [];

function occurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

for (const m of MUTATIONS) {
  if (only.length && !only.includes(m.id)) continue;
  const abs = path.join(CONSOLE_ROOT, m.file);
  // READ, then classify the failure — never `existsSync()` then read. This
  // harness rewrites source files, so a check-then-use here is a real TOCTOU
  // window on a file it is about to overwrite (`js/file-system-race`, flagged
  // by CodeQL on the first push of this file). The single read is also the
  // honest instrument: a missing file and an unreadable one are different
  // facts, and `existsSync` collapses them into one guess.
  let original;
  try {
    original = readFileSync(abs, 'utf8');
  } catch (e) {
    const absent = e && e.code === 'ENOENT';
    const ok = absent && m.expect === 'SKIPPED';
    results.push({ id: m.id, verdict: 'SKIPPED', ok, line: '', desc: m.desc });
    console.log(
      `[${m.id}] SKIPPED — target file not read (${(e && e.code) || 'unknown error'}): ${m.file}`
      + `${absent ? '' : ' *** this is an I/O failure, NOT an absent file ***'}`,
    );
    continue;
  }
  // The checkout is CRLF; match and mutate against an LF-normalised copy and
  // ALWAYS restore the byte-exact original afterwards.
  const lf = original.replace(/\r\n/g, '\n');
  const hits = occurrences(lf, m.find);

  if (hits === 0) {
    const ok = m.expect === 'SKIPPED';
    results.push({ id: m.id, verdict: 'SKIPPED', ok, line: '', desc: m.desc });
    console.log(`[${m.id}] SKIPPED — find string absent${ok ? ' (EXPECTED: this is the control)' : ' *** NOT EXPECTED ***'}  — ${m.desc}`);
    continue;
  }
  if (hits > 1) {
    const ok = m.expect === 'AMBIGUOUS';
    results.push({ id: m.id, verdict: 'AMBIGUOUS', ok, line: `${hits} matches`, desc: m.desc });
    console.log(`[${m.id}] AMBIGUOUS — find string matches ${hits}x; replace() would rewrite only the first${ok ? ' (EXPECTED: this is the control)' : ' *** NOT EXPECTED ***'}  — ${m.desc}`);
    continue;
  }

  writeFileSync(abs, lf.replace(m.find, m.replace), 'utf8');
  let out = '';
  let code = -1;
  try {
    const r = spawnSync(
      process.platform === 'win32' ? 'node_modules\\.bin\\vitest.cmd' : 'node_modules/.bin/vitest',
      ['run', ...m.suites, '--reporter=dot'],
      { cwd: CONSOLE_ROOT, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    code = r.status;
    out = `${r.stdout || ''}${r.stderr || ''}`;
  } finally {
    writeFileSync(abs, original, 'utf8');
  }

  const clean = out.replace(/\u001b?\[[0-9;]*m/g, '');
  const summary = (clean.match(/^\s*Tests\s+.*$/m) || [''])[0].trim();
  if (!summary) {
    // The runner never reported on a test, so `code` is a statement about the
    // RUNNER, not about the mutation. Refuse to score it.
    const ok = m.expect === 'NO-SUMMARY';
    results.push({ id: m.id, verdict: 'NO-SUMMARY', ok, code, line: '', desc: m.desc });
    console.log(`[${m.id}] NO-SUMMARY (exit ${code}) — the runner emitted no "Tests …" line; its exit code says nothing about the mutation${ok ? ' (EXPECTED: this is the control)' : ' *** NOT EXPECTED ***'}  — ${m.desc}`);
    continue;
  }

  const verdict = code === 0 ? 'GREEN' : 'RED';
  const ok = verdict === m.expect;
  results.push({ id: m.id, verdict, ok, code, line: summary, desc: m.desc });
  const note = ok
    ? (m.expect === 'GREEN' ? '  (EXPECTED: a deliberate survivor)' : '')
    : (verdict === 'GREEN'
      ? '  *** EXPECTED RED — MUTATION SURVIVED, the test is decoration ***'
      : `  *** EXPECTED ${m.expect} ***`);
  console.log(`[${m.id}] ${verdict} (exit ${code}) ${summary}${note}  — ${m.desc}`);
}

const tally = (v) => results.filter((r) => r.verdict === v).length;
const bad = results.filter((r) => !r.ok);

console.log('\n=== SUMMARY ===');
console.log(
  `mutations: ${results.length}   RED: ${tally('RED')}   GREEN(survived): ${tally('GREEN')}   `
  + `SKIPPED(not applied): ${tally('SKIPPED')}   AMBIGUOUS(not unique): ${tally('AMBIGUOUS')}   `
  + `NO-SUMMARY(not measured): ${tally('NO-SUMMARY')}`,
);
for (const r of results) console.log(`  ${r.id}\t${r.verdict}\t${r.ok ? 'as expected' : 'UNEXPECTED'}\t${r.line || ''}`);

if (bad.length) {
  console.error(`\n[ghsa-4gvx-mutations] FAIL — ${bad.length} mutation(s) did not match their expected verdict:`);
  for (const r of bad) console.error(`  ${r.id}: got ${r.verdict}, expected ${MUTATIONS.find((m) => m.id === r.id).expect}`);
  console.error('GREEN means the test cannot detect that defect. SKIPPED / AMBIGUOUS / NO-SUMMARY mean nothing was measured.');
  process.exit(1);
}
console.log('\n[ghsa-4gvx-mutations] OK — every mutation produced its expected verdict, including all four refusal controls.');
