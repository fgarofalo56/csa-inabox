#!/usr/bin/env bash
# sandbox.sh - LHDS W0 measurement sandbox (Commercial), created with az in ONE resource group.
#
# Usage: scripts/measure/health/sandbox.sh {up|status|pause|resume|down}
#
# Operator decisions 2026-10-22: subscription "Limitlessdata - DLZ"; DEV profile first (budget $750/month)
# to prove the pipeline works end to end, class S (~$4k) only after that. Defaults below are the DEV
# profile; class S is the same script with env overrides:
#   LHDS_AKS_NODES=3 LHDS_PG_SKU=Standard_E8ds_v5 LHDS_PG_STORAGE_GB=2048 LHDS_EGRESS_NODES=1 LHDS_BUDGET_USD=4000
# Numbers measured on the DEV profile prove function, NOT the W0 pass bars. Resource group deleted by
# LHDS_DELETE_BY. Nothing here touches the shared bicep tree (W0 rule).
#
# Required env (no defaults, by design - the script never picks a subscription for you):
#   LHDS_SANDBOX_SUBSCRIPTION  subscription id
#   LHDS_SANDBOX_RG            resource group name (created by `up`, deleted by `down`)
#   LHDS_LOCATION              Azure region, e.g. eastus2
#   LHDS_DELETE_BY             YYYY-MM-DD, written as a tag and printed by `status`
# Optional env:
#   LHDS_BUDGET_USD (750/month)  LHDS_AKS_VM_SIZE (Standard_D8s_v5)  LHDS_AKS_NODES (1)
#   LHDS_PG_SKU (Standard_D2ds_v5; tier derived from the SKU)  LHDS_PG_STORAGE_GB (128)
#   LHDS_EGRESS_VM_SIZE (Standard_D4s_v5)  LHDS_EGRESS_NODES (0; set 1 for the W0-4 egress capture)
#   Node counts are enforced on re-run. PostgreSQL storage can only grow: a smaller LHDS_PG_STORAGE_GB than
#   the existing server aborts (delete the server, then re-run `up` with a NEW LHDS_PG_NAME: a deleted
#   server name stays reserved for a while - "Specified server name is already used").
#   LHDS_DOWN_CONFIRM=<rg name>     required by `down`
#
# Secrets: the PostgreSQL admin password is generated here and written to the sandbox Key Vault (secret
# `pg-admin-password`, via ARM because the vault has no public data plane) and to the Kubernetes secret
# lhds-w0/lhds-pg-admin, through mode-600 temp files that are removed. It is never printed.
#
# Output: non-secret names/ids in temp/lhds-w0/sandbox-vars.sh for the measurement scripts to `source`.
set -euo pipefail
shopt -s inherit_errexit
export MSYS_NO_PATHCONV=1   # Git Bash would otherwise rewrite /subscriptions/... ids
die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[sandbox $(date -u +%H:%M:%SZ)] $*"; }

cd "$(git rev-parse --show-toplevel)"   # temp/ paths below are repo-root relative
cmd="${1:-}"
[[ "$cmd" =~ ^(up|status|pause|resume|down)$ ]] || die "usage: $0 {up|status|pause|resume|down}"
for v in LHDS_SANDBOX_SUBSCRIPTION LHDS_SANDBOX_RG LHDS_LOCATION LHDS_DELETE_BY; do
  [[ -n "${!v:-}" ]] || die "required env var $v is not set (no defaults, by design)"
done
[[ "$LHDS_DELETE_BY" =~ ^20[0-9]{2}-[01][0-9]-[0-3][0-9]$ ]] || die "LHDS_DELETE_BY must be YYYY-MM-DD"

SUB="$LHDS_SANDBOX_SUBSCRIPTION"; RG="$LHDS_SANDBOX_RG"; LOC="$LHDS_LOCATION"
az account set --subscription "$SUB"
active="$(az account show --query id -o tsv)"
[[ "$active" == "$SUB" ]] || die "active subscription $active != LHDS_SANDBOX_SUBSCRIPTION"

