#!/usr/bin/env bash
# CSA-0052 — sample-up stage 5: verify
#
# Smoke-checks that the stack is reachable:
#   1. Portal backend /api/v1/health is 200 (if running)
#   2. Prints the portal URLs the operator should open
#
# Usage:
#   bash scripts/sample-up/05-verify.sh <vertical>

set -euo pipefail

VERTICAL="${1:-${NAME:-}}"
if [ -z "${VERTICAL}" ]; then
    echo "ERROR: vertical name required. Usage: $0 <vertical>" >&2
    exit 2
fi

PORTAL_API_URL="${PORTAL_API_URL:-http://localhost:8000/api/v1}"
PORTAL_WEB_URL="${PORTAL_WEB_URL:-http://localhost:3000}"

echo "[sample-up 5/5 verify] vertical=${VERTICAL}"

if command -v curl >/dev/null 2>&1; then
    # NO `-f` (#3414). This probe READS the status, so `-f` would have collapsed
    # "backend is up and answering HTTP 500" into the same single outcome as
    # "nothing is listening" — the two states an operator most needs told apart
    # when a local stack half-starts. Branch on the captured code instead.
    # `|| true` fixes only the exit status (the script runs under `set -e`); an
    # EMPTY capture is the one case that needs a default.
    HEALTH_CODE="$(curl -sS -o /dev/null -w '%{http_code}' \
        --max-time 5 "${PORTAL_API_URL}/health" 2>/dev/null)" || true
    [ -n "$HEALTH_CODE" ] || HEALTH_CODE="000"
    if [ "$HEALTH_CODE" = "200" ]; then
        echo "  portal backend reachable at ${PORTAL_API_URL} (HTTP 200)"
    elif [ "$HEALTH_CODE" = "000" ]; then
        echo "  info: nothing answered at ${PORTAL_API_URL} (did you run 'make portal-dev'?)"
    else
        echo "  info: portal backend ANSWERED at ${PORTAL_API_URL} with HTTP ${HEALTH_CODE} — it is running, but /health is not 200"
    fi
fi

cat <<EOF

================================================================
 Sample vertical '${VERTICAL}' is up.
 Portal UI       : ${PORTAL_WEB_URL}
 Marketplace API : ${PORTAL_API_URL}/marketplace/products
 Tear down       : make teardown-example VERTICAL=${VERTICAL}
================================================================
EOF

echo "[sample-up 5/5 verify] OK"
