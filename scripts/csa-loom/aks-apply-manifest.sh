#!/usr/bin/env bash
# Apply a Kubernetes manifest to a PRIVATE AKS cluster through ARM managedClusters/runCommand
# (`az aks command invoke`), then wait, bounded, for a Deployment to roll out. Used by
# .github/workflows/deploy-health.yml to deliver the stamp PDP (OPA) - the one stamp-wide
# workload - because a Microsoft.Resources/deploymentScripts resource cannot run on tenants
# whose policy forces storage shared-key access off (#5345, #5355, #5422).
#
# FAIL CLOSED. Every az exit and every kubectl exit code is read; nothing here discards a result
# (no `|| true`, no stderr thrown away). Whether a Deployment is Ready is read from kubectl, never
# assumed from "the apply was accepted".
#
# Exit codes (callers branch on them):
#   0  manifest applied AND the Deployment rolled out
#   2  usage / missing input / az or jq not found
#   3  PERMISSION: ARM refused runCommand or Kubernetes refused the apply (after bounded retries)
#   4  the apply ran and kubectl failed for another reason
#   5  applied, but the Deployment did not become Ready within the timeout
#   6  UNPROVEN: az answered something that could not be parsed, so the outcome is unknown
#
# Usage: aks-apply-manifest.sh --resource-group RG --cluster NAME --namespace NS --deployment NAME \
#          --manifest FILE [--attempts N] [--sleep SECONDS] [--rollout-timeout SECONDS]
set -uo pipefail

RG=""; CLUSTER=""; NS=""; DEPLOY=""; MANIFEST=""
ATTEMPTS=8; SLEEP=30; ROLLOUT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --resource-group) RG="${2:-}"; shift 2 ;;
    --cluster) CLUSTER="${2:-}"; shift 2 ;;
    --namespace) NS="${2:-}"; shift 2 ;;
    --deployment) DEPLOY="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-}"; shift 2 ;;
    --sleep) SLEEP="${2:-}"; shift 2 ;;
    --rollout-timeout) ROLLOUT="${2:-}"; shift 2 ;;
    *) echo "::error::aks-apply-manifest.sh: unknown argument '$1'"; exit 2 ;;
  esac
done
for v in RG CLUSTER NS DEPLOY MANIFEST; do
  if [ -z "${!v}" ]; then echo "::error::aks-apply-manifest.sh: input $v is empty; nothing was applied."; exit 2; fi
done
case "$ATTEMPTS$SLEEP$ROLLOUT" in *[!0-9]*) echo "::error::--attempts, --sleep and --rollout-timeout must be whole numbers."; exit 2 ;; esac
if [ ! -s "$MANIFEST" ]; then echo "::error::manifest '$MANIFEST' is missing or empty; nothing was applied."; exit 2; fi
command -v az > /dev/null || { echo "::error::az is not on PATH."; exit 2; }
command -v jq > /dev/null || { echo "::error::jq is not on PATH."; exit 2; }

WORK="${AKS_APPLY_TMP:-$(mktemp -d)}"
mkdir -p "$WORK"
FILE_BASENAME=$(basename "$MANIFEST")

# invoke "<command>" [file]  -> sets INV_RC (az exit), INV_EXIT (kubectl exit code, "" if unreadable), INV_LOGS
invoke() {
  local cmd="$1" file="${2:-}" args
  args=(aks command invoke --resource-group "$RG" --name "$CLUSTER" --command "$cmd" -o json)
  if [ -n "$file" ]; then args+=(--file "$file"); fi
  az "${args[@]}" > "$WORK/out.json" 2> "$WORK/err.txt"
  INV_RC=$?
  INV_EXIT=""; INV_LOGS=""
  if [ "$INV_RC" = "0" ]; then
    INV_EXIT=$(jq -r '.exitCode // empty' "$WORK/out.json" 2> "$WORK/jq.err")
    INV_LOGS=$(jq -r '.logs // ""' "$WORK/out.json" 2>> "$WORK/jq.err")
  fi
}
is_denied() { # stdin text -> 0 when it reads as an authorization refusal
  grep -qiE 'forbidden|AuthorizationFailed|does not have authorization|AuthorizationPermissionMismatch|Unauthorized'
}

