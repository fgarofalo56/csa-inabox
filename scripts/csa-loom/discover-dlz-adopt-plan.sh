#!/usr/bin/env bash
# discover-dlz-adopt-plan.sh — turn a resolved DLZ into an ADOPT plan.
#
# WHY (auto-bind-by-default.md §5, deploy-integrity.md R5)
# --------------------------------------------------------
# `main.bicep` used to derive the lake account name from the single-sub
# convention alone:
#
#     loomStorageAccount: useSingleDlz ? take('saloomdefault…',24) : ''
#
# On a MULTI-SUB / dlz-attach estate `useSingleDlz` is false, so it passed ''.
# Measured on Commercial 2026-08-10: the lake `saloomdefaulttr4nm4dcgsq` was
# fully deployed in the DLZ subscription — next to Databricks, Event Hubs,
# Synapse and the Weave Postgres — while LOOM_ADLS_ACCOUNT rendered EMPTY, so
# svc-adls, medallion Silver/Gold, sample-data, RTI-export, CSV-imports and the
# S3 gateway were all hard-blocked on an estate that owned every resource they
# needed. The documented workaround was `patch-navigator-env.sh` AFTER the
# deploy — a manual step the NEXT deploy then reverted, because a bicep deploy
# re-renders the container app's env array and drops anything not in the
# template. That is the same mechanism that blanked the bootstrap admin OID.
#
# This script closes it at the source: DISCOVER what the estate already owns and
# emit it as an `adopt` plan, so the deploy BINDS to it. Adopt, never duplicate.
#
# WHAT IT DOES NOT DO
#   - It never CREATES anything and never grants anything.
#   - It never invents a name. A service it cannot find is simply absent from the
#     plan, and `adoptMode()` then defaults that key to 'create' exactly as before
#     — so a greenfield estate is completely unaffected by this script existing.
#   - It does not decide whether grants may run. main.bicep derives
#     `loomStorageAccountSameSub` from the plan's `sub`, and the grant modules
#     gate on that: binding is safe cross-subscription, RBAC is not.
#
# OUTPUT: one line of compact JSON on stdout, suitable for LOOM_ADOPT_JSON.
# Emits `{}` — never a partial or malformed document — when nothing is found.
#
# Usage:
#   discover-dlz-adopt-plan.sh --dlz-subscription <id> --dlz-rg <name> \
#                              [--admin-subscription <id>] [--admin-rg <name>]
#
# The admin coordinates are OPTIONAL and are used only as a FALLBACK for the two
# deploy-planner services that can legitimately sit outside the landing zone —
# see the `#4665` block near the bottom. Supplying them never changes a lookup
# the DLZ already answered. They are all-or-nothing: supplying exactly one of
# the two exits 2 (see the guard below the argument loop).
#
# EXTRAS. Two adopted services carry more than a name, as `extra` fields that
# main.bicep reads with adoptExtra():
#   eventhubs.extra.schemaGroup      → LOOM_EH_SCHEMA_GROUP
#   databricks.extra.hostname        → LOOM_DATABRICKS_HOSTNAME (pre-existing)
#   databricks.extra.sqlWarehouseId  → LOOM_DATABRICKS_SQL_WAREHOUSE_ID
# Each is omitted — never guessed — when it cannot be established, and the
# stderr line says WHICH of "absent" or "could not read" it was.
set -euo pipefail

DLZ_SUB=""; DLZ_RG=""; ADMIN_SUB=""; ADMIN_RG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dlz-subscription) DLZ_SUB="${2:-}"; shift 2 ;;
    --dlz-rg)           DLZ_RG="${2:-}"; shift 2 ;;
    --admin-subscription) ADMIN_SUB="${2:-}"; shift 2 ;;
    --admin-rg)         ADMIN_RG="${2:-}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── HALF AN ADMIN COORDINATE IS A CALLER DEFECT, NOT "NO ADMIN RG" ───────────
