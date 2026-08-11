#!/usr/bin/env bash
# =============================================================================
# test-cosign-sign-retry.sh — self-test for the keyless-signing retry
# =============================================================================
#
# Runs OFFLINE against a stub `cosign` on PATH. The case that matters is 3: the
# retry MUST be able to fail. A signing retry that cannot fail would ship an
# unsigned image while reporting success, which is worse than the transient it
# was written to absorb (deploy-integrity.md R6, csa_loom_gates_that_cannot_fail).
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGN="$HERE/cosign-sign-retry.sh"
STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

# Stub cosign: fails for the first $STUB_FAIL_TIMES invocations, then succeeds.
# Counts invocations so "did it re-invoke?" is measured, not inferred — the whole
# point of the fix is that a NEW process is what re-mints the OIDC token.
cat > "$STUB/cosign" <<'CS'
#!/usr/bin/env bash
N=$(( $(cat "$STUB_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$STUB_COUNT"
if [ "$N" -le "${STUB_FAIL_TIMES:-0}" ]; then
  echo "Error: signing digest: getting Fulcio signer: getting key from Fulcio: retrieving cert: error obtaining token: expired_token" >&2
  exit 1
fi
echo "tlog entry created with index: 12345"
exit 0
CS
chmod +x "$STUB/cosign"

REF="acrtest.azurecr.io/loom-console@sha256:75cc0213f7424f485eb54f7538d8a3ad34ff574b9a15fe90da7445a02ef4734b"

run() {
  : > "$STUB/count.txt"
  OUT="$(STUB_COUNT="$STUB/count.txt" PATH="$STUB:$PATH" \
        bash "$SIGN" --ref "${1:-$REF}" --attempts "${ATTEMPTS:-3}" --backoff 0 2>&1)"
  RC=$?
  # `: >` creates an EMPTY file, so a bare `cat` yields "" and the `|| echo 0`
  # never fires (cat SUCCEEDS on an empty file). An empty CALLS then compares
  # unequal to every expected count and prints "invoked  times" — a test bug that
  # reads exactly like a script bug.
  CALLS="$(cat "$STUB/count.txt" 2>/dev/null)"; CALLS="${CALLS:-0}"
}

echo "== cosign-sign-retry self-test =="

# 1. HAPPY PATH: signs on the first try, exactly one invocation, no sleeping.
STUB_FAIL_TIMES=0 run
[ $RC -eq 0 ] && pass "signs first try => exit 0" || fail "expected 0, got $RC: $OUT"
[ "$CALLS" = "1" ] && pass "happy path costs exactly ONE cosign invocation" || fail "invoked $CALLS times"

# 2. THE FIX: a transient failure is absorbed by RE-INVOKING, and the retry is a
#    new process — that is what mints a fresh OIDC token. Two failures then a
#    success must come out signed, with three invocations.
STUB_FAIL_TIMES=2 run
[ $RC -eq 0 ] && pass "two transients then success => exit 0" || fail "expected 0, got $RC: $OUT"
[ "$CALLS" = "3" ] && pass "re-INVOKES cosign (3 processes) rather than retrying in-process" || fail "expected 3 invocations, got $CALLS"
echo "$OUT" | grep -qi "expired_token. here is a symptom" \
  && pass "names expired_token as a symptom, not a credential fault" \
  || fail "does not explain the expired_token mutation"

# 3. IT MUST BE ABLE TO FAIL. A signing retry that cannot fail ships an unsigned
#    image while reporting success.
STUB_FAIL_TIMES=99 run
[ $RC -eq 1 ] && pass "exhausted budget => exit 1, FAILS CLOSED" || fail "expected 1, got $RC"
[ "$CALLS" = "3" ] && pass "spends exactly the 3-attempt budget, no more" || fail "expected 3 invocations, got $CALLS"
echo "$OUT" | grep -q "BUILT but UNSIGNED" && pass "says the image is unsigned and will be rejected" || fail "does not state the consequence"

# 4. ATTEMPT BUDGET is honoured, so a caller can tighten it.
ATTEMPTS=1 STUB_FAIL_TIMES=99 run
[ "$CALLS" = "1" ] && pass "--attempts 1 makes exactly one invocation" || fail "expected 1 invocation, got $CALLS"

# 5. A TAG REFERENCE IS REFUSED. Signing a tag signs whatever it pointed at when
#    cosign resolved it, which need not be what was just built — and the roll
#    gates verify by digest, so a tag signature would verify nothing.
run "acrtest.azurecr.io/loom-console:latest"
[ $RC -eq 1 ] && pass "a tag ref is refused => exit 1" || fail "expected 1 for a tag ref, got $RC"
[ "$CALLS" = "0" ] && pass "refused BEFORE invoking cosign" || fail "invoked cosign $CALLS times on a bad ref"
echo "$OUT" | grep -qi "does not prove which image" && pass "explains why a tag is not acceptable" || fail "no reason given for refusing a tag"

echo
if [ $FAILED -eq 0 ]; then echo "cosign-sign-retry: ALL CASES PASS"; else echo "cosign-sign-retry: FAILURES ABOVE"; fi
exit $FAILED
