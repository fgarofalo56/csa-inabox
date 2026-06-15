#!/usr/bin/env bash
# CSA Loom — ensure a per-domain Azure Data Explorer (ADX/Kusto) database exists
# on the shared hub cluster, idempotently, for dlz-attach / tenant topologies.
#
# WHY (deploy-readiness G4)
#   For single-sub deployments the DLZ bicep (modules/landing-zone/adx.bicep)
#   creates `loomdb-<domain>` at deploy time. For the dlz-attach + tenant
#   topologies the per-domain database is NOT created by bicep (a cross-
#   subscription nested ARM deployment can't carry the required `location` for a
#   Kusto database — see modules/admin-plane/adx-cluster.bicep). The KQL editors
#   then fall back to LOOM_KUSTO_DEFAULT_DB=loomdb-default, which may not exist on
#   the hub cluster in those topologies → an honest gate on first use. This script
#   creates the database at RUNTIME (the documented path) so the Eventhouse / KQL
#   Database / KQL Queryset / KQL Dashboard editors work first-try.
#
# WHAT IT DOES (idempotent — safe to re-run)
#   1. `az kusto database create` for loomdb-<domain> on the hub cluster
#      (soft-delete 365d, hot-cache 31d — Dev-SKU friendly defaults).
#   2. Admin-group principal assignment (AllDatabasesAdmin equivalent at db scope)
#      so domain admins can manage the database.
#   3. Activator UAMI principal assignment (Viewer) so Activator rules can read.
#   The Console UAMI already holds cluster-level AllDatabasesAdmin (granted in
#   adx-cluster.bicep), so no per-db Console grant is needed here.
#
# REQUIRES: az CLI logged in with rights on the hub cluster's subscription +
#           the Kusto extension (auto-installed on first `az kusto` call).
#
# USAGE
#   CLUSTER=adx-csa-loom-ab12cd CLUSTER_RG=rg-csa-loom-admin-eastus \
#     DOMAIN=finance ADMIN_GROUP_OID=<entra-group-oid> \
#     [ACTIVATOR_PRINCIPAL=<uami-principal-id>] [LOCATION=eastus] \
#     bash scripts/csa-loom/ensure-domain-adx-db.sh
#
#   # or drive from the deployed Console env (single source of truth):
#   CLUSTER=$LOOM_KUSTO_CLUSTER_NAME CLUSTER_RG=$LOOM_KUSTO_RG \
#     DOMAIN=$LOOM_DOMAIN ADMIN_GROUP_OID=$LOOM_ADMIN_ENTRA_GROUP \
#     bash scripts/csa-loom/ensure-domain-adx-db.sh
set -uo pipefail

CLUSTER="${CLUSTER:-${LOOM_KUSTO_CLUSTER_NAME:-}}"
CLUSTER_RG="${CLUSTER_RG:-${LOOM_KUSTO_RG:-}}"
CLUSTER_SUB="${CLUSTER_SUB:-${LOOM_KUSTO_SUB:-}}"
DOMAIN="${DOMAIN:-default}"
LOCATION="${LOCATION:-${LOOM_KUSTO_LOCATION:-${LOOM_LOCATION:-}}}"
ADMIN_GROUP_OID="${ADMIN_GROUP_OID:-${LOOM_ADMIN_ENTRA_GROUP:-}}"
ACTIVATOR_PRINCIPAL="${ACTIVATOR_PRINCIPAL:-}"
HOT_CACHE_DAYS="${HOT_CACHE_DAYS:-31}"
SOFT_DELETE_DAYS="${SOFT_DELETE_DAYS:-365}"

DB="loomdb-${DOMAIN}"

if [[ -z "$CLUSTER" || -z "$CLUSTER_RG" ]]; then
  echo "ERROR: set CLUSTER (hub Kusto cluster name) and CLUSTER_RG (its resource group)." >&2
  echo "       Source them from the Console env: LOOM_KUSTO_CLUSTER_NAME / LOOM_KUSTO_RG." >&2
  exit 2
fi

SUB_ARGS=()
[[ -n "$CLUSTER_SUB" ]] && SUB_ARGS=(--subscription "$CLUSTER_SUB")

echo "== ensure-domain-adx-db: db=$DB cluster=$CLUSTER rg=$CLUSTER_RG ${CLUSTER_SUB:+sub=$CLUSTER_SUB} =="

# Resolve the cluster location if not supplied (a Kusto database MUST be created
# in the cluster's region).
if [[ -z "$LOCATION" ]]; then
  LOCATION="$(az kusto cluster show -n "$CLUSTER" -g "$CLUSTER_RG" "${SUB_ARGS[@]}" --query location -o tsv 2>/dev/null || true)"
fi
[[ -z "$LOCATION" ]] && { echo "ERROR: could not resolve cluster location; set LOCATION=<region>." >&2; exit 2; }

# 1) Create the database if missing (idempotent: create is a PUT; re-running with
#    the same retention is a no-op).
if az kusto database show --cluster-name "$CLUSTER" -g "$CLUSTER_RG" -n "$DB" "${SUB_ARGS[@]}" -o none 2>/dev/null; then
  echo "  ✓ database $DB already exists — leaving as-is."
else
  echo "  + creating database $DB (softDelete=${SOFT_DELETE_DAYS}d hotCache=${HOT_CACHE_DAYS}d) in $LOCATION ..."
  az kusto database create \
    --cluster-name "$CLUSTER" -g "$CLUSTER_RG" -n "$DB" "${SUB_ARGS[@]}" \
    --read-write-database "location=$LOCATION softDeletePeriod=P${SOFT_DELETE_DAYS}D hotCachePeriod=P${HOT_CACHE_DAYS}D" \
    -o none && echo "  ✓ created $DB" || { echo "  ✗ failed to create $DB" >&2; exit 1; }
fi

# 2) Admin-group principal assignment (database-scoped Admin).
if [[ -n "$ADMIN_GROUP_OID" ]]; then
  echo "  + granting Admin on $DB to admin group $ADMIN_GROUP_OID ..."
  az kusto database-principal-assignment create \
    --cluster-name "$CLUSTER" -g "$CLUSTER_RG" --database-name "$DB" "${SUB_ARGS[@]}" \
    --principal-assignment-name "admin-${DOMAIN}" \
    --principal-id "$ADMIN_GROUP_OID" --principal-type Group --role Admin \
    -o none 2>/dev/null && echo "  ✓ admin-group Admin set" \
    || echo "  · admin-group assignment already present (or insufficient rights) — skipped"
else
  echo "  · ADMIN_GROUP_OID unset — skipping admin-group grant (set LOOM_ADMIN_ENTRA_GROUP)."
fi

# 3) Activator UAMI principal assignment (Viewer) for read-only rule evaluation.
if [[ -n "$ACTIVATOR_PRINCIPAL" ]]; then
  echo "  + granting Viewer on $DB to activator $ACTIVATOR_PRINCIPAL ..."
  az kusto database-principal-assignment create \
    --cluster-name "$CLUSTER" -g "$CLUSTER_RG" --database-name "$DB" "${SUB_ARGS[@]}" \
    --principal-assignment-name "activator-${DOMAIN}" \
    --principal-id "$ACTIVATOR_PRINCIPAL" --principal-type App --role Viewer \
    -o none 2>/dev/null && echo "  ✓ activator Viewer set" \
    || echo "  · activator assignment already present (or insufficient rights) — skipped"
fi

echo "== done. Set the attached-domain Console LOOM_KUSTO_DEFAULT_DB=$DB =="
echo "   (scripts/csa-loom/patch-navigator-env.sh can write it without a redeploy)."
