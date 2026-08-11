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
# The mutation that matters is case 5: the first draft wrote
# `CODE="$(curl … || echo 000)"`, and because curl PRINTS `000` on a connect
# failure and ALSO exits non-zero, the fallback concatenated to `000000`. That
# fell past the `000` branch and reported a DNS failure as "still refusing this
# runner" — the exact UNKNOWN-as-NEGATIVE bug the probe exists to prevent,
# reproduced inside the fix. This test fails if it comes back.
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/acr-dataplane-ready.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

# `az` stub: answers the two queries the probe makes.
cat > "$STUB_DIR/az" <<'AZ'
#!/usr/bin/env bash
case "$*" in
  *"cloud show"*)   echo ".azurecr.io" ;;
  *"acr show"*)     echo -e "Enabled\tAllow" ;;
  *)                exit 1 ;;
esac
AZ
chmod +x "$STUB_DIR/az"

# `curl` stub: STUB_CODE picks the HTTP status; STUB_CONNECT_FAIL=1 mimics a
# connect/DNS failure exactly as real curl does — print `000`, exit 6.
cat > "$STUB_DIR/curl" <<'CURL'
#!/usr/bin/env bash
OUT=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then OUT="$a"; fi
  prev="$a"
done
if [ "${STUB_CONNECT_FAIL:-0}" = "1" ]; then
  [ -n "$OUT" ] && : > "$OUT"
  printf '000'
  exit 6
fi
[ -n "$OUT" ] && printf '%s' "${STUB_BODY:-}" > "$OUT"
printf '%s' "${STUB_CODE:-401}"
exit 0
CURL
chmod +x "$STUB_DIR/curl"

run() { PATH="$STUB_DIR:$PATH" bash "$PROBE" --acr testacr --timeout-seconds "${1:-6}" --interval-seconds 2 2>&1; }

echo "== acr-dataplane-ready self-test =="

# 1. 401 => the registry is evaluating auth => READY.
OUT="$(STUB_CODE=401 STUB_BODY='{"errors":[{"code":"UNAUTHORIZED"}]}' run 6)"; RC=$?
[ $RC -eq 0 ] && pass "401 UNAUTHORIZED => ready (exit 0)" || fail "401 should be ready, got exit $RC: $OUT"

# 2. 200 (anonymous pull enabled) => also reachable.
OUT="$(STUB_CODE=200 STUB_BODY='{}' run 6)"; RC=$?
[ $RC -eq 0 ] && pass "200 => ready (exit 0)" || fail "200 should be ready, got exit $RC"

# 3. 403 DENIED for the whole budget => NOT ready, exit 1.
OUT="$(STUB_CODE=403 STUB_BODY='{"errors":[{"code":"DENIED","message":"client with IP is not allowed access"}]}' run 6)"; RC=$?
[ $RC -eq 1 ] && pass "403 DENIED for the full budget => exit 1" || fail "403 should exit 1, got $RC"

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

# 6. Suffix must come from the cloud, never a literal — an az that cannot answer
#    must make the probe refuse rather than guess.
cat > "$STUB_DIR/az" <<'AZ2'
#!/usr/bin/env bash
exit 1
AZ2
chmod +x "$STUB_DIR/az"
OUT="$(STUB_CODE=401 run 6)"; RC=$?
[ $RC -eq 3 ] && pass "unreadable cloud config => exit 3, refuses to guess a suffix" || fail "should exit 3 when the suffix is unknown, got $RC: $OUT"

echo
if [ $FAILED -eq 0 ]; then echo "acr-dataplane-ready: ALL CASES PASS"; else echo "acr-dataplane-ready: FAILURES ABOVE"; fi
exit $FAILED