# ── apply (retry ONLY on a permission refusal: a fresh role assignment takes minutes to propagate) ──
APPLIED=0
for i in $(seq 1 "$ATTEMPTS"); do
  invoke "kubectl apply -f $FILE_BASENAME" "$MANIFEST"
  if [ "$INV_RC" = "0" ] && [ "$INV_EXIT" = "0" ]; then
    echo "kubectl apply succeeded on attempt $i:"; printf '%s\n' "$INV_LOGS" | head -c 2000; echo
    APPLIED=1; break
  fi
  if [ "$INV_RC" != "0" ]; then
    DETAIL=$(head -c 600 "$WORK/err.txt")
    if printf '%s' "$DETAIL" | is_denied; then
      echo "attempt $i/$ATTEMPTS: ARM refused managedClusters/runCommand (a new role assignment can take minutes): $DETAIL"
      PERM_KIND="arm"
    else
      echo "::error::az aks command invoke failed (exit $INV_RC) before kubectl ran: $DETAIL. Whether the manifest was applied is UNKNOWN; this is not a claim that it was not."
      exit 6
    fi
  elif [ -z "$INV_EXIT" ]; then
    echo "::error::az aks command invoke exited 0 but its JSON carries no exitCode (got '$(head -c 200 "$WORK/out.json")'), so whether kubectl succeeded is UNKNOWN."
    exit 6
  elif printf '%s' "$INV_LOGS" | is_denied; then
    echo "attempt $i/$ATTEMPTS: Kubernetes refused the apply (exit $INV_EXIT): $(printf '%s' "$INV_LOGS" | head -c 600)"
    PERM_KIND="k8s"
  else
    echo "::error::kubectl apply exited $INV_EXIT in cluster $CLUSTER (not a permission refusal): $(printf '%s' "$INV_LOGS" | head -c 1200). Fix the manifest or the cluster state named above, then re-run."
    exit 4
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then sleep "$SLEEP"; fi
done
if [ "$APPLIED" != "1" ]; then
  if [ "${PERM_KIND:-}" = "arm" ]; then
    echo "::error::PERMISSION: ARM refused Microsoft.ContainerService/managedClusters/runcommand/action (or commandResults/read) on $CLUSTER for the deploy principal after $ATTEMPTS attempts. Contributor or Owner on the resource group carries both; grant one, or 'Azure Kubernetes Service Contributor Role' on the cluster."
  else
    echo "::error::PERMISSION: Kubernetes refused the apply for the deploy principal after $ATTEMPTS attempts. The cluster uses Azure RBAC, so the principal needs a Kubernetes DATA role: 'Azure Kubernetes Service RBAC Cluster Admin' on $CLUSTER (the manifest creates the Namespace, which is cluster-scoped). health.bicep grants it when controlPlaneConfig.pdpApplyPrincipalId is set; the workflow sets it from the signed-in service principal."
  fi
  exit 3
fi

# ── rollout, bounded ────────────────────────────────────────────────────────────
invoke "kubectl -n $NS rollout status deployment/$DEPLOY --timeout=${ROLLOUT}s"
if [ "$INV_RC" = "0" ] && [ "$INV_EXIT" = "0" ]; then
  echo "Deployment $NS/$DEPLOY rolled out:"; printf '%s\n' "$INV_LOGS" | head -c 1000; echo
  exit 0
fi
if [ "$INV_RC" != "0" ] || [ -z "$INV_EXIT" ]; then
  echo "::error::could not read the rollout of $NS/$DEPLOY: az exit $INV_RC, kubectl exit '${INV_EXIT}', $(head -c 400 "$WORK/err.txt"). Whether it is Ready is UNKNOWN."
  exit 6
fi
echo "::group::rollout of $NS/$DEPLOY did not complete (kubectl exit $INV_EXIT)"
printf '%s\n' "$INV_LOGS" | head -c 1500
invoke "kubectl -n $NS get pods -o wide; kubectl -n $NS get events --sort-by=.lastTimestamp | tail -n 12; kubectl -n $NS logs deployment/$DEPLOY --tail=20"
DIAG=""
if [ "$INV_RC" = "0" ]; then DIAG="$INV_LOGS"; else DIAG="(diagnostics unreadable: az exit $INV_RC: $(head -c 300 "$WORK/err.txt"))"; fi
printf '%s\n' "$DIAG" | head -c 4000
echo "::endgroup::"
if printf '%s' "$DIAG" | grep -qiE 'bundle'; then
  echo "::error::$NS/$DEPLOY was applied but is not Ready after ${ROLLOUT}s, and its pod output mentions the bundle. Established: the manifest applied. Most likely cause (NOT proven): no ES256-signed bundle is published for this stamp yet, and the PDP pod is only Ready once a signed bundle is active (readiness is /health?bundles). Publish one with .github/workflows/health-pdp-bundle-publish.yml, then re-run. Pod output is in the group above."
else
  echo "::error::$NS/$DEPLOY was applied but is not Ready after ${ROLLOUT}s. The cause is NOT established; the pod listing, events and log tail are in the group above."
fi
exit 5
