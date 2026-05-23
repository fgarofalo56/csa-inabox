#!/usr/bin/env bash
# CSA Loom — post-provision validation from inside the Container Apps Env.
#
# After azd provision succeeds, this script:
#   1. Discovers the Loom Container Apps in the Admin Plane RG
#   2. For each, runs `az containerapp exec` to curl its /health endpoint
#      from inside the Container App's own runtime — bypasses the
#      VNet-internal ingress restriction that blocks external smoke tests
#   3. Queries App Insights live metrics to confirm telemetry is flowing
#   4. Queries LAW to confirm diagnostic settings are emitting
#
# Doesn't fail the workflow — informational. Real "is it working?"
# validation requires a human via Bastion (Console UI is the only way
# to truly validate the React panes).

set -uo pipefail

RG="${RG_NAME:?RG_NAME must be set}"
BOUNDARY="${BOUNDARY:-Commercial}"

echo "🔬 CSA Loom — post-provision validation"
echo "   Admin Plane RG: $RG"
echo "   Boundary:       $BOUNDARY"
echo

# ---------------------------------------------------------------------
# 1. Inventory deployed Container Apps
# ---------------------------------------------------------------------
echo "── Container Apps inventory ──"
APPS=$(az containerapp list --resource-group "$RG" --query "[?starts_with(name, 'loom-')].name" -o tsv)
if [[ -z "$APPS" ]]; then
  echo "  ⚠️  No Container Apps with prefix 'loom-' found"
else
  for app in $APPS; do
    REVISION=$(az containerapp show --resource-group "$RG" --name "$app" --query "properties.latestRevisionName" -o tsv 2>/dev/null)
    PROVSTATE=$(az containerapp show --resource-group "$RG" --name "$app" --query "properties.provisioningState" -o tsv 2>/dev/null)
    REPLICAS=$(az containerapp revision show --resource-group "$RG" --revision "$REVISION" --query "properties.replicas" -o tsv 2>/dev/null || echo "?")
    echo "  ✓ $app: $PROVSTATE (revision: $REVISION, replicas: $REPLICAS)"
  done
fi
echo

# ---------------------------------------------------------------------
# 2. Per-app from-inside-cluster health check
# ---------------------------------------------------------------------
echo "── Per-app /health from inside cluster ──"
for app in $APPS; do
  # health path varies per app — bind by convention
  case "$app" in
    loom-console)            HPATH="/api/health"; PORT=3000 ;;
    loom-mcp)                HPATH="/.well-known/health"; PORT=8080 ;;
    loom-orchestrator)       HPATH="/health"; PORT=8000 ;;
    loom-copilot)            HPATH="/api/health"; PORT=8000 ;;
    loom-activator)          HPATH="/health"; PORT=8080 ;;
    loom-mirroring)          HPATH="/health"; PORT=8080 ;;
    loom-direct-lake-shim)   HPATH="/health"; PORT=8080 ;;
    *)                       HPATH="/health"; PORT=8080 ;;
  esac

  # az containerapp exec runs a command inside any running replica.
  RESULT=$(az containerapp exec \
    --resource-group "$RG" \
    --name "$app" \
    --command "curl -fsS -o /dev/null -w '%{http_code}' http://localhost:${PORT}${HPATH}" 2>&1 | tail -1)

  if [[ "$RESULT" == "200" ]]; then
    echo "  ✓ $app$HPATH → 200"
  else
    echo "  ⚠ $app$HPATH → $RESULT (app may still be starting; check probes)"
  fi
done
echo

# ---------------------------------------------------------------------
# 3. App Insights live metrics — confirm telemetry flowing
# ---------------------------------------------------------------------
echo "── App Insights — request count last 5 min ──"
AI_NAME=$(az monitor app-insights component show --resource-group "$RG" --app "ai-csa-loom-${AZURE_LOCATION:-eastus2}" --query "name" -o tsv 2>/dev/null || true)
if [[ -n "$AI_NAME" ]]; then
  AI_ID=$(az monitor app-insights component show --resource-group "$RG" --app "$AI_NAME" --query "appId" -o tsv)
  RESULT=$(az monitor app-insights query \
    --app "$AI_ID" \
    --analytics-query "requests | where timestamp > ago(5m) | summarize requestCount = count() by cloud_RoleName | order by cloud_RoleName asc" \
    -o tsv 2>/dev/null | head -20)
  if [[ -n "$RESULT" ]]; then
    echo "$RESULT" | sed 's/^/    /'
  else
    echo "  ⚠ no telemetry yet — apps may still be warming up"
  fi
else
  echo "  ⚠ App Insights component not found"
fi
echo

# ---------------------------------------------------------------------
# 4. LAW — confirm diagnostic settings are populating
# ---------------------------------------------------------------------
echo "── LAW — diagnostic data ingestion last 15 min ──"
LAW=$(az monitor log-analytics workspace list --resource-group "$RG" --query "[?starts_with(name, 'law-csa-loom-')]|[0].customerId" -o tsv 2>/dev/null || true)
if [[ -n "$LAW" ]]; then
  az monitor log-analytics query \
    --workspace "$LAW" \
    --analytics-query "union withsource=table * | where TimeGenerated > ago(15m) | summarize records = count() by table | order by records desc | take 20" \
    -o tsv 2>/dev/null | head -25 | sed 's/^/    /'
else
  echo "  ⚠ LAW not found"
fi
echo

# ---------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------
echo "── Summary ──"
echo "  - Container Apps inventory: see above"
echo "  - From-inside-cluster health probes: see above"
echo "  - App Insights + LAW: see above"
echo
echo "🌐 Console URL (VNet-internal — requires Bastion or VPN to reach):"
CONSOLE_FQDN=$(az containerapp show --resource-group "$RG" --name loom-console --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || echo "(not deployed)")
echo "   https://${CONSOLE_FQDN}"
echo
echo "ℹ️  For interactive UI validation: Bastion into a jumpbox in the hub VNet,"
echo "   browse to the Console URL above. The Console pane catalog is documented at"
echo "   docs/fiab/console/index.md (panes: Workspaces, Lakehouse, Warehouse,"
echo "   Notebook, Semantic Model, Activator, Data Agent, Setup Wizard)."
