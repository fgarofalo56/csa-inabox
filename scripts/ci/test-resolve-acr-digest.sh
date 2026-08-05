#!/usr/bin/env bash
# SELF-TEST for scripts/ci/resolve-acr-digest.sh (#2980 / #2982).
# ---------------------------------------------------------------------------
# The bug this resolver replaces was a gate that reported a FALSE NEGATIVE:
# "the tag does not exist" printed about images that were provably in the
# registry, because `2>/dev/null` had thrown the real (network-denied) error
# away. The fix is a retry loop — and a retry loop is exactly the kind of thing
# that quietly becomes a gate that CANNOT FAIL. So the first thing this test
# proves is the MUTATION: a registry that never returns a digest must come out
# RED after the budget, never green, never "assume fine".
#
# It also proves the happy path costs nothing: one `az` call, zero sleeps. A
# retry that adds latency to every good roll would be its own defect.
#
# Both `az` and `sleep` are stubbed and COUNTED. No Azure, no network, no
# credentials, no wall-clock waiting.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNDER_TEST="$HERE/resolve-acr-digest.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

AZ_CALLS="$STUB_DIR/az.calls"
SLEEP_CALLS="$STUB_DIR/sleep.calls"

# ── stub `az` ───────────────────────────────────────────────────────────────
# Emits what the REAL `az acr repository show --image <ref> -o json` emits:
# a MULTI-LINE JSON object on success (so the parser's newline handling is
# exercised), and the registry's own error text on failure.
#
# MODE:
#   ok              always resolves
#   denied          always refused by the ACR firewall (the #2980 condition)
#   absent          always 404
#   unauthorized    token/auth failure (must NOT be read as "absent")
#   nodigest        exit 0 but no digest field (an answer we do not understand)
#   denied-then-ok  refused for FLAKY_N calls, then resolves
#   absent-then-ok  404 for FLAKY_N calls, then resolves
#   denied-then-absent  refused once, then 404 forever
cat > "$STUB_DIR/az" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$AZ_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$AZ_CALLS"

emit_ok() {
  cat <<'JSON'
{
  "changeableAttributes": {
    "deleteEnabled": true,
    "listEnabled": true,
    "readEnabled": true,
    "writeEnabled": true
  },
  "createdTime": "2026-08-05T06:38:02.1234567Z",
  "digest": "sha256:a38a93e826a73f7afd1e812835f064f0c12808cd38db06c070a3a36318a5aed7",
  "lastUpdateTime": "2026-08-05T06:38:02.1234567Z",
  "name": "248dbc83b1741e9d5f71d0ceb77faf9df73721e5",
  "signed": false
}
JSON
  exit 0
}
emit_denied() {
  echo "denied: client with IP '20.42.13.7' is not allowed access. Refer to https://aka.ms/acr/firewall for details." >&2
  exit 1
}
emit_absent() {
  echo "ResourceNotFoundError: The manifest 'v0.1' does not exist for the repository 'loom-console' in the registry 'stubacr'." >&2
  exit 1
}

case "${MODE}" in
  ok)             emit_ok ;;
  denied)         emit_denied ;;
  absent)         emit_absent ;;
  unauthorized)   echo "unauthorized: authentication required, visit https://aka.ms/acr/authorization" >&2; exit 1 ;;
  nodigest)       echo '{"name": "248dbc83", "signed": false}'; exit 0 ;;
  denied-then-ok) if [ "$n" -le "${FLAKY_N:-1}" ]; then emit_denied; fi; emit_ok ;;
  absent-then-ok) if [ "$n" -le "${FLAKY_N:-1}" ]; then emit_absent; fi; emit_ok ;;
  denied-then-absent) if [ "$n" -le 1 ]; then emit_denied; fi; emit_absent ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/az"

# ── stub `sleep` — counts, never waits ──────────────────────────────────────
cat > "$STUB_DIR/sleep" <<'STUB'
#!/usr/bin/env bash
n=$(( $(cat "$SLEEP_CALLS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$SLEEP_CALLS"
exit 0
STUB
chmod +x "$STUB_DIR/sleep"

export AZ_CALLS SLEEP_CALLS
export LOOM_AZ_BIN="$STUB_DIR/az"
export LOOM_DIGEST_SLEEP_BIN="$STUB_DIR/sleep"
export LOOM_DIGEST_BACKOFF_SECONDS=1

FAILURES=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; FAILURES=$((FAILURES + 1)); }

reset() { rm -f "$AZ_CALLS" "$SLEEP_CALLS"; }
az_calls()    { cat "$AZ_CALLS" 2>/dev/null || echo 0; }
sleep_calls() { cat "$SLEEP_CALLS" 2>/dev/null || echo 0; }

run() { # run <MODE> [VAR=value ...] -> sets RC / OUT / ERRTXT
  reset
  local mode="$1"; shift
  ERR="$STUB_DIR/err.$$"
  # `env` — NOT `MODE=x "$@" bash …`, which makes bash try to EXECUTE the
  # assignment as a command (exit 127) and would have turned every negative
  # case into a false "it failed, good".
  OUT="$(env MODE="$mode" "$@" bash "$UNDER_TEST" --acr stubacr --image loom-console:248dbc83 2>"$ERR")"
  RC=$?
  ERRTXT="$(cat "$ERR")"
  return 0
}

echo "resolve-acr-digest self-test"

# ── 1. HAPPY PATH — resolves, and costs nothing extra ───────────────────────
run ok
[ "$RC" = "0" ] && pass "resolves the digest (exit 0)" || fail "resolves the digest — got exit $RC"
case "$OUT" in
  sha256:a38a93e826a73f7afd1e812835f064f0c12808cd38db06c070a3a36318a5aed7) pass "prints the digest parsed out of multi-line JSON" ;;
  *) fail "digest on stdout — got '$OUT'" ;;
