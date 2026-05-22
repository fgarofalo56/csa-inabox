#!/usr/bin/env bash
# CSA Loom smoke test
# Used by .github/workflows/deploy-fiab-*.yml
#
# Validates that a freshly-deployed Loom Admin Plane responds with
# Console URL 200 + can create a workspace via REST + can run a
# sample query.
#
# Status: SCAFFOLDED — full test logic per PRP-11

set -euo pipefail

CONSOLE_URL="${CONSOLE_URL:?CONSOLE_URL must be set}"
BOUNDARY="${BOUNDARY:-Commercial}"
SKIP_DIRECT_LAKE_TEST="${SKIP_DIRECT_LAKE_TEST:-false}"

echo "🧪 CSA Loom smoke test"
echo "   Console URL: $CONSOLE_URL"
echo "   Boundary:    $BOUNDARY"
echo "   Skip Direct Lake test: $SKIP_DIRECT_LAKE_TEST"
echo

# Test 1: Console health endpoint
echo "Test 1: Console /api/health responds 200"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${CONSOLE_URL}/api/health" || true)
if [[ "$RESPONSE" != "200" ]]; then
  echo "  ❌ FAIL: got $RESPONSE expected 200"
  exit 1
fi
echo "  ✅ PASS"

# Test 2: Create a workspace via Console REST
echo "Test 2: Workspace creation via Console REST"
WORKSPACE_NAME="ci-test-$(date +%s)"
# (Full impl: POST /api/workspaces with auth; verify deploy completes)
echo "  ⏭️  SCAFFOLDED — full test logic per PRP-11"

# Test 3: Sample query against the new workspace
echo "Test 3: Sample SQL query in created workspace"
echo "  ⏭️  SCAFFOLDED"

# Test 4: Direct-Lake-Shim refresh latency (skip in GCC)
if [[ "$SKIP_DIRECT_LAKE_TEST" != "true" ]]; then
  echo "Test 4: Direct-Lake-Shim refresh latency < 60s"
  echo "  ⏭️  SCAFFOLDED"
else
  echo "Test 4: SKIPPED (GCC has no F-SKU / Direct Lake parity)"
fi

echo
echo "🎉 Smoke test passed (scaffolded checks)"
