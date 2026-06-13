#!/usr/bin/env bash
# CSA Loom — orphan sweep (audit-t162)
# =====================================================================
# Cleans up the subscription-scope + cross-service artifacts that
# `az group delete` / fiab-teardown.sh do NOT remove when the old
# single-sub deployment is retired after the multi-sub migration
# (docs/fiab/topology-migration.md §6.3).
#
# What RG deletion leaves behind (and this sweeps):
#   1. Cosmos safety export (FIRST, best-effort, non-fatal) — raw dump of the
#      old `loom` control-plane DB to DMLZ storage before anything is deleted.
#   2. Subscription-scope role assignments — the Setup Orchestrator granted
#      Contributor (b24988ac-…) on each spoke sub via setup-orchestrator-rbac.
#      Per Microsoft Learn (role-based-access-control/troubleshooting), deleting
#      the principal leaves the assignment with an empty principalName /
#      "Unknown" type; it is NOT auto-removed and still grants access.
#   3. Orphan DNS records — the vanity CNAME + the _dnsauth.<sub> TXT challenge.
#   4. Orphan Front Door custom-domain + endpoint on the OLD profile.
#   5. Orphan Entra app artifacts — the MSAL app registration + the SCC-labels
#      app registration and its auth cert.
#
# SAFETY MODEL (mirrors apps/copilot test_orphan_cleanup.py contract):
#   - DRY-RUN BY DEFAULT. Nothing is deleted unless APPLY=1.
#   - Each class is independently gated by its env inputs; leave a class's env
#     vars unset to SKIP that class entirely (disabled flag => skip).
#   - Idempotent: re-running after a partial run is safe.
#
# Usage:
#   # Dry-run (default) — lists what WOULD happen, deletes nothing:
#   SUBS=<old-sub>,<dmlz-sub> bash .github/scripts/fiab-orphan-sweep.sh
#
#   # Execute:
#   APPLY=1 SUBS=<old-sub>,<dmlz-sub> \
#     VANITY_DOMAIN=csa-loom.agency.gov DNS_ZONE_RG=<rg> DNS_ZONE=<zone> \
#     OLD_AFD_RG=<rg> OLD_AFD_PROFILE=<profile> \
#     MSAL_APP_ID=<appId> SCC_APP_ID=<appId> \
#     COSMOS_EXPORT=1 COSMOS_SUB=<old-sub> COSMOS_RG=<dlz-rg> \
#       COSMOS_ACCOUNT=<acct> EXPORT_STORAGE_ACCOUNT=<dmlz-sa> EXPORT_CONTAINER=cosmos-export \
#     bash .github/scripts/fiab-orphan-sweep.sh
#
# NOTE: For Azure Government add CLOUD=AzureUSGovernment (the script passes it
# to `az cloud set` and flips the Cosmos suffix).

set -uo pipefail   # NOT -e: this is a best-effort sweep; one failed class must
                   # not abort the rest. Each step guards its own errors.

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
APPLY="${APPLY:-0}"                       # 0 = dry-run (default), 1 = execute
SUBS="${SUBS:-}"                          # comma-separated subs to scan for role-assignment orphans
CLOUD="${CLOUD:-}"                        # e.g. AzureUSGovernment (Gov)
CONTRIBUTOR_ROLE_ID="b24988ac-6180-42a0-ab88-20f7382dd24c"

VANITY_DOMAIN="${VANITY_DOMAIN:-}"
DNS_ZONE_RG="${DNS_ZONE_RG:-}"
DNS_ZONE="${DNS_ZONE:-}"
DNS_ZONE_SUB="${DNS_ZONE_SUB:-}"

OLD_AFD_RG="${OLD_AFD_RG:-}"
OLD_AFD_PROFILE="${OLD_AFD_PROFILE:-}"
OLD_AFD_SUB="${OLD_AFD_SUB:-}"

MSAL_APP_ID="${MSAL_APP_ID:-}"
SCC_APP_ID="${SCC_APP_ID:-}"

