#!/usr/bin/env bash
# SELF-TEST for scripts/ci/brain-scan-queue-watchdog.sh (#4014 review).
# ---------------------------------------------------------------------------
# THE TWO DEFECTS THIS PINS, both found by review of the inline version:
#
#   1. A `gh api` failure exited 0 on the FIRST iteration with only a warning.
#      One 403 or one blip and the watchdog was silently absent for that run,
#      while the run stayed green. EXITING 0 IS A CLAIM (deploy-integrity.md
#      R7): a guard that could not measure must not publish a clean verdict.
#
#   2. `TOTAL == 0` printed "a Brain scan job was still QUEUED", which is false.
#      Zero jobs is not a queued job, and the two have different causes — a
#      runner that never picked the job up vs. a `name:` that no longer matches
#      the filter, i.e. a watchdog watching nothing. An R7 violation inside an
#      R7 guard.
#
#   3. An unguarded `jq` left QUEUED/TOTAL as EMPTY strings, so the deadline
#      branch claimed the watchdog had "NEVER saw a job" when in fact it had
#      seen jobs and failed to parse them (review N3 on #4014). Two more arms
#      below pin the new outcome, in both directions.
#
# A retry loop is exactly the kind of thing that quietly becomes a gate that
# CANNOT FAIL, so the arms below run in BOTH directions: the transient case must
# still come out GREEN (or the fix is a blanket tightening that would fail every
# healthy run), and the permanent case must come out RED.
#
# ── "NO WALL-CLOCK WAITING" IS NOW TRUE (review N2 on #4014) ────────────────
# The previous revision of this header made that claim while the `queued` and
# `no-jobs` arms each burned the whole `BUDGET_MINUTES` in real seconds —
# measured at roughly 2.5 minutes for the suite, spawning several hundred stub
# subprocesses. `sleep` was stubbed, but the DEADLINE LOOP still read the real
# clock, so a stubbed sleep only made it spin faster. Correct outcome, false
# claim about the method, in a file whose entire subject is R7.
#
# The script under test now takes `WATCHDOG_VIRTUAL_CLOCK=1`, which advances
# time by POLL_SECONDS per poll instead of reading `date`. Every arm therefore
# drives the REAL loop, the REAL retry ceiling and the REAL deadline branch in a
# bounded number of iterations, WITHOUT waiting on the real clock. Stated
# precisely, because the last version of this claim was not: the suite still
# costs real seconds — on Windows, ~80s of pure subprocess spawn for `gh`, `jq`
# and `sleep` stubs — but it no longer WAITS for anything, which is the property
# that was false before and is asserted below rather than asserted here.
#
# The seam can only make the loop finish sooner — it cannot turn a red outcome
# green — and the arms below assert both directions, so it is not a switch that
# disables the guard.
#
# `gh`, `jq` and `sleep` are all stubbed and COUNTED.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNDER_TEST="$HERE/brain-scan-queue-watchdog.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

export GH_CALLS="$STUB_DIR/gh.calls"
export SLEEP_CALLS="$STUB_DIR/sleep.calls"
export JQ_CALLS="$STUB_DIR/jq.calls"

# ── stub `gh` ───────────────────────────────────────────────────────────────
# GH_MODE:
#   fail-always     every call is a 403 (the permanent case)
#   fail-then-ok    fails FLAKY_N times, then returns a clean job list
#   queued          always returns one job, status "queued"
#   running         always returns one job, status "in_progress"
#   no-jobs         returns a job list with NO job matching the prefix
cat > "$STUB_DIR/gh" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$GH_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$GH_CALLS"
case "${GH_MODE}" in
  fail-always)
    echo "gh: HTTP 403: Resource not accessible by integration" >&2
    exit 1
    ;;
  fail-then-ok)
    if [ "$n" -le "${FLAKY_N:-2}" ]; then
      echo "gh: HTTP 502: Bad gateway" >&2
      exit 1
    fi
    echo '{"jobs":[{"name":"Brain scan - Commercial","status":"completed"}]}'
    ;;
  queued)   echo '{"jobs":[{"name":"Brain scan - Commercial","status":"queued"}]}' ;;
  running)  echo '{"jobs":[{"name":"Brain scan - Commercial","status":"in_progress"}]}' ;;
  no-jobs)  echo '{"jobs":[{"name":"Queue watchdog","status":"in_progress"}]}' ;;
  *) echo "stub gh: unknown GH_MODE '${GH_MODE}'" >&2; exit 99 ;;
