#!/usr/bin/env bash
# =============================================================================
# test-acr-dataplane-gate.sh — self-test for scripts/ci/acr-dataplane-gate.sh
# =============================================================================
#
# WHY (#4079). Every Azure Government caller of the ACR data-plane probe threw
# its exit status away with `|| echo "::warning::…"`, so the probe's three
# distinguishable verdicts collapsed into one sentence and #4067's hardening
# changed the Gov LOG without changing Gov BEHAVIOUR.
#
# This suite pins the two properties that make the gate worth having:
#
#   1. It DISTINGUISHES. Exit 1 (never sustained — propagation), exit 2 (no HTTP
#      response at all — an UNKNOWN) and exit 3 (the caller's own arguments were
#      refused) produce different messages. A gate that says the same thing for
#      all three is the `|| echo` it replaces, wearing a script name.
#   2. It does NOT over-claim. No message may say the registry DENIED or REFUSED
#      this runner, because no exit code here establishes that (R7). That
#      assertion is checked against the emitted text, not asserted in prose.
#
# The probe is stubbed via a PATH-independent override (LOOM_ACR_DATAPLANE_READY_
# SCRIPT), so this runs anywhere — no Azure, no network, no registry.
#
# Usage: bash scripts/ci/test-acr-dataplane-gate.sh
# Exit:  0 all cases passed / 1 a case failed
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/acr-dataplane-gate.sh"
[ -f "$TARGET" ] || { echo "FAIL: $TARGET not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The probe stub: exits with whatever PROBE_RC asks for.
STUB="$TMP/probe.sh"
cat > "$STUB" <<'STUBEOF'
#!/usr/bin/env bash
echo "[stub-probe] invoked: $*"
exit "${PROBE_RC:-0}"
STUBEOF
chmod +x "$STUB"

PASS=0
FAIL=0

run() {
  # run <probe_rc> [extra args...] -> sets OUT and RC
  local rc="$1"; shift
  OUT="$(PROBE_RC="$rc" LOOM_ACR_DATAPLANE_READY_SCRIPT="$STUB" \
        bash "$TARGET" --acr testacr --timeout-seconds 5 "$@" 2>&1)"
  RC=$?
}

expect_rc() {
  local name="$1" want="$2"
  if [ "$RC" = "$want" ]; then
    echo "  ok   $name (rc=$RC)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected rc=$want, got rc=$RC"
    printf '%s\n' "$OUT" | sed 's/^/         | /'
    FAIL=$((FAIL + 1))
  fi
}

expect_says() {
  local name="$1" needle="$2"
  if printf '%s' "$OUT" | grep -qi -- "$needle"; then
    echo "  ok   $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — output did not contain: $needle"
    printf '%s\n' "$OUT" | sed 's/^/         | /'
    FAIL=$((FAIL + 1))
  fi
}

echo "== acr-dataplane-gate self-test"

# --- the success path is a pass-through --------------------------------------
run 0
expect_rc "READY probe exits 0" 0

# --- warn is the default, and it PROCEEDS ------------------------------------
run 1
expect_rc "not-sustained (1) warns and proceeds by default" 0
expect_says "…and names PROPAGATION, not a refusal" "propagat"

run 2
expect_rc "no-response (2) warns and proceeds by default" 0
expect_says "…and calls it an UNKNOWN" "UNKNOWN"

run 3
expect_rc "bad probe arguments (3) warns and proceeds by default" 0
expect_says "…and blames the CALLER's configuration" "CALLER"

# --- DISCRIMINATION: the three verdicts must not read the same ---------------
# Collapsing them is the `|| echo` this gate replaces. Comparing 1 against 2
# catches a refactor that funnels every code through one message.
run 1; MSG1="$OUT"
run 2; MSG2="$OUT"
if [ "$MSG1" != "$MSG2" ]; then
  echo "  ok   exit 1 and exit 2 produce DIFFERENT messages"
  PASS=$((PASS + 1))
else
  echo "  FAIL exit 1 and exit 2 produce the SAME message — the gate does not discriminate"
  FAIL=$((FAIL + 1))
fi

# --- R7: no message may assert a refusal the exit code did not establish ------
BAD=0
for rc in 1 2 3; do
  run "$rc"
  if printf '%s' "$OUT" | grep -qiE "\b(denied|refused (you|this runner)|rejected the runner)\b"; then
    echo "  FAIL exit $rc claims a DENIAL the probe never established (R7)"
    printf '%s\n' "$OUT" | sed 's/^/         | /'
    BAD=1
  fi
done
if [ "$BAD" -eq 0 ]; then
  echo "  ok   no verdict asserts a denial the exit code did not establish (R7)"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

# --- opt-in fail mode --------------------------------------------------------
run 1 --on-unconfirmed fail
expect_rc "--on-unconfirmed=fail turns a non-zero verdict into rc=1" 1
run 0 --on-unconfirmed fail
expect_rc "--on-unconfirmed=fail still passes a READY probe" 0

# --- usage -------------------------------------------------------------------
OUT="$(LOOM_ACR_DATAPLANE_READY_SCRIPT="$STUB" bash "$TARGET" --timeout-seconds 5 2>&1)"; RC=$?
expect_rc "missing --acr exits 3" 3
OUT="$(LOOM_ACR_DATAPLANE_READY_SCRIPT="$STUB" bash "$TARGET" --acr x --on-unconfirmed maybe 2>&1)"; RC=$?
expect_rc "an unknown --on-unconfirmed value exits 3" 3

# --- CONTROL: the harness must be able to fail -------------------------------
# Without this, a stub that was never invoked would make every case above pass
# vacuously.
run 0
if printf '%s' "$OUT" | grep -q "stub-probe"; then
  echo "  ok   CONTROL: the stub probe really was invoked"
  PASS=$((PASS + 1))
else
  echo "  FAIL CONTROL: the stub probe was never invoked — every case above is meaningless"
  FAIL=$((FAIL + 1))
fi

echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
