#!/usr/bin/env bash
# CSA Loom — grant the Console UAMI the per-resource roles the 12 service
# navigators need to read/manage real Azure resources. COMPLEMENTS
# csa-loom-post-deploy-bootstrap.yml (which already handles Synapse data-plane,
# Databricks SCIM, APIM Service Contributor, admin-RG Reader, Foundry ML
# workspace, Content Safety, Graph AppRoles, Power Platform + Dataverse).
#
# This script adds the navigator grants that bootstrap does NOT cover:
#   - Event Hubs namespace : Azure Event Hubs Data Owner + Contributor
#   - Cosmos (DLZ account) : DocumentDB Account Contributor (control-plane CRUD)
#   - ADX cluster          : AllDatabasesAdmin principal-assignment (KQL mgmt)
#   - AI Search service    : Search Service Contributor + Index Data Contributor
#   - AOAI account         : Cognitive Services Contributor (Foundry editor)
#   - DLZ resource group   : Reader (ARM list for DLZ-hosted navigators)
#
# Resource names are DISCOVERED (reuse-first), so this works whether the
# resource was provisioned by Loom or already existed. Idempotent.
#
# REQUIRES: az CLI logged in as a principal that can create role assignments
#           on the admin + DLZ resource groups (the limitlessdata_deploy SP).
set -uo pipefail

SUB="${SUB:-00000000-0000-0000-0000-000000000001}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-eastus2}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz-single-eastus2}"
# Console UAMI principal (object) id — the identity the BFF runs as.
UAMI_PRINCIPAL="${CONSOLE_UAMI_PRINCIPAL:-00000000-0000-0000-0000-00000000000a}"
UAMI_CLIENT="${CONSOLE_UAMI_CLIENT:-00000000-0000-0000-0000-00000000000b}"
TENANT_ID="${AZURE_TENANT_ID:-$(az account show --query tenantId -o tsv 2>/dev/null)}"

az account set --subscription "$SUB" 2>/dev/null || true
echo "== CSA Loom navigator RBAC =="
echo "   sub=$SUB admin_rg=$ADMIN_RG dlz_rg=$DLZ_RG uami=$UAMI_PRINCIPAL"
echo

# Built-in role definition GUIDs
EH_DATA_OWNER="f526a384-b230-433a-b45c-95f59c4a2dec"   # Azure Event Hubs Data Owner
CONTRIBUTOR="b24988ac-6180-42a0-ab88-20f7382dd24c"     # Contributor
COSMOS_CONTRIB="5bd9cd88-fe45-4216-938b-f97437e15450"  # DocumentDB Account Contributor
SEARCH_CONTRIB="7ca78c08-252a-4471-8644-bb5ff32d4ba0"  # Search Service Contributor
SEARCH_DATA="8ebe5a00-799e-43f5-93ac-243d3dce84a7"     # Search Index Data Contributor
COG_CONTRIB="25fbc0a9-bd7c-42a3-aa1a-3b75d497ee68"     # Cognitive Services Contributor
READER="acdd72a7-3385-48ef-bd42-f606fba81ae7"          # Reader
STORAGE_BLOB_CONTRIB="ba92f5b4-2d11-453d-a403-e96b0029c9fe" # Storage Blob Data Contributor
LOGIC_CONTRIB="87a39d53-fc1b-424a-814c-f7e04687dc9e"   # Logic App Contributor
ADF_CONTRIB="673868aa-7521-48a0-acc6-0f60742d39f5"     # Data Factory Contributor
APIM_CONTRIB="312a565d-c81f-4fd8-895a-4e21e48d571c"    # API Management Service Contributor

grant() { # grant ROLE_GUID SCOPE LABEL
  local role="$1" scope="$2" label="$3"
  [[ -z "$scope" ]] && { echo "  - $label: scope not found, skipping"; return; }
  MSYS_NO_PATHCONV=1 az role assignment create \
    --assignee-object-id "$UAMI_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role "$role" --scope "$scope" -o none 2>&1 | grep -vi "already exists\|RoleAssignmentExists" || true
  echo "  ✓ $label"
}
q() { az "$@" 2>/dev/null || true; }

# DLZ resource group Reader (ARM list for DLZ-hosted navigators)
grant "$READER" "/subscriptions/$SUB/resourceGroups/$DLZ_RG" "Reader on DLZ RG"

