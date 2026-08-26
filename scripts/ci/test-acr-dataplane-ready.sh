#!/usr/bin/env bash
# =============================================================================
# test-acr-dataplane-ready.sh — self-test for the ACR data-plane readiness probe
# =============================================================================
#
# Runs OFFLINE against a stub `curl` on PATH, so it needs no registry, no
# credentials and no network. Each case asserts the EXIT CODE, because the exit
# code is what a gate branches on, and asserts the MESSAGE does not claim
# something the probe did not establish (deploy-integrity.md R7).
#
# The `curl` stub takes a SAMPLE SEQUENCE (STUB_CODES="401 403 401 401"),
# consuming one entry per invocation and repeating the last entry once the
# sequence is exhausted. That is what makes the #4067 controls runnable: the
# defect was a probe that exited READY on ONE sample, and a stub that can only
# answer one fixed code forever cannot tell a 1-sample probe from a 3-sample one.
#
# THE MUTATIONS THAT MATTER
#
# 1. #4067 — the probe exited READY on the FIRST 401 and claimed "the registry is
#    evaluating auth, not blocking by IP". Three runs (31564296050, 32248671357,
#    32819789544) denied the same URL ~2s later. Cases 7-10 below. Case 7 measures
#    the DEFAULTS through the sampling loop — it counts the probe's actual
#    requests, and reads the pause the probe hands to `sleep` off a PATH stub —
#    rather than grepping the script for `3` and `2`, so lowering either default
#    back down fails a test instead of quietly re-arming the incident.
#
# 2. THE CALLER BYPASS. Pinning the numbers as DEFAULTS was not enough: a caller
#    passing `--consecutive-samples 1` or `--sample-interval-seconds 0` restored
#    the exact pre-#4067 behaviour with every case here still green. Cases 11b-11f
#    assert the floor is ENFORCED — the weakening is refused with exit 3, the only
#    way through is an explicit reason-carrying opt-out, a reason made only of
#    whitespace does NOT count as a reason (one space bought the whole override on
#    the previous commit), and a run that takes the opt-out says so loudly.
#
# 2b. THE HIGH SIDE OF THE SAME BYPASS. A floor only guards the low side. A
#    sample count high enough to be unsatisfiable inside the budget clears the
#    floor and leaves a probe that can ONLY exit 1 — which, at the 14 of 17 call
#    sites that discard the exit status, is the guard switched off without typing
#    the greppable flag. Cases 10b and 10c assert such a config is REFUSED rather
#    than merely warned about; case 10 keeps the exhaustion path under test by
#    taking the opt-out deliberately.
#
# 3. THE STREAK RESETS. Three code paths reset the streak (403, no-response, and
#    any other status) and each one is on the critical path of a VERDICT, not just
#    of a log line: cases 8b, 8c and 8d each drive a sample stream where the
#    difference between resetting and not resetting is 6 samples versus 4. Case 8's
#    "streak reset to 0" assertion was measured GREEN against a mutation that
#    deleted the reset and left the echo, which is why 8b-8d exist.
#
# 4. The first draft wrote `CODE="$(curl … || echo 000)"`, and because curl PRINTS
#    `000` on a connect failure and ALSO exits non-zero, the fallback concatenated
#    to `000000`. That fell past the `000` branch and reported a DNS failure as
#    "still refusing this runner" — the exact UNKNOWN-as-NEGATIVE bug the probe
#    exists to prevent, reproduced inside the fix. Case 5.
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/acr-dataplane-ready.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

# `az` stub: answers the two queries the probe makes. Installed as a function so
# case 6 (which needs an `az` that cannot answer) does not leave the suite in a
# broken state for anything added after it.
install_az_ok() {
  cat > "$STUB_DIR/az" <<'AZ'
#!/usr/bin/env bash
case "$*" in
  *"cloud show"*)   echo ".azurecr.io" ;;
  *"acr show"*)     echo -e "Enabled\tAllow" ;;
  *)                exit 1 ;;
esac
AZ
  chmod +x "$STUB_DIR/az"
}
install_az_fail() {
  cat > "$STUB_DIR/az" <<'AZ2'
#!/usr/bin/env bash
exit 1
AZ2
  chmod +x "$STUB_DIR/az"
}
install_az_ok

# `curl` stub.
#   STUB_CODE         — one HTTP status, returned for every call (legacy cases).
#   STUB_CODES        — a SEQUENCE, one entry consumed per call; the last entry
#                       repeats once the sequence runs out. An entry of `000`
#                       means a connect/DNS failure at that position, so a
#                       sequence can interleave refusals, answers and outages.
#   STUB_CONNECT_FAIL — every call is a connect/DNS failure, exactly as real curl
#                       reports one: print `000`, exit 6.
# Every invocation appends a line to .calls, so a case can count how many samples
# the probe actually took — the measurement the #4067 controls turn on.
cat > "$STUB_DIR/curl" <<'CURL'
#!/usr/bin/env bash
SELF_DIR="$(dirname "$0")"
OUT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then OUT="$a"; fi
  prev="$a"
