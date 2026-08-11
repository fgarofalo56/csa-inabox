#!/usr/bin/env bash
# =============================================================================
# test-deploy-retry.sh — self-test for the repo's retry primitive
# =============================================================================
#
# deploy-retry.mjs sits in front of EVERY deploy path in this repo (12+ call
# sites across Commercial, GCC, GCC-High, IL5 and the data-plane rolls).
#
# It is NOT untested: scripts/ci/__tests__/deploy-retry.test.mjs has 30 passing
# cases. But every one of them tests a PURE EXPORTED FUNCTION — decideRetry,
# decideRetryForLeaves, parseDuration, backoff. Nothing ran the process, so
# nothing covered how the child is spawned or which of its streams is read.
#
# That is precisely where the defect below lived: perfect coverage of the
# decision, zero coverage of the INPUT to the decision. This file tests the
# process end-to-end — spawn, streams, exit codes — which is the layer the
# unit tests cannot reach.
#
# Runs OFFLINE against stub commands. Asserts EXIT CODES, because that is what
# the workflows branch on, and asserts the failure report contains the evidence
# rather than an empty block.
#
# THE CASE THAT MATTERS is 4: a failure printed on STDOUT. `az acr build`
# streams the ACR Tasks runner's output — including `denied: client with IP …`
# — to stdout, not stderr. deploy-retry captured stderr only, so on run
# 31489538101 it printed an EMPTY stderr block and reported:
#
#     ##[error]Could not classify this failure … Unknown fails closed.
#
# while `deploy-classify.mjs --query` names that exact string `config` /
# `config.acr-unreachable` with a full remediation. A correct classifier fed the
# wrong stream reports UNKNOWN on something it can name — and UNKNOWN is the
# class this repo has already been burned by reading as a negative.
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RETRY="$HERE/deploy-retry.mjs"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

# A stub whose stream, message and exit code are chosen by the environment, and
# which records every invocation so "did it retry?" is measured, not inferred.
#
# WRITTEN IN NODE, not bash, and invoked as `node stub.mjs`. deploy-retry spawns
# with shell:false, and Windows does not honour a shebang — a `.sh` stub fails
# to spawn at all there, which made the FIRST version of this test report the
# spawn failure's exit 17 for every case. Two of those reads were false passes.
cat > "$WORK/stub.mjs" <<'STUB'
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_CALLS, 'invoked\n');
if (process.env.STUB_STDOUT) process.stdout.write(`${process.env.STUB_STDOUT}\n`);
if (process.env.STUB_STDERR) process.stderr.write(`${process.env.STUB_STDERR}\n`);
process.exit(Number(process.env.STUB_RC ?? 1));
STUB

ACR_DENY="denied: client with IP '172.212.129.1' is not allowed access. Refer to https://aka.ms/acr/firewall"
THROTTLE="ERROR: (TooManyRequests) The request is being throttled."

# run <label> — reads STUB_* from the environment, returns the exit code and
# leaves combined output in $OUT. --backoff 0 keeps the test instant.
run() {
  : > "$WORK/calls.txt"
  OUT="$(STUB_CALLS="$WORK/calls.txt" node "$RETRY" \
      --step "selftest" --max-attempts "${ATTEMPTS:-1}" --backoff 0 --jitter 0 \
      -- node "$WORK/stub.mjs" 2>&1)"
  RC=$?
  CALLS="$(wc -l < "$WORK/calls.txt" | tr -d '[:space:]')"
}

echo "== deploy-retry self-test =="

# 1. HAPPY PATH: success runs the command exactly once and exits 0. A retry
#    primitive that re-runs a SUCCESSFUL deploy would be far worse than one that
#    gives up early, so this is asserted before anything else.
STUB_RC=0 STUB_STDOUT="all good" run
[ $RC -eq 0 ] && pass "success => exit 0" || fail "expected 0, got $RC"
[ "$CALLS" = "1" ] && pass "success => exactly ONE invocation, no retry" || fail "ran $CALLS times on success"
echo "$OUT" | grep -q "all good" && pass "child stdout reaches the caller" || fail "child stdout was swallowed"