# ---------------------------------------------------------------------------
# Bring-Your-Own reused resources (cross-sub aware). When the operator points
# Loom at an EXISTING resource in another RG/subscription (via byo-wizard.sh /
# the EXISTING_* exports), grant the Console UAMI the same navigator role on THAT
# resource — at its real subscription scope. Additive: the discovery-based grants
# below still cover Loom-provisioned (own) resources. No-op when the matching
# EXISTING_* var is unset. (Cross-sub grants require the running principal to hold
# role-assignment rights in the target sub; Purview data-plane roles are granted
# in the Purview portal, not here — see full-deployment-and-byo.md §3b.)
# ---------------------------------------------------------------------------
byo_grant() { # byo_grant ROLE NAME RG SUB PROVIDER/TYPE LABEL
  local role="$1" name="$2" rg="$3" sub="$4" rt="$5" label="$6"
  [[ -z "$name" ]] && return 0
  [[ -z "$rg" ]] && { echo "  - BYO $label: set its _RG to grant cross-RG/sub — skipping"; return 0; }
  grant "$role" "/subscriptions/${sub:-$SUB}/resourceGroups/$rg/providers/$rt/$name" "BYO $label"
}
byo_grant "$EH_DATA_OWNER" "${EXISTING_EVENTHUB_NAMESPACE:-}" "${EXISTING_EVENTHUB_RG:-}" "${EXISTING_EVENTHUB_SUB:-}" "Microsoft.EventHub/namespaces" "Event Hubs Data Owner (reused)"
byo_grant "$CONTRIBUTOR"   "${EXISTING_EVENTHUB_NAMESPACE:-}" "${EXISTING_EVENTHUB_RG:-}" "${EXISTING_EVENTHUB_SUB:-}" "Microsoft.EventHub/namespaces" "Contributor on EH (reused)"
byo_grant "$COSMOS_CONTRIB" "${EXISTING_COSMOS_ACCOUNT:-}" "${EXISTING_COSMOS_ACCOUNT_RG:-}" "${EXISTING_COSMOS_ACCOUNT_SUB:-}" "Microsoft.DocumentDB/databaseAccounts" "DocumentDB Account Contributor (reused)"
byo_grant "$SEARCH_CONTRIB" "${EXISTING_AI_SEARCH_SERVICE:-}" "${EXISTING_AI_SEARCH_RG:-}" "${EXISTING_AI_SEARCH_SUB:-}" "Microsoft.Search/searchServices" "Search Service Contributor (reused)"
byo_grant "$SEARCH_DATA"    "${EXISTING_AI_SEARCH_SERVICE:-}" "${EXISTING_AI_SEARCH_RG:-}" "${EXISTING_AI_SEARCH_SUB:-}" "Microsoft.Search/searchServices" "Search Index Data Contributor (reused)"
byo_grant "$COG_CONTRIB"    "${EXISTING_AOAI:-${EXISTING_AOAI_ACCOUNT:-}}" "${EXISTING_AOAI_RG:-}" "${EXISTING_AOAI_SUB:-}" "Microsoft.CognitiveServices/accounts" "Cognitive Services Contributor (reused)"
# APIM / Synapse / Data Factory navigators read ARM in the reused resource's
# subscription (apim-client reads LOOM_APIM_SUB, synapse-* reads LOOM_SYNAPSE_SUB,
# adf-client reads LOOM_ADF_SUB) — grant the matching management-plane role THERE.
byo_grant "$APIM_CONTRIB"   "${EXISTING_APIM:-}"    "${EXISTING_APIM_RG:-}"    "${EXISTING_APIM_SUB:-}"    "Microsoft.ApiManagement/service"   "API Management Service Contributor (reused)"
byo_grant "$CONTRIBUTOR"    "${EXISTING_SYNAPSE:-}" "${EXISTING_SYNAPSE_RG:-}" "${EXISTING_SYNAPSE_SUB:-}" "Microsoft.Synapse/workspaces"      "Contributor on Synapse workspace (reused)"
byo_grant "$ADF_CONTRIB"    "${EXISTING_ADF:-}"     "${EXISTING_ADF_RG:-}"     "${EXISTING_ADF_SUB:-}"     "Microsoft.DataFactory/factories"   "Data Factory Contributor (reused)"
# Cosmos reused account also needs the data-plane Built-in Data Contributor.
if [[ -n "${EXISTING_COSMOS_ACCOUNT:-}" && -n "${EXISTING_COSMOS_ACCOUNT_RG:-}" ]]; then
  echo "  BYO Cosmos data-plane: Built-in Data Contributor (reused ${EXISTING_COSMOS_ACCOUNT})"
  MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
    --account-name "$EXISTING_COSMOS_ACCOUNT" -g "$EXISTING_COSMOS_ACCOUNT_RG" \
    ${EXISTING_COSMOS_ACCOUNT_SUB:+--subscription "$EXISTING_COSMOS_ACCOUNT_SUB"} \
    --role-definition-id "00000000-0000-0000-0000-000000000002" \
    --principal-id "$UAMI_PRINCIPAL" --scope "/" -o none 2>&1 \
    | grep -vi "already\|exists\|Conflict" || true
  echo "  ✓ Cosmos DB Built-in Data Contributor (reused ${EXISTING_COSMOS_ACCOUNT})"