done
echo "call" >> "$SELF_DIR/.calls"
CODE="${STUB_CODE:-401}"
if [ -n "${STUB_CODES:-}" ]; then
  N=0
  [ -f "$SELF_DIR/.seq" ] && N="$(cat "$SELF_DIR/.seq")"
  N=$(( N + 1 ))
  printf '%s' "$N" > "$SELF_DIR/.seq"
  # shellcheck disable=SC2086
  set -- $STUB_CODES
  IDX=$N
  [ "$IDX" -gt "$#" ] && IDX=$#
  CODE="${!IDX}"
fi
if [ "${STUB_CONNECT_FAIL:-0}" = "1" ] || [ "$CODE" = "000" ]; then
  [ -n "$OUT" ] && : > "$OUT"
  printf '000'
  exit 6
fi
if [ -n "${STUB_BODY:-}" ]; then
  B="$STUB_BODY"
else
  case "$CODE" in
    403) B='{"errors":[{"code":"DENIED","message":"client with IP is not allowed access"}]}' ;;
    401) B='{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}' ;;
    *)   B='{}' ;;
  esac
fi
[ -n "$OUT" ] && printf '%s' "$B" > "$OUT"
printf '%s' "$CODE"
exit 0
CURL
chmod +x "$STUB_DIR/curl"

reset_samples() { rm -f "$STUB_DIR/.seq" "$STUB_DIR/.calls" "$STUB_DIR/.sleeps"; }
samples() { [ -f "$STUB_DIR/.calls" ] && wc -l < "$STUB_DIR/.calls" | tr -d '[:space:]' || echo 0; }

# `sleep` recorder. bash has no `sleep` builtin, so the probe's `sleep "$SLEEP"`
# resolves through PATH and this stub intercepts it — logging the ARGUMENT and
# returning instantly.
#
# WHY NOT JUST TIME THE RUN. Because a wall-clock assertion here cannot fail
# honestly. Measured on the Windows Git Bash dev box, 2026-08-25, with the probe
# asked to sleep ZERO seconds between samples, the observed inter-sample gaps
# across four runs were: 4.19 3.83 16.27 19.10 12.74 11.98 9.93 13.08 14.60 11.80
# 11.27 7.53 8.82 8.08 7.69 11.30 seconds. A separate run asked to sleep TWELVE
# seconds produced a 22.37s gap. Process-spawn noise (mktemp + a stub curl + head
# + rm per sample, under concurrent load) swamps the signal completely, so there
# is no threshold that separates "slept 2s" from "slept 0s". An elapsed-time
# assertion was written first and MEASURED not to move under the 0s-spacing
# mutation — a gate that cannot fail. This records the argument instead: no
# timing, no flake, and it fails the moment the spacing is lowered.
install_sleep_recorder() {
  cat > "$STUB_DIR/sleep" <<'SLEEP'
#!/usr/bin/env bash
echo "$1" >> "$(dirname "$0")/.sleeps"
exit 0
SLEEP
  chmod +x "$STUB_DIR/sleep"
}
remove_sleep_recorder() { rm -f "$STUB_DIR/sleep"; }

# Fast sampling config for the cases that are NOT measuring the defaults. The
# spacing is 2s — the #4067 floor — because anything lower is now REFUSED by the
# probe (exit 3) rather than silently accepted. Case 11b proves that refusal; the
# helpers must not route around it with the opt-out flag, or every case below
# would be running on a weakened probe.
run() {
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr \
    --timeout-seconds "${1:-8}" --interval-seconds 2 \
    --sample-interval-seconds 2 --consecutive-samples 3 2>&1
}
# Same, but with the pauses stubbed out. Cases that assert on a SEQUENCE and a
# VERDICT (not on timing) use this.
#
# THE BUDGET IS DELIBERATELY ENORMOUS, AND THAT COSTS NOTHING. Stubbing `sleep`
# removes the probe's pauses but NOT the cost of the ~4 processes each sample
# spawns (mktemp, the curl stub, head, rm), and the wall-clock budget is spent on
# exactly that. The previous value was 120s, chosen after measuring a 6-sample
# case burn 16s of a 30s budget. 120s was still a bet, and the bet lost: running
# EIGHT copies of this suite concurrently on the Windows dev box (2026-08-25,
# ~150 other node processes), two UNMUTATED control copies went red — case 7 took
# 2 samples of 3 inside 30s and case 8b reached only 5 of the 6 it needs inside
# 120s. That is a control failing on CORRECT code, which is the control that gets
# loosened next time.
#
# Every case using this helper TERMINATES ON ITS OWN — correct code reaches READY
# in <= 6 samples, and every mutation these cases exist to catch reaches it
# SOONER (deleting a streak reset makes READY arrive at sample 4, not later). So
# the budget is never actually spent on a healthy box, and a 600s ceiling buys
# ~100x headroom on a loaded one while still bounding a genuinely stuck probe.
run_nosleep() {
  install_sleep_recorder
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr \
    --timeout-seconds "${1:-600}" --interval-seconds 2 \
    --sample-interval-seconds 2 --consecutive-samples 3 2>&1
  local rc=$?
  remove_sleep_recorder
  return $rc
}
# DEFAULTS ONLY — no --sample-interval-seconds, no --consecutive-samples. Case 7
# depends on this passing nothing the script could read instead of its defaults.
# The budget is large for the reason above: it is not spent on a healthy box, and
# at 30s case 7 was measured going red on correct code under load.
run_defaults() {
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds "${1:-600}" 2>&1
}

