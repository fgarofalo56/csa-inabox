#!/usr/bin/env bash
# purge-test-workspaces.sh (rel-T09c)
#
# Scripted, cross-partition purge of test / tutorial workspace debris from a
# CSA Loom tenant's Cosmos `loom` database. UAT and tutorial-capture runs create
# one throwaway workspace per app/test (names like `uat-app-supercharge-…`,
# `tut-notebook-…`, `supercharge-…`) and — for the two suites that skipped
# teardown — never delete them. Hundreds accumulate and pollute the Workspaces
# page, /browse item counts, the install workspace-picker, and Copilot answers.
#
# This is the OPERATOR-side counterpart to the in-app bulk-delete. The in-app
# delete (`/api/workspaces/bulk-delete`) is OWNER-SCOPED — it only sees the
# caller's own Cosmos partition (`workspaces` is partitioned by /tenantId, where
# tenantId == the creator's oid). UAT creates workspaces under a synthetic
# automation OID, so that debris lands in a partition the real operator's
# owner-scoped views cannot even enumerate, let alone delete. This script talks
# to the Cosmos data plane directly with AAD and sweeps CROSS-PARTITION, so it
# removes debris regardless of which owner partition it lives in.
#
# WHAT IT DELETES, per matched workspace (mirrors the in-app cascade + the
# per-workspace satellite containers the app leaves behind):
#   • workspaces            (the workspace doc,           PK /tenantId)
#   • items                 (every item in the workspace, PK /workspaceId)
#   • loom-workspaces        (admin Workspace-Catalog row, PK /tenantId — matched by name)
#   • folders, workspace-folders, workspace-permissions, workspace-roles,
#     workspace-git, task-flows, azure-connections, networking-config,
#     workspace-spark-config   (per-workspace satellites, PK /workspaceId)
#   • with --deep, also item-scoped satellites keyed by /itemId:
#     item-permissions, saved-queries, onelake-security-roles, audit-log,
#     comments, shares
#
# It does NOT touch the AI Search "loom-search" index (ws:<id> / it:<id> docs);
# those are a separate Azure Cognitive Search resource and self-heal on reindex.
# See docs/fiab/operations/clean-tenant.md for the residual note.
#
# SAFETY:
#   • DRY-RUN by default — prints every workspace it WOULD delete plus its item
#     and satellite counts, and a summary. Nothing is deleted without --apply.
#   • Refuses to run without explicit Cosmos coordinates (endpoint, or an
#     account name it can resolve to an endpoint). No hidden defaults.
#   • Name match is a single overridable regex (PURGE_PATTERN / --pattern),
#     anchored at the start of the name. The default is deliberately narrow.
#   • Per-doc logging on --apply; a per-workspace + grand-total receipt at the end.
#
# AUTH: DefaultAzureCredential — the caller (az login user, or the deploy SP)
# must hold "Cosmos DB Built-in Data Contributor" at the account scope. This is
# the SAME data-plane auth model as scripts/csa-loom/write-tenant-topology.sh.
#
# USAGE:
#   # Dry-run (default) — resolve the account from the admin RG by convention:
#   ./scripts/csa-loom/purge-test-workspaces.sh --account <cosmos-acct> [--resource-group <rg>]
#
#   # Dry-run against an explicit endpoint:
#   LOOM_COSMOS_ENDPOINT=https://<acct>.documents.azure.com:443/ \
#     ./scripts/csa-loom/purge-test-workspaces.sh
#
#   # Actually delete (add --apply). --deep also sweeps item-scoped satellites:
#   ./scripts/csa-loom/purge-test-workspaces.sh --account <acct> --apply --deep
#
#   # Broaden the match to also sweep per-suite `uat-<suite>-` debris:
#   PURGE_PATTERN='^(uat-|tut-|supercharge-)' \
#     ./scripts/csa-loom/purge-test-workspaces.sh --account <acct>
#
# ARGS / ENV:
#   --cosmos-endpoint <url>   Cosmos endpoint (or LOOM_COSMOS_ENDPOINT).
#   --account <name>          Cosmos DB account name; endpoint resolved via az.
#   --resource-group <rg>     RG for --account (or ADMIN_RG; auto-discovered if unset).
#   --subscription <sub>      Subscription for the az lookups (optional).
#   --database <id>           Cosmos database id (default 'loom' / LOOM_COSMOS_DATABASE).
#   --pattern <regex>         Name match (default '^(uat-app-|tut-|supercharge-)' / PURGE_PATTERN).
#   --apply                   Perform the deletes (default is dry-run).
#   --deep                    Also sweep item-scoped satellites (item-permissions, …).
#   --yes                     Skip the interactive confirmation on --apply.
set -euo pipefail

