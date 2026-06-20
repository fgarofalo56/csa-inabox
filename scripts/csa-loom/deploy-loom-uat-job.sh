#!/usr/bin/env bash
# Deploy/refresh the `loom-uat` Container App Job — an UNATTENDED, in-VNet,
# full-visual Playwright UAT runner for the live CSA Loom console.
#
# WHY a CA Job:
#   The Loom ACR and Key Vault have publicNetworkAccess=Disabled (private
#   endpoint only), so external GitHub runners cannot reach them.  A Container
#   App Job in the console's VNet-integrated environment CAN — it reuses the
#   console UAMI (already has AcrPull + KV / Storage access) and runs the
#   Playwright suite entirely inside the VNet.  No MFA, no user credentials.
#
# WHAT it does:
#   1. Toggles ACR public access (temp) so `az acr build` can upload the
#      source tarball from a public runner.  Mirrors the pattern in
#      .github/workflows/build-fiab-images-acr-tasks.yml (acr_enable /
#      acr_restore jobs).
#   2. Builds loom-uat:latest from apps/fiab-console/Dockerfile.uat via
#      `az acr build` (source is sent as a tar; build runs inside ACR Tasks,
#      inside Azure, so the private ACR endpoint is reachable for the push).
#   3. Restores ACR public access=Disabled after the build.
#   4. Creates or updates the `loom-uat` Container App Job using the console
#      UAMI for both registry pull and managed-identity Azure calls.
#   5. Sets the job's `session-secret` to the CONSOLE's literal SESSION_SECRET
#      (read via ARM — the console secret is NOT KV-backed; see issue #1534).
#      The value is read into a shell variable, piped to the CLI, and never
#      printed.
#
# IMPORTANT — SESSION_SECRET source:
#   The console stores SESSION_SECRET as a Container App LITERAL secret (NOT a
#   keyvaultref).  So the job secret is sourced from the console's ARM secret
#   value, NOT from Key Vault.  If/when the console secret is made KV-backed
#   and synced, switch the job secret to a keyvaultref.
#
# Run (from a shell with Contributor on the admin RG + ARM read on the
# console's secrets):
#
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   SUB=<admin-sub-id> \
#   CAE=cae-csa-loom-centralus \
#   CONSOLE_APP=loom-console \
#   CONSOLE_UAMI_ID=/subscriptions/<sub>/resourcegroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<name> \
#   ACR=acrloomk6mvh5sm6z7do.azurecr.io \
#   LOOM_URL=https://loom-console.b02.azurefd.net \
#   LOOM_AUTOMATION_OID=<tenant-admin oid> \
#   ./scripts/csa-loom/deploy-loom-uat-job.sh
#
# Trigger a run (full suite):
#   az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB
#
# Trigger a slice (e.g. catalog specs only):
#   az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB \
#     --image "" \  # use current image
#     --env-vars "UAT_GREP=catalog"
#
# Results:
#   - Container logs: Log Analytics workspace linked to the CAE.
#     ContainerAppConsoleLogs_CL, ContainerName_s == 'uat'.
#     Look for the "UAT_RESULT pass=<n> fail=<n> skip=<n>" line.
#   - Optional HTML report: set LOOM_UAT_RESULTS_CONTAINER to an
#     ADLS Gen2 / blob URL; the runner uploads playwright-report/ after the run.

set -euo pipefail

# ---------------------------------------------------------------------------
# Parameters (set via env or override below)
# ---------------------------------------------------------------------------
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-centralus}"
SUB="${SUB:?set SUB to the admin-plane subscription id}"
CONSOLE_APP="${CONSOLE_APP:-loom-console}"
CAE="${CAE:-cae-csa-loom-centralus}"
CONSOLE_UAMI_ID="${CONSOLE_UAMI_ID:?set CONSOLE_UAMI_ID to the console UAMI resource id}"

# ACR — derive from CONSOLE_IMAGE if provided, otherwise require explicit ACR.
# The ACR hostname looks like: acrloomk6mvh5sm6z7do.azurecr.io
ACR="${ACR:?set ACR to the ACR login server (e.g. acrloomk6mvh5sm6z7do.azurecr.io)}"

# Extract bare ACR name (everything before the first '.') for az acr commands.
ACR_NAME="${ACR%%.*}"

LOOM_URL="${LOOM_URL:?set LOOM_URL to the console base URL}"
LOOM_AUTOMATION_OID="${LOOM_AUTOMATION_OID:?set LOOM_AUTOMATION_OID to the automation identity OID}"
LOOM_AUTOMATION_UPN="${LOOM_AUTOMATION_UPN:-loom-uat@automation.local}"
LOOM_AUTOMATION_NAME="${LOOM_AUTOMATION_NAME:-LoomUAT[automation]}"

# UAT config — can be overridden per-run via job env-vars at trigger time.
UAT_PROJECT="${UAT_PROJECT:-uat}"
UAT_GREP="${UAT_GREP:-}"  # empty = full suite