echo "== acr-dataplane-ready self-test =="

# 1. 401 throughout => the registry is evaluating auth => READY.
OUT="$(STUB_CODE=401 STUB_BODY='{"errors":[{"code":"UNAUTHORIZED"}]}' run_nosleep 600)"; RC=$?
[ $RC -eq 0 ] && pass "401 UNAUTHORIZED => ready (exit 0)" || fail "401 should be ready, got exit $RC: $OUT"

# 1b. R7: the READY line must not claim the registry "is not blocking by IP".
#     That is the exact sentence #4067 falsified three times.
if echo "$OUT" | grep -qi "not blocking by IP"; then
  fail "READY still claims the registry is 'not blocking by IP' (#4067, deploy-integrity R7)"
else
  pass "READY makes no 'not blocking by IP' claim"
fi
if echo "$OUT" | grep -qi "can still be IP-denied"; then
  pass "READY states its scope (a later call can still be IP-denied)"
else
  fail "READY does not state the scope of what it observed: $OUT"
fi

# 2. 200 (anonymous pull enabled) => also reachable.
OUT="$(STUB_CODE=200 STUB_BODY='{}' run_nosleep 600)"; RC=$?
[ $RC -eq 0 ] && pass "200 => ready (exit 0)" || fail "200 should be ready, got exit $RC: $OUT"

# 3. 403 DENIED for the whole budget => NOT ready, exit 1.
OUT="$(STUB_CODE=403 STUB_BODY='{"errors":[{"code":"DENIED","message":"client with IP is not allowed access"}]}' run 6)"; RC=$?
[ $RC -eq 1 ] && pass "403 DENIED for the full budget => exit 1" || fail "403 should exit 1, got $RC: $OUT"

# 4. …and it must NOT assert anything about the registry's CONTENTS.
if echo "$OUT" | grep -qiE "not signed|unsigned|does not exist|no valid|not found"; then
  fail "403 message claims something about contents: $OUT"
else
  pass "403 message stays an UNKNOWN (no contents claim)"
fi
echo "$OUT" | grep -q "UNKNOWN" && pass "403 message says UNKNOWN explicitly" || fail "403 message should say UNKNOWN"

# 5. THE REGRESSION. Connect failure => exit 2 (DNS/TCP), never exit 1.
OUT="$(STUB_CONNECT_FAIL=1 run 6)"; RC=$?
[ $RC -eq 2 ] && pass "connect failure => exit 2 (not 1)" || fail "connect failure must exit 2, got $RC: $OUT"
if echo "$OUT" | grep -q "000000"; then
  fail "curl's 000 was concatenated with a fallback 000 => the '000' branch is unreachable"
else
  pass "no 000000 concatenation (the \`|| echo 000\` bug stays dead)"
fi
if echo "$OUT" | grep -qi "still refusing this runner"; then
  fail "a DNS/TCP failure is reported as a firewall refusal"
else
  pass "DNS/TCP failure is not reported as a firewall refusal"
fi

# ---------------------------------------------------------------------------
# #4067 — one sample is not an observation.
# ---------------------------------------------------------------------------

# 7. POSITIVE CONTROL, ON THE DEFAULTS. An all-401 registry is READY, but only
#    after >= 3 requests, and only if the probe actually paused >= 2s between
#    them. Both numbers are MEASURED through the loop — the request count comes
#    from the curl stub's call log, the pause from the sleep recorder's argument
#    log — not grepped out of the script. Set CONSECUTIVE_REQUIRED back to 1 and
#    the count assertion fails; set SAMPLE_INTERVAL to 0 and the pause assertion
#    fails. Both mutations were run; both go red.
install_sleep_recorder
OUT="$(STUB_CODES='401' run_defaults 600)"; RC=$?
CALLS="$(samples)"
SLEEP_ARGS="$(tr '\n' ' ' < "$STUB_DIR/.sleeps" 2>/dev/null)"
SLEEP_COUNT=0
SLEEP_MIN=""
for s in $SLEEP_ARGS; do
  SLEEP_COUNT=$(( SLEEP_COUNT + 1 ))
  if [ -z "$SLEEP_MIN" ] || [ "$s" -lt "$SLEEP_MIN" ]; then SLEEP_MIN="$s"; fi