# 2. A non-retryable failure on STDERR is classified and fails closed with the
#    class's own exit code (config = 15), without burning attempts.
ATTEMPTS=3 STUB_RC=1 STUB_STDERR="$ACR_DENY" run
[ $RC -eq 15 ] && pass "non-retryable on stderr => class exit 15 (config)" || fail "expected 15, got $RC"
[ "$CALLS" = "1" ] && pass "non-retryable => no pointless retries" || fail "retried $CALLS times on a deterministic failure"

# 3. A retryable failure is retried to the attempt budget, then fails closed.
ATTEMPTS=3 STUB_RC=1 STUB_STDERR="$THROTTLE" run
[ $RC -eq 10 ] && pass "retryable on stderr => class exit 10 (transient)" || fail "expected 10, got $RC"
[ "$CALLS" = "3" ] && pass "retryable => exhausts the 3-attempt budget" || fail "expected 3 attempts, got $CALLS"

# 4. THE DEFECT. Same failure, printed on STDOUT — which is where `az acr build`
#    puts it. Must classify identically. Before the fix this returned 17
#    (unknown) with an empty stderr block.
ATTEMPTS=1 STUB_RC=1 STUB_STDOUT="$ACR_DENY" run
[ $RC -eq 15 ] && pass "same failure on STDOUT => same class exit 15" || fail "expected 15, got $RC (stdout is not being classified)"
if echo "$OUT" | grep -qi "could not classify"; then
  fail "reported UNKNOWN for a string the taxonomy names — the run-31489538101 defect"
else
  pass "does not report UNKNOWN for a classifiable stdout failure"
fi
echo "$OUT" | grep -q "172.212.129.1" && pass "the evidence appears in the report" || fail "failed with an EMPTY evidence block"

# 5. PRECEDENCE, so the fix cannot make things worse: when stderr already yields
#    a class, stdout must not be able to override it. A build log mentioning a
#    throttle must not downgrade a real permission failure into a retry —
#    retrying a permission error is how a 3-minute failure becomes a 30-minute
#    one.
ATTEMPTS=2 STUB_RC=1 STUB_STDERR="ERROR: (AuthorizationFailed) does not have authorization" \
  STUB_STDOUT="$THROTTLE" run
[ $RC -eq 13 ] && pass "stderr keeps precedence over stdout (permission, exit 13)" || fail "expected 13, got $RC"
[ "$CALLS" = "1" ] && pass "a stdout throttle cannot make a permission failure retryable" || fail "retried $CALLS times — stdout hijacked the diagnosis"

# 6. A genuinely unclassifiable failure STILL fails closed as unknown (17). The
#    fix must not invent a class from noise.
ATTEMPTS=1 STUB_RC=1 STUB_STDOUT="lorem ipsum dolor sit amet" run
[ $RC -eq 17 ] && pass "unclassifiable => still exit 17, fails closed" || fail "expected 17, got $RC"

# 7. A missing binary is a real failure with no output at all, and must not be
#    classified from an empty string.
: > "$WORK/calls.txt"
OUT="$(node "$RETRY" --step selftest --max-attempts 1 --backoff 0 -- "$WORK/does-not-exist-binary" 2>&1)"; RC=$?
[ $RC -ne 0 ] && pass "missing binary => non-zero exit ($RC)" || fail "a missing binary reported success"
echo "$OUT" | grep -qiE "ENOENT|no such file|spawn" && pass "says the binary could not be run" || fail "no reason given for the spawn failure"

echo
if [ $FAILED -eq 0 ]; then echo "deploy-retry: ALL CASES PASS"; else echo "deploy-retry: FAILURES ABOVE"; fi
exit $FAILED