# Cosmos best-effort export
COSMOS_EXPORT="${COSMOS_EXPORT:-0}"
COSMOS_SUB="${COSMOS_SUB:-}"
COSMOS_RG="${COSMOS_RG:-}"
COSMOS_ACCOUNT="${COSMOS_ACCOUNT:-}"
COSMOS_DATABASE="${COSMOS_DATABASE:-loom}"
EXPORT_STORAGE_ACCOUNT="${EXPORT_STORAGE_ACCOUNT:-}"
EXPORT_CONTAINER="${EXPORT_CONTAINER:-cosmos-export}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
note()  { echo "::notice::$*"      2>/dev/null || echo "NOTE: $*"; }
warn()  { echo "::warning::$*"     2>/dev/null || echo "WARN: $*"; }
group() { echo "::group::$*"       2>/dev/null || echo "== $* =="; }
endg()  { echo "::endgroup::"      2>/dev/null || true; }

# would <human description> -- in dry-run prints the intent; in apply mode runs $@
would() {
  local desc="$1"; shift
  if [[ "$APPLY" == "1" ]]; then
    echo "  DELETE: $desc"
    "$@" 2>/dev/null && echo "    ok" || warn "    failed (continuing): $desc"
  else
    echo "  WOULD DELETE: $desc"
  fi
}

if [[ -n "$CLOUD" ]]; then
  az cloud set --name "$CLOUD" >/dev/null 2>&1 || warn "az cloud set $CLOUD failed"
fi

echo "============================================================"
echo " CSA Loom orphan sweep   (mode: $([[ "$APPLY" == "1" ]] && echo APPLY || echo DRY-RUN))"
echo "============================================================"

# ===========================================================================
# 0. Cosmos safety export (FIRST — best-effort, NEVER fatal)
# ===========================================================================
if [[ "$COSMOS_EXPORT" == "1" ]]; then
  group "0. Cosmos safety export → DMLZ storage (best-effort)"
  if [[ -z "$COSMOS_SUB" || -z "$COSMOS_RG" || -z "$COSMOS_ACCOUNT" || -z "$EXPORT_STORAGE_ACCOUNT" ]]; then
    warn "COSMOS_EXPORT=1 but COSMOS_SUB/COSMOS_RG/COSMOS_ACCOUNT/EXPORT_STORAGE_ACCOUNT not all set — skipping export"
  else
    EXPORT_DIR="$(mktemp -d)"
    SWEEP_OID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || az account show --query user.name -o tsv 2>/dev/null || true)"
    # The account sets disableLocalAuth=true → data-plane is AAD-RBAC only. Grant
    # the sweep principal Cosmos DB Built-in Data Reader (00000000-…-0001).
    if [[ -n "$SWEEP_OID" ]]; then
      note "Granting Cosmos DB Built-in Data Reader to sweep principal $SWEEP_OID"
      az cosmosdb sql role assignment create \
        --subscription "$COSMOS_SUB" -g "$COSMOS_RG" -a "$COSMOS_ACCOUNT" \
        --role-definition-id "00000000-0000-0000-0000-000000000001" \
        --principal-id "$SWEEP_OID" \
        --scope "/" >/dev/null 2>&1 || warn "data-reader grant failed (may already exist / insufficient rights)"
    fi
    EP="$(az cosmosdb show --subscription "$COSMOS_SUB" -g "$COSMOS_RG" -n "$COSMOS_ACCOUNT" --query documentEndpoint -o tsv 2>/dev/null || true)"
    # Enumerate containers via the control plane (always available with ARM rights).
    CONTAINERS="$(az cosmosdb sql container list \
        --subscription "$COSMOS_SUB" -g "$COSMOS_RG" -a "$COSMOS_ACCOUNT" \
        -d "$COSMOS_DATABASE" --query "[].name" -o tsv 2>/dev/null || true)"
    if [[ -z "$CONTAINERS" ]]; then
      warn "No containers enumerated for database '$COSMOS_DATABASE' — nothing to export"
    elif python -c "import azure.cosmos" >/dev/null 2>&1; then
      # Real data-plane export via the azure-cosmos SDK + AAD (DefaultAzureCredential).
      for c in $CONTAINERS; do
        note "Exporting container '$c' (SELECT * FROM c) → $EXPORT_DIR/$c.json"
        COSMOS_EP="$EP" COSMOS_DB="$COSMOS_DATABASE" COSMOS_CONTAINER="$c" OUT="$EXPORT_DIR/$c.json" \
        python - <<'PY' 2>/dev/null || warn "export of container failed (continuing)"
