/**
 * Teeth for check-role-guid-consistency.mjs (#3608).
 *
 * The point of these is NOT that the guard reports something — a guard that
 * cannot report nothing is as useless as one that cannot report something. Each
 * block below pairs a case that MUST be found with a case that MUST NOT be, so
 * a matcher that has degenerated into "always fire" or "never fire" fails here.
 *
 * Every wrong case is ADDITIVE: the fixture also contains a correct binding, so
 * the guard has to distinguish them rather than merely notice that the file is
 * non-empty. Replacing the only entry would trip the population floor and read
 * as proven while proving nothing.
 *
 * Run: node --test scripts/ci/__tests__/check-role-guid-consistency.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL,
  ALIASES,
  CONTROLS,
  REPO_SHAPES,
  NEAR_MISS_PREFIX,
  OBJECT_WINDOW,
  normalise,
  labelCandidates,
  resolveLabel,
  harvest,
  evaluate,
  tableFaults,
  controlFaults,
  repoShapeFaults,
  scan,
  scanFiles,
  SCAN_ROOTS,
  REPO_ROOT,
} from '../check-role-guid-consistency.mjs';

const CONTRIB = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const READER = 'acdd72a7-3385-48ef-bd42-f606fba81ae7';
const BLOB_CONTRIB = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
/** The value that actually shipped in lz-rbac.ts. */
const BAD_CONTRIB = 'b24988ac-6180-42a0-bb6f-b91a8f3d3d0e';

function run(source, file = 'fixture.ts') {
  const { pairs, unparsed } = harvest(source, file);
  return { ...evaluate(pairs), pairs, unparsed };
}
const checks = (r, id) => r.findings.filter((f) => f.check === id);

// ── the repo scan: a directory listing is a SNAPSHOT ─────────────────────────

/**
 * How many vanished-file events ONE repo scan may absorb before this suite
 * calls it churn rather than a race. "A couple" — the expected value is ZERO.
 */
const VANISH_BUDGET = 2;
/** Every path that was listed by scanFiles() and gone by the time it was read. */
const vanished = [];

/**
 * scan() the real repo, tolerating a file that disappeared between the
 * directory listing and the read.
 *
 * ── WHY THIS IS NEEDED ─────────────────────────────────────────────────────
 * scanFiles() lists a tree and inventory() then opens what it listed. Those are
 * two moments, and anything can happen in between — an editor's atomic-rename
 * save, a build cleaning an output, a git operation, or (the case that actually
 * bit) a CONCURRENT SUITE in this same `node --test` invocation writing a
 * temporary file into `scripts/ci` and deleting it again. Measured on PR #3892
 * (run 32613872830), a bicep-only change:
 *
 *   not ok 278 - the repo is clean — every resolved binding carries its documented id
 *     error: "ENOENT: no such file or directory, open
 *             '…/scripts/ci/deploy-fiab-guard.__control__.mjs'"
 *
 * The two harnesses that wrote those files now write them to a temp directory
 * instead, which removes THAT cause. This removes the CLASS: a snapshot is a
 * snapshot regardless of who invalidates it, and an unrelated PR going red on a
 * file that was never in its diff is the failure worth preventing.
 *
 * ── WHY IT RETRIES THE SCAN RATHER THAN SKIPPING THE FILE ──────────────────
 * Skipping the unreadable file and continuing is the obvious fix and it is the
 * WRONG one here: a skip silently shrinks the population, which is the
 * zero-population failure this repo keeps rediscovering. Re-running scan()
 * cannot do that — the retry re-LISTS the tree, the transient file is no longer
 * in the listing, and the assertions run against a COMPLETE scan. The tolerance
 * costs a rescan, not a measurement.
 *
 * DO NOT ARGUE THAT THE POPULATION FLOORS WOULD CATCH A SKIP. An earlier
 * revision of this comment said a skip "subtracts from exactly the number those
 * floors watch", implying `pairs >= 100` / `resolved >= 80` were the safety
 * net. MEASURED, by dropping one scan root at a time (#3912):
 *
 *     dropped root          pairs / resolved   verdict
 *     (none)                    342 / 155       pass
 *     platform/fiab/bicep       157 /  74       TRIPS
 *     apps/fiab-console         269 / 115       pass
 *     scripts                   290 / 130       pass
 *     .github                   310 / 146       pass
 *
 * You have to lose the BICEP tree — 185 of 342 bindings — before the floors say
 * anything. A partial scan that dropped the whole `scripts` root, i.e. the root
 * this race actually happens in, passes at 290/130 with `vanished` reporting 0.
 * The floors are ~3.4x looser than that sentence claimed, and stating a
 * stronger property than was tested is the R7 error this guard exists to catch.
 *
 * So the "retry, never skip" decision does NOT rest on this paragraph. It rests
 * on assertions below — and it is worth being exact about what each one can and
 * cannot see, because an earlier revision of this comment named only the first
 * and closed with "Prose is not a guard; that assertion is." That sentence was
 * true only of the WHOLE-ROOT mutation its author had defined, and "retry,
 * never skip" is a PER-FILE property. Measured, running that per-root assertion
 * IN ISOLATION so no other test can mask it: dropping only `scripts/ci` — 27
 * bindings, and the directory this race actually happens in — left it at RC=0,
 * pass=1, fail=0, because `scripts/csa-loom`'s 25 bindings keep
 * `some(startsWith('scripts/'))` true. So did dropping the single file those 27
 * come from. Only the whole `scripts` root moved it (RC=1). Restating a
 * stronger property than was tested is the R7 error this guard exists to catch,
 * and it had been made in the paragraph lecturing about it.
 *
 * What actually enforces the decision, at the granularity each one has:
 *
 *   - `the real repo yields a substantial, resolvable population` asserts every
 *     SCAN ROOT contributed. Granularity: WHOLE ROOT. It trips on a dropped
 *     `scripts`; it does NOT trip on a dropped `scripts/ci`.
 *   - `every file that CAN contribute a binding DID` closes that gap at PER-FILE
 *     granularity, by re-composing scanFiles() and harvest() here and comparing
 *     the resulting file sets against the scan's. Dropping any file that yields
 *     a pair, an unparsed entry or a near-miss trips it — including the single
 *     file all 27 `scripts/ci` bindings come from. It is NOT sensitive to
 *     dropping a file that yields none of the three; that file cannot change
 *     the verdict, and the oracle re-derives from the tree each run, so it
 *     starts being covered the moment it gains a binding.
 *   - Neither can see a `scanFiles()` that quietly stops listing a subtree,
 *     because BOTH derive their expectation from scanFiles(). That leg is the
 *     pinned listing sentinels in the same test: narrower — four named files —
 *     but genuinely independent of the listing under test.
 *
 * The tolerance is bounded and DISCLOSED either way: every vanished path is
 * recorded, the count is reported and asserted small by the test below, and a
 * fourth event stops retrying and rethrows with the whole list attached rather
 * than looping on a tree that is genuinely being churned.
 *
 * Memoised because all three repo-anchored tests want the same measurement and
 * one scan takes ~5s: one scan is cheaper AND is one third of the exposure.
 */