done
remove_sleep_recorder
[ $RC -eq 0 ] && pass "defaults: sustained 401 => ready (exit 0)" || fail "defaults should reach ready, got $RC: $OUT"
if [ "$CALLS" -ge 3 ]; then
  pass "defaults: took ${CALLS} samples (>= 3 required)"
else
  fail "defaults took only ${CALLS} sample(s) — the probe is not requiring 3 consecutive (#4067)"
fi
if [ "$SLEEP_COUNT" -ge 2 ]; then
  pass "defaults: paused between samples ${SLEEP_COUNT} time(s) (>= 2 gaps)"
else
  fail "defaults paused only ${SLEEP_COUNT} time(s) — the probe is not spacing its samples (#4067)"
fi
if [ -n "$SLEEP_MIN" ] && [ "$SLEEP_MIN" -ge 2 ]; then
  pass "defaults: shortest pause handed to sleep was ${SLEEP_MIN}s (>= 2s required)"
else
  fail "defaults: shortest pause was '${SLEEP_MIN:-none}'s — samples are not spaced >= 2s apart (#4067)"
fi
echo "$OUT" | grep -q "consecutive" && pass "READY reports the consecutive-sample count" || fail "READY should report how many consecutive samples it saw: $OUT"

# 8. THE NEGATIVE CONTROL FROM #4067: samples 401, 403, 401, 401.
#    The probe must NOT report READY at the first 401 — the 403 that follows is
#    the whole point. Measured by the REQUEST COUNT: the old probe exited at
#    sample 1, so it would show CALLS=1 here.
#
#    The threshold is 5, not 4, and the arithmetic is load-bearing. The stub
#    repeats its trailing entry, so the sample stream is 401 403 401 401 401…
#    With the 403 resetting the streak: 1, reset, 1, 2, 3 -> READY on sample 5.
#    WITHOUT the reset: 1, (403 ignored) 1, 2, 3 -> READY on sample 4. A `>= 4`
#    threshold therefore passes either way — it was measured GREEN against a
#    mutation that deleted `STREAK=0` from the 403 branch. See 8b.
OUT="$(STUB_CODES='401 403 401 401' run_nosleep 600)"; RC=$?
CALLS="$(samples)"
if [ "$CALLS" -ge 5 ]; then
  pass "401,403,401,401: kept sampling past the first 401 and past the 403 (${CALLS} samples)"
else
  fail "401,403,401,401: only ${CALLS} sample(s) — the probe exited READY early (#4067)"
fi
if echo "$OUT" | grep -qi "streak reset to 0"; then
  pass "401,403,401,401: the 403 announced a streak reset"
else
  fail "401,403,401,401: the 403 did not announce a streak reset: $OUT"
fi
if [ $RC -eq 0 ]; then
  # It is CORRECT to end READY here — the stub repeats the trailing 401, so the
  # streak legitimately rebuilds. What must be true is that it rebuilt AFTER the
  # denial rather than being declared before it.
  if echo "$OUT" | grep -qi "streak reset to 0" && [ "$CALLS" -ge 5 ]; then
    pass "401,403,401,401: READY only after rebuilding the streak past the 403"
  else
    fail "401,403,401,401: READY was reached without observing the reset"
  fi
else
  pass "401,403,401,401: did not reach READY within the budget (exit $RC)"
fi

# 8b. THE RESET ITSELF, MEASURED BEHAVIOURALLY.
#     Case 8's "streak reset to 0" assertion reads the probe's own MESSAGE, and a
#     message is not behaviour: deleting `STREAK=0` from the 403 branch while
#     leaving the echo in place kept that assertion GREEN (measured 2026-08-25).
#     This case puts the reset on the critical path of the VERDICT instead.
#
#     Stream: 401 401 403 401 401 401… (trailing entry repeats).
#       with the reset:    1, 2, reset, 1, 2, 3 -> READY on sample 6
#       without the reset: 1, 2, (ignored), 3   -> READY on sample 4
#     Six versus four. No message is consulted.
OUT="$(STUB_CODES='401 401 403 401' run_nosleep 600)"; RC=$?
CALLS="$(samples)"
if [ "$CALLS" -ge 6 ]; then
  pass "401,401,403,401: the 403 discarded the 2-sample streak (${CALLS} samples, 6 required)"
else
  fail "401,401,403,401: READY after only ${CALLS} samples — a 403 did NOT reset the streak, so a denial mid-run is being counted toward readiness (#4067)"
fi

# 8c. Same shape, for the OTHER thing that must reset the streak: a sample that
#     got no HTTP response at all. Three consecutive answers means three, not
#     "three, ignoring the connect failure in the middle" — an outage mid-run is
#     an UNKNOWN and an UNKNOWN cannot count toward readiness. Deleting `STREAK=0`
#     from the 000 branch was measured GREEN against every other case here.
#
#     Stream: 401 401 000 401 401 401… (trailing entry repeats).
#       with the reset:    1, 2, reset, 1, 2, 3 -> READY on sample 6
#       without the reset: 1, 2, (ignored), 3   -> READY on sample 4
OUT="$(STUB_CODES='401 401 000 401' run_nosleep 600)"; RC=$?
CALLS="$(samples)"
if [ "$CALLS" -ge 6 ]; then
  pass "401,401,000,401: the connect failure discarded the 2-sample streak (${CALLS} samples, 6 required)"
