#!/usr/bin/env bash
# QUEUE-TIME WATCHDOG for .github/workflows/loom-brain-scan.yml (#3936).
# ---------------------------------------------------------------------------
# `timeout-minutes` bounds a job's EXECUTION, not the time it spends waiting for
# a runner. A job targeting a label no runner serves therefore sits QUEUED — up
# to GitHub's 24-hour ceiling — showing as neither red nor green. A lane that
# never runs and never goes red is the exact failure mode #3936 exists to
# prevent.
#
# This polls the CURRENT run's own job list and FAILS if a scan job is still
# queued past the budget. It does not cancel anything: a late scan that
# eventually runs is still worth having, and the red run is the signal.
#
# ── WHY IT LIVES HERE AND NOT INLINE IN THE WORKFLOW (review of #4014) ──────
# The inline version could not be TESTED, and it needed to be, because it got
# two things wrong that only execution reveals:
#
#   1. A `gh api` failure exited 0 on the FIRST iteration with a warning. One
#      403 or one blip and the watchdog was silently absent for that run —
#      while the run itself stayed green. EXITING 0 IS A CLAIM. Per
#      deploy-integrity.md R7 a guard that could not measure must not publish a
#      clean verdict, so it now RETRIES and then FAILS CLOSED.
#   2. `TOTAL == 0` printed "a Brain scan job was still QUEUED", which is false:
#      zero jobs is not a queued job, and the two need different fixes (a runner
#      that never picked the job up vs. a `name:` that no longer matches this
#      filter). An R7 violation inside an R7 guard.
#   3. A `jq` failure left QUEUED and TOTAL as EMPTY strings. The numeric
#      comparisons then errored under `set +e`, SAW_A_READING stayed 0, and the
#      deadline branch printed "NEVER saw a job whose name starts with…" — which
#      is FALSE: it saw jobs and could not parse them. A third R7 violation
#      inside the R7 guard (review N3 on #4014). A parse failure is now its own
#      outcome, with its own message and its own fail-closed ceiling.
#
# `scripts/ci/test-brain-scan-queue-watchdog.sh` proves all three, with `gh`,
# `jq` and `sleep` stubbed and COUNTED.
#
# ── NO WALL CLOCK IN THE SELF-TEST, AND IT IS NOW TRUE ──────────────────────
# The previous revision of this line claimed "no wall-clock waiting" while the
# `queued` and `no-jobs` arms each burned the entire budget in real seconds
# (review N2 on #4014): `sleep` was stubbed but the DEADLINE LOOP still read
# `date +%s`, so a stubbed sleep just made it spin. Stubbing the thing that
# waits, while leaving the thing that decides when to stop waiting on the real
# clock, is a control that costs what it claims to save.
#
# The clock itself is therefore injectable — see WATCHDOG_VIRTUAL_CLOCK below.
# The self-test drives the REAL loop, the REAL retry ceiling and the REAL
# deadline branch without waiting on the real clock, and it ASSERTS that: the
# deadline arm must finish in under a third of the budget it exhausts.
#
# ── WHY THE BUDGET IS 20 MINUTES AND NOT 2 ──────────────────────────────────
# `loom-aca` is a KEDA-scaled ACA Job that scales FROM ZERO when a job queues —
# brief queueing is its normal, designed behaviour. A preflight demanding a
# runner already be online would fail on the healthy path. 20 minutes is far
# outside a cold start and far inside the 24-hour silent ceiling.
#
# Env (all optional; the defaults are the production values):
#   BUDGET_MINUTES      how long a job may stay queued          (default 20)
#   POLL_SECONDS        seconds between polls                   (default 30)
#   MAX_API_FAILURES    consecutive gh failures before red      (default 5)
#   MAX_PARSE_FAILURES  consecutive jq failures before red      (default 3)
#   JOB_NAME_PREFIX     which jobs this watches                 (default "Brain scan")
#   WATCHDOG_VIRTUAL_CLOCK  "1" advances time by POLL_SECONDS per poll instead
#                       of reading the wall clock. A TEST SEAM, and deliberately
#                       one that cannot weaken the guard: it can only make the
#                       loop finish SOONER, never make a red outcome green.
# Required: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID.
#
# `set -e` is deliberately OFF: `gh` failing is an outcome this script HANDLES,
# and `-e` would abort before the handler ran — the shape recorded in
# `csa_loom_guardrails_bash_e_aborts_later_guards`.
set +e -uo pipefail

BUDGET_MINUTES="${BUDGET_MINUTES:-20}"
POLL_SECONDS="${POLL_SECONDS:-30}"
MAX_API_FAILURES="${MAX_API_FAILURES:-5}"
MAX_PARSE_FAILURES="${MAX_PARSE_FAILURES:-3}"
JOB_NAME_PREFIX="${JOB_NAME_PREFIX:-Brain scan}"
WATCHDOG_VIRTUAL_CLOCK="${WATCHDOG_VIRTUAL_CLOCK:-0}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

VCLOCK="$(date +%s)"
# One poll advances the virtual clock by at least a second, so POLL_SECONDS=0
# cannot make the loop immortal.
CLOCK_STEP=$(( POLL_SECONDS > 0 ? POLL_SECONDS : 1 ))

now_epoch() {
  if [ "$WATCHDOG_VIRTUAL_CLOCK" = "1" ]; then
    printf '%s\n' "$VCLOCK"
  else
    date +%s
  fi
}

# Called wherever the script waits, so the virtual clock advances at exactly the
# points the real one would have.
wait_a_poll() {
  VCLOCK=$(( VCLOCK + CLOCK_STEP ))
  sleep "$POLL_SECONDS"
}