#
# The #4665 fallback below needs BOTH halves. Before this guard, a caller that
# passed `--admin-rg <name>` with an EMPTY `--admin-subscription` had the whole
# fallback skipped in silence, and the plan came out byte-identical to "the
# admin RG holds nothing". That is not hypothetical: deploy-fiab-commercial.yml
# bound the subscription to `steps.topology_guard.outputs.deploy_sub`, whose
# documented value on EVERY scheduled run is '' ("inherit the login
# subscription"), so the nightly reconcile passed
#   --admin-subscription "" --admin-rg rg-csa-loom-admin-centralus
# and never adopted Service Bus or Batch — measured on run 36428134174
# (2026-09-28, `ADMIN_SUB: ` empty in the step env; adopted only
# adf,databricks,eventhubs,storage-adls,synapse) while sb-loom-k6mvh5sm6z7do and
# batchloomk6mvh5sm6z7do sat in that admin RG. Each such run re-rendered
# LOOM_SERVICEBUS_NAMESPACE and LOOM_BATCH_ACCOUNT to ''.
#
# It FAILS rather than warns because no legitimate caller supplies one half:
# all four deploy workflows pass both, the three sovereign lanes refuse an
# empty subscription before calling this, and the Commercial lane now reads
# the guard's `target_sub`, which the guard refuses to leave empty. Reaching
# here means a caller regressed, and a warning would let that regression strip
# two env vars off the console on every run (deploy-integrity R6/R7).
if { [ -n "$ADMIN_RG" ] && [ -z "$ADMIN_SUB" ]; } || { [ -z "$ADMIN_RG" ] && [ -n "$ADMIN_SUB" ]; }; then
  echo "::error::[discover-dlz-adopt] admin coordinates are HALF-supplied (--admin-rg='${ADMIN_RG}', --admin-subscription is $( [ -n "$ADMIN_SUB" ] && echo set || echo EMPTY )). The admin-RG fallback needs both, and skipping it would silently drop the servicebus/batch adopt keys — which blanks LOOM_SERVICEBUS_NAMESPACE / LOOM_BATCH_ACCOUNT on the next deploy. Pass both or neither. In a deploy workflow the subscription must be a RESOLVED literal (the topology guard's target_sub), never deploy_sub, which is '' on every scheduled run." >&2
  exit 2
fi

if [ -z "$DLZ_SUB" ] || [ -z "$DLZ_RG" ]; then
  # Not an error: the caller may have no DLZ yet (greenfield/tenant first run).
  echo "[discover-dlz-adopt] no DLZ coordinates supplied — emitting an empty plan" >&2
  echo '{}'
  exit 0
fi

# A resource group that does not exist is a legitimate answer ("no DLZ yet"),
# NOT a failure — but an UNREADABLE one is different and must not be silently
# reported as absent (deploy-integrity R7, and the unknown-as-negative class).
RG_ERR="$(mktemp)"
if ! az group show -n "$DLZ_RG" --subscription "$DLZ_SUB" -o none 2>"$RG_ERR"; then
  if grep -qiE "ResourceGroupNotFound|could not be found" "$RG_ERR"; then
    echo "[discover-dlz-adopt] DLZ RG '$DLZ_RG' does not exist in that subscription — empty plan" >&2
    echo '{}'
    exit 0
  fi
  echo "::warning::[discover-dlz-adopt] could NOT read DLZ RG '$DLZ_RG' — this is UNKNOWN, not 'no DLZ'. Adoption is skipped for this run and the deploy will fall back to its create/convention path. az stderr:" >&2
  sed 's/^/  /' "$RG_ERR" >&2 || true
  echo '{}'
  exit 0
fi

# Every lookup is best-effort and independent: one service being absent must not
# suppress the others.
q() { az "$@" 2>/dev/null | tr -d '\r' || true; }