# Deterministic short suffix so re-runs find the same globally-unique names.
SFX="$(printf '%s/%s' "$SUB" "$RG" | sha256sum | cut -c1-6)"
VNET="vnet-lhds-w0"; SNET_AKS="snet-aks"; SNET_PG="snet-pg"; SNET_PE="snet-pe"
KV="kv-lhdsw0-$SFX"; UAMI="id-lhds-w0-cmk"; CMK="lhds-w0-cmk"
PG="${LHDS_PG_NAME:-pg-lhdsw0-$SFX}"; PG_DNS="lhdsw0.private.postgres.database.azure.com"
AKS="aks-lhds-w0"; EGRESS_POOL="egressprobe"
ENV_OUT="temp/lhds-w0/sandbox-vars.sh"
KUBECONFIG_OUT="temp/lhds-w0/kubeconfig"; K8S_NS="lhds-w0"
BUDGET="${LHDS_BUDGET_USD:-750}"; AKS_VM="${LHDS_AKS_VM_SIZE:-Standard_D8s_v5}"; AKS_N="${LHDS_AKS_NODES:-1}"
EG_VM="${LHDS_EGRESS_VM_SIZE:-Standard_D4s_v5}"; EG_N="${LHDS_EGRESS_NODES:-0}"
PG_SKU="${LHDS_PG_SKU:-Standard_D2ds_v5}"; PG_GB="${LHDS_PG_STORAGE_GB:-128}"
case "$PG_SKU" in
  Standard_E*) PG_TIER=MemoryOptimized ;;
  Standard_D*) PG_TIER=GeneralPurpose ;;
  Standard_B*) PG_TIER=Burstable ;;
  *) die "cannot derive a PostgreSQL tier from LHDS_PG_SKU=$PG_SKU" ;;
esac

# exists CMD...: 0 if the resource exists, 1 if the service says it does not. Any OTHER failure (auth,
# network, throttling) aborts with the real stderr - it must never be read as "absent" (deploy-integrity R7).
exists() {
  local err rc=0
  err="$(mktemp -p temp/lhds-w0 exists.XXXXXX)"
  "$@" --only-show-errors -o none 2> "$err" || rc=$?
  if [[ $rc -eq 0 ]]; then rm -f "$err"; return 0; fi
  if grep -qiE "not ?found|could not be found|does not exist|ResourceNotFound|was not found" "$err"; then
    rm -f "$err"; return 1
  fi
  echo "ERROR: existence check failed (rc=$rc) for: $*" >&2; cat "$err" >&2; rm -f "$err"; exit 1
}
# ARM (control-plane) helpers for the Key Vault: the vault is private (no public data plane), so the secret
# and the CMK key are written through ARM, which does not traverse the vault's network ACL.
arm_get() { exists az rest --method get --url "https://management.azure.com$1?api-version=2023-07-01"; }
arm_put() { az rest --method put --url "https://management.azure.com$1?api-version=2023-07-01" --body "@$2" -o none; }

case "$cmd" in
up)
  TAGS=(purpose=lhds-w0-measurement "delete-by=$LHDS_DELETE_BY" "budget-usd-month=$BUDGET" prp=loom-health-data-services)
  log "resource group $RG ($LOC)"
  az group create -n "$RG" -l "$LOC" --tags "${TAGS[@]}" -o none

  log "budget alert ($BUDGET USD/month, RG scope, notifies subscription Owners)"
  start="$(date -u +%Y-%m-01)"
  cat > temp/lhds-w0/budget.json <<JSON
{"properties":{"category":"Cost","amount":${BUDGET},"timeGrain":"Monthly",
 "timePeriod":{"startDate":"${start}T00:00:00Z"},
 "notifications":{
  "a25":{"enabled":true,"operator":"GreaterThan","threshold":25,"contactRoles":["Owner"],"thresholdType":"Actual"},
  "a50":{"enabled":true,"operator":"GreaterThan","threshold":50,"contactRoles":["Owner"],"thresholdType":"Actual"},
  "a80":{"enabled":true,"operator":"GreaterThan","threshold":80,"contactRoles":["Owner"],"thresholdType":"Actual"},
  "f100":{"enabled":true,"operator":"GreaterThan","threshold":100,"contactRoles":["Owner"],"thresholdType":"Forecasted"}}}}
