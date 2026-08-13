#!/usr/bin/env bash
# =============================================================================
# test-acr-login-retry.sh — self-test for scripts/ci/acr-login-retry.sh
# =============================================================================
#
# WHY THIS EXISTS (#3383). acr-login-retry.sh had 25 call sites and NO test, so
# its retry budget was a number nobody could change safely and nobody could
# verify. On 2026-08-13 that budget (6x10s) was too small for the ACR
# AAD->token-exchange propagation tail; loom-roll-and-validate run 31732873272
# exhausted it and rolled the estate back two commits.
#
# The budget was raised to 12x15s. This test pins it BEHAVIOURALLY — it counts
# how many times the loop actually invokes `az`, rather than grepping the source
# for `ATTEMPTS=12`. A grep-based assertion passes on a file where the literal is
# present but unreachable; only running the loop proves the default is the one
# that governs. (Same reasoning as guard_with_zero_population_needs_embedded_control:
# an assertion that cannot observe the thing it names is not an assertion.)
#
# `az` is stubbed via a PATH shim, so this runs anywhere — no Azure, no network,
# no credentials. Total runtime is ~0s: every case overrides backoff to 0, EXCEPT
# the one that measures the default backoff, which uses --attempts 1 (the loop
# never sleeps after its final attempt, so the default is observable for free).
#
# Usage: bash scripts/ci/test-acr-login-retry.sh
# Exit:  0 all cases passed / 1 a case failed
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/acr-login-retry.sh"
[ -f "$TARGET" ] || { echo "FAIL: $TARGET not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SHIM="$TMP/bin"
mkdir -p "$SHIM"

# The `az` stub. Appends one line per invocation so the caller can count, then
# succeeds or fails according to the env the case sets.
cat > "$SHIM/az" <<'SHIMEOF'
#!/usr/bin/env bash
printf 'call\n' >> "$AZ_CALLS"
n=$(wc -l < "$AZ_CALLS" | tr -d ' ')
if [ -n "${AZ_SUCCEED_ON:-}" ] && [ "$n" -ge "$AZ_SUCCEED_ON" ]; then
  echo "Login Succeeded"
  exit 0
fi
printf '%s\n' "${AZ_FAIL_MSG:-generic failure}"
exit 1
SHIMEOF
chmod +x "$SHIM/az"

TRANSIENT_MSG='WARNING: Unable to get AAD authorization tokens with message: CONNECTIVITY_REFRESH_TOKEN_ERROR. Access to registry '"'"'x.azurecr.io'"'"' was denied. Response code: 403.'
# Deliberately contains none of the transient tokens (no 403/503/504/throttling).
PERMANENT_MSG="ERROR: The registry 'nope' could not be resolved: the resource with that name does not exist in this subscription."

PASS=0
FAIL=0

run_case() {
  # run_case <name> <succeed_on|""> <fail_msg> <expect_rc> <expect_calls> [extra args...]
  local name="$1" succeed_on="$2" fail_msg="$3" want_rc="$4" want_calls="$5"
  shift 5
  local calls="$TMP/calls.$$"
  : > "$calls"
  local out rc got
  out="$(AZ_CALLS="$calls" AZ_SUCCEED_ON="$succeed_on" AZ_FAIL_MSG="$fail_msg" \
        PATH="$SHIM:$PATH" bash "$TARGET" --acr testacr "$@" 2>&1)"
  rc=$?
  got="$(wc -l < "$calls" | tr -d ' ')"
  if [ "$rc" = "$want_rc" ] && [ "$got" = "$want_calls" ]; then
    echo "  ok   $name (rc=$rc, az calls=$got)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected rc=$want_rc calls=$want_calls, got rc=$rc calls=$got"
    printf '%s\n' "$out" | sed 's/^/         | /'
    FAIL=$((FAIL + 1))
  fi
  LAST_OUT="$out"
}

echo "== acr-login-retry self-test"

# --- behaviour -------------------------------------------------------------
run_case "succeeds on first attempt"                1  "$TRANSIENT_MSG" 0 1  --attempts 5 --backoff 0
run_case "retries a transient, then succeeds"       3  "$TRANSIENT_MSG" 0 3  --attempts 5 --backoff 0
run_case "exhausts the budget and fails CLOSED"     "" "$TRANSIENT_MSG" 1 5  --attempts 5 --backoff 0
run_case "non-transient exits on attempt 1"         "" "$PERMANENT_MSG" 1 1  --attempts 5 --backoff 0

# --- the defaults, measured through the loop (the #3383 regression guard) ---
run_case "DEFAULT attempts is 12 (not 6)"           "" "$TRANSIENT_MSG" 1 12 --backoff 0
run_case "DEFAULT backoff is observable"            "" "$TRANSIENT_MSG" 1 1  --attempts 1
if printf '%s' "$LAST_OUT" | grep -q 'budget 1x15s'; then
  echo "  ok   DEFAULT backoff is 15s (not 10s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL DEFAULT backoff is not 15s — exhaustion message did not report 'budget 1x15s'"
  printf '%s\n' "$LAST_OUT" | sed 's/^/         | /'
  FAIL=$((FAIL + 1))
fi

# --- R7: the exhaustion message must not assert an unmeasured duration ------
# With backoff 0 the loop takes ~0s. A message claiming otherwise is the exact
# class of untrue error string deploy-integrity.md R7 exists to stop.
if printf '%s' "$LAST_OUT" | grep -qE 'after [0-9]+ attempts over [0-9]+s'; then
  echo "  ok   exhaustion message reports MEASURED elapsed time"
  PASS=$((PASS + 1))
else
  echo "  FAIL exhaustion message does not report measured elapsed time (R7)"
  FAIL=$((FAIL + 1))
fi

# --- usage ------------------------------------------------------------------
PATH="$SHIM:$PATH" bash "$TARGET" >/dev/null 2>&1
if [ $? -eq 3 ]; then
  echo "  ok   missing --acr exits 3"
  PASS=$((PASS + 1))
else
  echo "  FAIL missing --acr did not exit 3"
  FAIL=$((FAIL + 1))
fi

# --- CONTROL: the harness itself must be able to fail -----------------------
# Without this, a broken shim (never invoked, always exiting 0) would make every
# case above pass vacuously. Assert the stub really is what `az` resolves to.
if [ "$(PATH="$SHIM:$PATH" command -v az)" = "$SHIM/az" ]; then
  echo "  ok   CONTROL: az resolves to the stub, so the cases above measured it"
  PASS=$((PASS + 1))
else
  echo "  FAIL CONTROL: az did not resolve to the stub — every case above is meaningless"
  FAIL=$((FAIL + 1))
fi

echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