# Optional: blob container + storage account for report/screenshot upload
# (the runner uploads test-results/uat/report.json + artifacts via the UAMI,
# in-VNet, so PE-protected DLZ storage is reachable). See #1555.
LOOM_UAT_RESULTS_CONTAINER="${LOOM_UAT_RESULTS_CONTAINER:-}"
LOOM_UAT_RESULTS_ACCOUNT="${LOOM_UAT_RESULTS_ACCOUNT:-}"

# Image to push.
UAT_IMAGE="${ACR}/loom-uat:latest"

# Where this script lives (repo root is two levels up).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/fiab-console"

echo "[deploy-loom-uat-job] repo root : $REPO_ROOT"
echo "[deploy-loom-uat-job] app dir   : $APP_DIR"
echo "[deploy-loom-uat-job] acr       : $ACR"
echo "[deploy-loom-uat-job] image     : $UAT_IMAGE"
echo "[deploy-loom-uat-job] loom url  : $LOOM_URL"

# ---------------------------------------------------------------------------
# Step 1 — Enable ACR public access (temp) so az acr build can reach it
# ---------------------------------------------------------------------------
echo ""
echo "[deploy-loom-uat-job] 1/5 Enabling ACR public access (temporary)..."
az acr update --name "$ACR_NAME" --public-network-enabled true \
  -o tsv --query "publicNetworkAccess" --subscription "$SUB" || true
az acr update --name "$ACR_NAME" --default-action Allow \
  -o tsv --query "networkRuleSet.defaultAction" --subscription "$SUB" || true

# Wait for the change to propagate (mirrors the 30s sleep in the GHA workflow).
echo "[deploy-loom-uat-job] Waiting 35s for ACR network rule propagation..."
sleep 35

# ---------------------------------------------------------------------------
# Step 2 — Build + push loom-uat:latest via ACR Tasks
# ---------------------------------------------------------------------------
echo ""
echo "[deploy-loom-uat-job] 2/5 Building loom-uat:latest via ACR Tasks..."
# The default .dockerignore excludes e2e/ + tests/ (to keep the console image
# lean), and ACR Tasks does NOT honor a per-Dockerfile <Dockerfile>.dockerignore.
# So temporarily drop the e2e/tests exclusion for THIS build only (the runner
# needs the specs), then restore it in Step 3.
cp "$APP_DIR/.dockerignore" "$APP_DIR/.dockerignore.bak"
grep -vxE 'e2e|tests' "$APP_DIR/.dockerignore.bak" > "$APP_DIR/.dockerignore"
# Run from inside the app dir with a relative context (".") + relative
# --file so the Windows `az` CLI gets a path it understands (an MSYS
# absolute path like /e/... is rejected by Windows az acr build).
# --no-logs: the Windows az CLI crashes rendering ACR build logs that contain
# thin-space/Unicode chars (pnpm output) — 'charmap' codec can't encode  .
# Skip streaming; az still waits for the run + returns its success/fail status.
( cd "$APP_DIR" && az acr build \
  --registry "$ACR_NAME" \
  --image "loom-uat:latest" \
  --file "Dockerfile.uat" \
  --subscription "$SUB" \
  --no-logs \
  . )
echo "[deploy-loom-uat-job] Image built: $UAT_IMAGE"

# ---------------------------------------------------------------------------
# Step 3 — Restore ACR public access=Disabled (always, even on build failure)
# ---------------------------------------------------------------------------
echo ""
echo "[deploy-loom-uat-job] 3/5 Restoring ACR public access=Disabled + .dockerignore..."
[ -f "$APP_DIR/.dockerignore.bak" ] && mv "$APP_DIR/.dockerignore.bak" "$APP_DIR/.dockerignore"
az acr update --name "$ACR_NAME" --default-action Deny \
  -o tsv --query "networkRuleSet.defaultAction" --subscription "$SUB" || true
az acr update --name "$ACR_NAME" --public-network-enabled false \
  -o tsv --query "publicNetworkAccess" --subscription "$SUB" || true

# ---------------------------------------------------------------------------
# Step 4 — Resolve CAE resource ID
# ---------------------------------------------------------------------------
echo ""
echo "[deploy-loom-uat-job] 4/5 Resolving CAE + deploying loom-uat job..."
CAEID="$(az containerapp env show -n "$CAE" -g "$ADMIN_RG" \
          --subscription "$SUB" --query id -o tsv | tr -d '\r')"

# Build optional env entries for UAT config.
UAT_GREP_ENV=""
if [[ -n "$UAT_GREP" ]]; then
  UAT_GREP_ENV="- { name: UAT_GREP, value: \"${UAT_GREP}\" }"
fi

RESULTS_CONTAINER_ENV=""
if [[ -n "$LOOM_UAT_RESULTS_CONTAINER" ]]; then
  RESULTS_CONTAINER_ENV="- { name: LOOM_UAT_RESULTS_CONTAINER, value: \"${LOOM_UAT_RESULTS_CONTAINER}\" }"
fi