else
  fail "401,401,000,401: READY after only ${CALLS} samples — a no-response sample did NOT reset the streak, so an UNKNOWN is being counted toward readiness"
fi

# 8d. THE THIRD RESET BRANCH — the `*)` catch-all (acr-dataplane-ready.sh's
#     "not a readiness signal" arm), which 8b and 8c did not cover. Deleting
#     `STREAK=0` from it passed the ENTIRE suite, measured 2026-08-25 on the
#     first version of this file: 28/28 ok, RC=0, run alone to exclude load. A
#     429/500/503 mid-run would then be silently counted inside a verdict that
#     says "3 consecutive answers", and nothing in CI would notice.
#
#     Stream: 401 401 500 401 401 401… (trailing entry repeats).
#       with the reset:    1, 2, reset, 1, 2, 3 -> READY on sample 6
#       without the reset: 1, 2, (ignored), 3   -> READY on sample 4
#     The 500 needs no stub change: the curl stub synthesises `{}` for any code
#     that is not 401/403, which is exactly what a real 5xx body is not required
#     to be for this assertion to hold. No message is consulted.
OUT="$(STUB_CODES='401 401 500 401' run_nosleep 600)"; RC=$?
CALLS="$(samples)"
if [ "$CALLS" -ge 6 ]; then
  pass "401,401,500,401: the 500 discarded the 2-sample streak (${CALLS} samples, 6 required)"
else
  fail "401,401,500,401: READY after only ${CALLS} samples — a non-readiness status did NOT reset the streak, so a 5xx mid-run is being counted toward readiness"
fi
if echo "$OUT" | grep -qi "not a readiness signal"; then
  pass "401,401,500,401: the 500 was named as not a readiness signal"
else
  fail "401,401,500,401: the 500 was not reported as a non-readiness status: $OUT"
fi

# 9. HARD NEGATIVE. One 401 then 403 forever. The old probe exited 0 on sample 1;
#    this must never report READY, and the message must name the intermittency
#    rather than claiming a flat refusal it did not observe (R7).
#
#    THIS CASE CANNOT USE A HUGE BUDGET. Unlike 7 and 8b-8d it never reaches
#    READY, so it runs until the budget expires and the budget IS its runtime.
#    That makes it the one case whose sample count is genuinely load-dependent,
#    and at 20s it was MEASURED going red on correct code under 8-way parallel
#    load (2026-08-25): only the first sample landed inside the budget, so no 403
#    was ever observed and the probe correctly took the all-positive exhaustion
#    branch instead of the intermittent one. The budget is now 60s, and the
#    sample count is checked FIRST so that a box too slow to take two samples
#    reports THAT, instead of blaming the probe for a message it was never given
#    the chance to print (deploy-integrity.md R7).
OUT="$(STUB_CODES='401 403' run 60)"; RC=$?
CALLS="$(samples)"
[ $RC -ne 0 ] && pass "401 then 403 forever => never READY (exit $RC)" || fail "401-then-403 reported READY — one sample is being treated as an observation (#4067)"
if [ "$CALLS" -lt 2 ]; then
  fail "401-then-403: only ${CALLS} sample(s) completed inside the 60s budget, so this case never reached the 403 at all. That is a HARNESS-CAPACITY failure on this machine, not a verdict about the probe — raise the budget in this case."
elif echo "$OUT" | grep -qi "INTERMITTENTLY"; then
  pass "mixed answers are reported as intermittent propagation (${CALLS} samples)"
else
  fail "mixed 401/403 exhaustion should say the answers were intermittent: $OUT"
fi

# 10. R7 ON THE BUDGET PATH. If every sample answered 401 but the budget was too
#     short to fit the required run, the failure is a CONFIG problem — the script
#     must not report it as the registry refusing this runner.
#
#     THE OPT-OUT IS PART OF THE SETUP, NOT A WEAKENING OF THIS CASE. A budget
#     that cannot fit the required run is now REFUSED up front (exit 3, case 10b),
#     so the only way to reach the exhaustion path this case is about is to insist
#     on it explicitly. The assertions below are unchanged: what is tested is
#     still that the exhaustion message names the budget and does NOT claim a
#     refusal it never observed.
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 2 --sample-interval-seconds 2 --consecutive-samples 3 --unsafe-sampling-below-4067-floor "self-test: reaching the exhaustion path on purpose" 2>&1)"; RC=$?
[ $RC -eq 1 ] && pass "budget shorter than the sampling config => exit 1 (fails closed)" || fail "short budget should exit 1, got $RC: $OUT"
if echo "$OUT" | grep -qi "still refusing this runner"; then
  fail "a budget that was too short is reported as a firewall refusal (R7): $OUT"