let scanned = null;
function scanRepo() {
  if (scanned) return scanned;
  scanned = scanTolerantly(() => scan(), vanished, VANISH_BUDGET, SCAN_ROOTS);
  return scanned;
}

/**
 * The vanish-tolerant retry loop itself, PARAMETERISED over its scan function,
 * its record sink, its budget and the root names it reports.
 *
 * ── WHY IT IS A PARAMETER RATHER THAN A CLOSURE ────────────────────────────
 * In a clean run NOTHING vanishes, so every shipped assertion about this
 * machinery reads `0 <= 2` and cannot move. Measured, running the disclosure
 * test IN ISOLATION so no other test can mask it, three separate mutations OF
 * THE MACHINERY all left it at RC=0, pass=1, fail=0:
 *
 *     deleting the recorder            (sink.push(...) -> no-op)       RC=0
 *     deleting the tolerance           (catch -> always rethrow)       RC=0
 *     VANISH_BUDGET = Infinity         (what the failure text forbids) RC=0
 *
 * The verdict did not move for any of them, and that silence WAS the finding.
 * The author had exercised all four regions by hand with an external churner,
 * but nothing automated shipped — `guard_with_zero_population_needs_embedded
 * _control` verbatim.
 *
 * `EMBEDDED CONTROL — the vanish tolerance ...` below fabricates vanish events
 * and calls THIS function, so it exercises the shipped loop rather than a copy
 * of it. A control over a copy proves only that the copy works.
 */
function scanTolerantly(scanFn, sink, budget, roots) {
  for (;;) {
    try {
      return scanFn();
    } catch (err) {
      // ENOENT and EPERM are BOTH produced by THIS race. Anything else —
      // EACCES, EISDIR, a malformed read — is a real fault and must not be
      // retried into silence.
      //
      // WHAT IS ESTABLISHED (measurements in #3912). On a Windows workstation,
      // when ANOTHER PROCESS is creating and deleting names in a scanned
      // directory, a raced read returns EPERM at a substantial rate: ~3,400
      // EPERM across ~85,000 raced reads — 1.5% under heavy churn, 12% under
      // light churn — with zero EBUSY anywhere. This branch is genuinely
      // reachable, and deleting it reintroduces an unhandled crash.
      //
      // WHAT IS NOT ESTABLISHED: WHY Windows returns EPERM here rather than
      // ENOENT. The obvious hypothesis is delete-pending — unlink with another
      // handle still open leaves the entry listed, and an open inside that
      // window fails ERROR_DELETE_PENDING. That hypothesis was TESTED AND
      // FALSIFIED: the textbook delete-pending setup, cross-process, returned
      // ENOENT 92,506 times out of 92,506. Also ruled out — the create/truncate
      // window and interference from the security stack (create-only churn,
      // no deletes: 17,608 raced reads over ~73,000 writes, zero errors); and
      // single-process unlink→open (41,184 raced reads, 100% ENOENT), which is
      // why the first attempt to reproduce this saw nothing. Cross-process is
      // the variable that matters; the kernel-level cause is unknown.
      //
      // An earlier revision of this comment asserted delete-pending AS the
      // cause and said POSIX-semantics delete made EPERM unreachable. Both were
      // wrong, and the second is the dangerous kind of wrong — it argues for
      // narrowing this catch back to ENOENT-only. R7: if the code does not
      // know, it says it does not know.
      //
      // Do not narrow it back because "CI is green": loom-guardrails.yml:68 is
      // `runs-on: ubuntu-latest`, where unlink→open is always ENOENT, so an
      // ENOENT-only catch reads correct forever in CI and rethrows unhandled on
      // the Windows workstation every agent in this repo actually works on.
      //
      // And do not narrow it back because you ran the suite under churn and saw
      // only ENOENT. THIS FUNCTION IS A TERRIBLE INSTRUMENT FOR THAT QUESTION:
      // the first error aborts the scan, so one run samples ~1-3 raced reads
      // against the ~85,000 the rate above was measured over. At 1.5-12%,
      // seeing no EPERM in a handful of samples is the expected outcome and
      // establishes nothing. Measure it with a dedicated harness or not at all.
      if (err?.code !== 'ENOENT' && err?.code !== 'EPERM') throw err;
      // The code is recorded next to the path because the two codes are not the
      // same event and this suite cannot tell which occurred from the path
      // alone. The record says what was seen; it does not name a cause.
      sink.push(`${err.path ?? '<unnamed>'} (${err.code})`);
      if (sink.length > budget + 1) {
        err.message = `${err.message}\n  ${sink.length} file(s) went unreadable between the directory `
          + `listing and the read across as many rescans, so this is not a one-off race — something is `
          + `writing into a scanned tree (${roots.join(', ')}) while the tests run. Each error code is `
          + `recorded below; this does NOT establish why Windows returns one rather than the other:`
          + `\n    ${sink.join('\n    ')}`;
        throw err;
      }
    }
  }
}

// ── the reference table and the embedded controls ───────────────────────────

test('the canonical table is internally sound', () => {
  assert.deepEqual(tableFaults(), []);
});

test('every embedded control holds', () => {
  assert.deepEqual(controlFaults(), []);
});

test('the canonical table pins the documented Contributor id', () => {
  // The one fact this whole guard exists for. If this line is ever "corrected"
  // to the shipped value, everything below it becomes theatre.
  assert.equal(new Map(CANONICAL).get('Contributor'), CONTRIB);
  assert.notEqual(new Map(CANONICAL).get('Contributor'), BAD_CONTRIB);
});

test('every alias points at a role that exists and is stored normalised', () => {
  const names = new Set(CANONICAL.map(([n]) => n));
  for (const [alias, name] of ALIASES) {
    assert.ok(names.has(name), `alias ${alias} -> unknown role ${name}`);
    assert.equal(normalise(alias), alias);
  }
});

// ── C1: the mismatch, in every harvest shape ────────────────────────────────

test('C1 flags a wrong id in an object literal and leaves its correct siblings alone', () => {
  const r = run([
    "export const R = [",
    "  { name: 'Contributor',",
    `    guid: '${BAD_CONTRIB}' },`,
    "  { name: 'Storage Blob Data Contributor',",
    `    guid: '${BLOB_CONTRIB}' },`,
    "];",
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3, 'must point at the offending line');
  assert.match(c1[0].detail, /Contributor/);
  assert.match(c1[0].detail, new RegExp(CONTRIB), 'must name the id it expected');
  assert.equal(r.resolved, 2, 'the correct sibling stays in the population');
});

test('C1 flags a wrong id bound to a declaration identifier', () => {
  const r = run([
    `var contributorRoleId = '${READER}'`,
    `var readerRoleId = '${READER}'`,
  ].join('\n'), 'm.bicep');
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 1);
  assert.equal(c1[0].file, 'm.bicep', 'the finding must name the file');
});