SA="$(q storage account list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[?isHnsEnabled]|[0].name" -o tsv)"
EH="$(q eventhubs namespace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
SYN="$(q synapse workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
DBX_N="$(q databricks workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].name" -o tsv)"
DBX_H="$(q databricks workspace list --subscription "$DLZ_SUB" -g "$DLZ_RG" --query "[0].workspaceUrl" -o tsv)"
# Azure Data Factory. Read through `az resource list` rather than `az datafactory
# list` on purpose: `datafactory` is an az EXTENSION, and a lookup that needs one
# installed would silently return nothing on a runner that lacks it — the same
# unknown-reported-as-absent shape the header refuses.
#
# WHY THIS ENTRY WAS MISSING, AND WHAT IT COST (auto-bind-by-default.md §5).
# The four lookups above adopt the DLZ's lake, Event Hubs, Synapse and
# Databricks. The factory sits in the SAME resource group and was not adopted.
# Measured ON THIS TREE (not on any live estate — this note asserts only what the
# code establishes): with `adopt.adf` absent, main.bicep's `existingAdfFactory`
# is '' and admin-plane/main.bicep falls through to
#   effAdfName = deAdfEnabled ? loomAdfName : ''    // 'adf-loom-default-<region>'
#   effAdfRg   = loomAdfRg || loomDlzRg             // the ADMIN rg on tenant
#   byoAdfSub  = subscription().subscriptionId      // the ADMIN sub
# On a `topology='tenant'` estate no landing zone is deployed by that run, so
# those three coordinates name a factory this deployment did not create, in a
# resource group and subscription it is not in. Two consequences:
#   1. LOOM_ADF_NAME / _RG / _SUB address the wrong place on any estate whose
#      factory lives in a separately-deployed landing zone;
#   2. main.bicep cannot grant that factory ANYTHING, because it does not know
#      which factory it is — so `adf-keyvault-rbac.bicep` (the Key Vault Secrets
#      User grant every Snowflake mirror needs to read its credential) had no
#      reachable call site on any shipped boundary at all.
# Adopting the factory here is what makes `main.bicep`'s `adoptedAdfKeyVaultRbac`
# reachable with the checked-in param files.
ADF="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.DataFactory/factories --query "[0].name" -o tsv)"
# Service Bus namespace + Azure Batch account (#3317). Both are read by
# RESOURCE TYPE, never by a derived name, and that distinction is the whole
# point of these two entries.
#
# WHY THEY WERE MISSING, AND WHAT IT COST (auto-bind-by-default.md §5).
# main.bicep derived both coordinates from the single-sub naming convention
# alone — `(useSingleDlz && deployServiceBus) ? 'sbns-loom-default-<region>' : ''`
# and the matching `take('batchloom<hash>',24)` for Batch. `useSingleDlz` is
# `deployLandingZones && effectiveTopology == 'single-sub'`, and every shipped
# params file pins `topology='tenant'` (commercial, commercial-full, gcc,
# gcc-high, il5), so BOTH expressions evaluate to '' on every boundary Loom
# ships. LOOM_SERVICEBUS_NAMESPACE and LOOM_BATCH_ACCOUNT therefore rendered
# empty everywhere and svc-servicebus / svc-batch honest-gated on every cloud.
#
# Even on a `single-sub` estate the Service Bus convention would not have
# matched: deploy-planner/service-bus.bicep names its namespace
# `sb-loom-<uniqueString(rg.id)>`, not `sbns-loom-default-<region>`. A convention
# that two modules spell differently cannot be the binding mechanism — which is
# exactly why these are DISCOVERED, like the lake in #3327.
SB="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.ServiceBus/namespaces --query "[0].name" -o tsv)"
BATCH="$(q resource list --subscription "$DLZ_SUB" -g "$DLZ_RG" --resource-type Microsoft.Batch/batchAccounts --query "[0].name" -o tsv)"

# Where each adopted service was FOUND. Defaults to the DLZ for every lookup
# above; the #4665 fallback below overrides only the two it actually resolves.
SB_RG="$DLZ_RG";    SB_SUB="$DLZ_SUB"
BATCH_RG="$DLZ_RG"; BATCH_SUB="$DLZ_SUB"