import json, os
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential
cli = CosmosClient(os.environ["COSMOS_EP"], credential=DefaultAzureCredential())
cont = cli.get_database_client(os.environ["COSMOS_DB"]).get_container_client(os.environ["COSMOS_CONTAINER"])
items = list(cont.query_items("SELECT * FROM c", enable_cross_partition_query=True))
json.dump(items, open(os.environ["OUT"], "w"), default=str)
print(f"  {len(items)} items")
PY
      done
      if [[ "$APPLY" == "1" ]]; then
        STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
        note "Uploading export bundle → $EXPORT_STORAGE_ACCOUNT/$EXPORT_CONTAINER/cosmos-$COSMOS_ACCOUNT-$STAMP/"
        az storage container create --account-name "$EXPORT_STORAGE_ACCOUNT" --name "$EXPORT_CONTAINER" --auth-mode login >/dev/null 2>&1 || true
        az storage blob upload-batch --account-name "$EXPORT_STORAGE_ACCOUNT" \
          --destination "$EXPORT_CONTAINER/cosmos-$COSMOS_ACCOUNT-$STAMP" \
          --source "$EXPORT_DIR" --auth-mode login --overwrite >/dev/null 2>&1 \
          && note "export uploaded" || warn "blob upload failed (export retained locally at $EXPORT_DIR)"
      else
        note "DRY-RUN: would upload $EXPORT_DIR → $EXPORT_STORAGE_ACCOUNT/$EXPORT_CONTAINER/"
      fi
    else
      # Honest fallback (no SDK present) — emit the grounded data-migration-tool command.
      warn "python azure-cosmos SDK not available — cannot run an inline data-plane export."
      warn "Run the Cosmos DB Data Migration Tool (github.com/azurecosmosdb/data-migration-desktop-tool)"
      warn "with a Cosmos source (endpoint=$EP db=$COSMOS_DATABASE, AAD auth) → JSON sink, then upload to"
      warn "$EXPORT_STORAGE_ACCOUNT/$EXPORT_CONTAINER. Containers: $(echo $CONTAINERS | tr '\n' ' ')"
    fi
  fi
  endg
else
  note "Cosmos export skipped (set COSMOS_EXPORT=1 to enable)"
fi

# ===========================================================================
# 1. Subscription-scope orphan role assignments (empty principalName)
# ===========================================================================
if [[ -n "$SUBS" ]]; then
  group "1. Orphan role assignments (deleted principals still granting access)"
  IFS=',' read -ra SUB_ARR <<< "$SUBS"
  for sub in "${SUB_ARR[@]}"; do
    echo " sub: $sub"
    # Orphans surface as assignments whose principalName is empty (the directory
    # object is gone). --all walks sub + nested scopes.
    ORPHANS="$(az role assignment list --all --subscription "$sub" \
      --query "[?principalName=='' || principalName==null].{id:id, role:roleDefinitionName, scope:scope}" \
      -o json 2>/dev/null || echo '[]')"
    COUNT="$(echo "$ORPHANS" | python -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)"
    echo "   found $COUNT orphan assignment(s)"
    echo "$ORPHANS" | python -c "import json,sys; [print(a['id']) for a in json.load(sys.stdin)]" 2>/dev/null | while read -r aid; do
      [[ -z "$aid" ]] && continue
      would "role assignment $aid" az role assignment delete --ids "$aid"
    done
  done
  endg
else
  note "Role-assignment sweep skipped (set SUBS=<csv> to enable)"
fi

