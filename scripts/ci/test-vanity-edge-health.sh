#!/usr/bin/env bash
# =============================================================================
# test-vanity-edge-health.sh — self-test for the vanity-domain edge detector
# =============================================================================
#
# Runs OFFLINE against stub `az` / `openssl` / `curl` on PATH. Each case asserts
# the EXIT CODE, because that is what a monitor branches on, and asserts the
# message does not claim something the probe did not establish (R7).
#
# The case that matters most is 4: an UNREADABLE control plane must be UNKNOWN
# (exit 2), never "unbound" (exit 1). A monitor that cries outage whenever its
# own permissions lapse gets muted, and then the real outage is invisible — which
# is how the vanity domain went down twice with nothing watching it.
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/check-vanity-edge-health.sh"
STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT

FAILED=0
pass() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

cat > "$STUB/az" <<'AZ'
#!/usr/bin/env bash
case "${STUB_ROUTE:-ok}" in
  unreadable) echo "ERROR: (AuthorizationFailed) does not have authorization to perform action 'Microsoft.Cdn/profiles/afdEndpoints/routes/read'" >&2; exit 1 ;;
  garbage)    echo "not json at all" ;;
  unbound)    echo '{"name":"console-route","customDomains":[],"linkToDefaultDomain":"Enabled"}' ;;
  *)          echo '{"name":"console-route","customDomains":[{"id":"/subscriptions/x/…/csa-loom-limitlessdata"}],"linkToDefaultDomain":"Enabled"}' ;;
esac
exit 0
AZ
chmod +x "$STUB/az"

cat > "$STUB/openssl" <<'SSL'
#!/usr/bin/env bash
case "${STUB_CERT:-good}" in
  fallback) echo "subject=C=US, ST=WA, L=Redmond, O=Microsoft Corporation, CN=*.azureedge.net" ;;
  silent)   : ;;
  *)        echo "subject=CN=csa-loom.limitlessdata.ai" ;;
esac
exit 0
SSL
chmod +x "$STUB/openssl"

# `timeout` is invoked around openssl; keep it real but make sure the stub wins.
run() {
  PATH="$STUB:$PATH" bash "$PROBE" \
    --profile p --rg rg --endpoint ep --route console-route \
    --host csa-loom.limitlessdata.ai 2>&1
}

echo "== vanity-edge-health self-test =="

# 1. Bound + its own certificate => healthy.
OUT="$(STUB_ROUTE=ok STUB_CERT=good run)"; RC=$?
[ $RC -eq 0 ] && pass "bound + own certificate => exit 0" || fail "expected 0, got $RC: $OUT"

# 2. THE OUTAGE: customDomains: [] => broken, and the message must name the ROUTE,
#    not the custom-domain resource (which reads healthy throughout).
OUT="$(STUB_ROUTE=unbound STUB_CERT=fallback run)"; RC=$?
[ $RC -eq 1 ] && pass "customDomains: [] => exit 1" || fail "expected 1, got $RC: $OUT"
echo "$OUT" | grep -q "VANITY DOMAIN UNBOUND" && pass "names the unbinding explicitly" || fail "no VANITY DOMAIN UNBOUND: $OUT"
echo "$OUT" | grep -qi "check the ROUTE, not the domain" && pass "warns that the custom domain reads healthy anyway" || fail "missing the route-vs-domain warning"
echo "$OUT" | grep -q -- "--formatted-custom-domains" && pass "carries the repair command that actually exists" || fail "missing the repair command"

# 3. Bound, but the edge still serves the fallback (a just-repaired estate).
#    Must be RED — a user cannot load the site — and must say which case it is.
OUT="$(STUB_ROUTE=ok STUB_CERT=fallback run)"; RC=$?
[ $RC -eq 1 ] && pass "bound but edge serves the fallback => exit 1" || fail "expected 1, got $RC"
echo "$OUT" | grep -qi "propagation" && pass "distinguishes propagation from an unbinding" || fail "does not distinguish propagation: $OUT"

# 4. THE REGRESSION GUARD. An unreadable control plane is UNKNOWN, never "unbound".
OUT="$(STUB_ROUTE=unreadable run)"; RC=$?
[ $RC -eq 2 ] && pass "unreadable control plane => exit 2 (UNKNOWN, not broken)" || fail "expected 2, got $RC: $OUT"
if echo "$OUT" | grep -qi "VANITY DOMAIN UNBOUND"; then
  fail "an unreadable route was reported as an unbinding — the exact false-outage this guard must not produce"
else
  pass "an unreadable route is NOT reported as an unbinding"
fi
echo "$OUT" | grep -q "UNKNOWN" && pass "says UNKNOWN explicitly" || fail "missing UNKNOWN"

# 5. Unparseable output is also UNKNOWN, not zero domains.
OUT="$(STUB_ROUTE=garbage run)"; RC=$?
[ $RC -eq 2 ] && pass "unparseable route JSON => exit 2, not a zero-domain verdict" || fail "expected 2, got $RC: $OUT"

# 6. A silent TLS handshake must NOT flip the verdict on its own — a runner-side
#    network fault looks identical, and the control plane is authoritative.
OUT="$(STUB_ROUTE=ok STUB_CERT=silent run)"; RC=$?
[ $RC -eq 0 ] && pass "bound + no TLS answer => still exit 0, warned not failed" || fail "expected 0, got $RC: $OUT"
echo "$OUT" | grep -qi "not by itself proof of an outage" && pass "says why the silence is not a verdict" || fail "missing the silence caveat"

echo
if [ $FAILED -eq 0 ]; then echo "vanity-edge-health: ALL CASES PASS"; else echo "vanity-edge-health: FAILURES ABOVE"; fi
exit $FAILED
