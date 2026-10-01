#!/usr/bin/env bash
# =============================================================================
# containerapp-revision-check.sh — wait for a Container App revision, or say
# why it failed
# =============================================================================
#
# WHY THIS EXISTS
#
# gov-uc-purview-wire.yml's loom-unity deploy printed raw ARM JSON on failure
# and nothing else, and its health loop discarded stderr and never failed:
# after 20 polls it fell through to the next step whatever the health was.
# On 2026-09-30 the deploy failed with only "Operation expired"; the cause (the
# pull identity could not pull) was found later by a separate diagnostic run.
#
# SUBCOMMANDS
#
#   wait      --app A --rg RG [--acr NAME] [--identity-name NAME]
#             Polls the latest revision's health (bounded). Exit 0 when it reports
#             Healthy. Otherwise runs `diagnose` and exits 1. A failed read is
#             reported, never treated as "not yet healthy" in silence.
#   diagnose  --app A --rg RG [--acr NAME] [--identity-name NAME]
#             [--deploy-stderr FILE]
#             Reads the NEWEST revision (`--all`, by createdTime) and its
#             replicas, prints their platform fields, classifies the failure and
#             prints a remediation (deploy-integrity R6).
#
# DIAGNOSE EXIT CODES (the class)
#   10  retry       another operation was in progress; retrying once is valid
#   11  permission  the image pull was refused (authorization)
#   12  missing     the image or digest is not in the registry
#   13  pull        the image pull failed for a reason not shown
#   14  image       the container started and crashed or failed its probes
#   15  capacity    quota or capacity
#   16  unknown     no classifiable signal
#
# Only platform fields are printed (state, provisioningError, runningState,
# runningStateDetails, restart counts) plus the deploy's own error text. Each
# block of Azure text is wrapped in ::stop-commands:: with a fresh random token,
# and GUIDs are masked.
#
# ENVIRONMENT (tests shorten these)
#   LOOM_REVISION_WAIT_ATTEMPTS  default 20
#   LOOM_REVISION_WAIT_SECONDS   default 15
# =============================================================================
set -uo pipefail

CMD="${1:-}"; [ $# -gt 0 ] && shift
APP="" RG="" ACR="" IDN="" DEPLOY_STDERR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --acr) ACR="${2:-}"; shift 2 ;;
    --identity-name) IDN="${2:-}"; shift 2 ;;
    --deploy-stderr) DEPLOY_STDERR="${2:-}"; shift 2 ;;
    *) echo "::error::containerapp-revision-check: unknown argument '$1'"; exit 64 ;;
  esac
done
if [ -z "$APP" ] || [ -z "$RG" ] || { [ "$CMD" != wait ] && [ "$CMD" != diagnose ]; }; then
  echo "::error::usage: containerapp-revision-check.sh wait|diagnose --app NAME --rg RG [--acr NAME] [--identity-name NAME] [--deploy-stderr FILE]"
  exit 64
fi

guid_mask() { sed -E 's/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/<guid>/g'; }
oneline() { tr '\r\n' '  ' | guid_mask | sed -e 's/##\[/## [/g' -e 's/::/: :/g' | cut -c1-300; }
shield() {
  local t
  t=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '::stop-commands::%s\n' "$t"
  guid_mask
  printf '::%s::\n' "$t"
}
azq() {
  local f
  f=$(mktemp)
  AZ_RC=0
  AZ_OUT=$(az "$@" 2>"$f" </dev/null) || AZ_RC=$?
  AZ_OUT=$(printf '%s' "$AZ_OUT" | tr -d '\r')
  AZ_ERR=$(head -c 2000 "$f")
  rm -f "$f"
}

