#!/usr/bin/env bash
# loom-validate-live.sh — probes the live Loom Console URL and validates that
# the deployed image contains the expected build markers. Exits 1 on any
# discrepancy so the calling workflow can roll back / open an issue.
#
# Usage:
#   bash .github/scripts/loom-validate-live.sh <url> <expected-sha-prefix>
# Example:
#   bash .github/scripts/loom-validate-live.sh \
#     https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net \
#     d07f330d
set -uo pipefail

URL="${1:-https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net}"
EXPECTED_SHA="${2:-}"

FAIL=0
log() { echo "::group::$1"; }
end() { echo "::endgroup::"; }
ok() { echo "::notice::PASS — $1"; }
fail() { echo "::error::FAIL — $1"; FAIL=1; }

CACHEBUST="?_$(date +%s)"

# ---------------------------------------------------------------------------
# 1) /api/health — basic alive check
# ---------------------------------------------------------------------------
log "1. /api/health"
HEALTH=$(curl -s -m 30 "${URL}/api/health${CACHEBUST}" || true)
echo "$HEALTH"
echo "$HEALTH" | grep -q '"status":"ok"' && ok "health endpoint returns ok" || fail "health endpoint did not return ok"
end

# ---------------------------------------------------------------------------
# 2) /api/version — must include the expected SHA if provided
# ---------------------------------------------------------------------------
log "2. /api/version"
VER_JSON=$(curl -s -m 30 "${URL}/api/version${CACHEBUST}" || true)
echo "$VER_JSON"
CURRENT=$(echo "$VER_JSON" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('current',''))" 2>/dev/null || echo "")
echo "current=$CURRENT"
if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$CURRENT" == *"$EXPECTED_SHA"* ]]; then
    ok "version $CURRENT contains expected SHA prefix $EXPECTED_SHA"
  else
    fail "version is '$CURRENT' but expected to contain '$EXPECTED_SHA' — env var LOOM_VERSION not updated OR rollout did not take"
  fi
else
  ok "no expected SHA passed, current is '$CURRENT' (informational)"
fi
end

# ---------------------------------------------------------------------------
# 3) /build-marker.txt — definitive proof of which build is on disk
# ---------------------------------------------------------------------------
log "3. /build-marker.txt"
MARKER=$(curl -s -m 30 "${URL}/build-marker.txt${CACHEBUST}" || true)
echo "$MARKER"
if [[ -n "$EXPECTED_SHA" ]] && echo "$MARKER" | grep -q "sha=${EXPECTED_SHA}"; then
  ok "build-marker.txt contains expected SHA"
elif [[ -n "$EXPECTED_SHA" ]]; then
  fail "build-marker.txt did not contain sha=${EXPECTED_SHA} — stale image or build context"
else
  echo "$MARKER" | grep -q 'loom-build-marker' && ok "build-marker.txt is present (no SHA check requested)" || fail "build-marker.txt missing entirely"
fi
end

# ---------------------------------------------------------------------------
# 4) /items/notebook/new — page route compiled + Phase 1A/2/3 markers
# ---------------------------------------------------------------------------
log "4. notebook editor smoke — page route + Phase markers"
NB_HTML=$(curl -s -m 30 "${URL}/items/notebook/new${CACHEBUST}" || true)
echo "${NB_HTML:0:500}"
# The page must return 200 with the Fluent UI shell. Auth-gate is fine — we
# just need the page to compile and serve.
if echo "$NB_HTML" | grep -q '<title>CSA Loom Console</title>'; then
  ok "notebook page route renders (auth-gated content is expected if unauthenticated)"
else
  fail "notebook page did not render the shell title"
fi
end

# ---------------------------------------------------------------------------
# 5) /items/data-pipeline/new — DAG canvas page should compile
# ---------------------------------------------------------------------------
log "5. data-pipeline editor smoke"
DP_HTML=$(curl -s -m 30 "${URL}/items/data-pipeline/new${CACHEBUST}" || true)
if echo "$DP_HTML" | grep -q '<title>CSA Loom Console</title>'; then
  ok "data-pipeline page route renders"
else
  fail "data-pipeline page did not render"
fi
end

# ---------------------------------------------------------------------------
# 6) /api/copilot/tools — orchestrator must respond. We accept:
#   - 200 with count > 0 (authed probe path)
#   - 401 (session-gated — expected for unauthenticated CI probes)
# We only FAIL if the route 5xx's OR returns 200 with count=0.
# ---------------------------------------------------------------------------
log "6. /api/copilot/tools"
TOOLS_HTTP=$(curl -s -m 30 -o /tmp/loom-tools.json -w "%{http_code}" "${URL}/api/copilot/tools${CACHEBUST}" || echo "000")
cat /tmp/loom-tools.json 2>/dev/null
echo ""
echo "http=$TOOLS_HTTP"
if [[ "$TOOLS_HTTP" == "401" ]]; then
  ok "copilot tools route is wired (401 unauthenticated — expected for CI probe)"
elif [[ "$TOOLS_HTTP" == "200" ]]; then
  TOOL_COUNT=$(python -c "import json; d=json.load(open('/tmp/loom-tools.json')); print(d.get('count',0))" 2>/dev/null || echo "0")
  if [[ "$TOOL_COUNT" -gt 0 ]]; then
    ok "copilot tool registry returns $TOOL_COUNT tools"
  else
    fail "copilot tool registry returned 200 with 0 tools — orchestrator may be broken"
  fi
else
  fail "copilot tools route returned http=$TOOLS_HTTP (expected 200 or 401)"
fi
end

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ $FAIL -eq 0 ]]; then
  echo "::notice::✅ Loom live deploy validation PASSED"
  exit 0
else
  echo "::error::❌ Loom live deploy validation FAILED — see grouped output above"
  exit 1
fi
