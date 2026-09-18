// Pins the ONE arm of `scripts/csa-loom/check-retired-function-timers.sh` that
// no read-only run can exercise: the host-restart lag after an `--apply` write.
//
// WHY THIS FILE EXISTS. `appsettings set` RESTARTS the Functions host, and the
// script's read 2 (`az functionapp function show --query isDisabled`) reports
// what the host has RECOMPUTED. So on the very run that disables a timer, read
// 2 could still answer with the pre-write value and the script would report its
// own successful fix as a DOUBLE-EXECUTION HAZARD (rc 1). Flagged in PR #4564
// round 6 review, S3.
//
// NO ESTATE CONTACT. Every arm runs against a shim `az` on PATH. The shim is
// asserted to be the one that resolves BEFORE any arm runs — a mis-resolved
// shim falling through to a real `az` is a known failure of this repo's
// harnesses, and it would issue live ARM calls while reporting a clean pass.
//
// BOTH POLARITIES, so no arm is a tautology:
//   converges  — isDisabled false then true  -> rc 0, OK        (the lag arm works)
//   stuck      — isDisabled false forever    -> rc 1, ENABLED   (it FAILS CLOSED)
//   verify-only— no --apply, isDisabled false-> rc 1, ENABLED   (default path unchanged)
//   read-fails — show breaks mid-retry       -> rc 1, isDisabled=<unset>, never "disabled"
//
// Run: node --test scripts/ci/__tests__/retired-function-timers-apply-lag.test.mjs
// CI:  loom-guardrails.yml runs `node --test scripts/ci/__tests__/*.test.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, delimiter } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = resolve(REPO, 'scripts/csa-loom/check-retired-function-timers.sh');

// One target is enough to exercise the arm; the shim answers for whichever is asked.
const SHIM = `#!/usr/bin/env bash
# Shim 'az'. Records a call counter in $AZ_STATE so 'function show' can change
# its answer between reads, which is exactly what a host restart looks like.
#
# AZ_CR=1 appends a CARRIAGE RETURN to the two '-o tsv' reads the script strips
# at :257 and :266 — i.e. it emits what a Windows az actually emits. Only those
# two; the CLOUD and LISTED reads keep their pre-existing strips out of scope so
# a failure here names the right line.
emit() { if [ "\${AZ_CR:-0}" = "1" ]; then printf '%s\\r\\n' "\$1"; else printf '%s\\n' "\$1"; fi; }
sub=""; for a in "\$@"; do case "\$a" in account|functionapp) sub="\$a"; break;; esac; done
case "\$sub" in
  account) echo "AzureCloud"; exit 0 ;;
esac
case "\$*" in
  *"functionapp list"*)
      # AZ_LIST_EMPTY=1 models a list that SUCCEEDS but returns nothing — either
      # the host really is deleted, or the identity cannot read the RG. The
      # script must not treat those as the same thing, so the arms below drive
      # the corroborating 'functionapp show' separately.
      if [ "\${AZ_LIST_EMPTY:-0}" = "1" ]; then printf '\\n'; exit 0; fi
      echo "func-secexp-k6mvh5sm6z7do"; exit 0 ;;
  *"config appsettings set"*)    exit "\${AZ_SET_RC:-0}" ;;
  *"config appsettings list"*)   emit "\${AZ_SETTING_VALUE:-true}"; exit 0 ;;
  *"functionapp function show"*)
      n=\$(( \$(cat "\$AZ_STATE" 2>/dev/null || echo 0) + 1 ))
      echo "\$n" > "\$AZ_STATE"
      if [ "\${AZ_SHOW_FAIL_AT:-0}" = "\$n" ]; then echo "shim: show failed" >&2; exit 1; fi
      if [ "\$n" -ge "\${AZ_SHOW_TRUE_FROM:-999}" ]; then emit "true"; else emit "false"; fi
      exit 0 ;;
  *"functionapp show"*)
      # The HOST-level read used to corroborate an empty listing. The script
      # keys on az's EXIT CODE first (3 = resource-not-found, a contract) and on
      # the message text only as a fallback, so the shim models both — including
      # an az whose prose does NOT match, which is what wording drift or a
      # localised CLI looks like.
      case "\${AZ_SHOW_APP:-found}" in
        found)     exit 0 ;;
        notfound)  echo "(ResourceNotFound) The Resource 'Microsoft.Web/sites/func-secexp-k6mvh5sm6z7do' under resource group 'rg-csa-loom-admin-centralus' was not found." >&2; exit 3 ;;
        notfound_rc_only) echo "la ressource est introuvable" >&2; exit 3 ;;
        forbidden) echo "(AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Web/sites/read' over scope." >&2; exit 1 ;;
        other)     echo "(ServiceUnavailable) the service is temporarily unavailable" >&2; exit 1 ;;
      esac ;;
esac
echo "shim: unhandled az invocation: $*" >&2
exit 64
`;