# ===========================================================================
# 2. Orphan DNS records (vanity CNAME + _dnsauth TXT)
# ===========================================================================
if [[ -n "$VANITY_DOMAIN" && -n "$DNS_ZONE_RG" && -n "$DNS_ZONE" ]]; then
  group "2. Orphan DNS records for $VANITY_DOMAIN"
  SUBARG=(); [[ -n "$DNS_ZONE_SUB" ]] && SUBARG=(--subscription "$DNS_ZONE_SUB")
  # The vanity record name relative to the zone (strip the zone suffix).
  REC="${VANITY_DOMAIN%.$DNS_ZONE}"
  [[ "$REC" == "$VANITY_DOMAIN" ]] && REC="@"
  would "CNAME record '$REC' in $DNS_ZONE" \
    az network dns record-set cname delete -y "${SUBARG[@]}" -g "$DNS_ZONE_RG" -z "$DNS_ZONE" -n "$REC"
  would "TXT record '_dnsauth.$REC' in $DNS_ZONE" \
    az network dns record-set txt delete -y "${SUBARG[@]}" -g "$DNS_ZONE_RG" -z "$DNS_ZONE" -n "_dnsauth.$REC"
  endg
else
  note "DNS sweep skipped (set VANITY_DOMAIN + DNS_ZONE_RG + DNS_ZONE to enable)"
fi

# ===========================================================================
# 3. Orphan Front Door custom-domain + endpoint on the OLD profile
# ===========================================================================
if [[ -n "$OLD_AFD_RG" && -n "$OLD_AFD_PROFILE" ]]; then
  group "3. Orphan Front Door custom-domains/endpoints on $OLD_AFD_PROFILE"
  SUBARG=(); [[ -n "$OLD_AFD_SUB" ]] && SUBARG=(--subscription "$OLD_AFD_SUB")
  CDS="$(az afd custom-domain list "${SUBARG[@]}" -g "$OLD_AFD_RG" --profile-name "$OLD_AFD_PROFILE" \
        --query "[].name" -o tsv 2>/dev/null || true)"
  for cd in $CDS; do
    would "AFD custom-domain '$cd'" \
      az afd custom-domain delete -y "${SUBARG[@]}" -g "$OLD_AFD_RG" --profile-name "$OLD_AFD_PROFILE" --custom-domain-name "$cd"
  done
  EPS="$(az afd endpoint list "${SUBARG[@]}" -g "$OLD_AFD_RG" --profile-name "$OLD_AFD_PROFILE" \
        --query "[].name" -o tsv 2>/dev/null || true)"
  for ep in $EPS; do
    would "AFD endpoint '$ep'" \
      az afd endpoint delete -y "${SUBARG[@]}" -g "$OLD_AFD_RG" --profile-name "$OLD_AFD_PROFILE" --endpoint-name "$ep"
  done
  endg
else
  note "Front Door sweep skipped (set OLD_AFD_RG + OLD_AFD_PROFILE to enable)"
fi

# ===========================================================================
# 4. Orphan Entra app artifacts (MSAL app reg + SCC-labels app)
# ===========================================================================
if [[ -n "$MSAL_APP_ID" || -n "$SCC_APP_ID" ]]; then
  group "4. Orphan Entra app registrations"
  for appid in "$MSAL_APP_ID" "$SCC_APP_ID"; do
    [[ -z "$appid" ]] && continue
    DN="$(az ad app show --id "$appid" --query displayName -o tsv 2>/dev/null || true)"
    if [[ -n "$DN" ]]; then
      would "Entra app registration '$DN' ($appid) + its credentials/SP" \
        az ad app delete --id "$appid"
    else
      note "app $appid not found (already gone) — skipping"
    fi
  done
  endg
else
  note "Entra app sweep skipped (set MSAL_APP_ID and/or SCC_APP_ID to enable)"
fi

echo "============================================================"
if [[ "$APPLY" == "1" ]]; then
  note "Orphan sweep complete (APPLY mode)."
else
  note "Dry-run complete. Re-run with APPLY=1 to execute the deletions above."
fi
echo "============================================================"
exit 0