# ── ADMIN-RG FALLBACK for Service Bus + Batch (#4665) ────────────────────────
#
# WHY. The two lookups above read the DLZ resource group, which is where a
# landing-zone deploy puts these. But deploy-planner/service-bus.bicep and
# deploy-planner/batch.bicep are ORDINARY resource-group-scoped modules: nothing
# stops an operator deploying them straight at the admin RG, and on the
# Commercial estate somebody did — `loom-servicebus-1784162471` and
# `loom-batch-1784162511`, both Succeeded 2026-07-16, both into
# rg-csa-loom-admin-centralus. Measured 2026-09-22: that estate owns
# `sb-loom-k6mvh5sm6z7do` (queue `loom-queue`, exactly what service-bus.bicep:56
# creates) and `batchloomk6mvh5sm6z7do`, while the DLZ resource group in the
# OTHER subscription holds neither — so discovery looked only where they were
# not, the plan omitted both keys, and LOOM_SERVICEBUS_NAMESPACE /
# LOOM_BATCH_ACCOUNT rendered '' with svc-servicebus and svc-batch honest-gating
# on an estate that owned both resources. Same shape as the #3327 lake and the
# #3317 entries above: the resource exists, the binding does not.
#
# This does NOT widen the other five lookups. The lake, Event Hubs, Synapse,
# Databricks and ADF belong to a landing zone by construction, and adopting an
# admin-RG namesake for any of them would bind the console to the wrong tier.
#
# PRECEDENCE: the DLZ always wins. This only fills a key the DLZ left empty.
#
# WHAT IT STILL DOES NOT COVER, stated rather than implied: this block sits after
# the DLZ-coordinate and RG-readability guards above, so it runs only when a DLZ
# resource group was resolved and read. An estate with NO landing zone at all
# never reaches here — and could not anyway, because all four deploy workflows
# call this script only inside `if [ -n "$DLZ_SUB" ] && [ -n "$DLZ_RG" ]`.
# Admin-RG-only resources on a landing-zone-less estate are therefore still
# unadopted. That is a real hole, deliberately left: closing it means relaxing a
# gate that also guards the fail-closed lake-binding backstop (#3701), which is
# a bigger change than the defect being fixed here warrants.
if [ -n "$ADMIN_SUB" ] && [ -n "$ADMIN_RG" ]; then
  # Unlike q(), this separates UNREADABLE from ABSENT. A subscription the deploy
  # identity cannot read must not render as "the estate does not have one" —
  # that is the unknown-as-negative shape this file's header refuses, and the
  # reason the lake has a fail-closed backstop in the calling workflow.
  admin_names() { # admin_names <resource-type> → names on stdout, rc 1 if unreadable
    local err out rc=0
    err="$(mktemp)"
    out="$(az resource list --subscription "$ADMIN_SUB" -g "$ADMIN_RG" \
             --resource-type "$1" --query "[].name" -o tsv 2>"$err")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "::warning::[discover-dlz-adopt] could NOT read $1 in admin RG '$ADMIN_RG' — that is UNKNOWN, not 'absent'. Skipping the admin-RG fallback for it; the DLZ answer (empty) stands. az stderr:" >&2
      sed 's/^/  /' "$err" >&2 || true
      rm -f "$err"
      return 1
    fi
    rm -f "$err"
    printf '%s' "$out" | tr -d '\r' | sed '/^[[:space:]]*$/d'
  }

  # Exactly one candidate, or nothing. Picking `[0]` out of several would bind
  # the console to whichever namespace ARM happened to list first, which is a
  # coin flip dressed as a measurement.
  admin_pick() { # admin_pick <key> <candidates…> → the single name, or ''
    local key="$1"; shift
    local n; n="$(printf '%s\n' "$@" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    if [ "$n" -eq 1 ]; then printf '%s' "$1"; return 0; fi
    if [ "$n" -gt 1 ]; then
      echo "::warning::[discover-dlz-adopt] admin RG '$ADMIN_RG' holds $n candidates for '$key' ($*) and the DLZ held none, so there is no unambiguous resource to adopt. Adopting NONE rather than guessing — set LOOM_ADOPT_JSON explicitly to name the intended one (an explicit plan always wins over discovery)." >&2
    fi
    return 0
  }

  if [ -z "$SB" ]; then
    if SB_CAND="$(admin_names Microsoft.ServiceBus/namespaces)"; then
      # admin-plane/aas.bicep ALSO creates a Service Bus namespace in this very
      # resource group — the direct-lake-shim's, named `sb-loom-dlshim-<region>`
      # (admin-plane/main.bicep:2223). It carries the shim's own queue and is not
      # what the svc-servicebus navigator binds, so it is excluded by name before
      # the count is taken. This is the ONE place a name is used, and it is used
      # to EXCLUDE a known sibling, never to construct the thing being adopted.
      SB_CAND="$(printf '%s\n' "$SB_CAND" | grep -v '^sb-loom-dlshim-' || true)"
      # shellcheck disable=SC2086 # deliberate word-split: one candidate per line
      SB_PICK="$(admin_pick servicebus $SB_CAND)"
      if [ -n "$SB_PICK" ]; then
        SB="$SB_PICK"; SB_RG="$ADMIN_RG"; SB_SUB="$ADMIN_SUB"
        echo "[discover-dlz-adopt] servicebus not in the DLZ RG — adopting '$SB' from the admin RG '$ADMIN_RG'" >&2
      fi
    fi
  fi

  if [ -z "$BATCH" ]; then
    if BATCH_CAND="$(admin_names Microsoft.Batch/batchAccounts)"; then
      # No exclusion needed: deploy-planner/batch.bicep is the ONLY declaration
      # of Microsoft.Batch/batchAccounts in the tree, so any account here is one
      # of ours. The exactly-one rule still applies.
      # shellcheck disable=SC2086 # deliberate word-split: one candidate per line
      BATCH_PICK="$(admin_pick batch $BATCH_CAND)"
      if [ -n "$BATCH_PICK" ]; then
        BATCH="$BATCH_PICK"; BATCH_RG="$ADMIN_RG"; BATCH_SUB="$ADMIN_SUB"
        echo "[discover-dlz-adopt] batch not in the DLZ RG — adopting '$BATCH' from the admin RG '$ADMIN_RG'" >&2
      fi
    fi
  fi