test('C1 flags a wrong id bound to a shell/YAML env assignment', () => {
  const r = run([
    `CONTRIBUTOR_ROLE_ID="${READER}"`,
    `READER_ROLE_ID="${READER}"`,
  ].join('\n'), 'x.sh');
  assert.equal(checks(r, 'C1').length, 1);
});

test('C1 uses a trailing comment as the label when the identifier says nothing', () => {
  const r = run([
    `const A = '${READER}'; // Contributor`,
    `const B = '${READER}'; // Reader`,
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 1);
});

test('C1 reads a value that sits on the line after the `=`', () => {
  const r = run(['var contributorRoleId =', `  '${READER}'`].join('\n'), 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
});

// ── the shapes the rework review measured as UNREAD ─────────────────────────

test('C1 flags a wrong id in a name-keyed map — the shape that was silently green', () => {
  // Verbatim SQL_DATABASE_ROLES, a live grant path: grantDatabaseRole() does
  // SQL_DATABASE_ROLES[roleNameOrGuid] to pick the id that reaches ARM.
  // Re-introducing #3608's own value here produced exit 0 under the shipped
  // guard, with the population count unchanged — the line was not even residue.
  const r = run([
    'export const SQL_DATABASE_ROLES: Record<string, string> = {',
    `  'Reader':             '${READER}',`,
    `  'Contributor':        '${BAD_CONTRIB}',`,
    "  'SQL DB Contributor': '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec',",
    '};',
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3);
  assert.equal(r.resolved, 3, 'the correct siblings stay in the population');
});

test('a name-keyed map that is correct produces nothing', () => {
  const r = run([
    'const BLOB_DATA_ROLES: Record<string, string> = {',
    `  'Storage Blob Data Contributor':  '${BLOB_CONTRIB}',`,
    "  'Storage Blob Data Owner':        'b7e6dc6d-f1e8-4753-8033-0f276bb0955b',",
    '};',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 2);
});

test('C1 flags a wrong id in an array member labelled by its comment (the Gov lane shape)', () => {
  const r = run([
    '            roles: [',
    `              '${BLOB_CONTRIB}', // Storage Blob Data Contributor`,
    `              '${BLOB_CONTRIB}', // Azure Event Hubs Data Sender`,
    '            ]',
  ].join('\n'), '.github/workflows/gov-workspace-identity.yml');
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1);
  assert.equal(c1[0].line, 3);
  assert.match(c1[0].detail, /Azure Event Hubs Data Sender/);
});

test('C1 flags a wrong id in a one-line object literal', () => {
  const r = run([
    `  { name: 'Contributor', guid: '${READER}' },`,
    `  { name: 'Reader', guid: '${READER}' },`,
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C1')[0].line, 1);
});

test('C1 flags a wrong id in a bicep `param … string = …` default', () => {
  const r = run(`param contributorRoleId string = '${READER}'`, 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
});

test('a WRAPPED subscriptionResourceId call is read, not just the compact one', () => {
  // The bicep formatter splits the call over three lines, which is the dominant
  // formatting in platform/fiab/bicep. A single-line matcher reads the compact
  // form and is silently blind to this one.
  const r = run([
    '    // Contributor',
    '    roleDefinitionId: subscriptionResourceId(',
    "      'Microsoft.Authorization/roleDefinitions',",
    `      '${READER}')`,
  ].join('\n'), 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(r.resolved, 1);
});

test('a comment above one grant is not attributed to the NEXT grant', () => {
  // The label walk must stop at another binding. Both ids here are correct for
  // their own role; if the second inherited "// Contributor" it would be a
  // fabricated finding against a correct line.
  const r = run([
    '  // Contributor',
    `  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${CONTRIB}')`,
    `  roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${READER}')`,
  ].join('\n'), 'm.bicep');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 1, 'only the commented one is judged');
});

// ── #3420: a binding folded across a `\` must not be invisible ──────────────

test('a grant folded across a backslash continuation is READ, not skipped', () => {
  // `scripts/` and `.github/` are scan roots, so `.sh` and `.yml` are in the
  // population, and a shell author folds a long `az` invocation across a
  // trailing `\`. Judged by PHYSICAL line the `roleDefinitions` marker is on
  // one line and the id on the next, mid-line, out of reach of the bare-GUID
  // lookahead — MEASURED against the pre-adoption revision, this fixture
  // produced ZERO pairs and ZERO findings there. A guard that reports clean on
  // a tree carrying the defect is the #3417 class, not a near miss.
  const r = run([
    'az role assignment create --assignee "$OID" \\',
    '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
    `  --id '${READER}' --scope "$SCOPE"   # Contributor`,
  ].join('\n'), 'grant.sh');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
});

test('the same folded grant with the RIGHT id produces nothing', () => {
  // Must-not-fire half. Without it, a matcher that flagged every folded line
  // would look proven by the test above.
  const r = run([
    'az role assignment create --assignee "$OID" \\',
    '  --role-definition-id "$SCOPE/providers/Microsoft.Authorization/roleDefinitions" \\',
    `  --id '${CONTRIB}' --scope "$SCOPE"   # Contributor`,
  ].join('\n'), 'grant.sh');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 1);
});

test('a folded finding still points at the PHYSICAL line the statement starts on', () => {
  // Folding is an analysis device, not a reporting one. If the reported line
  // were the logical index the annotation would land on the wrong code, which
  // is how a true finding gets dismissed as noise.
  const r = run([
    '# a preamble line',
    '# another preamble line',
    'export CONTRIBUTOR_ROLE_ID=\\',
    `  '${READER}'`,
  ].join('\n'), 'grant.sh');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C1')[0].line, 3, 'the `export` is on physical line 3');
});

test('an EVEN run of trailing backslashes does not splice the next line', () => {
  // Over-reach fails the same way under-reach does: splice this and `var …` is
  // no longer at the start of its logical line, DECL_RE stops matching, and a
  // wrong id goes unjudged.
  const r = run([
    'echo "a literal trailing pair" \\\\',
    `var contributorRoleId = '${READER}'`,
  ].join('\n'), 'grant.sh');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
});

// ── S6 with an UNQUOTED value: the YAML half of the name-keyed map ──────────

test('an UNQUOTED YAML map value is read — the live Gov `env:` grant shape', () => {
  // TypeScript and JSON always quote a string, so a matcher validated only
  // against those reads as complete and is blind to YAML, where a scalar is
  // bare. gov-provision-streaming-migrate.yml:96 writes exactly this and
  // :331 spends it on `az role assignment create --role "$BLOB_CONTRIB_ROLE"`.
  // MEASURED with quotes required: planting a wrong id here returned EXIT=0
  // and did not move the population by one.
  const r = run([
    '  # Storage Blob Data Contributor — cloud-invariant built-in role id.',
    `  BLOB_CONTRIB_ROLE: ${READER}`,
  ].join('\n'), 'gov.yml');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
  assert.match(checks(r, 'C1')[0].detail, /does not grant "Storage Blob Data Contributor"/);
});

test('the same unquoted YAML binding with the RIGHT id produces nothing', () => {
  const r = run(`  BLOB_CONTRIB_ROLE: ${BLOB_CONTRIB}`, 'gov.yml');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 1);
});

test('a quoted YAML value still reads — widening the matcher did not narrow it', () => {
  const r = run(`  Contributor: '${READER}'`, 'gov.yml');
  assert.equal(r.resolved, 1);
  assert.equal(checks(r, 'C1').length, 1);
});

test('an unquoted binding whose GUID is neither canonical NOR near-canonical is still SEEN', () => {
  // The sharper half, and the one the residue count could not have surfaced.
  // `unharvested` only records a GUID that is canonical or a near-miss, so a
  // binding to a foreign id — what most wrong GUIDs look like — appeared in NO
  // section of `--list`: not judged, not unjudged, not residue. AcrPull is not
  // in CANONICAL, so this must NOT become a finding; it must become an honest
  // unjudged entry, which is the difference between a disclosed gap and an
  // invisible one.
  const { pairs, unparsed } = harvest('  ACRPULL_ROLE: 7f951dda-4ed3-4680-a7ca-000000000000', 'gov.yml');
  assert.deepEqual(unparsed, []);
  assert.equal(pairs.length, 1, 'the binding must be harvested even though its role is unknown');
  const { findings, resolved, unresolved } = evaluate(pairs);
  assert.deepEqual(findings, [], 'AcrPull is not in the table, so nothing may be asserted about it');
  assert.equal(resolved, 0);
  assert.equal(unresolved.length, 1, 'and it must appear in the honest not-judged list');
});

// ── R7: C1 must not assert an outcome it has not established ────────────────

test('C1 says ARM ACCEPTS the grant when the bound id is another KNOWN role', () => {
  // The rework finding. "every role assignment written from this value is
  // rejected" was false here: ARM resolves by id, finds Reader, and grants
  // Reader — a silent wrong privilege with nothing in any deploy log, which is
  // strictly harder to diagnose than a rejected PUT.
  const r = run(`var contributorRoleId = '${READER}'`, 'm.bicep');
  const [c1] = checks(r, 'C1');
  assert.match(c1.detail, /ACCEPTS this assignment and grants "Reader"/);
  assert.match(c1.detail, /silently, with no error to find/);
  assert.doesNotMatch(c1.detail, /REJECTS every assignment/);
});

test('C1 says it CANNOT TELL when the bound id is outside its partial table', () => {
  // #3608's own value. This guard's table is deliberately partial, so it cannot
  // establish that the id names no role — only that it does not name the one
  // that was written. UNKNOWN must be reported as unknown, not as "rejected".
  const r = run(`var contributorRoleId = '${BAD_CONTRIB}'`, 'm.bicep');
  const [c1] = checks(r, 'C1');
  assert.match(c1.detail, /cannot establish which of two outcomes applies/);
  assert.match(c1.detail, /REJECTS every assignment/);
  assert.match(c1.detail, /ACCEPTS the assignment and grants THAT role/);
  assert.match(c1.detail, /az role definition list/, 'must hand back a way to settle it');
});

test('both C1 wordings state the one thing that IS established', () => {
  for (const guid of [READER, BAD_CONTRIB]) {
    const [c1] = checks(run(`var contributorRoleId = '${guid}'`, 'm.bicep'), 'C1');
    assert.match(c1.detail, /Established either way: this binding does not grant "Contributor"/);
  }
});

// ── the guard must be able to stay silent ───────────────────────────────────

test('a fully correct tree produces nothing', () => {
  const r = run([
    `var contributorRoleId = '${CONTRIB}'`,
    `const RBAC_READER = '${READER}';`,
    `STORAGE_BLOB_DATA_CONTRIBUTOR_ROLE_ID='${BLOB_CONTRIB}'`,
    'const X = {',
    "  name: 'Reader',",
    `  guid: '${READER}',`,
    '};',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 4);
});

test('a role-GUID key with no findable name is recorded as unjudged, not dropped', () => {
  // Silence and invisibility are different failures. This shape yields no
  // verdict, but it must still appear in the residue so `--list` shows it.
  const r = run(['  roleGuid: ' + `'${READER}',`].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].why, /no name key/);
});

test('a GUID that is not a role is not judged (no invented finding)', () => {
  // AzureDatabricks first-party app id, and a Cosmos SQL data role — both are
  // GUID-shaped, neither is an Azure RBAC role definition.
  const r = run([
    "var dbxResource = '2ff814a6-3304-4ab8-85cb-cd0e6f879c1d'",
    "var cosmosDataContributorGuid = '00000000-0000-0000-0000-000000000002'",
  ].join('\n'), 'm.bicep');
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
  assert.equal(r.unresolved.length, 2, 'the residue is reported, not dropped');
});

// ── the specific false pairing found while writing this guard ───────────────

test('an env-var `name:` is not paired with a nearby role GUID', () => {
  // Measured in app-resources.ts: `{ name: 'LOOM_ADLS_ACCOUNT', … }` six lines
  // above a `roleGuid:`. A forward scan from `name:` paired them. Here the
  // decoy is literally spelled "Contributor" — if it were paired, the guard
  // would report a finding against a value that is not a role binding at all.
  const r = run([
    '  envVars: [',
    "    { name: 'Contributor', value: env('X') },",
    '  ],',
    '  grantScope: armId(a, b, c),',
    `  roleGuid: '${READER}',`,
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 0);
});

test('`roleName:` BELOW its `roleGuid:` is still paired', () => {
  const r = run([
    '  grantScope: armId(a, b, c),',
    `  roleGuid: '${READER}',`,
    "  roleName: 'Storage Blob Data Contributor',",
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1, 'the real pair must be judged');
  assert.equal(r.resolved, 1);
});

test('a bare `name:` in a DIFFERENT object is not pulled in', () => {
  // What rejects this is the bracket boundary, not a distance window: the
  // decoy's object opens and closes on its own line, so the span between it and
  // the roleGuid dips out of the enclosing object. The filler is sized past the
  // old window purely so this stays a fair test of the new rule.
  const far = ["    { name: 'Contributor', value: 1 },"];
  for (let i = 0; i < OBJECT_WINDOW - 2; i += 1) far.push('    filler,');
  far.push(`    roleGuid: '${READER}',`);
  const r = run(far.join('\n'));
  assert.equal(r.resolved, 0);
});

test('a bare `name:` in the SAME object is still paired, however far the window allows', () => {
  // The other half. Removing the tight bare-name window would be a regression
  // if it also stopped finding the real thing; it must still pair here, and the
  // binding is wrong, so it must be a finding.
  const r = run([
    '  {',
    "    name: 'Contributor',",
    "    why: 'a',",
    "    why2: 'b',",
    `    guid: '${READER}',`,
    '  },',
  ].join('\n'));
  assert.equal(checks(r, 'C1').length, 1);
  assert.match(checks(r, 'C1')[0].detail, /Contributor/);
});

// ── the false pairing measured on rework: nearest-in-either-direction ────────

test('an object that CLOSES on its guid line does not borrow the next object\'s name', () => {
  // Measured on the shipped guard: with any line between `name:` and `guid:`,
  // the NEXT object's `name:` was strictly nearer and won. Contributor bound to
  // Reader's real id produced NO finding at all — a false negative in the exact
  // name/GUID-swap class this guard exists to catch.
  const r = run([
    'const R = [',
    "  { name: 'Contributor',",
    "    why: 'the DLZ attach needs it',",
    `    guid: '${READER}' },`,
    "  { name: 'Reader',",
    `    guid: '${READER}' },`,
    '];',
  ].join('\n'));
  const c1 = checks(r, 'C1');
  assert.equal(c1.length, 1, 'the wrong binding must be found');
  assert.equal(c1[0].line, 4);
  assert.match(c1[0].detail, /names the built-in role "Contributor"/);
  assert.equal(r.resolved, 2);
});

test('the same layout with CORRECT bindings produces no finding', () => {
  // The other half of the same defect: the shipped guard labelled Contributor's
  // own correct id "Reader" and reported a FALSE C1 on two right answers.
  const r = run([
    'const R = [',
    "  { name: 'Contributor',",
    "    why: 'the DLZ attach needs it',",
    `    guid: '${CONTRIB}' },`,
    "  { name: 'Reader',",
    `    guid: '${READER}' },`,
    '];',
  ].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.resolved, 2);
});

// ── C2: contradictory labels ────────────────────────────────────────────────

test('C2 fires when the identifier and the comment name different roles', () => {
  const r = run(`var contributorRoleId = '${CONTRIB}' // Reader`, 'm.bicep');
  const c2 = checks(r, 'C2');
  assert.equal(c2.length, 1);
  assert.match(c2[0].detail, /Contributor/);
  assert.match(c2[0].detail, /Reader/);
  // It must not also claim to know which is right.
  assert.match(c2[0].detail, /not something this guard can establish/);
});

test('C2 does NOT fire when the identifier and the comment agree', () => {
  const r = run(`var contributorRoleId = '${CONTRIB}' // Contributor`, 'm.bicep');
  assert.deepEqual(r.findings, []);
});

// ── C3: near miss ───────────────────────────────────────────────────────────

test('C3 flags an unlabelled GUID that closely resembles one canonical id', () => {
  const r = run("var frobnicatorRoleId = 'b24988ac-6180-42a0-9999-999999999999'", 'm.bicep');
  const c3 = checks(r, 'C3');
  assert.equal(c3.length, 1);
  // R7: it must describe a resemblance, not assert an intent it cannot prove.
  assert.match(c3[0].detail, /does NOT establish/);
  assert.match(c3[0].detail, /Contributor/);
});

test('C3 stays quiet on an unrelated GUID', () => {
  const r = run("var frobnicatorRoleId = '11111111-2222-3333-4444-555555555555'", 'm.bicep');
  assert.deepEqual(r.findings, []);
});

test('C3 does not double-report a binding C1 already explained', () => {
  const r = run(`var contributorRoleId = '${BAD_CONTRIB}'`, 'm.bicep');
  assert.equal(checks(r, 'C1').length, 1);
  assert.equal(checks(r, 'C3').length, 0);
});

test('NEAR_MISS_PREFIX is long enough that a coincidence is not plausible', () => {
  // 19 chars spans the first three groups: 16 hex digits, 64 bits.
  assert.ok(NEAR_MISS_PREFIX >= 19);
});

// ── label resolution ────────────────────────────────────────────────────────

test('label resolution reaches the same role from every spelling used in-repo', () => {
  for (const spelling of ['Contributor', 'contributorRoleId', 'RBAC_CONTRIBUTOR', 'CONTRIBUTOR_ROLE_ID', 'contributor']) {
    assert.equal(resolveLabel(spelling)?.name, 'Contributor', spelling);
  }
  for (const spelling of ['storageBlobDataContributorRoleId', 'blobDataContributorGuid', 'Storage Blob Data Contributor']) {
    assert.equal(resolveLabel(spelling)?.name, 'Storage Blob Data Contributor', spelling);
  }
});

test('a trailing parenthetical note does not defeat resolution', () => {
  assert.equal(resolveLabel('Storage Blob Data Reader (global built-in)')?.name, 'Storage Blob Data Reader');
});

test('a label that names nothing known resolves to null, not to a guess', () => {
  for (const s of ['dbxResource', 'SENTINEL_APP_ID', 'WORKSPACE_ID', 'placeholder', '']) {
    assert.equal(resolveLabel(s), null, s);
  }
});

test('candidate generation never yields an empty key', () => {
  for (const s of ['ROLE', 'role', 'guid', 'id', 'RoleId', '']) {
    assert.ok(!labelCandidates(s).includes(''), s);
  }
});

// ── F5: an unreadable value is UNKNOWN, never assumed safe ──────────────────

test('a known role identifier with an empty value is surfaced, not skipped', () => {
  const { unparsed } = harvest('var contributorRoleId =\n\n\n\nvar other = 1', 'm.bicep');
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].ident, 'contributorRoleId');
});

test('an UNKNOWN identifier with an empty value is not reported (nothing to claim)', () => {
  const { unparsed } = harvest('var somethingElse =\n\n\n\nvar other = 1', 'm.bicep');
  assert.deepEqual(unparsed, []);
});

// ── scope + floors ──────────────────────────────────────────────────────────

test('test files are out of scope — their GUIDs are fixtures, not grants', () => {
  const files = scanFiles().map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(!f.includes('__tests__/'), f);
    assert.ok(!/\.(test|spec)\./.test(f), f);
  }
});

test('the guard does not harvest its own reference table', () => {
  const self = 'scripts/ci/check-role-guid-consistency.mjs';
  const { pairs } = scanRepo();
  assert.equal(pairs.filter((p) => p.file === self).length, 0);
});

test('the real repo yields a substantial, resolvable population', () => {
  // The floors in main() are `> 0`; this asserts the tree is genuinely being
  // read, so a matcher that silently degrades to a handful of hits is visible
  // here even while the binary floor still passes.
  const { pairs, resolved } = scanRepo();
  assert.ok(pairs.length >= 100, `only ${pairs.length} bindings harvested`);
  assert.ok(resolved >= 80, `only ${resolved} bindings resolved`);

  // EVERY SCAN ROOT MUST CONTRIBUTE — this is what actually enforces
  // scanRepo()'s "retry, never skip" decision, and it is here because the two
  // floors above DO NOT. Measured by dropping one root at a time (#3912):
  //
  //     dropped root          pairs / resolved   the floors above say
  //     (none)                    342 / 155       pass
  //     platform/fiab/bicep       157 /  74       TRIPS
  //     apps/fiab-console         269 / 115       pass
  //     scripts                   290 / 130       pass   <- where the race is
  //     .github                   310 / 146       pass
  //
  // So a scanRepo() mutated to give up quietly and return a PARTIAL scan —
  // drop the affected root, never record it in `vanished` — passes 4/4 with
  // `vanished` reporting 0, at 290/130, with the entire `scripts` tree missing.
  // Per-root contributions are 185 / 73 / 52 / 32, so none of these is a
  // zero-population assertion.
  //
  // Keyed on `${root}/` and not a bare prefix: `startsWith('scripts')` would
  // also accept a hypothetical `scripts-other/`, the sibling-directory trap
  // this repo already pays for elsewhere.
  for (const root of SCAN_ROOTS) {
    assert.ok(
      pairs.some((p) => p.file.startsWith(`${root}/`)),
      `no bindings harvested from ${root} — the scan is PARTIAL, not clean. The totals above can still pass `
        + 'with a whole root missing, so this is the assertion that catches it. Something dropped a scan root: '
        + 'do NOT delete this check, find what stopped reading that tree.',
    );
  }
});

test('the repo is clean — every resolved binding carries its documented id', () => {
  // The baseline half of the mutation proof, pinned so a regression is a test
  // failure and not just a red CI step somebody reruns.
  const { findings } = scanRepo();
  assert.deepEqual(findings.map((f) => `${f.check} ${f.file}:${f.line}`), []);
});

test('the repo scan absorbed at most a couple of vanished files, and names them', (t) => {
  // The disclosure half of scanRepo()'s ENOENT tolerance. Without this, "the
  // listing can go stale" would be an unbounded, silent licence — and a
  // scanner that swallows every read error is the zero-population failure this
  // repo keeps rediscovering, wearing a different hat.
  //
  // Declared AFTER the three tests above so it reports on their scan (node:test
  // runs a file's top-level tests in declaration order); the call is here too
  // so this still measures something when run with --test-name-pattern.
  scanRepo();
  t.diagnostic(
    `files that went unreadable between the directory listing and the read: ${vanished.length}`
      + (vanished.length > 0 ? ` — ${vanished.join(', ')}` : ''),
  );
  assert.ok(
    vanished.length <= VANISH_BUDGET,
    `${vanished.length} file(s) went unreadable mid-scan, over a budget of ${VANISH_BUDGET}. The EXPECTED `
      + 'value is ZERO: the two suites that used to write a transient `*.__control__.mjs` into scripts/ci now '
      + 'write it to a temp directory. More than a couple means something is writing into a scanned tree '
      + 'again — fix that, do NOT raise the budget:'
      + `\n    ${vanished.join('\n    ')}`,
  );
});

test('every file that CAN contribute a binding DID — per FILE, not per root', (t) => {
  const { pairs, unparsed, unharvested } = scanRepo();
  const listed = scanFiles();
  const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  const listedRel = new Set(listed.map(rel));

  // ── LEG 1 — the LISTING, pinned by name. ───────────────────────────────────
  // This test and the per-root assertion above both derive their expectation
  // FROM scanFiles(), so a scanFiles() that quietly stopped descending into a
  // subtree would shrink expectation and result together and neither would
  // notice. These four are the leg that does not share that method: one tracked
  // file per SCAN_ROOT, NAMED rather than derived. Four files wide, not 4863 —
  // narrow on purpose, and honestly narrow. The scripts/ci entry is deliberate:
  // that is the directory the #3892 race happens in, and "drop only scripts/ci"
  // is exactly the mutation the whole-root assertion cannot see.
  const SENTINELS = [
    'platform/fiab/bicep/main.bicep',
    'apps/fiab-console/lib/client-fetch.ts',
    'scripts/ci/deploy-fiab-guard.mjs',
    '.github/workflows/loom-guardrails.yml',
  ];
  for (const s of SENTINELS) {
    assert.ok(
      listedRel.has(s),
      `scanFiles() no longer lists ${s}. Either the scan stopped descending into that tree — which is the `
        + 'defect this sentinel exists to catch — or the file moved, in which case repoint the sentinel at '
        + 'another tracked file under the same root. Do NOT simply delete it.',
    );
  }
  assert.ok(listed.length >= 1000, `scanFiles() listed only ${listed.length} files — the walk is not reaching the tree`);

  // ── LEG 2 — per-FILE completeness of the HARVEST. ──────────────────────────
  // inventory() is scanFiles() + harvest() composed in a loop. This re-composes
  // the SAME two exported primitives here and compares the two file sets.
  //
  // WHAT THIS ESTABLISHES: that no file which yields harvest output was dropped
  // from, or discarded by, that composition — at PER-FILE granularity. Measured
  // with the per-root assertion run in isolation, it stays green (RC=0, pass=1,
  // fail=0) while all 27 of `scripts/ci`'s bindings go missing, because
  // `scripts/csa-loom`'s 25 keep `some(startsWith('scripts/'))` true. Dropping
  // the ONE file those 27 come from trips this test (RC=1, pass=62, fail=1).
  //
  // WHAT IT DOES NOT ESTABLISH, precisely: (1) anything about scanFiles()
  // itself, which both sides share — agreement between two counts that share a
  // method confirms the METHOD, and that gap is LEG 1's, four named files wide;
  // (2) the skipping of a file that yields NO harvest output at all. Measured:
  // of the 4863 listed files, 158 carry a binding and `scripts/ci` has exactly
  // ONE contributor (check-docs-hygiene.mjs, all 27 of its bindings), so
  // dropping e.g. deploy-fiab-guard.mjs — 0 bindings — moves nothing here and
  // this test stays green. That is deliberate rather than overlooked: a file
  // that yields no pair, no unparsed entry and no near-miss cannot change the
  // guard's verdict, and if a later edit gives it one, this oracle re-derives
  // from the tree on every run and will require it from that moment on.
  const SELF = 'scripts/ci/check-role-guid-consistency.mjs';
  assert.ok(listedRel.has(SELF), `${SELF} is not in the listing, so the exemption below is stale and hides a file`);

  const expected = new Set();
  for (const abs of listed) {
    const r = rel(abs);
    // inventory() skips ITSELF — harvesting the reference table would compare
    // CANONICAL against itself and could never fail. That is the ONLY permitted
    // listed-but-not-harvested file, and it is named here so a SECOND exemption
    // added to the guard surfaces as a failure rather than widening this hole.
    if (r === SELF) continue;
    const h = harvest(fs.readFileSync(abs, 'utf8'), r);
    // All THREE outputs, not just pairs: `unparsed` and `unharvested` are read
    // by main() and a dropped file could hide one of those just as easily.
    if (h.pairs.length + h.unparsed.length + h.unharvested.length > 0) expected.add(r);
  }
  const got = new Set([...pairs, ...unparsed, ...unharvested].map((p) => p.file));
  t.diagnostic(`listed ${listed.length} files; ${expected.size} of them yield harvest output; the scan attributed ${got.size}`);

  // The oracle's own population, as a number: an independent pass that silently
  // found nothing would AGREE with a scan that found nothing, which is the
  // zero-population failure wearing yet another hat.
  assert.ok(
    expected.size >= 20,
    `the independent pass found bindings in only ${expected.size} file(s) — the ORACLE is broken, so its `
      + 'agreement with the scan establishes nothing',
  );

  // ONE RESIDUAL SENSITIVITY, stated rather than hidden: the two sides read the
  // tree at two different MOMENTS (scan() first, this pass second). A file that
  // is transiently rewritten in between, by a suite co-scheduled in the same
  // `node --test` invocation, could therefore disagree with itself. Measured on
  // this tree, the remaining in-tree writer is
  // `scripts/ci/__tests__/external-origin-urls.test.mjs`, which swaps
  // `externalOrigin(req.headers)` for `new URL(req.url).origin` in three
  // tracked routes under `apps/fiab-console/app/api` — none of which adds or
  // removes a role-name/GUID pair, so it cannot move either set today. If this
  // assertion ever fires naming a file nobody touched, look there FIRST: it is
  // the same class #3912 fixed, not a partial scan.
  const missing = [...expected].filter((f) => !got.has(f)).sort();
  const extra = [...got].filter((f) => !expected.has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    'these files carry a harvestable binding and were listed by scanFiles(), but contributed NOTHING to the '
      + 'scan — the scan is PARTIAL. The per-root assertion cannot see this; that is why this one exists.',
  );
  assert.deepEqual(
    extra,
    [],
    'the scan harvested bindings from files an independent scanFiles()+harvest() pass does not attribute to '
      + 'it — the two disagree about WHICH files were read, so at least one of them is wrong.',
  );
});

// ── the vanish tolerance: an EMBEDDED CONTROL, because its population is ZERO ─

test('EMBEDDED CONTROL — the vanish tolerance records, retries, bounds, and rethrows', () => {
  // POPULATION. On a clean run `vanished` is EMPTY, so the disclosure assertion
  // above reads `0 <= 2` forever and every branch of scanTolerantly() past the
  // first `return` is unexecuted. Measured with the disclosure test run in
  // isolation, three mutations OF THAT MACHINERY all left it at RC=0, pass=1,
  // fail=0 — deleting the
  // recorder, deleting the tolerance so the catch always rethrows, and setting
  // the budget to Infinity. The verdict did not move for any of them. These
  // fabricated events are the population that makes them move.
  const raced = (code, p) => Object.assign(new Error(`${code}: fake, open '${p}'`), { code, path: p });

  // (a) ENOENT is ABSORBED, the whole scan is RE-RUN, and the event is RECORDED.
  {
    const sink = [];
    let calls = 0;
    const out = scanTolerantly(() => {
      calls += 1;
      if (calls === 1) throw raced('ENOENT', 'scripts/ci/a.mjs');
      return 'COMPLETE SCAN';
    }, sink, 2, ['scripts']);
    assert.equal(out, 'COMPLETE SCAN');
    assert.equal(calls, 2, 'the tolerance must RETRY the whole scan — skipping the file would shrink the population');
    assert.deepEqual(sink, ['scripts/ci/a.mjs (ENOENT)'], 'the vanished path AND its code must be recorded');
  }

  // (b) EPERM is the OTHER half of the catch and is exercised SEPARATELY, so a
  //     tolerance — or a recorder — narrowed to ENOENT-only goes red HERE. It
  //     would not go red in CI otherwise: loom-guardrails.yml runs
  //     ubuntu-latest, where unlink->open is always ENOENT, so an ENOENT-only
  //     catch reads correct forever there and rethrows unhandled on the Windows
  //     workstation. That asymmetry is the whole reason the catch takes two.
  {
    const sink = [];
    let calls = 0;
    const out = scanTolerantly(() => {
      calls += 1;
      if (calls === 1) throw raced('EPERM', 'scripts/ci/b.mjs');
      return 'COMPLETE SCAN';
    }, sink, 2, ['scripts']);
    assert.equal(out, 'COMPLETE SCAN');
    assert.equal(calls, 2, 'EPERM must be retried exactly as ENOENT is');
    assert.deepEqual(sink, ['scripts/ci/b.mjs (EPERM)'], 'an EPERM event must be recorded, and recorded AS EPERM');
  }

  // (c) any OTHER code is a real fault: NOT retried into silence, NOT recorded
  //     as a vanish, and not relabelled as one.
  {
    const sink = [];
    let calls = 0;
    let thrown = null;
    try {
      scanTolerantly(() => { calls += 1; throw raced('EACCES', 'scripts/ci/c.mjs'); }, sink, 2, ['scripts']);
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'a non-race error must propagate');
    assert.equal(thrown.code, 'EACCES');
    assert.equal(calls, 1, 'a non-race error must NOT be retried');
    assert.deepEqual(sink, [], 'a non-race error must NOT be recorded as a vanished file');
  }

  // (d) past the budget it STOPS retrying and rethrows, naming every path and
  //     the roots. The threshold is pinned as a NUMBER: with a budget of 2 the
  //     FOURTH event is the one that throws, so loosening `> budget + 1` fails
  //     here rather than quietly turning the bound into a suggestion.
  {
    const sink = [];
    let calls = 0;
    let thrown = null;
    try {
      scanTolerantly(() => {
        calls += 1;
        throw raced('ENOENT', `scripts/ci/d${calls}.mjs`);
      }, sink, 2, ['scripts', '.github']);
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'a tree that keeps churning must eventually rethrow, not loop');
    assert.equal(calls, 4, 'with a budget of 2, three events are absorbed and the FOURTH rethrows');
    assert.equal(sink.length, 4);
    assert.match(thrown.message, /4 file\(s\) went unreadable/);
    assert.match(thrown.message, /scripts, \.github/, 'the message must name the roots that were being scanned');
    for (const n of [1, 2, 3, 4]) {
      assert.match(thrown.message, new RegExp(`d${n}\\.mjs`), `the rethrow must list every path, including d${n}`);
    }
    // R7 — the message says what was SEEN and explicitly declines to name a
    // cause for the code. Pinned so a future edit cannot quietly upgrade an
    // observation into a diagnosis.
    assert.match(thrown.message, /does NOT establish why/);
  }
});

test('the vanish budget is a small FINITE number', () => {
  // `VANISH_BUDGET = Infinity` makes the disclosure assertion read
  // `0 <= Infinity` and makes scanTolerantly() retry forever on a tree that is
  // genuinely being churned. Measured with the disclosure test run in
  // isolation, that mutation left it at RC=0, pass=1, fail=0 — its own failure
  // text says "do NOT raise the budget", and nothing enforced it. Prose is not
  // a guard.
  assert.ok(
    Number.isInteger(VANISH_BUDGET) && VANISH_BUDGET >= 0 && VANISH_BUDGET <= 3,
    `VANISH_BUDGET is ${VANISH_BUDGET}. It must be a small finite integer (0-3). Raising it does not fix a `
      + 'churning tree, it hides one — and Infinity turns the retry loop into a hang. Find what is writing '
      + 'into a scanned tree instead.',
  );
});

test('every embedded control has a name and both halves are exercised somewhere', () => {
  // What this DOES prove: each implemented shape still behaves. What it CANNOT
  // prove — and what the old test called "CONTROLS covers every harvest shape
  // the guard claims to read" wrongly implied — is that a shape exists at all.
  // CONTROLS can only exercise shapes the harvester implements, and this
  // assertion reads its ids from that same list, so as a coverage claim it is
  // circular. It caught OBJ_GUID_RE drift; it could never have caught the
  // name-keyed map, which was simply never written. The non-circular half is
  // the repo-anchored test below.
  assert.ok(CONTROLS.length >= 15);
  const ids = new Set(CONTROLS.map((c) => c.id));
  assert.equal(ids.size, CONTROLS.length, 'control ids must be unique');
  const fires = CONTROLS.filter((c) => (c.expect.C1 ?? 0) + (c.expect.C3 ?? 0) > 0).length;
  const silent = CONTROLS.filter((c) => (c.expect.C1 ?? 0) + (c.expect.C3 ?? 0) === 0).length;
  assert.ok(fires > 0 && silent > 0, 'a control set with no silent case cannot detect "always fire"');
});

test('REPO_SHAPES is anchored to the real repo, not to the implementation', () => {
  // The non-circular coverage claim. Its population is the code: every entry is
  // a VERBATIM excerpt that must still exist in the file it names, and the
  // harvester must still read it. Deleting a shape from the harvester turns
  // this red; so does moving the code out from under the sample. This is what
  // would have caught the name-keyed map — SQL_DATABASE_ROLES was in the repo
  // and unread the whole time the old coverage test passed.
  assert.deepEqual(repoShapeFaults(), []);
});

test('REPO_SHAPES covers the live grant paths the rework review reintroduced the defect in', () => {
  // Named explicitly so deleting one is a visible diff and not a silent
  // shrinking of the population. Each of these was measured GREEN under the
  // shipped guard with this story's own bad GUID planted in it.
  const files = REPO_SHAPES.map((s) => s.file);
  for (const need of [
    'apps/fiab-console/lib/azure/azure-sql-client.ts',   // SQL_DATABASE_ROLES -> grantDatabaseRole
    'apps/fiab-console/lib/azure/adls-client.ts',        // BLOB_DATA_ROLES -> grant value + allow-list
    '.github/workflows/gov-workspace-identity.yml',      // the GOV lane, pinned nowhere before this
    'apps/fiab-console/lib/setup/lz-rbac.ts',            // #3608 itself
    // The second GOV lane, and the shape a TS/JSON-only matcher cannot see:
    // YAML does not quote a scalar, so `KEY: <guid>` in a workflow `env:` block
    // read as absent. Consumed at :331 by a real role assignment.
    '.github/workflows/gov-provision-streaming-migrate.yml',
  ]) {
    assert.ok(files.includes(need), `no repo-anchored shape sample for ${need}`);
  }
});

test('a repo shape sample that no longer matches its file is a FAULT, not a pass', () => {
  // The floor must be able to fail, and it must fail for the right reason: a
  // fixture that has drifted away from the code it models is worthless, and
  // this repo has an incident of exactly that.
  const faults = repoShapeFaults(path.join(REPO_ROOT, 'scripts'));
  assert.ok(faults.length > 0, 'pointed at a root with none of the files, F6 must refuse');
  assert.ok(faults.some((f) => /unreadable|no longer contains/.test(f)), faults.join('\n'));
});

test('F6 does NOT blame the harvester when `resolved` moved because the TABLE grew', () => {
  // R7, in the guard's own output, and the SECOND time this floor has had one.
  // `pairs` and `resolved` used to share the sentence "the harvester has stopped
  // reading a shape the repo still uses". That is true of `pairs` and false of
  // `resolved`, which also moves when CANONICAL/ALIASES changes — and this
  // file's own docstring calls adding a role "a pure improvement". Adding
  // AcrPull took the gov-provision-streaming-migrate anchor from resolved=1 to
  // resolved=2 and reported a regression that had not happened: coverage went
  // UP. A message that asserts a cause the code did not establish is exactly
  // what this guard exists to catch.
  //
  // Driven through the real repoShapeFaults() against a synthetic anchor whose
  // `resolved` expectation is deliberately one too low, so the fault fires for
  // the "more resolved than expected" reason without mutating CANONICAL.
  const shape = {
    id: 'synthetic — resolved moved UP',
    file: '.github/workflows/gov-provision-streaming-migrate.yml',
    excerpt: [
      '  # Storage Blob Data Contributor — cloud-invariant built-in role id.',
      '  BLOB_CONTRIB_ROLE: ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    ],
    expect: { pairs: 1, resolved: 0 },
  };
  const saved = REPO_SHAPES.splice(0, REPO_SHAPES.length, shape);
  let faults;
  try {
    faults = repoShapeFaults();
  } finally {
    REPO_SHAPES.splice(0, REPO_SHAPES.length, ...saved);
  }

  const [msg] = faults;
  assert.ok(msg, 'the floor must still fail — this is not about silencing it');
  assert.match(msg, /expected resolved=0, got 1/);
  // The load-bearing half: it must not assert the harvester regressed.
  assert.doesNotMatch(msg, /harvester has stopped reading/);
  // It must say what it DID establish, and name both causes without picking.
  assert.match(msg, /MORE of this sample's harvested lines now resolve/);
  assert.match(msg, /That is ALL this establishes/);
  assert.match(msg, /REGRESSED/);
  assert.match(msg, /CANONICAL\/ALIASES CHANGED/);
  assert.match(msg, /do NOT relax the check/);
});

test('F6 DOES still blame the harvester when `pairs` moves — that one is its property', () => {
  // The non-weakening half. Only a matcher can change how many bindings a fixed
  // block of text yields, so the original wording is exactly right for `pairs`
  // and must survive the split.
  const shape = {
    id: 'synthetic — pairs moved',
    file: '.github/workflows/gov-provision-streaming-migrate.yml',
    excerpt: [
      '  # Storage Blob Data Contributor — cloud-invariant built-in role id.',
      '  BLOB_CONTRIB_ROLE: ba92f5b4-2d11-453d-a403-e96b0029c9fe',
    ],
    expect: { pairs: 99 },
  };
  const saved = REPO_SHAPES.splice(0, REPO_SHAPES.length, shape);
  let faults;
  try {
    faults = repoShapeFaults();
  } finally {
    REPO_SHAPES.splice(0, REPO_SHAPES.length, ...saved);
  }

  const [msg] = faults;
  assert.ok(msg);
  assert.match(msg, /expected pairs=99, got 1/);
  assert.match(msg, /harvester has stopped reading a shape the repo still uses/);
});

test('importing this module runs no scan as a side effect', () => {
  // check-guard-import-side-effects.mjs enforces the same property statically;
  // reaching this line at all is the runtime half.
  assert.ok(typeof scan === 'function');
  assert.ok(path.isAbsolute(fileURLToPath(import.meta.url)));
});