else
  pass "a too-short budget is not reported as a refusal"
fi
if echo "$OUT" | grep -qi "budget/sampling-configuration problem"; then
  pass "the too-short budget names itself as the cause"
else
  fail "the exhaustion message does not name the budget as the cause: $OUT"
fi

# 10b. THE HIGH SIDE OF THE #4067 FLOOR. The same configuration WITHOUT the
#      opt-out is refused before the probe touches the network. Until this case
#      existed the script only printed `::warning:: … can only fail closed` and
#      then burnt the budget: measured 2026-08-25 on the previous commit,
#      `--consecutive-samples 1000 --timeout-seconds 6` cleared BOTH floor checks
#      (1000 >= 3, spacing 2 >= 2), warned, took a sample and exited 1. At the 14
#      of 17 call sites that discard the exit status with `|| echo "::warning::"`
#      that is a permanently-yellow, permanently-ignored gate — the #4067 guard
#      switched off without ever typing the greppable opt-out flag. (That 14-of-17
#      swallowing, and the fact that every Gov call site is one of them, is
#      tracked separately as #4079; no workflow is touched here.)
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 2 --sample-interval-seconds 2 --consecutive-samples 3 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "a budget too short for the sampling config => exit 3 (refused, not merely warned)" || fail "an unsatisfiable sampling config should be REFUSED with exit 3, got $RC — a config that can only fail closed is a switched-off gate at 14 of 17 call sites: $OUT"
if echo "$OUT" | grep -q -- "--unsafe-sampling-below-4067-floor"; then
  pass "the unsatisfiable-config refusal routes through the same greppable opt-out"
else
  fail "the refusal does not name the opt-out, so a weakening here would not be greppable: $OUT"
fi

# 10c. The reviewer's literal scenario, at the DEFAULT budget: a sample count high
#      enough to be unsatisfiable clears the low floor and must still be refused.
#      This is the arithmetic in the header — 1000 samples spaced 2s need 1998s,
#      and the default budget is 180s. No stub sequence is needed: the refusal
#      happens before the first request.
reset_samples
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 1000 2>&1)"; RC=$?
CALLS="$(samples)"
[ $RC -eq 3 ] && pass "--consecutive-samples 1000 at the default budget => exit 3" || fail "--consecutive-samples 1000 clears the low floor and can only fail; it should exit 3, got $RC: $OUT"
[ "$CALLS" -eq 0 ] && pass "the unsatisfiable config was refused before any request was made" || fail "the probe made ${CALLS} request(s) for a config it can never satisfy"

# 11. A sampling config that would silently defeat the gate is REJECTED, not
#     coerced. A silent coercion is how "3 consecutive" becomes "1" with nothing
#     going red.
OUT="$(PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 0 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--consecutive-samples 0 => exit 3 (rejected, not coerced)" || fail "--consecutive-samples 0 should exit 3, got $RC: $OUT"
OUT="$(PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --sample-interval-seconds abc 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--sample-interval-seconds abc => exit 3 (rejected)" || fail "non-numeric sample interval should exit 3, got $RC: $OUT"

# ---------------------------------------------------------------------------
# 11b-11e. THE FLOOR. The first version of this fix pinned 3-samples-at-2s as
# DEFAULTS only, and case 7 measured the defaults — so a CALLER could restore the
# exact pre-#4067 behaviour and the whole suite stayed green. Measured against
# that version with these stubs: `--consecutive-samples 1` exited 0 after exactly
# ONE sample with a READY line reading "on 1 consecutive fresh-connection samples
# over 0s", and `--sample-interval-seconds 0` took 3 back-to-back samples with no
# spacing. That is this repo's documented narrow-bypass shape: a safety property
# living in a default that any caller can dial away is not a guard.
#
# These cases assert the WEAKENING IS REFUSED, and that the ONLY way through is
# an explicit, greppable, reason-carrying opt-out. They deliberately do NOT read
# the probe's source — each one runs the probe and asserts the exit code, so
# deleting the floor check makes them red rather than making them stale.
# ---------------------------------------------------------------------------