COSMOS_ENDPOINT="${LOOM_COSMOS_ENDPOINT:-}"
ACCOUNT=""
RESOURCE_GROUP="${ADMIN_RG:-}"
SUBSCRIPTION=""
DATABASE="${LOOM_COSMOS_DATABASE:-loom}"
PATTERN="${PURGE_PATTERN:-^(uat-app-|tut-|supercharge-)}"
APPLY="false"
DEEP="false"
ASSUME_YES="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cosmos-endpoint) COSMOS_ENDPOINT="$2"; shift 2;;
    --account) ACCOUNT="$2"; shift 2;;
    --resource-group|-g) RESOURCE_GROUP="$2"; shift 2;;
    --subscription) SUBSCRIPTION="$2"; shift 2;;
    --database) DATABASE="$2"; shift 2;;
    --pattern) PATTERN="$2"; shift 2;;
    --apply) APPLY="true"; shift;;
    --deep) DEEP="true"; shift;;
    --yes|-y) ASSUME_YES="true"; shift;;
    -h|--help) sed -n '2,66p' "$0"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

SUB_ARGS=()
[[ -n "$SUBSCRIPTION" ]] && SUB_ARGS=(--subscription "$SUBSCRIPTION")

# ---------------------------------------------------------------------------
# COORDINATE RESOLUTION
# Endpoint wins if provided. Otherwise resolve it from the account name (and,
# if needed, discover the RG that holds the account). Refuse if neither the
# endpoint nor a resolvable account is available — no silent default.
# ---------------------------------------------------------------------------
if [[ -z "$COSMOS_ENDPOINT" ]]; then
  if [[ -z "$ACCOUNT" ]]; then
    echo "ERROR: provide --cosmos-endpoint (or LOOM_COSMOS_ENDPOINT), or --account <cosmos-acct>." >&2
    echo "       Refusing to run without explicit Cosmos coordinates." >&2
    exit 2
  fi
  if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "-> Resolving resource group for Cosmos account '$ACCOUNT'…"
    RESOURCE_GROUP=$(az cosmosdb list "${SUB_ARGS[@]}" \
      --query "[?name=='$ACCOUNT'].resourceGroup | [0]" -o tsv 2>/dev/null || true)
  fi
  if [[ -z "$RESOURCE_GROUP" ]]; then
    echo "ERROR: could not resolve the resource group for account '$ACCOUNT'." >&2
    echo "       Pass --resource-group <rg> (or set ADMIN_RG)." >&2
    exit 2
  fi
  echo "-> Resolving Cosmos endpoint for account '$ACCOUNT' in RG '$RESOURCE_GROUP'…"
  COSMOS_ENDPOINT=$(az cosmosdb show -n "$ACCOUNT" -g "$RESOURCE_GROUP" "${SUB_ARGS[@]}" \
    --query documentEndpoint -o tsv 2>/dev/null || true)
  if [[ -z "$COSMOS_ENDPOINT" ]]; then
    echo "ERROR: az cosmosdb show could not return an endpoint for '$ACCOUNT'." >&2
    exit 2
  fi
  echo "   Endpoint: $COSMOS_ENDPOINT"
fi

echo "─────────────────────────────────────────────────────────────────────"
echo " CSA Loom — purge test/tutorial workspace debris"
echo "   Endpoint : $COSMOS_ENDPOINT"
echo "   Database : $DATABASE"
echo "   Pattern  : $PATTERN"
echo "   Mode     : $([[ "$APPLY" == "true" ]] && echo 'APPLY (deletes)' || echo 'DRY-RUN (no deletes)')$([[ "$DEEP" == "true" ]] && echo ' + deep')"
echo "─────────────────────────────────────────────────────────────────────"