diagnose() {
  local text="" rev="" cls
  if [ -n "$DEPLOY_STDERR" ] && [ -s "$DEPLOY_STDERR" ]; then
    echo "--- deployment error (first 40 lines) ---"
    head -n 40 "$DEPLOY_STDERR" | shield
    text="$text $(head -c 20000 "$DEPLOY_STDERR")"
  fi
  azq containerapp revision list -n "$APP" -g "$RG" --all \
    --query "sort_by([], &properties.createdTime)[-1].{name:name,created:properties.createdTime,active:properties.active,provisioning:properties.provisioningState,provisioningError:properties.provisioningError,running:properties.runningState,runningDetails:properties.runningStateDetails,health:properties.healthState}" -o json
  if [ "$AZ_RC" -ne 0 ]; then
    echo "::warning::the newest $APP revision could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline)); classifying from the deployment error alone."
  else
    echo "--- newest $APP revision ---"
    printf '%s\n' "$AZ_OUT" | shield
    text="$text $AZ_OUT"
    azq containerapp revision list -n "$APP" -g "$RG" --all --query "sort_by([], &properties.createdTime)[-1].name" -o tsv
    rev="$AZ_OUT"
  fi
  if [ -n "$rev" ]; then
    azq containerapp replica list -n "$APP" -g "$RG" --revision "$rev" \
      --query "[].{name:name,running:properties.runningState,details:properties.runningStateDetails,containers:properties.containers[].{name:name,ready:ready,started:started,restarts:restartCount,state:runningState,details:runningStateDetails}}" -o json
    if [ "$AZ_RC" -ne 0 ]; then
      echo "(replicas of $rev could not be read: az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"
    else
      echo "--- replicas of $rev ---"
      printf '%s\n' "$AZ_OUT" | shield
      text="$text $AZ_OUT"
    fi
  fi

  cls=unknown
  shopt -s nocasematch
  if [[ "$text" =~ OperationInProgress|AnotherOperationInProgress|another\ operation\ is\ in\ progress|operation\ is\ already\ in\ progress ]]; then
    cls=retry
  elif [[ "$text" =~ manifest\ unknown|MANIFEST_UNKNOWN|not\ found:\ manifest ]]; then
    cls=missing
  elif [[ "$text" =~ (ImagePull|ErrImagePull|failed\ to\ pull|pull\ access|pulling\ image) ]] \
    && [[ "$text" =~ (unauthori[sz]ed|authentication\ required|denied|forbidden|(^|[^0-9])40[13]([^0-9]|$)) ]]; then
    cls=permission
  elif [[ "$text" =~ ImagePullBackOff|ErrImagePull|failed\ to\ pull ]]; then
    cls=pull
  elif [[ "$text" =~ CrashLoopBackOff|Back-off\ restarting|probe\ failed|Probe\ of|ContainerTerminated|exited\ with\ code|OOMKilled ]]; then
    cls=image
  elif [[ "$text" =~ QuotaExceeded|exceeds\ quota|InsufficientCapacity|SubscriptionIsOverQuota ]]; then
    cls=capacity
  fi
  shopt -u nocasematch

  case "$cls" in
    retry)
      echo "::warning::$APP: classified RETRY. Another operation on the app was in progress; one retry is valid."
      return 10 ;;
    permission)
      echo "::error::$APP: classified PERMISSION (image pull refused). The revision's pull identity${IDN:+ ($IDN)} could not pull from registry ${ACR:-<registry>}. Remediation: grant AcrPull on the registry to that identity (az role assignment create --assignee-object-id \"\$(az identity show -n ${IDN:-<identity>} -g $RG --query principalId -o tsv)\" --assignee-principal-type ServicePrincipal --role AcrPull --scope \"\$(az acr show -n ${ACR:-<registry>} --query id -o tsv)\"), then re-dispatch."
      return 11 ;;
    missing)
      echo "::error::$APP: classified MISSING IMAGE. The registry answered that the image or digest does not exist. Remediation: rebuild and push the image to ${ACR:-the registry} (this workflow's build step), confirm the digest resolves, then re-dispatch."
      return 12 ;;
    pull)
      echo "::error::$APP: classified PULL FAILURE without an authorization or not-found signal in the fields read. Remediation: check registry reachability from the environment (private endpoint and DNS) and the pull identity's AcrPull on ${ACR:-the registry}, then re-dispatch."
      return 13 ;;
    image)
      echo "::error::$APP: classified IMAGE (the container started, then crashed or failed its probes). The deployment is not at fault. Remediation: read the revision's console output (gov-bff-verify.yml prints the [loom-unity] lines and exception classes), fix the image or entrypoint, rebuild, re-dispatch."
      return 14 ;;
    capacity)
      echo "::error::$APP: classified CAPACITY/QUOTA. Remediation: request quota for the environment's workload profile in this region, or reduce the requested replicas or resources, then re-dispatch."
      return 15 ;;
    *)
      echo "::error::$APP: UNCLASSIFIED. Neither the revision state nor the deployment error carries a pull, crash, probe, quota or in-progress signal. 'Operation expired' on its own means the revision did not become ready within ARM's provisioning window and does not say why. Remediation: dispatch gov-bff-verify.yml and read its loom-unity diagnostics (system log reasons and the pull identity's roles)."
      return 16 ;;
  esac
}

if [ "$CMD" = diagnose ]; then
  diagnose
  exit $?
fi

# ---- wait ------------------------------------------------------------------------
ATTEMPTS="${LOOM_REVISION_WAIT_ATTEMPTS:-20}"
INTERVAL="${LOOM_REVISION_WAIT_SECONDS:-15}"
HEALTH="" LATEST=""
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  i=$((i + 1))
  azq containerapp show -n "$APP" -g "$RG" --query properties.latestRevisionName -o tsv
  if [ "$AZ_RC" -ne 0 ] || [ -z "$AZ_OUT" ]; then
    echo "::warning::$APP health read $i/$ATTEMPTS: the latest revision name could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"
  else
    LATEST="$AZ_OUT"
    azq containerapp revision show -n "$APP" -g "$RG" --revision "$LATEST" --query properties.healthState -o tsv
    if [ "$AZ_RC" -ne 0 ]; then
      echo "::warning::$APP health read $i/$ATTEMPTS: the health of $LATEST could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"
    else
      HEALTH="$AZ_OUT"
      echo "$APP revision=$LATEST health=$HEALTH ($i/$ATTEMPTS)"
      if [ "$HEALTH" = Healthy ]; then exit 0; fi
    fi
  fi
  [ "$i" -lt "$ATTEMPTS" ] && sleep "$INTERVAL"
done
echo "::error::$APP: revision ${LATEST:-<not read>} did not report Healthy after $ATTEMPTS reads (last health: ${HEALTH:-<not read>}). Refusing to continue on a revision that is not serving."
diagnose
exit 1