fi

# Event Hubs namespace
EH_NS="$(q eventhubs namespace list -g "$DLZ_RG" --query "[0].name" -o tsv)"
if [[ -n "$EH_NS" ]]; then
  EH_SCOPE="/subscriptions/$SUB/resourceGroups/$DLZ_RG/providers/Microsoft.EventHub/namespaces/$EH_NS"
  grant "$EH_DATA_OWNER" "$EH_SCOPE" "Event Hubs Data Owner ($EH_NS)"
  grant "$CONTRIBUTOR"   "$EH_SCOPE" "Contributor on EH namespace ($EH_NS)"
else
  echo "  - Event Hubs namespace not found in $DLZ_RG — skipping"
fi

# Cosmos (control-plane navigator account)
COSMOS_ACCT="$(q cosmosdb list -g "$DLZ_RG" --query "[?starts_with(name,'cosmos-loom')].name | [0]" -o tsv)"
[[ -z "$COSMOS_ACCT" ]] && COSMOS_ACCT="$(q cosmosdb list -g "$DLZ_RG" --query "[0].name" -o tsv)"
if [[ -n "$COSMOS_ACCT" ]]; then
  COSMOS_SCOPE="/subscriptions/$SUB/resourceGroups/$DLZ_RG/providers/Microsoft.DocumentDB/databaseAccounts/$COSMOS_ACCT"
  grant "$COSMOS_CONTRIB" "$COSMOS_SCOPE" "DocumentDB Account Contributor ($COSMOS_ACCT)"
  # DATA-plane role for the Items Data Explorer (query/CRUD documents). The
  # control-plane role above does NOT grant data access (Cosmos returns 403
  # substatus 5300). Assign the built-in "Cosmos DB Built-in Data Contributor"
  # (00000000-0000-0000-0000-000000000002) at account scope "/" via the Cosmos
  # SQL role-assignment surface (sqlRoleAssignments — distinct from Azure RBAC).
  echo "  Cosmos data-plane: Built-in Data Contributor for the Console UAMI"
  MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
    --account-name "$COSMOS_ACCT" -g "$DLZ_RG" \
    --role-definition-id "00000000-0000-0000-0000-000000000002" \
    --principal-id "$UAMI_PRINCIPAL" --scope "/" -o none 2>&1 \
    | grep -vi "already\|exists\|Conflict" || true
  echo "  ✓ Cosmos DB Built-in Data Contributor ($COSMOS_ACCT)"
else
  echo "  - Cosmos account not found in $DLZ_RG — skipping"
fi

# label-propagation timer Function (F15) — its system-assigned identity needs the
# Cosmos DATA-plane role to read items + upsert propagation state. Discover the
# function app (func-lblprop-*) in the admin RG and grant Built-in Data
# Contributor at the Loom Cosmos account. Keyed off LABEL_PROP_FUNC_NAME or
# discovered by name prefix. No-op when the engine isn't deployed.
LABEL_PROP_FUNC="${LABEL_PROP_FUNC_NAME:-$(q functionapp list -g "$ADMIN_RG" --query "[?starts_with(name,'func-lblprop')].name | [0]" -o tsv)}"
if [[ -n "$LABEL_PROP_FUNC" && -n "${COSMOS_ACCT:-}" ]]; then
  LP_PRINCIPAL="$(q functionapp identity show -n "$LABEL_PROP_FUNC" -g "$ADMIN_RG" --query principalId -o tsv)"
  if [[ -n "$LP_PRINCIPAL" ]]; then
    echo "  label-propagation Function data-plane: Built-in Data Contributor ($LABEL_PROP_FUNC)"
    MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
      --account-name "$COSMOS_ACCT" -g "$DLZ_RG" \
      --role-definition-id "00000000-0000-0000-0000-000000000002" \
      --principal-id "$LP_PRINCIPAL" --scope "/" -o none 2>&1 \
      | grep -vi "already\|exists\|Conflict" || true
    echo "  ✓ Cosmos data-plane granted to $LABEL_PROP_FUNC"
  fi
