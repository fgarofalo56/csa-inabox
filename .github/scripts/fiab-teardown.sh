#!/usr/bin/env bash
# CSA Loom teardown — removes a CI-test deployment
#
# Strategy:
#   1. Identify all RGs starting with "rg-csa-loom-" in the current
#      subscription (or per-DLZ subs if multi-sub mode).
#   2. For each RG, purge soft-deletable resources (Key Vault, Cosmos
#      restorable accounts) before deletion — otherwise the names
#      remain reserved for 90 days and the next CI run collides.
#   3. Delete RGs with --no-wait + capture the request IDs.
#   4. Poll until all RGs are gone (or 30 min timeout).

set -euo pipefail

RG_NAME="${RG_NAME:?RG_NAME must be set}"
DLZ_SUBS="${DLZ_SUBS:-}"  # comma-separated list of DLZ sub IDs
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-30}"

echo "🧹 Tearing down CI-test deployment"
echo "   Admin Plane RG: $RG_NAME"
echo "   DLZ subs:       ${DLZ_SUBS:-(none)}"
echo "   Timeout:        ${TIMEOUT_MINUTES}m"

# Build the set of (sub_id, rg_name) pairs to delete
declare -a TARGETS
TARGETS+=("$(az account show --query id -o tsv):${RG_NAME}")

if [[ -n "$DLZ_SUBS" ]]; then
  IFS=',' read -ra SUBS <<< "$DLZ_SUBS"
  for sub in "${SUBS[@]}"; do
    RGS=$(az group list --subscription "$sub" --query "[?starts_with(name, 'rg-csa-loom-')].name" -o tsv)
    for rg in $RGS; do
      TARGETS+=("${sub}:${rg}")
    done
  done
fi

# Also pick up any CSA Loom RGs in the current sub beyond the admin RG
CUR_SUB=$(az account show --query id -o tsv)
ADDL=$(az group list --query "[?starts_with(name, 'rg-csa-loom-') && name != '${RG_NAME}'].name" -o tsv)
for rg in $ADDL; do
  TARGETS+=("${CUR_SUB}:${rg}")
done

echo "  Targets:"
for t in "${TARGETS[@]}"; do echo "    - $t"; done

# Record of soft-deletable resources captured BEFORE resource-group deletion.
# Cognitive Services (AOAI/Foundry) and API Management only appear in their
# `list-deleted` / `deletedservice list` catalogs AFTER the resource itself is
# deleted, and APIM's deleted-service list carries no resource-group, so we must
# remember (name, location) now to purge precisely later. One record per line:
#   cognitive <sub> <rg> <name> <location>
#   apim      <sub> <name> <location>
SOFTDEL_RECORD="$(mktemp)"
trap 'rm -f "$SOFTDEL_RECORD"' EXIT

