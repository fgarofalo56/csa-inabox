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
# THE TWO MUTATIONS THAT MATTER
#
# 1. #4067 — the probe exited READY on the FIRST 401 and claimed "the registry is
#    evaluating auth, not blocking by IP". Three runs (31564296050, 32248671357,
#    32819789544) falsified that ~2s later with an IP denial on the SAME
#    `GET /v2/` URL. Cases 7-10 below. Case 7 measures the DEFAULTS through the
#    sampling loop — it counts the probe's actual requests, and reads the pause
#    the probe hands to `sleep` off a PATH stub — rather than grepping the script
#    for `3` and `2`, so lowering either default back down fails a test instead
#    of quietly re-arming the incident.
#
# 2. The first draft wrote `CODE="$(curl … || echo 000)"`, and because curl PRINTS
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

# Fast sampling config for the cases that are NOT measuring the defaults.
run() {
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr \
    --timeout-seconds "${1:-8}" --interval-seconds 2 \
    --sample-interval-seconds 1 --consecutive-samples 3 2>&1
}
# Same, but with the pauses stubbed out. Cases that assert on a SEQUENCE and a
# VERDICT (not on timing) use this: it makes them deterministic instead of a race
# between the probe's budget and however long a process spawn takes on the host.
# Measured on the dev box under load, a single sample costs ~5s of spawn time, so
# a wall-clock budget that comfortably fits 3 samples in CI fits 2 here.
run_nosleep() {
  install_sleep_recorder
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr \
    --timeout-seconds "${1:-8}" --interval-seconds 2 \
    --sample-interval-seconds 1 --consecutive-samples 3 2>&1
  local rc=$?
  remove_sleep_recorder
  return $rc
}
# DEFAULTS ONLY — no --sample-interval-seconds, no --consecutive-samples. Case 7
# depends on this passing nothing the script could read instead of its defaults.
run_defaults() {
  reset_samples
  PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds "${1:-30}" 2>&1
}

echo "== acr-dataplane-ready self-test =="

# 1. 401 throughout => the registry is evaluating auth => READY.
OUT="$(STUB_CODE=401 STUB_BODY='{"errors":[{"code":"UNAUTHORIZED"}]}' run_nosleep 60)"; RC=$?
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
OUT="$(STUB_CODE=200 STUB_BODY='{}' run_nosleep 60)"; RC=$?
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
OUT="$(STUB_CODES='401' run_defaults 30)"; RC=$?
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
OUT="$(STUB_CODES='401 403 401 401' run_nosleep 30)"; RC=$?
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
OUT="$(STUB_CODES='401 401 403 401' run_nosleep 30)"; RC=$?
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
OUT="$(STUB_CODES='401 401 000 401' run_nosleep 30)"; RC=$?
CALLS="$(samples)"
if [ "$CALLS" -ge 6 ]; then
  pass "401,401,000,401: the connect failure discarded the 2-sample streak (${CALLS} samples, 6 required)"
else
  fail "401,401,000,401: READY after only ${CALLS} samples — a no-response sample did NOT reset the streak, so an UNKNOWN is being counted toward readiness"
fi

# 9. HARD NEGATIVE. One 401 then 403 forever. The old probe exited 0 on sample 1;
#    this must never report READY, and the message must name the intermittency
#    rather than claiming a flat refusal it did not observe (R7).
OUT="$(STUB_CODES='401 403' run 20)"; RC=$?
[ $RC -ne 0 ] && pass "401 then 403 forever => never READY (exit $RC)" || fail "401-then-403 reported READY — one sample is being treated as an observation (#4067)"
if echo "$OUT" | grep -qi "INTERMITTENTLY"; then
  pass "mixed answers are reported as intermittent propagation"
else
  fail "mixed 401/403 exhaustion should say the answers were intermittent: $OUT"
fi

# 10. R7 ON THE BUDGET PATH. If every sample answered 401 but the budget was too
#     short to fit the required run, the failure is a CONFIG problem — the script
#     must not report it as the registry refusing this runner.
OUT="$(STUB_CODES='401' PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds 2 --sample-interval-seconds 2 --consecutive-samples 3 2>&1)"; RC=$?
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

# 11. A sampling config that would silently defeat the gate is REJECTED, not
#     coerced. A silent coercion is how "3 consecutive" becomes "1" with nothing
#     going red.
OUT="$(PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --consecutive-samples 0 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--consecutive-samples 0 => exit 3 (rejected, not coerced)" || fail "--consecutive-samples 0 should exit 3, got $RC: $OUT"
OUT="$(PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --sample-interval-seconds abc 2>&1)"; RC=$?
[ $RC -eq 3 ] && pass "--sample-interval-seconds abc => exit 3 (rejected)" || fail "non-numeric sample interval should exit 3, got $RC: $OUT"

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