fi

PY="$(command -v python || command -v python3 || true)"

# ── Event Hubs SCHEMA GROUP on the adopted namespace → LOOM_EH_SCHEMA_GROUP ──
#
# WHY. admin-plane/main.bicep's ONLY source for LOOM_EH_SCHEMA_GROUP is
# `eventsConfig.?loomEhSchemaGroup ?? ''`, and main.bicep never passed
# eventsConfig at all — so the var rendered '' on every estate, including the
# Commercial one whose adopted namespace evhns-loom-default-centralus carries
# the `loom-schemas` group landing-zone/eventhubs.bicep creates. The console then
# silently used its in-process Avro validator instead of the service-enforced
# registry the namespace was built with.
#
# CHOICE, deterministic and stated: `loom-schemas` if present (the name
# eventhubs.bicep's `schemaGroupName` defaults to); else the ONLY group if there
# is exactly one; else none. Several groups with no `loom-schemas` among them is
# ambiguous and adopts NONE — picking `[0]` would be a coin flip.
#
# UNREADABLE IS NOT ABSENT. Read directly rather than through q(), whose
# `2>/dev/null || true` turns an authorization failure into "no groups".
EH_SCHEMA_GROUP=""
if [ -n "$EH" ]; then
  SG_ERR="$(mktemp)"; SG_RC=0
  SG_LIST="$(az eventhubs namespace schema-registry list --subscription "$DLZ_SUB" -g "$DLZ_RG" \
               --namespace-name "$EH" --query "[].name" -o tsv 2>"$SG_ERR")" || SG_RC=$?
  if [ "$SG_RC" -ne 0 ]; then
    echo "::warning::[discover-dlz-adopt] could NOT list schema groups on Event Hubs namespace '$EH' (az exit $SG_RC) — that is UNKNOWN, not 'none'. LOOM_EH_SCHEMA_GROUP will render '' for this run (the console falls back to its in-process Avro validator). Grant the deploy identity Reader on the namespace. az stderr:" >&2
    sed 's/^/  /' "$SG_ERR" >&2 || true
  else
    SG_LIST="$(printf '%s\n' "$SG_LIST" | tr -d '\r' | sed '/^[[:space:]]*$/d')"
    SG_N="$(printf '%s' "$SG_LIST" | grep -c . || true)"
    if grep -qxF 'loom-schemas' <<<"$SG_LIST"; then
      EH_SCHEMA_GROUP="loom-schemas"
      echo "[discover-dlz-adopt] eventhubs schema group = loom-schemas (the preferred name; $SG_N group(s) on '$EH')" >&2
    elif [ "$SG_N" -eq 1 ]; then
      EH_SCHEMA_GROUP="$SG_LIST"
      echo "[discover-dlz-adopt] eventhubs schema group = $EH_SCHEMA_GROUP (the ONLY group on '$EH'; no 'loom-schemas' present)" >&2
    elif [ "$SG_N" -eq 0 ]; then
      echo "::notice::[discover-dlz-adopt] Event Hubs namespace '$EH' was read and holds NO schema groups — LOOM_EH_SCHEMA_GROUP stays '' (in-process Avro validator)." >&2
    else
      echo "::warning::[discover-dlz-adopt] Event Hubs namespace '$EH' holds $SG_N schema groups ($(printf '%s' "$SG_LIST" | tr '\n' ' ')) and none is 'loom-schemas', so there is no unambiguous one to bind. Adopting NONE rather than guessing — name it in LOOM_ADOPT_JSON (eventhubs.extra.schemaGroup) to choose." >&2
    fi
  fi
  rm -f "$SG_ERR"