# 11b. The single-sample restoration is REFUSED.
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 1 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--consecutive-samples 1 => exit 3 (the pre-#4067 behaviour is refused, not defaulted away)" || fail "--consecutive-samples 1 should be REFUSED with exit 3, got $RC — a caller can restore the #4067 defect: $OUT"
if echo "$OUT" | grep -q "4067"; then
  pass "the refusal names #4067"
else
  fail "the refusal does not name the incident it is protecting: $OUT"
fi
if echo "$OUT" | grep -q -- "--unsafe-sampling-below-4067-floor"; then
  pass "the refusal names the explicit opt-out flag"
else
  fail "the refusal does not tell the caller how to opt out explicitly: $OUT"
fi

# 11c. Removing the SPACING is refused on the same terms — 3 back-to-back samples
#      all land inside the 1.63-2.09s window in which the three cited runs were
#      falsified, so unspaced samples measure what one sample measured.
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --sample-interval-seconds 0 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--sample-interval-seconds 0 => exit 3 (unspaced samples are refused)" || fail "--sample-interval-seconds 0 should be REFUSED with exit 3, got $RC: $OUT"

# 11d. The opt-out with an EMPTY reason is still a refusal. A bare flag would be
#      exactly as easy to slip into a workflow as the raw override was.
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 1 --unsafe-sampling-below-4067-floor "" 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "opt-out with an empty reason => still exit 3" || fail "an opt-out with no reason should still be refused, got $RC: $OUT"

# 11e. The opt-out with a REASON is honoured — and is LOUD. This is the positive
#      half: the floor is an enforced default with a documented escape, not a
#      hard-coded constant that would send someone editing the script instead.
install_sleep_recorder
reset_samples
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 60 \
  --consecutive-samples 1 --unsafe-sampling-below-4067-floor "self-test: proving the opt-out is the only way through" 2>&1)"; RC=$?
CALLS="$(samples)"
remove_sleep_recorder
[ $RC -eq 0 ] && pass "opt-out with a reason => the override is honoured (exit 0)" || fail "an explicit reasoned opt-out should be honoured, got $RC: $OUT"
[ "$CALLS" -eq 1 ] && pass "opt-out actually took 1 sample (the override is real, not cosmetic)" || fail "opt-out took ${CALLS} samples, expected 1 — the flag is not doing what it says"
if echo "$OUT" | grep -q "::warning::"; then
  pass "the opt-out emits a ::warning:: into the run log"
else
  fail "a weakened run must be loud in the log, not silent: $OUT"
fi
if echo "$OUT" | grep -q "self-test: proving the opt-out is the only way through"; then
  pass "the warning carries the caller's stated reason"
else
  fail "the warning does not carry the reason the caller gave: $OUT"
fi

# 11f. A reason made only of WHITESPACE is still a refusal. `[ -z "$REASON" ]`
#      accepts one space, and 11d only ever passed the truly-empty string, so the
#      "mandatory reason" half of the opt-out was one keystroke from being
#      cosmetic. MEASURED on the previous commit with these stubs: a single space
#      and a single tab each exited 0 after exactly ONE curl call — the full
#      pre-#4067 single-sample behaviour, bought without writing a word.
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 1 --unsafe-sampling-below-4067-floor " " 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "opt-out with a space-only reason => still exit 3" || fail "a space satisfied the 'mandatory reason' and bought the single-sample override (got $RC): $OUT"
OUT="$(STUB_CODE=401 PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 1 --unsafe-sampling-below-4067-floor "$(printf '\t \n')" 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "opt-out with a tab/newline-only reason => still exit 3" || fail "whitespace other than a plain space satisfied the 'mandatory reason' (got $RC): $OUT"

# ---------------------------------------------------------------------------
# 11g. THE MAGNITUDE BOUND — the high-side check is ARITHMETIC, and bash
# arithmetic wraps. Both floor halves above are `[ x -lt y ]` and `$(( ))`, so a
# big enough number walks straight through both of them. MEASURED 2026-08-26 on
# the previous commit, which already had the low floor AND the unsatisfiable
# check:
#
#   --consecutive-samples 9223372036854775807  (INT64_MAX, a VALID bash integer)
#     cleared the low floor, MIN_SPAN=(N-1)*2 wrapped to -4, `budget < -4` was
#     false, and the probe ACCEPTED and RAN a config needing 9.2 quintillion
#     consecutive samples in a 1s budget — printing NO warning and NO error.
#   --consecutive-samples 99999999999999999999 (past INT64_MAX)
#     bash printed `[: ...: integer expected` and `[` returned 2, which the `if`
#     read as false; the probe ran the full 180s budget (RC=2). A value bash
#     could not compare was treated as "safely above the floor" — an UNKNOWN
#     scored as a NEGATIVE.
#
# Both land exactly where the high-side check exists to prevent: a probe that can
# only ever exit 1, at the 14-of-17 call sites that discard the exit status, and
# reached WITHOUT typing the greppable opt-out. Case 10c enumerated 1000; that is
# the narrow-enumeration trap this repo keeps re-learning, so these assert the
# PROPERTY (the arithmetic can never be handed a value that wraps) by driving the
# real entry point at and past the boundary.
#
# Each asserts ZERO requests as well as exit 3: a refusal that still opens a
# connection has not refused early enough to be free.
for BIGVAL in 9223372036854775807 99999999999999999999; do
  reset_samples
  OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples "$BIGVAL" --timeout-seconds 1 2>&1)"; RC=$?
  CALLS="$(samples)"
  [ $RC -eq 3 ] && pass "--consecutive-samples ${BIGVAL} => exit 3 (arithmetic cannot wrap)" || fail "--consecutive-samples ${BIGVAL} overflows MIN_SPAN past both floor checks and must exit 3, got $RC: $OUT"
  [ "$CALLS" -eq 0 ] && pass "  ...refused before any request (${BIGVAL})" || fail "the probe made ${CALLS} request(s) for a sample count it can never reach"
