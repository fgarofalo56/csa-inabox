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
    if curl -sSf -o /dev/null -w "portal backend: %{http_code}\n" \
            --max-time 5 "${PORTAL_API_URL}/health" 2>/dev/null; then
        echo "  portal backend reachable at ${PORTAL_API_URL}"
    else
        echo "  info: portal backend not reachable at ${PORTAL_API_URL} (did you run 'make portal-dev'?)"
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
