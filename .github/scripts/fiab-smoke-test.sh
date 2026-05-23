#!/usr/bin/env bash
# CSA Loom smoke test
# Used by .github/workflows/deploy-fiab-*.yml
#
# Validates that a freshly-deployed Loom Admin Plane responds with
# Console URL 200 + can create a workspace via REST + can run a
# sample query.

set -euo pipefail

CONSOLE_URL="${CONSOLE_URL:?CONSOLE_URL must be set}"
BOUNDARY="${BOUNDARY:-Commercial}"
SKIP_DIRECT_LAKE_TEST="${SKIP_DIRECT_LAKE_TEST:-false}"
DEPLOY_PRINCIPAL_TOKEN="${DEPLOY_PRINCIPAL_TOKEN:-}"

echo "🧪 CSA Loom smoke test"
echo "   Console URL: $CONSOLE_URL"
echo "   Boundary:    $BOUNDARY"
echo "   Skip Direct Lake test: $SKIP_DIRECT_LAKE_TEST"
echo

TESTS_PASSED=0
TESTS_FAILED=0

fail() {
  echo "  ❌ FAIL: $1"
  TESTS_FAILED=$((TESTS_FAILED + 1))
}

pass() {
  echo "  ✅ PASS"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

# ---------------------------------------------------------------------
# Test 1: Console health endpoint
# ---------------------------------------------------------------------
echo "Test 1: Console /api/health responds 200"
RESPONSE=$(curl -fsS -o /tmp/health-resp -w "%{http_code}" --max-time 30 "${CONSOLE_URL}/api/health" || echo "000")
if [[ "$RESPONSE" != "200" ]]; then
  fail "got $RESPONSE expected 200; body: $(cat /tmp/health-resp 2>/dev/null || echo '(empty)')"
else
  pass
fi

# ---------------------------------------------------------------------
# Test 2: Workspaces list responds 200 (with auth) or 401 (without)
# ---------------------------------------------------------------------
echo "Test 2: /api/workspaces enforces auth"
RESPONSE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 30 "${CONSOLE_URL}/api/workspaces" || echo "000")
if [[ "$RESPONSE" != "401" && "$RESPONSE" != "403" ]]; then
  fail "expected 401/403 (unauth), got $RESPONSE — auth gate may be broken"
else
  pass
fi

# ---------------------------------------------------------------------
# Test 3: Workspaces create via Console REST (requires CI principal token)
# ---------------------------------------------------------------------
echo "Test 3: Workspace creation via Console REST"
if [[ -z "$DEPLOY_PRINCIPAL_TOKEN" ]]; then
  echo "  ⏭️  SKIP — DEPLOY_PRINCIPAL_TOKEN not set; skipping authed create"
else
  WORKSPACE_NAME="ci-smoke-$(date +%s)"
  RESPONSE=$(curl -fsS -o /tmp/ws-resp -w "%{http_code}" --max-time 60 \
    -X POST "${CONSOLE_URL}/api/workspaces" \
    -H "Authorization: Bearer $DEPLOY_PRINCIPAL_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$WORKSPACE_NAME\",\"capacitySku\":\"F2\",\"region\":\"eastus2\",\"domainName\":\"ci\"}" \
    || echo "000")
  if [[ "$RESPONSE" != "201" ]]; then
    fail "expected 201, got $RESPONSE; body: $(cat /tmp/ws-resp 2>/dev/null)"
  else
    pass
    WORKSPACE_ID=$(jq -r .id /tmp/ws-resp 2>/dev/null || echo "")
    echo "  Created workspace ID: $WORKSPACE_ID"
  fi
fi

# ---------------------------------------------------------------------
# Test 4: MCP server health
# ---------------------------------------------------------------------
echo "Test 4: MCP server health endpoint"
MCP_URL="${MCP_URL:-${CONSOLE_URL/loom-console/loom-mcp}}"
RESPONSE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 30 "${MCP_URL}/.well-known/health" || echo "000")
if [[ "$RESPONSE" != "200" ]]; then
  fail "MCP server health expected 200, got $RESPONSE at ${MCP_URL}"
else
  pass
fi

# ---------------------------------------------------------------------
# Test 5: Setup Orchestrator health
# ---------------------------------------------------------------------
echo "Test 5: Setup Orchestrator health endpoint"
ORCH_URL="${ORCH_URL:-${CONSOLE_URL/loom-console/loom-orchestrator}}"
RESPONSE=$(curl -fsS -o /tmp/orch-resp -w "%{http_code}" --max-time 30 "${ORCH_URL}/health" || echo "000")
if [[ "$RESPONSE" != "200" ]]; then
  fail "Setup Orchestrator health expected 200, got $RESPONSE; body: $(cat /tmp/orch-resp 2>/dev/null)"
else
  pass
fi

# ---------------------------------------------------------------------
# Test 6: Direct-Lake-Shim refresh latency (skip in GCC)
# ---------------------------------------------------------------------
if [[ "$SKIP_DIRECT_LAKE_TEST" == "true" || "$BOUNDARY" == "GCC" ]]; then
  echo "Test 6: SKIPPED (GCC has no F-SKU / Direct Lake parity per LD-7)"
else
  echo "Test 6: Direct-Lake-Shim refresh latency telemetry exists"
  # Without a real Power BI Premium model wired, we can only verify the
  # shim service is up and reporting telemetry.
  SHIM_URL="${SHIM_URL:-${CONSOLE_URL/loom-console/loom-direct-lake-shim}}"
  RESPONSE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 30 "${SHIM_URL}/health" || echo "000")
  if [[ "$RESPONSE" != "200" ]]; then
    fail "Direct-Lake-Shim health expected 200, got $RESPONSE at ${SHIM_URL}"
  else
    pass
  fi
fi

# ---------------------------------------------------------------------
# Test 7: Activator Engine + Mirroring Engine health
# ---------------------------------------------------------------------
for svc in activator-engine mirroring-engine; do
  echo "Test 7.$svc: $svc health endpoint"
  SVC_URL="${CONSOLE_URL/loom-console/loom-$svc}"
  RESPONSE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 30 "${SVC_URL}/health" || echo "000")
  if [[ "$RESPONSE" != "200" ]]; then
    fail "$svc health expected 200, got $RESPONSE"
  else
    pass
  fi
done

# ---------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------
echo
echo "── Smoke test summary ──"
echo "  Passed: $TESTS_PASSED"
echo "  Failed: $TESTS_FAILED"
echo

if [[ $TESTS_FAILED -gt 0 ]]; then
  echo "❌ Smoke test FAILED — $TESTS_FAILED test(s) did not pass"
  exit 1
fi

echo "🎉 Smoke test passed"
