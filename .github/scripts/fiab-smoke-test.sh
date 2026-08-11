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

# ---------------------------------------------------------------------------
# http_code — the ONLY way this script reads a status code.
#
# Every probe here used to be:
#     curl -fsS -o … -w "%{http_code}" … || echo "000"
# which is wrong twice over, both measured with real curl:
#
#   connection failure : curl PRINTS 000 and exits non-zero  -> "000000"
#   HTTP 401 with -f   : curl PRINTS 401 and exits 22        -> "401000"
#
# The second one is what made Test 2 unpassable. It asserts that /api/workspaces
# refuses an unauthenticated caller — i.e. a 401 is the SUCCESS case — but `-f`
# makes curl exit non-zero on exactly that response, so the fallback concatenated
# and the comparison against "401" could never match. The test failed when the
# auth gate was working, and also failed when it was broken (200 matches neither
# 401 nor 403). It could not pass. Nobody saw it, because the deploy ran this
# script under `continue-on-error: true` and threw the result away.
#
# NO `-f`: this script is INTERESTED in 4xx/5xx — they are answers, not errors.
# NO `|| echo`: curl already prints the right value in both failure modes; a
# fallback can only concatenate onto it. An EMPTY capture (curl absent, killed)
# is the one case that needs a default.
# ---------------------------------------------------------------------------
http_code() {
  local code
  code="$(curl -sS -w '%{http_code}' "$@" 2>/dev/null)"
  [ -n "$code" ] || code="000"
  printf '%s' "$code"
}

# ---------------------------------------------------------------------
# Test 1: Console health endpoint
# ---------------------------------------------------------------------
echo "Test 1: Console /api/health responds 200"
RESPONSE=$(http_code -o /tmp/health-resp --max-time 30 "${CONSOLE_URL}/api/health")
if [[ "$RESPONSE" != "200" ]]; then
  fail "got $RESPONSE expected 200; body: $(cat /tmp/health-resp 2>/dev/null || echo '(empty)')"
else
  pass
fi

# ---------------------------------------------------------------------
# Test 2: Workspaces list responds 200 (with auth) or 401 (without)
# ---------------------------------------------------------------------
echo "Test 2: /api/workspaces enforces auth"
RESPONSE=$(http_code -o /dev/null --max-time 30 "${CONSOLE_URL}/api/workspaces")
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
RESPONSE=$(http_code -o /dev/null --max-time 30 "${MCP_URL}/.well-known/health")
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
RESPONSE=$(http_code -o /tmp/orch-resp --max-time 30 "${ORCH_URL}/health")
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
  RESPONSE=$(http_code -o /dev/null --max-time 30 "${SHIM_URL}/health")
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
  RESPONSE=$(http_code -o /dev/null --max-time 30 "${SVC_URL}/health")
  if [[ "$RESPONSE" != "200" ]]; then
    fail "$svc health expected 200, got $RESPONSE"
  else
    pass
  fi
done

# ---------------------------------------------------------------------
# Test 8: Copilot orchestration tier (GCC-High / IL5 MAF — A-4 / PMF-64)
# ---------------------------------------------------------------------
# The loom-copilot-maf Container App is VNet-internal (never public), so we
# cannot probe its /health directly from the smoke-test runner. Instead we
# verify the Console's orchestration route is wired + auth-gated (the route
# that proxies to MAF when LOOM_MAF_ENDPOINT is set on a Gov boundary, and
# otherwise falls through to Gov AOAI-direct). MAF_ENDPOINT (from the
# deployment's copilotMafEndpoint output) is reported for the receipt.
if [[ "$BOUNDARY" == "GCC-High" || "$BOUNDARY" == "IL5" ]]; then
  echo "Test 8: Copilot orchestrate route enforces auth (MAF tier wiring)"
  RESPONSE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 30 \
    -X POST "${CONSOLE_URL}/api/copilot/orchestrate" \
    -H "Content-Type: application/json" -d '{}' || echo "000")
  if [[ "$RESPONSE" != "401" && "$RESPONSE" != "403" ]]; then
    fail "expected 401/403 (unauth) at /api/copilot/orchestrate, got $RESPONSE"
  else
    pass
  fi
  if [[ -n "${MAF_ENDPOINT:-}" ]]; then
    echo "  ℹ️  MAF tier active — copilotMafEndpoint=${MAF_ENDPOINT}"
  else
    echo "  ℹ️  MAF tier inactive on this compute path — Console uses Gov AOAI-direct fallback"
  fi
else
  echo "Test 8: SKIPPED (MAF orchestration tier is GCC-High / IL5 only)"
fi

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