fi

# ── Databricks SQL WAREHOUSE (loom-default | loom-governance) → LOOM_DATABRICKS_SQL_WAREHOUSE_ID ──
#
# WHY. admin-plane/main.bicep declares `loomDatabricksSqlWarehouseId` and emits
# it as LOOM_DATABRICKS_SQL_WAREHOUSE_ID, but main.bicep never passed it, so the
# env var rendered '' on every estate.
#
# TWO NAMES are written in this repo, and they differ by writer, not by cloud:
#   loom-default     csa-loom-post-deploy-bootstrap.yml (called by the
#                    Commercial, GCC, GCC-High and IL5 deploy lanes) and
#                    csa-loom-grant-delta-sharing.yml create/reuse this name.
#   loom-governance  gov-provision-dbx-sql.yml and gov-provision-dbx-sql-invnet.yml
#                    (the apps/loom-dbx-init image), both Azure Government only,
#                    create this name — but only when NO warehouse whose name
#                    starts with `loom` exists; otherwise they reuse that one.
# PREFERENCE, deterministic and stated in the output: `loom-default` if the
# workspace lists one, else `loom-governance`. `loom-default` wins because the
# bootstrap re-wires the console to it on every run, so preferring the other
# would make this reconcile and the bootstrap overwrite each other. Each name
# must match EXACTLY ONE warehouse; two of the preferred name adopts NONE
# (it does not fall through to the next name — a duplicate is a defect to
# surface, not a reason to pick a different warehouse).
#
# THREE STATES, never collapsed (deploy-integrity R7):
#   found                  → its id is adopted.
#   API answered, no match → '' and a ::notice:: — a measured negative (the
#                            warehouse has not been created on this workspace).
#   API refused/unreachable→ '' and a ::warning:: naming the HTTP code. This is
#                            UNKNOWN and is never reported as "no warehouse".
#                            A workspace with publicNetworkAccess Disabled
#                            answers a hosted runner 403 "Unauthorized network
#                            access to workspace" — that is this state, and the
#                            warning says so rather than blaming RBAC.
# It never fails the script: a warehouse is an optional binding (the console
# auto-selects a RUNNING warehouse when the id is blank), and in a boundary
# where Databricks SQL is unavailable the API answers with no match or an error,
# both of which degrade to ''.
#
# The AAD token never reaches argv or the log: it is handed to curl as a config
# file on STDIN (`--config -`).
DBX_AAD_RESOURCE="2ff814a6-3304-4ab8-85cb-cd0e6f879c1d"
dbx_sql_warehouse_id() { # dbx_sql_warehouse_id <workspace host> → id or '' on stdout
  local host="$1" tok err body code rc=0 pick why rest
  err="$(mktemp)"; body="$(mktemp)"
  tok="$(az account get-access-token --resource "$DBX_AAD_RESOURCE" --query accessToken -o tsv 2>"$err")" || rc=$?
  tok="$(printf '%s' "$tok" | tr -d '\r\n')"
  if [ "$rc" -ne 0 ] || [ -z "$tok" ]; then
    echo "::warning::[discover-dlz-adopt] could NOT obtain an Azure Databricks AAD token (az exit $rc), so whether a 'loom-default' or 'loom-governance' SQL warehouse exists on '$host' is UNKNOWN — not 'absent'. LOOM_DATABRICKS_SQL_WAREHOUSE_ID renders '' for this run. az stderr:" >&2
    sed 's/^/  /' "$err" >&2 || true
    rm -f "$err" "$body"; return 0
  fi
  rc=0
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$tok" \
            | curl -sS --config - --max-time 30 -o "$body" -w '%{http_code}' \
                   "https://$host/api/2.0/sql/warehouses" 2>"$err")" || rc=$?
  tok=""
  code="$(printf '%s' "${code:-}" | tr -d '\r\n')"
  if [ "$code" != "200" ]; then
    if grep -qi 'network access' "$body"; then
      why="The workspace refused this runner at the NETWORK layer (its body names network access): a workspace with publicNetworkAccess Disabled is reachable only through its private endpoint, so a hosted runner cannot read it at all. The warehouse id has to be read, or the warehouse created, from inside the network."
    else
      why="On 401/403 without a network-access message the deploy identity is likely not a user of that workspace (Contributor on the workspace resource provisions it as a workspace admin on first sign-in); HTTP 000 means the host was unreachable."
    fi
    echo "::warning::[discover-dlz-adopt] the Databricks SQL Warehouses API on '$host' did NOT answer 200 (HTTP ${code:-000}, curl exit $rc), so whether a 'loom-default' or 'loom-governance' warehouse exists is UNKNOWN — not 'absent'. LOOM_DATABRICKS_SQL_WAREHOUSE_ID renders '' for this run. $why Detail:" >&2
    { sed 's/^/  /' "$err"; head -c 300 "$body" | sed 's/^/  /'; echo; } >&2 || true
    rm -f "$err" "$body"; return 0
  fi
  if [ -z "$PY" ]; then
    echo "::warning::[discover-dlz-adopt] the SQL Warehouses API answered but no python is on PATH to read it — the warehouse is UNKNOWN; LOOM_DATABRICKS_SQL_WAREHOUSE_ID renders ''." >&2
    rm -f "$err" "$body"; return 0
  fi
  # Every parse path prints ONE verdict token and exits 0 — a body of the wrong
  # SHAPE (a JSON array, a non-object warehouse) is caught like a non-JSON body,
  # so a surprising answer degrades to a ::warning:: instead of tripping `set -e`.
  # Verdicts: ID:<name>:<id> | AMBIG:<name>:<count> | NONE | ERR:<why>. The FIRST
  # name in PREFER with any match decides; a later name is never consulted then.
  pick="$("$PY" -c '
import json, sys
PREFER = ("loom-default", "loom-governance")
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    ws = d.get("warehouses") or []
    by = {n: [str(w["id"]) for w in ws if w.get("name") == n and w.get("id")] for n in PREFER}
except Exception as e:
    print("ERR:" + type(e).__name__); sys.exit(0)
for n in PREFER:
    ids = by[n]
    if len(ids) == 1:
        print("ID:" + n + ":" + ids[0]); break
    if ids:
        print("AMBIG:" + n + ":" + str(len(ids))); break
else:
    print("NONE")
' "$body" | tr -d '\r')" || pick="ERR:python-exit"
  rm -f "$err" "$body"
  case "$pick" in
    ID:*)
      rest="${pick#ID:}"
      printf '%s' "${rest#*:}"
      echo "[discover-dlz-adopt] databricks SQL warehouse '${rest%%:*}' = ${rest#*:} (preference: loom-default, then loom-governance)" >&2 ;;
    NONE)
      echo "::notice::[discover-dlz-adopt] the Databricks SQL Warehouses API on '$host' answered 200 and lists NO warehouse named 'loom-default' or 'loom-governance' — LOOM_DATABRICKS_SQL_WAREHOUSE_ID stays ''. Nothing has created one on this workspace yet (csa-loom-post-deploy-bootstrap.yml creates 'loom-default'; in Azure Government gov-provision-dbx-sql.yml creates 'loom-governance'); the next deploy after one exists binds it." >&2 ;;
    AMBIG:*)
      rest="${pick#AMBIG:}"
      echo "::warning::[discover-dlz-adopt] '$host' lists ${rest#*:} warehouses named '${rest%%:*}'; adopting NONE rather than guessing (and not falling back to a lower-preference name)." >&2 ;;
    *)
      echo "::warning::[discover-dlz-adopt] the SQL Warehouses API on '$host' answered 200 with a body that is not the documented JSON ($pick) — the warehouse is UNKNOWN; LOOM_DATABRICKS_SQL_WAREHOUSE_ID renders ''." >&2 ;;
  esac
  return 0
}
DBX_WH=""
if [ -n "$DBX_N" ] && [ -n "$DBX_H" ]; then
  DBX_WH="$(dbx_sql_warehouse_id "$DBX_H")"