esac
STUB

# ── stub `jq` ───────────────────────────────────────────────────────────────
# Real jq is not present in Git Bash, and the point here is the CONTROL FLOW,
# not the filter. It answers the two questions the script asks by grepping the
# stub's own fixed payloads — so a stub that silently answered 0 to everything
# (which would make every arm look like "no jobs") is impossible: the arms below
# distinguish 0 from 1.
#
# JQ_MODE (default "ok"):
#   ok            answer the two questions as above
#   fail-always   exit non-zero with nothing on stdout (the N3 shape)
#   garbage       exit 0 having printed a NON-NUMERIC line — the nastier half of
#                 N3, because a zero exit code makes it look like a reading
cat > "$STUB_DIR/jq" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$JQ_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$JQ_CALLS"
case "${JQ_MODE:-ok}" in
  fail-always)
    echo "jq: error: syntax error, unexpected INVALID_CHARACTER" >&2
    exit 3
    ;;
  garbage)
    echo "null"
    exit 0
    ;;
esac
file="${@: -1}"
body="$(cat "$file")"
want_queued=0
case "$*" in *'status == "queued"'*) want_queued=1 ;; esac
case "$body" in
  *'"name":"Brain scan'*)
    if [ "$want_queued" -eq 1 ]; then
      case "$body" in *'"status":"queued"'*) echo 1 ;; *) echo 0 ;; esac
    else
      echo 1
    fi
    ;;
  *) echo 0 ;;
esac
STUB

# ── stub `sleep` ────────────────────────────────────────────────────────────
# Counts, never waits. A test that actually slept could not run a 20-minute
# budget, and shortening the budget alone would leave the poll interval real.
cat > "$STUB_DIR/sleep" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$SLEEP_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$SLEEP_CALLS"
exit 0
STUB

chmod +x "$STUB_DIR/gh" "$STUB_DIR/jq" "$STUB_DIR/sleep"

PASS=0
FAIL=0
TOTAL_ELAPSED=0
LAST_ELAPSED=0
# Every arm gets this budget. It is named rather than inlined because the
# wall-clock assertion below is stated as a FRACTION of it — an assertion in
# absolute seconds would either be flaky on a slow box or too loose to
# distinguish the virtual clock from the real one.
ARM_BUDGET_MINUTES=3