# Purge soft-deletable resources first
for target in "${TARGETS[@]}"; do
  IFS=':' read -r sub rg <<< "$target"

  echo "  🔑 Purging Key Vaults in ${rg}..."
  KVS=$(az keyvault list --subscription "$sub" --resource-group "$rg" --query "[].name" -o tsv 2>/dev/null || true)
  for kv in $KVS; do
    az keyvault delete --subscription "$sub" --name "$kv" 2>/dev/null || true
    az keyvault purge --subscription "$sub" --name "$kv" 2>/dev/null || true
  done

  echo "  🌐 Purging Managed HSMs in ${rg}..."
  HSMS=$(az keyvault list --subscription "$sub" --resource-group "$rg" --resource-type hsm --query "[].name" -o tsv 2>/dev/null || true)
  for hsm in $HSMS; do
    az keyvault delete --subscription "$sub" --hsm-name "$hsm" 2>/dev/null || true
    az keyvault purge --subscription "$sub" --hsm-name "$hsm" --no-wait 2>/dev/null || true
  done

  # Capture Cognitive Services accounts (Azure OpenAI / AI Foundry) so their
  # soft-deleted names can be purged after RG deletion. Missing service =
  # empty list = fine. The resource-group delete performs the actual delete.
  echo "  🧠 Recording Cognitive Services accounts in ${rg}..."
  while IFS=$'\t' read -r cog_name cog_loc; do
    [[ -z "$cog_name" ]] && continue
    echo "cognitive ${sub} ${rg} ${cog_name} ${cog_loc}" >> "$SOFTDEL_RECORD"
  done < <(az cognitiveservices account list --subscription "$sub" --resource-group "$rg" \
             --query "[].[name,location]" -o tsv 2>/dev/null || true)

  # Capture API Management services (soft-delete on delete; deleted-service list
  # has no RG, so remember name+location now).
  echo "  🚪 Recording API Management services in ${rg}..."
  while IFS=$'\t' read -r apim_name apim_loc; do
    [[ -z "$apim_name" ]] && continue
    echo "apim ${sub} ${apim_name} ${apim_loc}" >> "$SOFTDEL_RECORD"
  done < <(az apim list --subscription "$sub" --resource-group "$rg" \
             --query "[].[name,location]" -o tsv 2>/dev/null || true)

  # Azure Analysis Services servers do NOT soft-delete, but delete them
  # explicitly first so the name is released cleanly before the RG delete. A
  # missing server is fine; the delete itself is best-effort here because the
  # RG delete is the authoritative removal.
  echo "  📊 Deleting Analysis Services servers in ${rg}..."
  AAS=$(az resource list --subscription "$sub" --resource-group "$rg" \
          --resource-type "Microsoft.AnalysisServices/servers" --query "[].name" -o tsv 2>/dev/null || true)
  for aas in $AAS; do
    az resource delete --subscription "$sub" --resource-group "$rg" \
      --resource-type "Microsoft.AnalysisServices/servers" --name "$aas" 2>/dev/null || true
  done

  # Cosmos DB account names are released immediately on delete (no 90-day name
  # reservation like Key Vault), so they do NOT block a same-name redeploy. When
  # continuous backup is on, a restorable-database-account artifact lingers per
  # the backup retention and expires on its own — there is no purge for it. Log
  # any restorable accounts for operator visibility; do not fail on them.
  RESTORABLE=$(az cosmosdb restorable-database-account list --subscription "$sub" \
                 --query "[?resourceGroup=='${rg}'].name" -o tsv 2>/dev/null || true)
  if [[ -n "$RESTORABLE" ]]; then
    echo "  🪐 Cosmos restorable accounts (expire with backup retention, no purge): ${RESTORABLE}"
  fi
done

# Purge the Cognitive Services + APIM soft-deletes captured before RG deletion.
# These only enter their deleted catalogs once the resource is gone, so this
# runs AFTER deletion. Every purge is best-effort (|| true): a not-yet-soft-
# deleted or already-purged resource is fine — the nightly cleanup retries the
# rest. The resource-group delete is the authoritative removal; this only frees
# the reserved name so a same-name redeploy succeeds.
purge_captured_softdeletes() {
  [[ -s "$SOFTDEL_RECORD" ]] || return 0
  echo "  ♻️  Purging captured soft-deleted Cognitive Services + APIM..."
  while read -r kind sub a b c; do
    case "$kind" in
      cognitive)
        # cognitive <sub> <rg> <name> <location>
        echo "    🧠 purge Cognitive Services '${b}' (${c})"
        az cognitiveservices account purge --subscription "$sub" \
          --resource-group "$a" --name "$b" --location "$c" 2>/dev/null || true
        ;;
      apim)
        # apim <sub> <name> <location>   (a=name, b=location)
        echo "    🚪 purge APIM '${a}' (${b})"
        az apim deletedservice purge --subscription "$sub" \
          --service-name "$a" --location "$b" 2>/dev/null || true
        ;;
    esac
  done < "$SOFTDEL_RECORD"
}

# Delete RGs (async)
echo "  🗑️  Submitting RG deletions..."
for target in "${TARGETS[@]}"; do
  IFS=':' read -r sub rg <<< "$target"
  az group delete --subscription "$sub" --name "$rg" --yes --no-wait 2>/dev/null || \
    echo "    (rg ${rg} already gone)"
done

# Poll until all gone or timeout
echo "  ⏳ Polling for deletion completion..."
START=$(date +%s)
DEADLINE=$((START + TIMEOUT_MINUTES * 60))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  REMAINING=0
  for target in "${TARGETS[@]}"; do
    IFS=':' read -r sub rg <<< "$target"
    if az group exists --subscription "$sub" --name "$rg" 2>/dev/null | grep -q true; then
      REMAINING=$((REMAINING + 1))
    fi
  done
  if [[ $REMAINING -eq 0 ]]; then
    echo
    echo "🧹 All target RGs deleted"
    purge_captured_softdeletes
    exit 0
  fi
  echo "    $REMAINING RG(s) remaining..."
  sleep 30
done

echo
echo "⚠️  Teardown timeout reached after ${TIMEOUT_MINUTES}m — some RGs may still be in 'Deleting' state"
echo "    Check Azure portal for status; nightly cleanup job will retry"
# Best-effort purge of whatever has already soft-deleted; the rest is retried.
purge_captured_softdeletes
exit 1