else
  echo "  - label-propagation Function not found in $ADMIN_RG — skipping (F15 engine optional)"
fi

# report-subscriptions timer Function — its system-assigned identity renders
# Power BI reports on a schedule and delivers them by email. It needs:
#   - Cosmos DATA-plane Built-in Data Contributor (read subs + write delivery log)
#   - Storage Blob Data Contributor on the ADLS account (archive the export)
#   - Logic App Contributor on the delivery workflow (resolve trigger URL)
# (Power BI workspace membership is granted in the Power BI portal/tenant, not
# Azure RBAC.) No-op when the engine isn't deployed (opt-in feature).
RPTSUB_FUNC="${REPORT_SUBS_FUNC_NAME:-$(q functionapp list -g "$ADMIN_RG" --query "[?starts_with(name,'func-rptsub')].name | [0]" -o tsv)}"
if [[ -n "$RPTSUB_FUNC" ]]; then
  RS_PRINCIPAL="$(q functionapp identity show -n "$RPTSUB_FUNC" -g "$ADMIN_RG" --query principalId -o tsv)"
  if [[ -n "$RS_PRINCIPAL" ]]; then
    # Cosmos data-plane (same role-definition surface as the Console + F15).
    if [[ -n "${COSMOS_ACCT:-}" ]]; then
      echo "  report-subscriptions Function data-plane: Built-in Data Contributor ($RPTSUB_FUNC)"
      MSYS_NO_PATHCONV=1 az cosmosdb sql role assignment create \
        --account-name "$COSMOS_ACCT" -g "$DLZ_RG" \
        --role-definition-id "00000000-0000-0000-0000-000000000002" \
        --principal-id "$RS_PRINCIPAL" --scope "/" -o none 2>&1 \
        | grep -vi "already\|exists\|Conflict" || true
      echo "  ✓ Cosmos data-plane granted to $RPTSUB_FUNC"
    fi
    # Storage Blob Data Contributor on the ADLS account (export archive). The
    # ADLS account is the Loom storage account; discover it in the DLZ RG, or
    # override with REPORT_SUBS_ADLS_ACCT / REPORT_SUBS_ADLS_RG.
    RS_ADLS_RG="${REPORT_SUBS_ADLS_RG:-$DLZ_RG}"
    RS_ADLS="${REPORT_SUBS_ADLS_ACCT:-$(q storage account list -g "$RS_ADLS_RG" --query "[?starts_with(name,'st')].name | [0]" -o tsv)}"
    if [[ -n "$RS_ADLS" ]]; then
      RS_ADLS_SCOPE="/subscriptions/$SUB/resourceGroups/$RS_ADLS_RG/providers/Microsoft.Storage/storageAccounts/$RS_ADLS"
      MSYS_NO_PATHCONV=1 az role assignment create \
        --assignee-object-id "$RS_PRINCIPAL" --assignee-principal-type ServicePrincipal \
        --role "$STORAGE_BLOB_CONTRIB" --scope "$RS_ADLS_SCOPE" -o none 2>&1 \
        | grep -vi "already exists\|RoleAssignmentExists" || true
      echo "  ✓ Storage Blob Data Contributor granted to $RPTSUB_FUNC ($RS_ADLS)"
    else
      echo "  - ADLS account not found in $RS_ADLS_RG — report exports won't archive (delivery still works)"
    fi
    # Logic App Contributor on the delivery workflow (listCallbackUrl).
    RS_LA="${REPORT_SUBS_LOGIC_APP:-$(q logic workflow list -g "$ADMIN_RG" --query "[?starts_with(name,'logic-loom-report-subs')].name | [0]" -o tsv)}"
    if [[ -n "$RS_LA" ]]; then
      RS_LA_SCOPE="/subscriptions/$SUB/resourceGroups/$ADMIN_RG/providers/Microsoft.Logic/workflows/$RS_LA"
      MSYS_NO_PATHCONV=1 az role assignment create \
        --assignee-object-id "$RS_PRINCIPAL" --assignee-principal-type ServicePrincipal \
        --role "$LOGIC_CONTRIB" --scope "$RS_LA_SCOPE" -o none 2>&1 \
        | grep -vi "already exists\|RoleAssignmentExists" || true
      echo "  ✓ Logic App Contributor granted to $RPTSUB_FUNC ($RS_LA)"
    else
      echo "  - report-subscription Logic App not found in $ADMIN_RG — skipping (delivery gated)"
    fi
  fi
