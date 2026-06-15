#!/usr/bin/env bash
# CSA Loom — console-runtime (probes, resources, telemetry) post-deploy verifier.
#
# Deploy-readiness guard for the "Console runtime" domain. Asserts the loom-console
# Container App came up healthy with the #1382 fix in place:
#   1. latest revision is Running + Healthy (no crash-loop behind Envoy)
#   2. console container is right-sized (>= 1 cpu / 2Gi) — not the 0.5/1Gi default
#      that OOMs Next.js SSR + OTel
#   3. probes carry a relaxed timeout (timeoutSeconds >= 5, not the ACA default 1)
#   4. telemetry wiring is internally consistent — if LOOM_CONSOLE_TELEMETRY_ENABLED
#      is 'true' the connection string is present; if disabled, it is withheld
#      (drift guard: a wired conn string while telemetry is OFF, or vice-versa, fails)
#
# USAGE
#   ADMIN_RG=<rg> CONSOLE_APP=loom-console bash scripts/csa-loom/verify-console-runtime.sh
# Exits non-zero on any failed assertion so the post-deploy bootstrap fails loudly.
set -uo pipefail

ADMIN_RG="${ADMIN_RG:-${LOOM_ADMIN_RG:-}}"
CONSOLE_APP="${CONSOLE_APP:-loom-console}"
FAIL=0
ok()   { echo "  PASS: $*"; }
bad()  { echo "  FAIL: $*"; FAIL=1; }
note() { echo "  note: $*"; }

if [[ -z "$ADMIN_RG" ]]; then
  echo "verify-console-runtime: ADMIN_RG/LOOM_ADMIN_RG not set; skipping (no target)." >&2
  exit 0
fi

echo "== console-runtime verify: $CONSOLE_APP in $ADMIN_RG =="

APP_JSON=$(az containerapp show -n "$CONSOLE_APP" -g "$ADMIN_RG" -o json 2>/dev/null || true)
if [[ -z "$APP_JSON" ]]; then
  # AKS boundaries (GCC-High / IL5) run the console as a k8s workload, not ACA.
  note "Container App '$CONSOLE_APP' not found in $ADMIN_RG (AKS boundary or apps not deployed yet); skipping ACA checks."
  exit 0
fi

# 1. revision health
RUNNING=$(echo "$APP_JSON" | jq -r '.properties.runningStatus // empty')
LATEST=$(echo "$APP_JSON" | jq -r '.properties.latestRevisionName // empty')
HEALTH=$(az containerapp revision show -n "$CONSOLE_APP" -g "$ADMIN_RG" --revision "$LATEST" \
          --query "properties.healthState" -o tsv 2>/dev/null || echo "Unknown")
[[ "$RUNNING" == "Running" ]] && ok "runningStatus=Running" || bad "runningStatus=$RUNNING (expected Running — crash-loop?)"
[[ "$HEALTH" == "Healthy" || "$HEALTH" == "None" ]] && ok "revision health=$HEALTH" || bad "revision health=$HEALTH (expected Healthy)"

# 2. right-sizing
CPU=$(echo "$APP_JSON" | jq -r '.properties.template.containers[0].resources.cpu // 0')
MEM=$(echo "$APP_JSON" | jq -r '.properties.template.containers[0].resources.memory // "0Gi"')
awk -v c="$CPU" 'BEGIN{exit !(c+0 >= 1.0)}' && ok "cpu=$CPU (>=1.0)" || bad "cpu=$CPU (expected >=1.0 — OOM risk)"
case "$MEM" in 2*|3*|4*) ok "memory=$MEM (>=2Gi)" ;; *) bad "memory=$MEM (expected >=2Gi — OOM risk)" ;; esac

# 3. relaxed probe timeout
MINTO=$(echo "$APP_JSON" | jq -r '[.properties.template.containers[0].probes[]?.timeoutSeconds // 1] | min')
awk -v t="$MINTO" 'BEGIN{exit !(t+0 >= 5)}' && ok "probe timeoutSeconds=$MINTO (>=5)" || bad "probe timeoutSeconds=$MINTO (expected >=5 — ACA default 1 crash-loops)"
HASSTART=$(echo "$APP_JSON" | jq -r '[.properties.template.containers[0].probes[]?.type] | map(ascii_downcase) | index("startup") // empty')
[[ -n "$HASSTART" ]] && ok "Startup probe present" || note "no Startup probe (ACA may auto-inject only when zero probes are defined)"

# 4. telemetry wiring consistency (drift guard)
ENVJSON=$(echo "$APP_JSON" | jq -r '.properties.template.containers[0].env // []')
TELE=$(echo "$ENVJSON" | jq -r '.[] | select(.name=="LOOM_CONSOLE_TELEMETRY_ENABLED") | .value // ""')
CONN=$(echo "$ENVJSON" | jq -r '.[] | select(.name=="APPLICATIONINSIGHTS_CONNECTION_STRING") | (.value // .secretRef // "")')
if [[ "$TELE" == "true" ]]; then
  [[ -n "$CONN" ]] && ok "telemetry on + connection string wired" || bad "telemetry on but APPLICATIONINSIGHTS_CONNECTION_STRING missing"
else
  [[ -z "$CONN" ]] && ok "telemetry off + connection string withheld (consistent)" || bad "drift: telemetry off but APPLICATIONINSIGHTS_CONNECTION_STRING is wired"
fi

if [[ "$FAIL" != "0" ]]; then
  echo "== console-runtime verify FAILED =="
  exit 1
fi
echo "== console-runtime verify PASSED =="