# run_arm <label> <expected-rc> <GH_MODE> <FLAKY_N> <MAX_API_FAILURES> [JQ_MODE]
#
# `env` rather than a `NAME=value ... bash` prefix: bash decides what is an
# assignment at PARSE time, so a value that arrives by expansion becomes the
# COMMAND word instead and the arm dies with 127 — which reads like the script
# under test failing rather than the harness. `env` resolves them at run time.
#
# WATCHDOG_VIRTUAL_CLOCK=1 with BUDGET_MINUTES=3 / POLL_SECONDS=30 gives every
# arm exactly 6 polls of SIMULATED time — enough for the deepest retry arm
# (FLAKY_N=2 needs three gh calls) and instant on the deadline arms, which
# previously spun on the real clock for the whole budget (N2).
run_arm() {
  local label="$1" expect_rc="$2" mode="$3" flaky="${4:-0}" maxfail="${5:-3}" jqmode="${6:-ok}"
  echo 0 > "$GH_CALLS"; echo 0 > "$SLEEP_CALLS"; echo 0 > "$JQ_CALLS"
  local out rc started
  started=$(date +%s)
  out="$(
    env \
      PATH="$STUB_DIR:$PATH" \
      GH_CALLS="$GH_CALLS" \
      SLEEP_CALLS="$SLEEP_CALLS" \
      JQ_CALLS="$JQ_CALLS" \
      GH_MODE="$mode" \
      JQ_MODE="$jqmode" \
      FLAKY_N="$flaky" \
      GH_TOKEN=stub \
      GITHUB_REPOSITORY=o/r \
      GITHUB_RUN_ID=1 \
      BUDGET_MINUTES="$ARM_BUDGET_MINUTES" \
      POLL_SECONDS=30 \
      WATCHDOG_VIRTUAL_CLOCK=1 \
      MAX_API_FAILURES="$maxfail" \
      MAX_PARSE_FAILURES=3 \
      bash "$UNDER_TEST" 2>&1
  )"
  rc=$?
  LAST_ELAPSED=$(( $(date +%s) - started ))
  TOTAL_ELAPSED=$(( TOTAL_ELAPSED + LAST_ELAPSED ))
  LAST_OUT="$out"
  if [ "$rc" -eq "$expect_rc" ]; then
    printf '  ok   %-52s RC=%s (expected %s)\n' "$label" "$rc" "$expect_rc"
    PASS=$(( PASS + 1 ))
  else
    printf '  FAIL %-52s RC=%s (expected %s)\n' "$label" "$rc" "$expect_rc"
    printf '%s\n' "$out" | sed -n '1,15p' | sed 's/^/       | /'
    FAIL=$(( FAIL + 1 ))
  fi
}

expect_output() {
  local label="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) printf '  ok   %-52s says %s\n' "$label" "\"${needle:0:38}\""; PASS=$(( PASS + 1 )) ;;
    *) printf '  FAIL %-52s did NOT say %s\n' "$label" "\"${needle:0:38}\""; FAIL=$(( FAIL + 1 )) ;;
  esac
}

expect_not_output() {
  local label="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) printf '  FAIL %-52s WRONGLY says %s\n' "$label" "\"${needle:0:38}\""; FAIL=$(( FAIL + 1 )) ;;
    *) printf '  ok   %-52s does not say %s\n' "$label" "\"${needle:0:38}\""; PASS=$(( PASS + 1 )) ;;
  esac
}

echo "== R7: a watchdog that could not MEASURE must not report clean =="

run_arm 'THE FORCED-FAILURE ARM: gh fails always' 1 fail-always 0 3
expect_output 'fail-always' 'FAILING CLOSED'
expect_output 'fail-always' 'established NOTHING'
# It must not blame the scan for its own blindness.
expect_not_output 'fail-always' 'still QUEUED'

run_arm 'CONTROL: a TRANSIENT gh failure still passes' 0 fail-then-ok 2 3
expect_output 'fail-then-ok' 'every scan job has left the queue'
# Proves the retry actually retried rather than the first call happening to work.
if [ "$(cat "$GH_CALLS")" -ge 3 ]; then
  printf '  ok   %-52s retried (%s gh calls)\n' 'fail-then-ok' "$(cat "$GH_CALLS")"
  PASS=$(( PASS + 1 ))
else
  printf '  FAIL %-52s did not retry (%s gh calls)\n' 'fail-then-ok' "$(cat "$GH_CALLS")"
  FAIL=$(( FAIL + 1 ))
fi

run_arm 'CONTROL: failures BELOW the ceiling are not fatal' 0 fail-then-ok 2 5
run_arm 'failures AT the ceiling are fatal' 1 fail-then-ok 99 2

echo
echo "== R7: the deadline message must be TRUE =="