JSON
  BUDGET_URL="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/lhds-w0?api-version=2023-05-01"
  # A budget's time grain cannot be updated in place ("Budget time grain cannot be updated"): replace it.
  if exists az rest --method get --url "$BUDGET_URL"; then
    grain="$(az rest --method get --url "$BUDGET_URL" --query properties.timeGrain -o tsv)"
    [[ "$grain" == "Monthly" ]] || az rest --method delete --url "$BUDGET_URL" -o none
  fi
  az rest --method put --url "$BUDGET_URL" --body @temp/lhds-w0/budget.json -o none

  log "network $VNET"
  exists az network vnet show -g "$RG" -n "$VNET" || \
    az network vnet create -g "$RG" -n "$VNET" -l "$LOC" --address-prefixes 10.240.0.0/16 \
      --subnet-name "$SNET_AKS" --subnet-prefixes 10.240.0.0/20 -o none
  exists az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$SNET_PG" || \
    az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "$SNET_PG" --address-prefixes 10.240.16.0/24 \
      --delegations Microsoft.DBforPostgreSQL/flexibleServers -o none
  exists az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$SNET_PE" || \
    az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "$SNET_PE" --address-prefixes 10.240.17.0/24 -o none
  VNET_ID="$(az network vnet show -g "$RG" -n "$VNET" --query id -o tsv)"
  AKS_SUBNET_ID="$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$SNET_AKS" --query id -o tsv)"

  log "key vault $KV (RBAC, purge protection for CMK, PRIVATE: no public data plane)"
  exists az keyvault show -g "$RG" -n "$KV" || \
    az keyvault create -g "$RG" -n "$KV" -l "$LOC" --enable-rbac-authorization true \
      --enable-purge-protection true --retention-days 7 --public-network-access Disabled -o none
  KV_ID="$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv)"
  log "key vault private endpoint in $SNET_PE (in-cluster consumers read secrets through it)"
  exists az network private-dns zone show -g "$RG" -n privatelink.vaultcore.azure.net || \
    az network private-dns zone create -g "$RG" -n privatelink.vaultcore.azure.net -o none
  exists az network private-dns link vnet show -g "$RG" -z privatelink.vaultcore.azure.net -n kv-link || \
    az network private-dns link vnet create -g "$RG" -z privatelink.vaultcore.azure.net -n kv-link \
      -v "$VNET_ID" -e false -o none
  if ! exists az network private-endpoint show -g "$RG" -n pe-kv; then
    az network private-endpoint create -g "$RG" -n pe-kv -l "$LOC" --vnet-name "$VNET" --subnet "$SNET_PE" \
      --private-connection-resource-id "$KV_ID" --group-id vault --connection-name kv -o none
    az network private-endpoint dns-zone-group create -g "$RG" --endpoint-name pe-kv -n default \
      --private-dns-zone privatelink.vaultcore.azure.net --zone-name vault -o none
  fi

  log "CMK key $CMK (via ARM) + identity $UAMI"
  if ! arm_get "$KV_ID/keys/$CMK"; then
    printf '{"properties":{"kty":"RSA","keySize":3072}}' > temp/lhds-w0/cmk-key.json
    arm_put "$KV_ID/keys/$CMK" temp/lhds-w0/cmk-key.json
  fi
  exists az identity show -g "$RG" -n "$UAMI" || az identity create -g "$RG" -n "$UAMI" -l "$LOC" -o none
  UAMI_ID="$(az identity show -g "$RG" -n "$UAMI" --query id -o tsv)"
  UAMI_PID="$(az identity show -g "$RG" -n "$UAMI" --query principalId -o tsv)"
  az role assignment create --assignee-object-id "$UAMI_PID" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Crypto Service Encryption User" --scope "$KV_ID" -o none --only-show-errors

  log "AKS $AKS ($AKS_N x $AKS_VM, Azure CNI overlay, workload identity)"
  if ! exists az aks show -g "$RG" -n "$AKS"; then
    az aks create -g "$RG" -n "$AKS" -l "$LOC" --tier free \
      --node-count "$AKS_N" --node-vm-size "$AKS_VM" \
      --network-plugin azure --network-plugin-mode overlay --vnet-subnet-id "$AKS_SUBNET_ID" \
      --enable-managed-identity --enable-oidc-issuer --enable-workload-identity \
      --no-ssh-key --tags "${TAGS[@]}" -o none
  fi
  if ! exists az aks nodepool show -g "$RG" --cluster-name "$AKS" -n "$EGRESS_POOL"; then
    log "egress-probe node pool ($EG_N x $EG_VM, labelled + tainted for W0-4)"
    az aks nodepool add -g "$RG" --cluster-name "$AKS" -n "$EGRESS_POOL" --mode User --node-count "$EG_N" \
      --node-vm-size "$EG_VM" \
      --labels loom.io/pool=egress-probe --node-taints loom.io/egress-probe=true:NoSchedule -o none
  fi
  # Enforce node counts on an existing cluster (the profile can change between runs).
  sys_pool="$(az aks nodepool list -g "$RG" --cluster-name "$AKS" --query "[?mode=='System'].name | [0]" -o tsv)"
  for pc in "$sys_pool:$AKS_N" "$EGRESS_POOL:$EG_N"; do
    pool="${pc%%:*}"; want="${pc##*:}"
    have="$(az aks nodepool show -g "$RG" --cluster-name "$AKS" -n "$pool" --query count -o tsv)"
    if [[ "$have" != "$want" ]]; then
      log "scaling node pool $pool $have -> $want"
      az aks nodepool scale -g "$RG" --cluster-name "$AKS" -n "$pool" --node-count "$want" -o none
    fi
  done
  # kubeconfig holds a cluster credential: gitignored temp/ only, never printed.
  az aks get-credentials -g "$RG" -n "$AKS" --file "$KUBECONFIG_OUT" --overwrite-existing -o none --only-show-errors
  export KUBECONFIG="$KUBECONFIG_OUT"
  kubectl get namespace "$K8S_NS" -o name > /dev/null 2> temp/lhds-w0/ns.err || kubectl create namespace "$K8S_NS"

  log "PostgreSQL $PG ($PG_SKU / $PG_TIER, $PG_GB GB, no HA, private access)"
  # az >= 2.9x only ACCEPTS an existing zone (it no longer creates one); a missing zone surfaces as the
  # misleading "PrivateDnsZoneNameNotValid ... server name plus zone suffix". Create + link it first.
  exists az network private-dns zone show -g "$RG" -n "$PG_DNS" || \
    az network private-dns zone create -g "$RG" -n "$PG_DNS" -o none
  exists az network private-dns link vnet show -g "$RG" -z "$PG_DNS" -n pg-link || \
    az network private-dns link vnet create -g "$RG" -z "$PG_DNS" -n pg-link -v "$VNET_ID" -e false -o none
  PG_DNS_ID="$(az network private-dns zone show -g "$RG" -n "$PG_DNS" --query id -o tsv)"
  if ! exists az postgres flexible-server show -g "$RG" -n "$PG"; then
    # The password is generated here and lands in exactly two places: Key Vault (via ARM) and the
    # Kubernetes secret $K8S_NS/lhds-pg-admin. It is never printed; the temp files are mode 600 and removed.
    umask 077
    pw_file="$(mktemp -p temp/lhds-w0 pgpw.XXXXXX)"; body_file="$(mktemp -p temp/lhds-w0 pgpwbody.XXXXXX)"
    trap 'rm -f "$pw_file" "$body_file"' EXIT
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-32 | tr -d '\n' > "$pw_file"
    printf 'Aa1' >> "$pw_file"   # guarantees upper/lower/digit classes required by PostgreSQL Flexible Server
    [[ "$(wc -c < "$pw_file")" -ge 35 ]] || die "password generation produced too few characters"
    printf '{"properties":{"value":"%s","contentType":"postgresql-admin-password"}}' "$(cat "$pw_file")" > "$body_file"
    arm_put "$KV_ID/secrets/pg-admin-password" "$body_file"
    kubectl -n "$K8S_NS" delete secret lhds-pg-admin --ignore-not-found
    kubectl -n "$K8S_NS" create secret generic lhds-pg-admin --from-literal=username=lhdsadmin \
      --from-file=password="$pw_file" -o name
    az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOC" --yes \
      --tier "$PG_TIER" --sku-name "$PG_SKU" \
      --storage-size "$PG_GB" --version 16 --zonal-resiliency Disabled \
      --vnet "$VNET" --subnet "$SNET_PG" --private-dns-zone "$PG_DNS_ID" \
      --admin-user lhdsadmin --admin-password "$(cat "$pw_file")" --tags "${TAGS[@]}" -o none --only-show-errors
    rm -f "$pw_file" "$body_file"; trap - EXIT
  else
    have_sku="$(az postgres flexible-server show -g "$RG" -n "$PG" --query sku.name -o tsv)"
    have_gb="$(az postgres flexible-server show -g "$RG" -n "$PG" --query storage.storageSizeGb -o tsv)"
    (( PG_GB >= have_gb )) || die "PostgreSQL storage cannot shrink ($have_gb GB -> $PG_GB GB): delete $PG and re-run up"
    if [[ "$have_sku" != "$PG_SKU" || "$have_gb" != "$PG_GB" ]]; then
      log "resizing PostgreSQL $have_sku/$have_gb GB -> $PG_SKU/$PG_GB GB"
      az postgres flexible-server update -g "$RG" -n "$PG" --tier "$PG_TIER" --sku-name "$PG_SKU" \
        --storage-size "$PG_GB" -o none --only-show-errors
    fi
  fi
  for db in hapi medplum dcm4chee; do
    exists az postgres flexible-server db show -g "$RG" -s "$PG" -n "$db" || \
      az postgres flexible-server db create -g "$RG" -s "$PG" -n "$db" -o none
  done
  PG_FQDN="$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)"

  mkdir -p temp/lhds-w0
  cat > "$ENV_OUT" <<ENV