function makeShimDir() {
  const dir = mkdtempSync(join(tmpdir(), 'op19-lag-'));
  const az = join(dir, 'az');
  writeFileSync(az, SHIM, { mode: 0o755 });
  chmodSync(az, 0o755);
  return dir;
}

function run(env, shimDir) {
  const state = join(shimDir, 'state');
  return spawnSync('bash', [SCRIPT, ...(env.APPLY ? ['--apply'] : [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: shimDir + delimiter + process.env.PATH,
      AZ_STATE: state,
      AZ_SHOW_TRUE_FROM: env.AZ_SHOW_TRUE_FROM ?? '999',
      AZ_SHOW_FAIL_AT: env.AZ_SHOW_FAIL_AT ?? '0',
      AZ_SETTING_VALUE: env.AZ_SETTING_VALUE ?? 'true',
      AZ_SET_RC: env.AZ_SET_RC ?? '0',
      AZ_CR: env.AZ_CR ?? '0',
      AZ_LIST_EMPTY: env.AZ_LIST_EMPTY ?? '0',
      AZ_SHOW_APP: env.AZ_SHOW_APP ?? 'found',
      // Collapses the 5/10/15s backoff to 0/0/0. This is the FAIL-CLOSED
      // direction (the script gives up sooner and reports ENABLED sooner), so
      // the "stuck" and "verify-only" arms below are if anything easier to
      // pass and the "converges" arm is if anything harder. It cannot
      // manufacture the OK verdict the second arm asserts.
      LOOM_OP19_RETRY_UNIT_SECONDS: '0',
    },
  });
}

test('an EMPTY listing corroborated by ResourceNotFound is GONE, and exits 0', () => {
  // Before this arm existed, `gone` was unreachable: the shim's `functionapp
  // list` was hard-coded to return the host, so no test ever drove the absence
  // path at all. A branch with no witness is not covered, whatever the total
  // arm count says.
  //
  // WHAT VALUE MAKES THIS FAIL: the corroborating `show` being dropped, or its
  // ResourceNotFound match being narrowed so a real 404 no longer counts. Then
  // a genuinely deleted host reports UNKNOWN and the job never reaches its
  // terminal good state.
  const dir = makeShimDir();
  try {
    const r = run({ AZ_LIST_EMPTY: '1', AZ_SHOW_APP: 'notfound' }, dir);
    const all = r.stdout + r.stderr;
    assert.match(all, /GONE/, `expected a GONE verdict, got:\n${all}`);
    assert.doesNotMatch(all, /UNKNOWN/, 'a confirmed 404 must not also report UNKNOWN');
    assert.equal(r.status, 0, `a retired host is the terminal GOOD state, rc should be 0:\n${all}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an EMPTY listing that CANNOT be corroborated is UNKNOWN, never GONE (the fail-open)', () => {
  // THE ARM THAT MATTERS. `az functionapp list` exits 0 and returns a FILTERED
  // view when the identity cannot read the resource group, so "absent from a
  // successful listing" conflated "deleted" with "invisible to me" — and the
  // deleted reading is fail-OPEN: rc 0 plus "the double-execution hazard is
  // retired by teardown" for hosts that are still running their timers.
  // Measured on review at the previous head: gone=2, rc 0, for two live hosts.
  //
  // WHAT VALUE MAKES THIS FAIL: restoring the bare `gone=$((gone+1))` on an
  // empty listing. The assertions below then see GONE and rc 0.
  const dir = makeShimDir();
  try {
    const r = run({ AZ_LIST_EMPTY: '1', AZ_SHOW_APP: 'forbidden' }, dir);
    const all = r.stdout + r.stderr;
    assert.match(all, /UNKNOWN/, `an unreadable RG must report UNKNOWN, got:\n${all}`);
    assert.doesNotMatch(all, /GONE/, 'a 403 must NEVER be reported as a deleted host');
    assert.notEqual(r.status, 0, `blindness must not exit 0:\n${all}`);
    // Pair the absence assertion with a positive one: the remediation must name
    // the role and the scope (deploy-integrity.md R6), or the operator is told
    // only that something failed.
    assert.match(all, /Reader/, 'R6: the remediation must name the role to grant');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an EMPTY listing whose host IS found means the listing was incomplete, not absent', () => {
  // The third outcome, and the one easiest to drop: the list was filtered or
  // paged, the host exists, and the script must go on to read its definition
  // rather than scoring the target at all on the strength of the listing.
  //
  // WHAT VALUE MAKES THIS FAIL: a `continue` inserted after the WARN echo, so
  // the target is dropped instead of scored. Measured on review: the absence
  // assertions below do NOT catch that — the mutant survived 10/10 — because
  // "no GONE" and "warning present" are both still true of a dropped target.
  // The ENABLED assertion is what kills it, and it is the reason this arm is
  // coverage rather than decoration (`assertion-design.md` "done" #4: an
  // absence-only assertion is satisfied by deleting the feature).
  //
  // `AZ_SETTING_VALUE: 'false'` means `AzureWebJobs.<fn>.Disabled=false`, i.e.
  // the timer is NOT disabled — so a correct run reaches the ENABLED hazard.
  // A dropped target reaches nothing, and `resolved=$((ok+gone+enabled))` then
  // ignores a live host entirely.
  const dir = makeShimDir();
  try {
    const r = run({ AZ_LIST_EMPTY: '1', AZ_SHOW_APP: 'found', AZ_SETTING_VALUE: 'false' }, dir);
    const all = r.stdout + r.stderr;
    assert.doesNotMatch(all, /GONE/, 'a host a direct read FOUND is not gone');
    assert.match(all, /listing was incomplete/i, `expected the incomplete-listing warning, got:\n${all}`);
    assert.match(all, /ENABLED/, (
      'the run must go on to SCORE the target, not just warn about the listing — '
      + `a dropped target is counted by nothing at all:\n${all}`
    ));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reworded az still reports GONE, because the EXIT CODE is the oracle', () => {
  // The prose match alone fails closed — but it fails closed INTO THE
  // PERMANENTLY RED state: once the OP-19 deletes land, every target depends on
  // reaching GONE, so a reworded or localised `az` would make the terminal good
  // state unreachable forever. az exits 3 for resource-not-found and that is a
  // contract, so it is checked first.
  //
  // WHAT VALUE MAKES THIS FAIL: dropping the `[ "$SHOW_RC" -eq 3 ]` arm and
  // keeping only the grep. This fixture's message matches no English pattern.
  const dir = makeShimDir();
  try {
    const r = run({ AZ_LIST_EMPTY: '1', AZ_SHOW_APP: 'notfound_rc_only' }, dir);
    const all = r.stdout + r.stderr;
    assert.match(all, /GONE/, `rc=3 must establish absence on its own:\n${all}`);
    assert.equal(r.status, 0, `a retired host is the terminal GOOD state:\n${all}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unclassified failure does NOT print a permission remediation it never established', () => {
  // R7. An earlier revision printed "Grant the running identity Reader on <RG>"
  // on EVERY non-404 — asserting a cause the code had not determined. A 503 is
  // not a permission problem and saying so sends the operator to the wrong fix.
  //
  // WHAT VALUE MAKES THIS FAIL: collapsing the AuthorizationFailed arm and the
  // catch-all back into one branch. The Reader string then appears here too.
  const dir = makeShimDir();
  try {
    const r = run({ AZ_LIST_EMPTY: '1', AZ_SHOW_APP: 'other' }, dir);
    const all = r.stdout + r.stderr;
    assert.match(all, /UNKNOWN/, `an unclassified failure is UNKNOWN:\n${all}`);
    assert.doesNotMatch(all, /GONE/, 'an unclassified failure is never a deletion');
    assert.doesNotMatch(all, /Grant the running identity Reader/, (
      `R7: a permission remediation was printed for a failure that was not a `
      + `permission failure:\n${all}`
    ));
    // Paired positive: it must still say something actionable rather than going
    // quiet — the absence assertion above is satisfied by printing nothing.
    assert.match(all, /has not classified/, 'the message must name its own uncertainty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shim, not a real az, is what resolves (guards against a live ARM call)', () => {
  // WHAT VALUE MAKES THIS FAIL: a PATH on which the real az wins. Without this
  // arm every result below could have come from the live estate.
  const dir = makeShimDir();
  try {
    const which = spawnSync('bash', ['-c', 'command -v az'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + delimiter + process.env.PATH },
    });
    assert.equal(which.status, 0, `no az resolved at all: ${which.stderr}`);
    assert.ok(
      which.stdout.trim().includes('op19-lag-'),
      `az resolved to ${which.stdout.trim()}, NOT the shim — this file would have hit the real estate`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply: a host that catches up on a later read is OK, not a hazard (the S3 fix)', () => {
  // WHAT VALUE MAKES THIS FAIL: an isDisabled that never flips (covered by the
  // next arm) — or a script that scores read 2 once and never re-reads, which
  // is the pre-fix behaviour and produces rc 1 here.
  const dir = makeShimDir();
  try {
    const r = run({ APPLY: true, AZ_SHOW_TRUE_FROM: '2' }, dir);
    assert.equal(r.status, 0, `expected rc 0 (OK) after the host caught up.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /OK\s+func-secexp/, 'no OK line for the target');
    assert.doesNotMatch(r.stderr, /DOUBLE-EXECUTION HAZARD/, 'reported its own fix as a hazard');
    // Paired positive assertion: absence of the hazard line must not be
    // satisfiable by the script having done nothing.
    assert.match(r.stdout, /targets=3 ok=3 gone=0 enabled=0 unknown=0 applyfail=0/, 'the tally does not show 3 resolved OK targets');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply: a host that never agrees still FAILS CLOSED as ENABLED', () => {
  // WHAT VALUE MAKES THIS FAIL: a retry that eventually gives up and calls it
  // OK. That is the "retry that cannot fail" this repo forbids.
  const dir = makeShimDir();
  try {
    const r = run({ APPLY: true, AZ_SHOW_TRUE_FROM: '999' }, dir);
    assert.equal(r.status, 1, `expected rc 1 (ENABLED).\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /DOUBLE-EXECUTION HAZARD/, 'a genuinely enabled timer was not reported');
    assert.match(r.stderr, /NOT a host-restart lag/, 'the verdict does not say the lag explanation was tested and rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify-only (no --apply): the default read-only path is scored exactly as before', () => {
  // WHAT VALUE MAKES THIS FAIL: a lag arm that runs when nothing was written —
  // it would add 30s per target and could mask a real hazard behind a retry.
  const dir = makeShimDir();
  try {
    const r = run({ APPLY: false, AZ_SHOW_TRUE_FROM: '999' }, dir);
    assert.equal(r.status, 1, `expected rc 1 (ENABLED) on a verify-only run.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /NOT a host-restart lag/, 'the lag arm ran on a run that wrote nothing');
    assert.match(r.stderr, /DOUBLE-EXECUTION HAZARD/, 'the verify-only run did not report the hazard at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture control: AZ_CR=1 really does put a CR on the two tsv reads', () => {
  // WITHOUT THIS ARM THE NEXT ONE IS VACUOUS. If the AZ_CR plumbing breaks —
  // a mis-escaped `\r` in the template literal above is one keystroke away —
  // the shim emits a CLEAN value, the script passes for the wrong reason, and
  // a guard reports green over a fixture that carries no CR at all. That is
  // the blind-instrument class, and it is exactly how this file came to have
  // ZERO CR bytes in 165 lines while the strips it should witness shipped.
  const dir = makeShimDir();
  try {
    const r = spawnSync('bash', [join(dir, 'az'), 'functionapp', 'config', 'appsettings', 'list'], {
      encoding: 'utf8',
      env: { ...process.env, AZ_CR: '1' },
    });
    assert.equal(r.status, 0, `shim exited ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.includes('\r'), `AZ_CR=1 produced no CR: ${JSON.stringify(r.stdout)}`);
    // And the negative half: default off, or every other arm in this file is
    // silently running against CR-tainted values.
    const clean = spawnSync('bash', [join(dir, 'az'), 'functionapp', 'config', 'appsettings', 'list'], {
      encoding: 'utf8',
      env: { ...process.env, AZ_CR: '0' },
    });
    assert.equal(clean.stdout.includes('\r'), false, `AZ_CR=0 still emitted a CR: ${JSON.stringify(clean.stdout)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CR on the two `-o tsv` reads is stripped, so a DISABLED timer is not reported as a hazard', () => {
  // THE ROUND-7 FIX, WITNESSED. `check-retired-function-timers.sh` gained CR
  // strips at :257 (VAL, the app setting) and :266 (SHOWN, isDisabled) and
  // NOTHING exercised them — this file contained no CR byte anywhere, so
  // deleting either strip stayed green. A correct fix with no witness is one
  // edit from being silently reverted.
  //
  // WHAT VALUE MAKES THIS FAIL: deleting either strip. `-o tsv` on Windows az
  // emits "true\r"; the `== "true"` comparisons at the verdict then read
  // FALSE for both operands, and a correctly DISABLED timer is reported as an
  // ENABLED DOUBLE-EXECUTION HAZARD at rc=1 — permanently, on every run from a
  // workstation, which is precisely the persona this script is offered to.
  // Verified RED with each strip removed in a sandbox copy (PR receipt).
  const dir = makeShimDir();
  try {
    const r = run({ APPLY: false, AZ_SHOW_TRUE_FROM: '1', AZ_CR: '1' }, dir);
    assert.equal(r.status, 0, `expected rc 0 (OK) on CR-tainted reads.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /OK\s+func-secexp/, 'no OK line for the target');
    assert.doesNotMatch(r.stderr, /DOUBLE-EXECUTION HAZARD/, 'a CR turned a disabled timer into a reported hazard');
    // Paired positive assertion: "no hazard" must not be satisfiable by the
    // script having resolved nothing.
    assert.match(r.stdout, /targets=3 ok=3 gone=0 enabled=0 unknown=0 applyfail=0/, 'the tally does not show 3 resolved OK targets');
    // And the verdict line must carry the STRIPPED value, not "true\r" — a
    // strip that only fixed the comparison would still publish a bare CR into
    // a workflow log, which is the round-7 injection primitive next door.
    assert.doesNotMatch(r.stdout, /\r/, 'a raw CR survived into the script output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply: a read that BREAKS mid-retry reports <unset>, never "disabled"', () => {
  // WHAT VALUE MAKES THIS FAIL: keeping the stale SHOWN after a failed read,
  // which would let an unreadable host present as a measured one.
  const dir = makeShimDir();
  try {
    const r = run({ APPLY: true, AZ_SHOW_TRUE_FROM: '999', AZ_SHOW_FAIL_AT: '2' }, dir);
    assert.equal(r.status, 1, `expected rc 1.\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /isDisabled=<unset>/, 'a failed re-read did not empty the value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