done

# The same bound applies to the other two numbers the arithmetic consumes. A
# bound on --consecutive-samples alone would leave MIN_SPAN's other factor free.
reset_samples
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --sample-interval-seconds 9223372036854775807 --timeout-seconds 1 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--sample-interval-seconds INT64_MAX => exit 3" || fail "the spacing is the OTHER factor in MIN_SPAN and must be bounded too, got $RC: $OUT"
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 9223372036854775807 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--timeout-seconds INT64_MAX => exit 3" || fail "an unbounded budget is compared against MIN_SPAN and must be bounded too, got $RC: $OUT"

# The magnitude bound deliberately has NO opt-out, unlike the #4067 floor: past
# it the script cannot describe its own config truthfully (the exhaustion message
# would quote a negative MIN_SPAN), which deploy-integrity R7 forbids. If the
# refusal were routed through the opt-out, this assertion would go red.
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 9223372036854775807 --timeout-seconds 1 --unsafe-sampling-below-4067-floor "self-test: the opt-out must NOT buy an overflowing value" 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "the opt-out does not buy an overflowing sample count" || fail "the opt-out bought a value that breaks the arithmetic, so the floor checks silently stop working (got $RC): $OUT"

# 11h. THE NON-REGRESSION for 11g. The bound counts DIGITS, so it must count
# SIGNIFICANT digits — otherwise `0000000003` (ten characters, the integer 3)
# becomes a refusal and the bound is a new defect rather than a fix. This is the
# positive control: a zero-padded 3 must be accepted and reach READY exactly as a
# bare 3 does. Uses the sleep recorder + a large budget for the reason at
# run_nosleep: a control that can go red on correct code is the control that gets
# loosened next time.
install_sleep_recorder
reset_samples
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 600 --interval-seconds 2 --sample-interval-seconds 0000000002 --consecutive-samples 0000000003 2>&1)"; RC=$?
CALLS="$(samples)"
remove_sleep_recorder
[ $RC -eq 0 ] && pass "zero-padded 0000000003/0000000002 is accepted and reaches READY" || fail "the digit bound must count SIGNIFICANT digits — a zero-padded 3 is the integer 3, not a 10-digit value (got $RC): $OUT"
[ "$CALLS" -ge 3 ] && pass "  ...and still took ${CALLS} samples (>= 3), so the padding did not weaken it" || fail "zero-padded config took only ${CALLS} sample(s)"
# ...and a padded value whose SIGNIFICANT digits are past the bound is still
# refused, so the zero-stripping cannot be used to smuggle one through.
reset_samples
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 0009223372036854775807 --timeout-seconds 1 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "zero-padding does not smuggle an overflowing value past the bound" || fail "padding INT64_MAX with leading zeros defeated the digit bound (got $RC): $OUT"
# ---------------------------------------------------------------------------

# 12. `--help` PRINTS THE HEADER AND NOTHING ELSE. The first version of this
#     script printed the header with `sed -n '1,95p'` while the header ended at
#     line 92, so `--help` leaked three lines of executable code — and any edit to
#     the header silently changes how much. The fix walks until the first
#     non-comment line, so this case asserts the PROPERTY (no code in the output)
#     rather than a line count that would need updating with every header edit.
HELP_OUT="$(PATH="$STUB_DIR:$PATH" bash "$PROBE" --help 2>&1)"; RC=$?
HELP_LINES="$(printf '%s\n' "$HELP_OUT" | wc -l | tr -d '[:space:]')"
# Every line after the shebang must be a comment. `grep -c` counts the offenders.
HELP_CODE="$(printf '%s\n' "$HELP_OUT" | tail -n +2 | grep -cvE '^#|^[[:space:]]*$')"
[ $RC -eq 0 ] && pass "--help exits 0" || fail "--help should exit 0, got $RC"
[ "$HELP_LINES" -gt 50 ] && pass "--help printed the header (${HELP_LINES} lines)" || fail "--help printed only ${HELP_LINES} lines — the header is not being shown"
[ "$HELP_CODE" -eq 0 ] && pass "--help leaked 0 lines of executable code" || fail "--help leaked ${HELP_CODE} line(s) of executable script after the header"

# 6. Suffix must come from the cloud, never a literal — an az that cannot answer
#    must make the probe refuse rather than guess. Last, because it swaps the az
#    stub for a broken one.
install_az_fail
OUT="$(STUB_CODE=401 run 6)"; RC=$?
[ $RC -eq 3 ] && pass "unreadable cloud config => exit 3, refuses to guess a suffix" || fail "should exit 3 when the suffix is unknown, got $RC: $OUT"
install_az_ok

echo
if [ $FAILED -eq 0 ]; then echo "acr-dataplane-ready: ALL CASES PASS"; else echo "acr-dataplane-ready: FAILURES ABOVE"; fi
exit $FAILED