run_arm 'a genuinely QUEUED job is red' 1 queued 0 3
expect_output 'queued' 'still QUEUED after'
# ── THE HEADER'S OWN CLAIM, ASSERTED (N2) ──────────────────────────────────
# "No wall-clock waiting" is a claim, and this file's whole subject is claims
# that are not true. So it is measured, on the arm where it matters: `queued`
# never leaves the queue, so it runs the deadline loop to exhaustion. On the
# real clock that costs the WHOLE budget; on the virtual clock it costs only
# what the stub subprocesses cost.
#
# The threshold is a FRACTION of the budget rather than an absolute, so it is
# the same assertion on a fast Linux runner and a slow Windows box: anything
# under a third of the budget cannot have waited the budget out.
QUEUED_ARM_ELAPSED="$LAST_ELAPSED"
BUDGET_SECONDS=$(( ARM_BUDGET_MINUTES * 60 ))
CEILING=$(( BUDGET_SECONDS / 3 ))
if [ "$QUEUED_ARM_ELAPSED" -lt "$CEILING" ]; then
  printf '  ok   %-52s %ss, well under the %ss budget it exhausted\n' 'the deadline arm did NOT wait on the real clock' "$QUEUED_ARM_ELAPSED" "$BUDGET_SECONDS"
  PASS=$(( PASS + 1 ))
else
  printf '  FAIL %-52s %ss against a %ss budget — the deadline loop is reading the REAL clock again\n' 'the deadline arm did NOT wait on the real clock' "$QUEUED_ARM_ELAPSED" "$BUDGET_SECONDS"
  FAIL=$(( FAIL + 1 ))
fi

run_arm 'ZERO matching jobs is red, and NOT called queued' 1 no-jobs 0 3
expect_output 'no-jobs' 'NEVER saw a job whose name starts with'
# The R7 nit inside the R7 guard: zero jobs is not a queued job.
expect_not_output 'no-jobs' 'still QUEUED after'

echo
echo "== R7 (N3): a PARSE failure is its own outcome, not a reading of zero =="

# `gh` succeeds and returns a job list; `jq` cannot read it. The old code let
# QUEUED/TOTAL become empty strings and then asserted it had NEVER SEEN a
# matching job — false, and it points the reader at the workflow's `name:`
# values when the actual defect is jq or the payload shape.
run_arm 'jq FAILS on a readable job list -> red' 1 queued 0 3 fail-always
expect_output 'jq-fail' 'could NOT PARSE it'
expect_not_output 'jq-fail' 'NEVER saw a job whose name starts with'
expect_not_output 'jq-fail' 'still QUEUED after'
# It must also not claim the API was unreadable — it read it perfectly well.
expect_not_output 'jq-fail' 'could not read this run'"'"'s job list 3 times'

# The nastier half: jq exits 0 and prints something non-numeric. A zero exit
# code makes this look like a successful reading, which is exactly how a control
# stops watching without going red.
run_arm 'jq exits 0 with NON-NUMERIC output -> red' 1 queued 0 3 garbage
expect_output 'jq-garbage' 'could NOT PARSE it'
expect_not_output 'jq-garbage' 'NEVER saw a job whose name starts with'

echo
echo "== the happy path costs nothing =="

run_arm 'CONTROL: a job that left the queue is green' 0 fail-then-ok 0 3
run_arm 'CONTROL: a RUNNING job is green' 0 running 0 3
expect_output 'running' 'every scan job has left the queue'

echo
echo "== the watchdog is wired into the workflow it claims to watch =="
WF="$HERE/../../.github/workflows/loom-brain-scan.yml"
if grep -q 'scripts/ci/brain-scan-queue-watchdog.sh' "$WF"; then
  printf '  ok   %-52s\n' 'the workflow invokes this script'
  PASS=$(( PASS + 1 ))
else
  printf '  FAIL %-52s\n' 'the workflow does NOT invoke this script'
  FAIL=$(( FAIL + 1 ))
fi
# A watchdog keyed to a prefix no job name carries watches nothing. `no-jobs`
# above proves that state goes red; this proves it is not the state we ship.
if grep -q "name: Brain scan" "$WF"; then
  printf '  ok   %-52s\n' 'at least one job name matches the default prefix'
  PASS=$(( PASS + 1 ))
else
  printf '  FAIL %-52s\n' 'NO job name matches JOB_NAME_PREFIX'
  FAIL=$(( FAIL + 1 ))
fi

echo
echo "passed ${PASS}, failed ${FAIL} (${TOTAL_ELAPSED}s of wall clock across all arms)"
[ "$FAIL" -eq 0 ]
