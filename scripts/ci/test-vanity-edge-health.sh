#!/usr/bin/env bash
# =============================================================================
# test-vanity-edge-health.sh — self-test for the vanity-domain edge detector
# =============================================================================
#
# Runs OFFLINE against a stub `az` / `openssl` on PATH. Each case asserts the
# EXIT CODE, because that is what a monitor branches on, and asserts the message
# does not claim something the probe did not establish (R7).
#
# The case that matters most is 5: an UNREADABLE control plane must be UNKNOWN
# (exit 2), never "unbound" (exit 1). A monitor that cries outage whenever its
# own permissions lapse gets muted, and then the real outage is invisible — which
# is how the vanity domain went down twice with nothing watching it.
#
# The stub models the DISCOVERY chain the probe actually walks:
#   az afd profile list  ->  az afd custom-domain list  ->
#   az afd endpoint list ->  az afd route list
# The probe takes no endpoint or route NAME (check-afd-endpoint-discovery.mjs),
# so the stub cannot shortcut it either.
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
SUB="$1 $2 $3"
case "$SUB" in
  "afd profile list")
     case "${STUB_MODE:-ok}" in
       profiles-unreadable) echo "ERROR: (AuthorizationFailed) no authorization to perform 'Microsoft.Cdn/profiles/read'" >&2; exit 1 ;;
       no-profiles)         : ;;
       *)                   echo "fd-loom-test" ;;
     esac ;;
  "afd custom-domain list")
     case "${STUB_MODE:-ok}" in
       domains-unreadable) echo "ERROR: (AuthorizationFailed) customDomains/read denied" >&2; exit 1 ;;
       no-domain)          echo "" ;;
       *)                  echo "csa-loom-limitlessdata" ;;
     esac ;;
  "afd endpoint list")
     echo "loom-console-test" ;;
  "afd route list")
     case "${STUB_MODE:-ok}" in
       routes-unreadable) echo "ERROR: (AuthorizationFailed) routes/read denied" >&2; exit 1 ;;
       routes-garbage)    echo "not json at all" ;;
       no-routes)         echo '[]' ;;
       unbound)           echo '[{"name":"console-route","customDomains":[],"linkToDefaultDomain":"Enabled"}]' ;;
       *)                 echo '[{"name":"console-route","customDomains":[{"id":"/subscriptions/x/providers/Microsoft.Cdn/profiles/fd-loom-test/customDomains/csa-loom-limitlessdata"}],"linkToDefaultDomain":"Enabled"}]' ;;
     esac ;;
  *) exit 0 ;;
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

run() {
  PATH="$STUB:$PATH" bash "$PROBE" --rg rg-test --host csa-loom.limitlessdata.ai 2>&1
}

echo "== vanity-edge-health self-test =="

# 1. Discovered, bound, own certificate => healthy.
OUT="$(STUB_MODE=ok STUB_CERT=good run)"; RC=$?
[ $RC -eq 0 ] && pass "discovered + bound + own certificate => exit 0" || fail "expected 0, got $RC: $OUT"
echo "$OUT" | grep -q "carried by route" && pass "names the route that carries it" || fail "does not name the carrying route"

# 2. THE OUTAGE: no route lists the domain => broken, and the message must point
#    at the ROUTE, not the custom-domain resource (which reads healthy throughout).
OUT="$(STUB_MODE=unbound STUB_CERT=fallback run)"; RC=$?
[ $RC -eq 1 ] && pass "no route carries the domain => exit 1" || fail "expected 1, got $RC: $OUT"
echo "$OUT" | grep -q "VANITY DOMAIN UNBOUND" && pass "names the unbinding explicitly" || fail "no VANITY DOMAIN UNBOUND"
echo "$OUT" | grep -qi "check the ROUTE, not the domain" && pass "warns the custom domain reads healthy anyway" || fail "missing the route-vs-domain warning"
echo "$OUT" | grep -q -- "--formatted-custom-domains" && pass "carries the repair flag that actually exists" || fail "missing the repair command"

# 3. Bound, but the edge still serves the fallback (a just-repaired estate).
#    Must be RED — a user cannot load the site — and must say which case it is.
OUT="$(STUB_MODE=ok STUB_CERT=fallback run)"; RC=$?
[ $RC -eq 1 ] && pass "bound but edge serves the fallback => exit 1" || fail "expected 1, got $RC"
echo "$OUT" | grep -qi "propagation" && pass "distinguishes propagation from an unbinding" || fail "does not distinguish propagation"

# 4. The host is not configured at the edge at all — a deploy gap, not a loose
#    binding. Different cause, different message.
OUT="$(STUB_MODE=no-domain run)"; RC=$?
[ $RC -eq 1 ] && pass "no custom domain for the host => exit 1" || fail "expected 1, got $RC: $OUT"
echo "$OUT" | grep -qi "not configured at the edge at all" && pass "calls it a deploy gap, not an unbinding" || fail "conflates a missing domain with an unbinding"

# 5. THE REGRESSION GUARD. Every unreadable control-plane call is UNKNOWN (2),
#    never "unbound" (1). Four separate az calls, four chances to get it wrong.
for MODE in profiles-unreadable domains-unreadable routes-unreadable routes-garbage; do
  OUT="$(STUB_MODE=$MODE run)"; RC=$?
  [ $RC -eq 2 ] && pass "$MODE => exit 2 (UNKNOWN)" || fail "$MODE expected 2, got $RC: $OUT"
  if echo "$OUT" | grep -qi "VANITY DOMAIN UNBOUND"; then
    fail "$MODE was reported as an unbinding — the exact false outage this must not produce"
  fi
done

# 6. A silent TLS handshake must NOT flip the verdict on its own — a runner-side
#    network fault looks identical, and the control plane is authoritative.
OUT="$(STUB_MODE=ok STUB_CERT=silent run)"; RC=$?
[ $RC -eq 0 ] && pass "bound + no TLS answer => still exit 0, warned not failed" || fail "expected 0, got $RC: $OUT"
echo "$OUT" | grep -qi "not by itself proof of an outage" && pass "says why the silence is not a verdict" || fail "missing the silence caveat"

echo
if [ $FAILED -eq 0 ]; then echo "vanity-edge-health: ALL CASES PASS"; else echo "vanity-edge-health: FAILURES ABOVE"; fi
exit $FAILED