else
  echo "  - report-subscriptions Function not found in $ADMIN_RG — skipping (opt-in feature)"
fi

# AI Search service
SEARCH_NAME="$(q search service list -g "$ADMIN_RG" --query "[0].name" -o tsv)"
if [[ -n "$SEARCH_NAME" ]]; then
  SEARCH_SCOPE="/subscriptions/$SUB/resourceGroups/$ADMIN_RG/providers/Microsoft.Search/searchServices/$SEARCH_NAME"
  grant "$SEARCH_CONTRIB" "$SEARCH_SCOPE" "Search Service Contributor ($SEARCH_NAME)"
  grant "$SEARCH_DATA"    "$SEARCH_SCOPE" "Search Index Data Contributor ($SEARCH_NAME)"
  # A keys-only search service returns 403 to the UAMI's AAD bearer token even
  # with the data-plane role assigned. Enable AAD (RBAC) auth alongside keys so
  # the token is accepted. Additive + reversible (aadOrApiKey keeps API keys).
  echo "  search auth before: $(q search service show -n "$SEARCH_NAME" -g "$ADMIN_RG" --query "{authOptions:authOptions, disableLocalAuth:disableLocalAuth}" -o json)"
  MSYS_NO_PATHCONV=1 az search service update -n "$SEARCH_NAME" -g "$ADMIN_RG" \
    --auth-options aadOrApiKey --aad-auth-failure-mode http403 -o none 2>&1 | tail -3 || true
  echo "  ✓ AI Search AAD (RBAC) data-plane auth enabled ($SEARCH_NAME)"
else
  echo "  - AI Search service not found in $ADMIN_RG — skipping (navigator stays gated)"
fi

# AOAI / AI Services account (Foundry editor models/quota/keys)
AOAI_NAME="$(q cognitiveservices account list -g "$ADMIN_RG" --query "[?kind=='AIServices'].name | [0]" -o tsv)"
if [[ -n "$AOAI_NAME" ]]; then
  AOAI_SCOPE="/subscriptions/$SUB/resourceGroups/$ADMIN_RG/providers/Microsoft.CognitiveServices/accounts/$AOAI_NAME"
  grant "$COG_CONTRIB" "$AOAI_SCOPE" "Cognitive Services Contributor ($AOAI_NAME)"
else
  echo "  - AOAI/AIServices account not found in $ADMIN_RG — skipping"
fi

# ADX cluster — KQL management requires a Kusto cluster principal assignment,
# NOT an ARM role. AllDatabasesAdmin lets the navigator run .show/.create/.drop
# across every database. Use a deterministic ARM PUT (the `az kusto` CLI is
# experimental and mis-reports on the idempotent path). principalId is the
# UAMI's OBJECT id with principalType App — matching adx-db-inner.bicep.
KUSTO_NAME="$(q kusto cluster list -g "$ADMIN_RG" --query "[0].name" -o tsv)"
if [[ -n "$KUSTO_NAME" ]]; then
  PA_URL="https://management.azure.com/subscriptions/$SUB/resourceGroups/$ADMIN_RG/providers/Microsoft.Kusto/clusters/$KUSTO_NAME/principalAssignments/loom-console-alladmin?api-version=2024-04-13"
  PA_BODY="{\"properties\":{\"principalId\":\"$UAMI_PRINCIPAL\",\"principalType\":\"App\",\"role\":\"AllDatabasesAdmin\",\"tenantId\":\"$TENANT_ID\"}}"
  MSYS_NO_PATHCONV=1 az rest --method put --url "$PA_URL" --body "$PA_BODY" -o none 2>&1 \
    | grep -vi "already\|exists\|Conflict" || true
  echo "  ✓ ADX AllDatabasesAdmin ($KUSTO_NAME)"
else
  echo "  - ADX cluster not found in $ADMIN_RG — skipping"
fi

echo
echo "== Navigator RBAC complete. Allow ~60s for AAD propagation before validation. =="
echo "   Note: Databricks (SCIM), Synapse (data-plane), APIM, Graph, Power Platform,"
echo "   and Dataverse grants are handled by csa-loom-post-deploy-bootstrap.yml."