esac
# THE LATENCY PROOF: exactly one registry call, and not a single sleep.
[ "$(az_calls)" = "1" ]    && pass "happy path makes exactly 1 az call"  || fail "happy path made $(az_calls) az calls, expected 1"
[ "$(sleep_calls)" = "0" ] && pass "happy path sleeps 0 times (no added latency)" || fail "happy path slept $(sleep_calls) times, expected 0"

# ── 2. THE MUTATION PROOF ───────────────────────────────────────────────────
# A registry that NEVER returns a digest must end RED after the budget. If this
# case ever goes green the retry has become a gate that cannot fail, and the
# roll is free to deploy an image nobody verified.
run denied LOOM_DIGEST_ATTEMPTS=4
[ "$RC" = "4" ] && pass "MUTATION: registry never returns a digest -> RED (exit 4)" \
                || fail "MUTATION: expected exit 4 (fail closed), got $RC — the retry cannot fail"
[ "$RC" != "0" ] || fail "MUTATION: resolver returned success while never resolving anything"
[ "$(az_calls)" = "4" ] && pass "MUTATION: consumed the whole 4-attempt budget" \
                        || fail "MUTATION: made $(az_calls) attempts, expected 4"
[ "$(sleep_calls)" = "3" ] && pass "MUTATION: backed off between attempts (3 sleeps for 4 attempts)" \
                           || fail "MUTATION: slept $(sleep_calls) times, expected 3"
case "$ERRTXT" in
  *"could not READ"*) pass "MUTATION: message says it could not READ the registry" ;;
  *) fail "MUTATION: message did not say 'could not READ' — got: $ERRTXT" ;;
esac
case "$ERRTXT" in
  *"does not exist"*) fail "MUTATION: a network denial was reported as 'does not exist' — the exact false statement this fixes" ;;
  *) pass "MUTATION: a network denial is NOT reported as 'the tag does not exist'" ;;
esac

# ── 3. GENUINE ABSENCE still fails, and says so accurately ──────────────────
run absent LOOM_DIGEST_ABSENT_ATTEMPTS=3
[ "$RC" = "3" ] && pass "a genuinely missing tag -> exit 3" || fail "missing tag — expected exit 3, got $RC"
case "$ERRTXT" in
  *"does not exist"*) pass "missing tag is reported as 'does not exist'" ;;
  *) fail "missing tag message lacked 'does not exist' — got: $ERRTXT" ;;
esac

# ── 4. UNKNOWN must never collapse into NEGATIVE (#2819 invariant) ──────────
# One unreadable answer poisons the well: absence was never observed.
run denied-then-absent LOOM_DIGEST_ATTEMPTS=4 LOOM_DIGEST_ABSENT_ATTEMPTS=2
[ "$RC" = "4" ] && pass "unreadable-then-404 -> UNKNOWN (4), never ABSENT (3)" \
                || fail "unreadable-then-404 — expected exit 4, got $RC"

# ── 5. RETRY ACTUALLY WORKS — the propagation windows both close ────────────
run denied-then-ok FLAKY_N=2 LOOM_DIGEST_ATTEMPTS=6
[ "$RC" = "0" ] && pass "firewall denial that clears mid-budget -> resolves (exit 0)" \
                || fail "denied-then-ok — expected exit 0, got $RC"
[ "$(az_calls)" = "3" ] && pass "retried until the registry answered (3 calls)" || fail "denied-then-ok made $(az_calls) calls, expected 3"

run absent-then-ok FLAKY_N=1 LOOM_DIGEST_ABSENT_ATTEMPTS=3
[ "$RC" = "0" ] && pass "just-pushed manifest that 404s once -> resolves (exit 0)" \
                || fail "absent-then-ok — expected exit 0, got $RC"

# ── 6. An answer we do not understand is UNKNOWN, not absence ───────────────
run nodigest LOOM_DIGEST_ATTEMPTS=2
[ "$RC" = "4" ] && pass "exit-0-without-a-digest-field -> UNKNOWN (4)" || fail "nodigest — expected exit 4, got $RC"

run unauthorized LOOM_DIGEST_ATTEMPTS=2
[ "$RC" = "4" ] && pass "auth failure -> UNKNOWN (4), not ABSENT" || fail "unauthorized — expected exit 4, got $RC"

# ── 7. Usage ────────────────────────────────────────────────────────────────
reset
bash "$UNDER_TEST" --acr stubacr >/dev/null 2>&1
[ "$?" = "2" ] && pass "missing --image -> usage exit 2" || fail "missing --image did not exit 2"
reset
bash "$UNDER_TEST" --image loom-console:abc >/dev/null 2>&1
[ "$?" = "2" ] && pass "missing --acr -> usage exit 2" || fail "missing --acr did not exit 2"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "::error::resolve-acr-digest self-test FAILED ($FAILURES check(s))." >&2
  exit 1
fi
echo "resolve-acr-digest self-test: all checks passed."