RESULTS_ACCOUNT_ENV=""
if [[ -n "$LOOM_UAT_RESULTS_ACCOUNT" ]]; then
  RESULTS_ACCOUNT_ENV="- { name: LOOM_UAT_RESULTS_ACCOUNT, value: \"${LOOM_UAT_RESULTS_ACCOUNT}\" }"
fi

# UAMI client id — lets the runner's ACA managed-identity token fetch (for the
# blob results upload) target the right user-assigned identity. See #1555.
UAMI_CLIENT_ID_ENV=""
if [[ -n "${LOOM_UAMI_CLIENT_ID:-}" ]]; then
  UAMI_CLIENT_ID_ENV="- { name: LOOM_UAMI_CLIENT_ID, value: \"${LOOM_UAMI_CLIENT_ID}\" }"
fi

# Write the YAML to a repo-relative temp path, NOT mktemp(1): on Windows/MSYS
# `mktemp` yields a /tmp/tmp.XXXX path that the Windows `az` CLI cannot read
# ("does not exist"), which silently breaks the job create/update step.
mkdir -p "$REPO_ROOT/temp"
TMP="$REPO_ROOT/temp/loom-uat-job-$$.yaml"
# The Windows `az` CLI needs a Windows path (E:\...), not an MSYS path (/e/...).
# Convert with cygpath when available; fall back to the raw path off-Windows.
TMP_AZ="$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")"
cat > "$TMP" <<YAML
location: centralus
identity:
  type: UserAssigned
  userAssignedIdentities:
    ${CONSOLE_UAMI_ID}: {}
properties:
  environmentId: ${CAEID}
  configuration:
    triggerType: Manual
    replicaTimeout: 3600
    replicaRetryLimit: 0
    manualTriggerConfig:
      parallelism: 1
      replicaCompletionCount: 1
    registries:
      - server: ${ACR}
        identity: ${CONSOLE_UAMI_ID}
    secrets:
      # Defined with a placeholder so the SESSION_SECRET secretRef resolves at
      # create time; overwritten with the console's real literal in Step 5.
      - name: session-secret
        value: "placeholder-overwritten-step5"
  template:
    containers:
      - name: uat
        image: ${UAT_IMAGE}
        resources: { cpu: 2.0, memory: 4.0Gi }
        env:
          - { name: LOOM_URL,                value: "${LOOM_URL}" }
          - { name: LOOM_AUTOMATION_OID,     value: "${LOOM_AUTOMATION_OID}" }
          - { name: LOOM_AUTOMATION_UPN,     value: "${LOOM_AUTOMATION_UPN}" }
          - { name: LOOM_AUTOMATION_NAME,    value: "${LOOM_AUTOMATION_NAME}" }
          - { name: UAT_PROJECT,             value: "${UAT_PROJECT}" }
          ${UAT_GREP_ENV}
          ${RESULTS_CONTAINER_ENV}
          ${RESULTS_ACCOUNT_ENV}
          ${UAMI_CLIENT_ID_ENV}
          - { name: SESSION_SECRET,          secretRef: session-secret }
YAML

az containerapp job create -n loom-uat -g "$ADMIN_RG" --subscription "$SUB" \
  --yaml "$TMP_AZ" -o none 2>/dev/null \
  || az containerapp job update -n loom-uat -g "$ADMIN_RG" --subscription "$SUB" \
       --yaml "$TMP_AZ" -o none
rm -f "$TMP"

# ---------------------------------------------------------------------------
# Step 5 — Set the job's session-secret from the console's ARM literal
# ---------------------------------------------------------------------------
# Read the console's literal SESSION_SECRET via ARM, pipe directly to the
# CLI secret-set command.  The value is stored in a shell variable only
# long enough to pass it to az; we unset immediately.  It is NEVER echoed,
# logged, or printed.
echo ""
echo "[deploy-loom-uat-job] 5/5 Wiring session-secret from console ARM literal..."
SS="$(az containerapp secret show \
  -n "$CONSOLE_APP" \
  -g "$ADMIN_RG" \
  --subscription "$SUB" \
  --secret-name session-secret \
  --query value -o tsv | tr -d '\r\n')"

az containerapp job secret set \
  -n loom-uat \
  -g "$ADMIN_RG" \
  --subscription "$SUB" \
  --secrets "session-secret=$SS" \
  -o none

unset SS

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "[deploy-loom-uat-job] loom-uat job deployed successfully."
echo ""
echo "  Trigger full suite:"
echo "    az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB"
echo ""
echo "  Trigger a slice (e.g. catalog):"
echo "    az containerapp job start -n loom-uat -g $ADMIN_RG --subscription $SUB"
echo "    # then re-deploy with UAT_GREP=catalog, or pass via the job's env-var override"
echo ""
echo "  View results (Log Analytics):"
echo "    ContainerAppConsoleLogs_CL"
echo "    | where ContainerName_s == 'uat'"
echo "    | where Log_s contains 'UAT_RESULT'"
echo "    | order by TimeGenerated desc"
