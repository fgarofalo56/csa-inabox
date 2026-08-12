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

# WAIT FOR THE ROLLOUT TO BE SERVED, DON'T JUST ASK ONCE (#3305).
#
# The roll waits for the new revision to report Healthy+Running and then probes
# immediately. Revision health is NOT the same event as ingress serving that
# revision: ACA finishes activating and shifting traffic some seconds later.
# A single curl in that window reads the OLD build and the roll concludes
# "rollout did not take" — then rolls back a revision that was fine.
#
# Measured on run 31616497298: revision loom-console--0000670 was created
# 16:21:40Z and was HEALTHY; the probe fired 16:23:34Z, saw the previous SHA,
# and the roll reverted to 0000671. The same roll succeeded at 14:17 and 15:06
# and failed at 13:08, 13:27 and 16:13 — the signature of a race, not a bad build.
#
# THIS DOES NOT MAKE THE ASSERTION UNABLE TO FAIL. It is a bounded wait: after
# the budget the check fails exactly as before, and says how long it waited so a
# genuinely stuck rollout is not mistaken for a slow one.
ROLLOUT_WAIT_SECONDS="${LOOM_ROLLOUT_WAIT_SECONDS:-180}"
ROLLOUT_POLL_SECONDS="${LOOM_ROLLOUT_POLL_SECONDS:-10}"
VER_JSON=""
BUILD_SHA=""
_waited=0
while :; do
  VER_JSON=$(curl -s -m 30 "${URL}/api/version${CACHEBUST}" || true)
  BUILD_SHA=$(echo "$VER_JSON" | python -c "import json,sys; print((json.load(sys.stdin).get('build') or {}).get('sha',''))" 2>/dev/null || echo "")
  # No expected SHA means nothing to wait for.
  [[ -z "$EXPECTED_SHA" ]] && break
  [[ "$BUILD_SHA" == *"$EXPECTED_SHA"* ]] && break
  (( _waited >= ROLLOUT_WAIT_SECONDS )) && break
  echo "   …serving '${BUILD_SHA:-<none>}', waiting for '${EXPECTED_SHA}' (${_waited}s/${ROLLOUT_WAIT_SECONDS}s)"
  sleep "$ROLLOUT_POLL_SECONDS"
  _waited=$(( _waited + ROLLOUT_POLL_SECONDS ))
done
echo "$VER_JSON"
CURRENT=$(echo "$VER_JSON" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('current',''))" 2>/dev/null || echo "")
# The rolled SHA lives in build.sha (the semver `current` is the last cut
# release tag, e.g. 0.72.1, and does NOT carry the commit SHA). Validate the
# SHA against build.sha; keep `current` only for the human-readable message.
echo "current=$CURRENT build.sha=$BUILD_SHA"
if [[ -n "$EXPECTED_SHA" ]]; then
  if [[ "$BUILD_SHA" == *"$EXPECTED_SHA"* ]]; then
    ok "version $CURRENT (build.sha $BUILD_SHA) contains expected SHA prefix $EXPECTED_SHA"
  else
    fail "build.sha is '$BUILD_SHA' but expected to contain '$EXPECTED_SHA' after waiting ${ROLLOUT_WAIT_SECONDS}s for the rollout to be SERVED — the new revision is not receiving traffic (not merely slow to activate)"
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
if [[ "$NB_HTML" == *"_next/static"* ]]; then
  ok "notebook page route renders the Next.js app shell (auth-gated content is expected if unauthenticated)"
else
  fail "notebook page did not render"
fi
end

# ---------------------------------------------------------------------------
# 5) /items/data-pipeline/new — DAG canvas page should compile
# ---------------------------------------------------------------------------
log "5. data-pipeline editor smoke"
DP_HTML=$(curl -s -m 30 "${URL}/items/data-pipeline/new${CACHEBUST}" || true)
if [[ "$DP_HTML" == *"_next/static"* ]]; then
  ok "data-pipeline page route renders the Next.js app shell"
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
# NO `|| echo "000"`: curl prints 000 itself on a connection failure AND exits
# non-zero, so the fallback concatenates to "000000" — which compares unequal to
# "000" and defeats every branch that tests for it.
TOOLS_HTTP=$(curl -s -m 30 -o /tmp/loom-tools.json -w "%{http_code}" "${URL}/api/copilot/tools${CACHEBUST}")
[ -n "$TOOLS_HTTP" ] || TOOLS_HTTP="000"
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