fi

# `extra` objects. Keys are emitted only when their value was ESTABLISHED, so
# adoptExtra() returns '' for anything this run could not measure.
json_obj() { # json_obj key value [key value …] → {"k":"v",…} over the non-empty pairs, or ''
  local out="" k v
  while [ $# -ge 2 ]; do
    k="$1"; v="$2"; shift 2
    [ -n "$v" ] || continue
    out="${out:+$out,}\"$k\":\"$v\""
  done
  [ -n "$out" ] && printf '{%s}' "$out"
  return 0
}
EH_EXTRA="$(json_obj schemaGroup "$EH_SCHEMA_GROUP")"
DBX_EXTRA="$(json_obj hostname "$DBX_H" sqlWarehouseId "$DBX_WH")"

entries=""
add() { # add <key> <name> <rg> <sub> [extraJson]
  [ -n "${2:-}" ] || return 0
  local extra="${5:-}"
  local one
  one="$(printf '"%s":{"mode":"adopt","target":{"name":"%s","rg":"%s","sub":"%s"}%s}' \
        "$1" "$2" "$3" "$4" "${extra:+,\"extra\":$extra}")"
  entries="${entries:+$entries,}$one"
  echo "[discover-dlz-adopt] adopt $1 = $2 (rg=$3)" >&2
}

add "storage-adls" "$SA"    "$DLZ_RG"    "$DLZ_SUB"
add "eventhubs"    "$EH"    "$DLZ_RG"    "$DLZ_SUB" "$EH_EXTRA"
add "synapse"      "$SYN"   "$DLZ_RG"    "$DLZ_SUB"
add "databricks"   "$DBX_N" "$DLZ_RG"    "$DLZ_SUB" "$DBX_EXTRA"
add "adf"          "$ADF"   "$DLZ_RG"    "$DLZ_SUB"
add "servicebus"   "$SB"    "$SB_RG"     "$SB_SUB"
add "batch"        "$BATCH" "$BATCH_RG"  "$BATCH_SUB"

if [ -z "$entries" ]; then
  echo "[discover-dlz-adopt] DLZ RG exists but held none of the adoptable services — empty plan" >&2
  echo '{}'
  exit 0
fi

PLAN="{$entries}"
# Never emit a document the param file cannot parse: a malformed plan would take
# `json()` down inside bicep compilation and fail the whole deploy.
if command -v python >/dev/null 2>&1; then
  printf '%s' "$PLAN" | python -c 'import json,sys; json.load(sys.stdin)' \
    || { echo "::error::[discover-dlz-adopt] composed an INVALID adopt plan — refusing to emit it"; exit 1; }
fi
printf '%s\n' "$PLAN"