DEADLINE=$(( $(now_epoch) + BUDGET_MINUTES * 60 ))
API_FAILURES=0
PARSE_FAILURES=0
# Carried out of the loop so the deadline message describes what was ACTUALLY
# last observed rather than restating the failure it was written for.
TOTAL=0
QUEUED=0
POLLS=0
SAW_A_READING=0

while [ "$(now_epoch)" -lt "$DEADLINE" ]; do
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs" \
    --paginate > "$WORK/jobs.json" 2> "$WORK/jobs.err"
  # RC on the NEXT line, with no pipe in between: piping would hand back the
  # LAST command's status, not gh's.
  RC=$?

  if [ "$RC" -ne 0 ]; then
    API_FAILURES=$(( API_FAILURES + 1 ))
    echo "::warning::could not read this run's job list (gh exit ${RC}); consecutive failure ${API_FAILURES} of ${MAX_API_FAILURES}."
    sed -n '1,20p' "$WORK/jobs.err"
    if [ "$API_FAILURES" -ge "$MAX_API_FAILURES" ]; then
      echo "::error::the watchdog could not read this run's job list ${API_FAILURES} times in a row (last gh exit ${RC}, stderr above). It has established NOTHING about whether the scan jobs started, so it is FAILING CLOSED rather than exiting 0 — exiting 0 here would publish 'the queue is fine' on no evidence at all, which is precisely the claim deploy-integrity.md R7 forbids. This is a defect in the WATCHDOG's access, not necessarily in the scan: check that the workflow still grants 'actions: read' and that the API is reachable, then re-run."
      exit 1
    fi
    wait_a_poll
    continue
  fi

  # A run of failures that then succeeds was transient, which is the case the
  # retry exists for. Only CONSECUTIVE failures are fatal.
  API_FAILURES=0
  POLLS=$(( POLLS + 1 ))

  # ── N3: A PARSE FAILURE IS ITS OWN OUTCOME, NOT A READING OF ZERO ─────────
  # `RC` is captured on the line immediately after each `jq`, with no pipe in
  # between. Previously an unguarded `jq` left these as EMPTY strings; every
  # numeric test below then errored under `set +e`, SAW_A_READING stayed 0, and
  # the deadline branch asserted the watchdog had never seen a matching job —
  # a claim it had not established, about jobs it HAD seen.
  QUEUED=$(jq --arg p "$JOB_NAME_PREFIX" '[.jobs[] | select(.name | startswith($p)) | select(.status == "queued")] | length' "$WORK/jobs.json" 2> "$WORK/jq.err")
  QRC=$?
  TOTAL=$(jq --arg p "$JOB_NAME_PREFIX" '[.jobs[] | select(.name | startswith($p))] | length' "$WORK/jobs.json" 2>> "$WORK/jq.err")
  TRC=$?

  case "${QUEUED}${TOTAL}" in
    *[!0-9]*|'') NUMERIC=0 ;;
    *)           NUMERIC=1 ;;
  esac

  if [ "$QRC" -ne 0 ] || [ "$TRC" -ne 0 ] || [ "$NUMERIC" -ne 1 ]; then
    PARSE_FAILURES=$(( PARSE_FAILURES + 1 ))
    echo "::warning::read this run's job list but could NOT parse it (jq exit ${QRC}/${TRC}, queued='${QUEUED}', total='${TOTAL}'); consecutive parse failure ${PARSE_FAILURES} of ${MAX_PARSE_FAILURES}."
    sed -n '1,20p' "$WORK/jq.err"
    if [ "$PARSE_FAILURES" -ge "$MAX_PARSE_FAILURES" ]; then
      echo "::error::the watchdog READ this run's job list ${PARSE_FAILURES} times in a row and could NOT PARSE it (last jq exit ${QRC}/${TRC}, stderr above). This is NOT 'no scan job was found' and it is NOT 'a job was queued' — the API answered and this script could not interpret the answer, so it has established nothing and is FAILING CLOSED. Look at jq's availability on the runner and at the shape of the /jobs payload before looking at the scan."
      exit 1
    fi
    # Reset so a garbled poll cannot be mistaken for a reading of zero.
    QUEUED=0
    TOTAL=0
    wait_a_poll
    continue
  fi
  PARSE_FAILURES=0

  if [ "$TOTAL" -gt 0 ]; then SAW_A_READING=1; fi
  echo "scan jobs: ${TOTAL}, still queued: ${QUEUED}"

  if [ "$TOTAL" -gt 0 ] && [ "$QUEUED" -eq 0 ]; then
    echo "every scan job has left the queue."
    exit 0
  fi
  wait_a_poll
done

# ── The budget elapsed. Say which of the two things is actually true. ───────
if [ "$SAW_A_READING" -eq 0 ]; then
  echo "::error::the watchdog polled this run ${POLLS} time(s) over ${BUDGET_MINUTES} minutes and NEVER saw a job whose name starts with '${JOB_NAME_PREFIX}'. That is NOT a queued job — it is no job at all, and the two have different causes and different fixes. Either every scan job was skipped by its 'if:' condition, or a job's 'name:' was changed and this filter no longer matches it, in which case the watchdog has been watching nothing and would keep reporting green forever. Compare the 'name:' values in .github/workflows/loom-brain-scan.yml against JOB_NAME_PREFIX."
  exit 1
fi

echo "::error::${QUEUED} of ${TOTAL} Brain scan job(s) were still QUEUED after ${BUDGET_MINUTES} minutes. Nothing has been established about the estate and nothing will be until a runner picks the job up — a queued job is neither red nor green, which is the silent-absence failure this lane must never have. Most likely cause: no runner is serving the label the job targets. 'loom-aca' is declared in .github/actionlint.yaml and served by the scale-to-zero gh-aca-runner ACA Job; check that it is running."
exit 1
