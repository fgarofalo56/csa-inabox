#!/usr/bin/env bash
# Proof for the #3305 rollout wait in loom-validate-live.sh.
#
# `curl` is STUBBED on PATH — no sockets. Loopback HTTP is not reachable from
# every dev host (curl here routes 127.0.0.1 through a proxy and every request
# times out at 30s), and a harness that measures the proxy instead of the script
# is worse than no harness.
#
# Three cases:
#   A. the new SHA is served immediately   -> PASS, and does NOT wait
#   B. the new SHA appears after N polls   -> PASS, and DID wait
#      (a single curl here is the #3305 bug: it rolled back a healthy revision)
#   C. the new SHA never appears           -> STILL FAILS
#      (the wait must not make the assertion unfailable)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../loom-validate-live.sh"
OLD_SHA="24966acc1f0b2514ad06a055337ef8a766700c59"
NEW_SHA="8449aff57a689a2e6c213913c18f06b663b59e13"
EXPECTED="8449aff5"

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

# A curl that serves OLD_SHA until it has been called FLIP_AFTER times for
# /api/version, then serves NEW_SHA. Every other probe answers healthily so the
# suite reaches its summary.
cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
URL=""
for a in "$@"; do case "$a" in http*) URL="$a";; esac; done
COUNTER="${CURL_COUNTER_FILE}"
case "$URL" in
  */api/version*)
    n=$(cat "$COUNTER" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER"
    if [ "$n" -gt "${FLIP_AFTER:-0}" ] && [ "${SERVE_NEW:-true}" = "true" ]; then
      printf '{"current":"0.93.2","build":{"sha":"%s"}}' "$NEW_SHA_V"
    else
      printf '{"current":"0.93.1","build":{"sha":"%s"}}' "$OLD_SHA_V"
    fi ;;
  */api/health*)  printf '{"status":"ok"}' ;;
  */build-marker.txt*)
    n=$(cat "$COUNTER" 2>/dev/null || echo 0)
    if [ "$n" -gt "${FLIP_AFTER:-0}" ] && [ "${SERVE_NEW:-true}" = "true" ]; then
      printf 'loom-build-marker sha=%s token=LOOM_LIVE_BUILD' "$NEW_SHA_V"
    else
      printf 'loom-build-marker sha=%s token=LOOM_LIVE_BUILD' "$OLD_SHA_V"
    fi ;;
  */api/copilot/tools*)
    for a in "$@"; do [ "$prev" = "-o" ] && echo '{"error":"unauthenticated"}' > "$a"; prev="$a"; done
    printf '401' ;;
  *) printf '<html><script src="/_next/static/x.js"></script></html>' ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/curl"

run_case() {
  local name="$1" serve_new="$2" flip_after="$3" budget="$4" poll="$5"
  local counter; counter="$(mktemp)"
  local out rc start took
  start=$(date +%s)
  out=$(PATH="$STUB_DIR:$PATH" \
        CURL_COUNTER_FILE="$counter" SERVE_NEW="$serve_new" FLIP_AFTER="$flip_after" \
        OLD_SHA_V="$OLD_SHA" NEW_SHA_V="$NEW_SHA" \
        LOOM_ROLLOUT_WAIT_SECONDS="$budget" LOOM_ROLLOUT_POLL_SECONDS="$poll" \
        bash "$SCRIPT" "http://stub.invalid" "$EXPECTED" 2>&1)
  rc=$?
  took=$(( $(date +%s) - start ))
  rm -f "$counter"
  printf '%s|%s|%s\n' "$rc" "$took" "$out"
}

FAILS=0
check() { if [ "$1" = "true" ]; then echo "  ok   — $2"; else echo "  FAIL — $2"; FAILS=$((FAILS+1)); fi; }

echo "A. new SHA served immediately"
R=$(run_case A true 0 60 2); RC="${R%%|*}"; REST="${R#*|}"; TOOK="${REST%%|*}"; OUT="${REST#*|}"
check "$([ "$RC" = "0" ] && echo true || echo false)" "exits 0 (got $RC)"
check "$(echo "$OUT" | grep -q 'contains expected SHA prefix' && echo true || echo false)" "SHA check passed"
check "$([ "$TOOK" -lt 5 ] && echo true || echo false)" "did NOT wait (${TOOK}s)"

echo "B. new SHA appears after 3 polls — the #3305 regression"
R=$(run_case B true 3 60 2); RC="${R%%|*}"; REST="${R#*|}"; TOOK="${REST%%|*}"; OUT="${REST#*|}"
check "$([ "$RC" = "0" ] && echo true || echo false)" "exits 0 (got $RC) — a single curl here rolled back a healthy revision"
check "$(echo "$OUT" | grep -q 'contains expected SHA prefix' && echo true || echo false)" "SHA check passed after waiting"
check "$(echo "$OUT" | grep -q 'waiting for' && echo true || echo false)" "reported that it waited"

echo "C. new SHA never appears — must STILL fail"
R=$(run_case C false 0 6 2); RC="${R%%|*}"; REST="${R#*|}"; TOOK="${REST%%|*}"; OUT="${REST#*|}"
check "$([ "$RC" != "0" ] && echo true || echo false)" "exits non-zero (got $RC) — the wait must not make this unfailable"
check "$(echo "$OUT" | grep -q 'after waiting' && echo true || echo false)" "failure says how long it waited"
check "$([ "$TOOK" -ge 6 ] && [ "$TOOK" -lt 40 ] && echo true || echo false)" "respected the budget (${TOOK}s)"

echo
if [ "$FAILS" -eq 0 ]; then echo "rollout-wait: ALL CHECKS PASS"; exit 0; fi
echo "rollout-wait: $FAILS CHECK(S) FAILED"; exit 1