if [[ "$APPLY" == "true" && "$ASSUME_YES" != "true" ]]; then
  read -r -p "About to DELETE every workspace matching '$PATTERN' and its items. Type 'purge' to continue: " reply
  if [[ "$reply" != "purge" ]]; then echo "Aborted."; exit 1; fi
fi

export COSMOS_ENDPOINT DATABASE PATTERN APPLY DEEP
python3 - <<'PY'
import os, re, sys

try:
    from azure.cosmos import CosmosClient
    from azure.cosmos import exceptions as cx
    from azure.identity import DefaultAzureCredential
except ImportError:
    sys.stderr.write(
        "ERROR: azure-cosmos + azure-identity are required.\n"
        "       pip install azure-cosmos azure-identity\n"
    )
    sys.exit(3)

ENDPOINT = os.environ["COSMOS_ENDPOINT"]
DATABASE = os.environ["DATABASE"]
PATTERN  = os.environ["PATTERN"]
APPLY    = os.environ["APPLY"] == "true"
DEEP     = os.environ["DEEP"] == "true"

try:
    rx = re.compile(PATTERN)
except re.error as e:
    sys.stderr.write(f"ERROR: invalid --pattern regex: {e}\n")
    sys.exit(2)

# Per-workspace satellite containers, all partitioned by /workspaceId. Each is
# best-effort: a container that doesn't exist in this account, or has no rows
# for a given workspace, is silently skipped.
WS_SATELLITES = [
    "folders", "workspace-folders", "workspace-permissions", "workspace-roles",
    "workspace-git", "task-flows", "azure-connections", "networking-config",
    "workspace-spark-config",
]
# Item-scoped satellites (PK /itemId), only swept with --deep.
ITEM_SATELLITES = [
    "item-permissions", "saved-queries", "onelake-security-roles",
    "audit-log", "comments", "shares",
]

client = CosmosClient(ENDPOINT, credential=DefaultAzureCredential())
db = client.get_database_client(DATABASE)

def container(cid):
    return db.get_container_client(cid)

def query(cid, sql, params=None, cross=True):
    """Query a container; returns [] if the container is absent."""
    try:
        return list(container(cid).query_items(
            query=sql,
            parameters=params or [],
            enable_cross_partition_query=cross,
        ))
    except cx.CosmosResourceNotFoundError:
        return []
    except cx.CosmosHttpResponseError as e:
        # A missing container surfaces as 404; anything else is a real error.
        if getattr(e, "status_code", None) == 404:
            return []
        raise

def delete_doc(cid, doc_id, pk):
    try:
        container(cid).delete_item(item=doc_id, partition_key=pk)
        return True, None
    except cx.CosmosResourceNotFoundError:
        return False, "not_found"
    except cx.CosmosHttpResponseError as e:
        return False, f"http_{getattr(e, 'status_code', '?')}"

# 1) All workspaces, cross-partition. `workspaces` PK is /tenantId, so this scan
#    spans every owner partition — the whole point of the operator-side purge.
all_ws = query(
    "workspaces",
    "SELECT c.id, c.tenantId, c.name, c.createdBy FROM c",
)
matched = [w for w in all_ws if isinstance(w.get("name"), str) and rx.search(w["name"])]
matched.sort(key=lambda w: w.get("name", ""))

print(f"Workspaces total (all partitions): {len(all_ws)}")
print(f"Matching '{PATTERN}': {len(matched)}\n")

if not matched:
    print("Nothing to purge. Done.")
    sys.exit(0)

grand = {"workspaces": 0, "items": 0, "loom-workspaces": 0, "satellites": 0, "item-satellites": 0, "failed": 0}