# generated by scripts/measure/health/sandbox.sh up - non-secret names only
export LHDS_SANDBOX_SUBSCRIPTION=$SUB
export LHDS_SANDBOX_RG=$RG
export LHDS_LOCATION=$LOC
export LHDS_DELETE_BY=$LHDS_DELETE_BY
export LHDS_AKS_NAME=$AKS
export LHDS_PG_SERVER=$PG
export LHDS_PG_FQDN=$PG_FQDN
export LHDS_PG_ADMIN_USER=lhdsadmin
export LHDS_KV_NAME=$KV
export LHDS_PG_PASSWORD_SECRET=pg-admin-password
export LHDS_PG_K8S_SECRET=lhds-pg-admin
export LHDS_K8S_NAMESPACE=lhds-w0
export KUBECONFIG=temp/lhds-w0/kubeconfig
export LHDS_CMK_VAULT_URI=https://$KV.vault.azure.net/
export LHDS_CMK_KEY_NAME=$CMK
export LHDS_CMK_IDENTITY_ID=$UAMI_ID
export LHDS_PE_VNET_ID=$VNET_ID
export LHDS_PE_SUBNET_NAME=$SNET_PE
ENV
  log "wrote $ENV_OUT"
  "$0" status
  ;;

status)
  az group show -n "$RG" --query "{rg:name, location:location, tags:tags}" -o json
  az resource list -g "$RG" --query "[].{type:type, name:name}" -o table
  exists az aks show -g "$RG" -n "$AKS" && \
    az aks show -g "$RG" -n "$AKS" --query "{aks:name, power:powerState.code, k8s:kubernetesVersion, pools:agentPoolProfiles[].{n:name, count:count, vm:vmSize}}" -o json
  exists az postgres flexible-server show -g "$RG" -n "$PG" && \
    az postgres flexible-server show -g "$RG" -n "$PG" --query "{pg:name, state:state, sku:sku.name, storageGB:storage.storageSizeGb, version:version}" -o json
  az rest --method get \
    --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/lhds-w0?api-version=2023-05-01" \
    --query "{budgetUsd:properties.amount, currentSpend:properties.currentSpend}" -o json
  ;;

pause)
  log "stopping AKS and PostgreSQL (storage and disks still bill)"
  az aks stop -g "$RG" -n "$AKS" -o none
  az postgres flexible-server stop -g "$RG" -n "$PG" -o none
  "$0" status
  ;;

resume)
  log "starting PostgreSQL and AKS"
  az postgres flexible-server start -g "$RG" -n "$PG" -o none
  az aks start -g "$RG" -n "$AKS" -o none
  "$0" status
  ;;

down)
  [[ "${LHDS_DOWN_CONFIRM:-}" == "$RG" ]] || die "set LHDS_DOWN_CONFIRM=$RG to delete the sandbox"
  log "deleting resource group $RG (waits for completion)"
  az group delete -n "$RG" --yes
  # Receipt: the deletion is verified, not assumed.
  [[ "$(az group exists -n "$RG")" == "false" ]] || die "resource group $RG still exists after delete"
  log "verified: resource group $RG no longer exists (Key Vault $KV stays soft-deleted for 7 days, no charge)"
  ;;
esac