for w in matched:
    ws_id = w["id"]
    ws_tenant = w.get("tenantId")
    ws_name = w.get("name", "")

    # Items in this workspace — single-partition query (items PK == /workspaceId).
    items = query(
        "items",
        "SELECT c.id FROM c WHERE c.workspaceId = @w",
        params=[{"name": "@w", "value": ws_id}],
        cross=False,
    )
    item_ids = [it["id"] for it in items]

    # Satellite counts for the dry-run report.
    sat_counts = {}
    for cid in WS_SATELLITES:
        rows = query(
            cid,
            "SELECT c.id FROM c WHERE c.workspaceId = @w",
            params=[{"name": "@w", "value": ws_id}],
            cross=False,
        )
        if rows:
            sat_counts[cid] = [r["id"] for r in rows]

    # loom-workspaces admin-catalog rows that share this name (PK /tenantId).
    admin_rows = query(
        "loom-workspaces",
        "SELECT c.id, c.tenantId FROM c WHERE c.name = @n OR c.id = @i",
        params=[{"name": "@n", "value": ws_name}, {"name": "@i", "value": ws_id}],
    )

    sat_total = sum(len(v) for v in sat_counts.values())
    tag = "DELETE" if APPLY else "would delete"
    print(f"[{tag}] {ws_name}  (id={ws_id}, tenant={ws_tenant})")
    print(f"         items={len(item_ids)} satellites={sat_total} admin-rows={len(admin_rows)}", end="")

    if not APPLY:
        # Dry-run: also count deep item-satellites so the report is honest.
        if DEEP and item_ids:
            deep_total = 0
            for cid in ITEM_SATELLITES:
                # Chunk the IN() list to keep each query small.
                for i in range(0, len(item_ids), 100):
                    chunk = item_ids[i:i+100]
                    ph = ",".join(f"@i{j}" for j in range(len(chunk)))
                    rows = query(
                        cid,
                        f"SELECT c.id FROM c WHERE c.itemId IN ({ph})",
                        params=[{"name": f"@i{j}", "value": v} for j, v in enumerate(chunk)],
                    )
                    deep_total += len(rows)
            print(f" deep-item-satellites={deep_total}", end="")
        print()
        continue

    print()  # newline before per-doc log

    # --- APPLY: delete items first, then satellites, then admin rows, then ws ---
    for iid in item_ids:
        ok, why = delete_doc("items", iid, ws_id)
        grand["items" if ok else "failed"] += 1
        if not ok:
            print(f"           ! item {iid}: {why}")

    for cid, ids in sat_counts.items():
        for did in ids:
            ok, why = delete_doc(cid, did, ws_id)
            grand["satellites" if ok else "failed"] += 1
            if not ok:
                print(f"           ! {cid} {did}: {why}")

    if DEEP and item_ids:
        idset = set(item_ids)
        for cid in ITEM_SATELLITES:
            for i in range(0, len(item_ids), 100):
                chunk = item_ids[i:i+100]
                ph = ",".join(f"@i{j}" for j in range(len(chunk)))
                rows = query(
                    cid,
                    f"SELECT c.id, c.itemId FROM c WHERE c.itemId IN ({ph})",
                    params=[{"name": f"@i{j}", "value": v} for j, v in enumerate(chunk)],
                )
                for r in rows:
                    ok, why = delete_doc(cid, r["id"], r["itemId"])
                    grand["item-satellites" if ok else "failed"] += 1
                    if not ok:
                        print(f"           ! {cid} {r['id']}: {why}")

    for r in admin_rows:
        ok, why = delete_doc("loom-workspaces", r["id"], r.get("tenantId"))
        grand["loom-workspaces" if ok else "failed"] += 1
        if not ok:
            print(f"           ! loom-workspaces {r['id']}: {why}")

    ok, why = delete_doc("workspaces", ws_id, ws_tenant)
    grand["workspaces" if ok else "failed"] += 1
    if not ok:
        print(f"           ! workspace {ws_id}: {why}")

# ---- Receipt ----
print("\n─────────────────────────────────────────────────────────────────────")
if APPLY:
    print("PURGE RECEIPT")
    print(f"  workspaces deleted      : {grand['workspaces']}")
    print(f"  items deleted           : {grand['items']}")
    print(f"  admin-catalog rows      : {grand['loom-workspaces']}")
    print(f"  workspace satellites    : {grand['satellites']}")
    if DEEP:
        print(f"  item satellites (deep)  : {grand['item-satellites']}")
    print(f"  failed deletes          : {grand['failed']}")
    if grand["failed"]:
        sys.exit(4)
else:
    print(f"DRY-RUN complete — {len(matched)} workspace(s) matched. Re-run with --apply to delete.")
PY

echo "Done."
