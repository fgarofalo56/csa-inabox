#!/usr/bin/env bash
# =============================================================================
# containerapp-revision-check.sh — wait for a Container App revision, or say
# why a deployment of it failed
# =============================================================================
#
# WHY THIS EXISTS
#
# gov-uc-purview-wire.yml's loom-unity deploy printed raw ARM JSON on failure
# and nothing else, and its health loop discarded stderr and never failed. On
# 2026-09-30 the deploy failed with only "Operation expired"; the next day a
# separate diagnostic run found the pull identity held no visible pull role,
# the probable cause.
#
# SUBCOMMANDS
#
#   wait      --app A --rg RG [--since T] [--acr N] [--identity-name N] [--diagnostics-hint TEXT]
#             Polls the latest revision's health (bounded). Exit 0 when it reports
#             Healthy; otherwise runs `diagnose` and exits 1. A failed read is
#             reported, never treated as "not yet healthy" in silence.
#   diagnose  --app A --rg RG [--since T] [--attempt N] [--acr N] [--identity-name N]
#             [--deploy-stderr FILE] [--diagnostics-hint TEXT]
#             Reports only on a revision created at or after --since (the deploy
#             start, UTC ISO 8601). If the deployment created none, it says so
#             and reads the app's provisioning state instead. With --since it
#             also reads the environment's system log from that time (Log
#             Analytics). It classifies the failure and prints a remediation
#             (deploy-integrity R6).
#
# DIAGNOSE EXIT CODES (the class)
#   10  retry       another operation was in progress (read from the deployment
#                   error only); with --attempt 2 or more it is reported exhausted
#   11  permission  the image pull was refused (authorization)
#   12  missing     the image or digest is not in the registry
#   13  pull        the image pull failed for a reason not shown
#   14  image       the image pulled and started; the fault is at or after start
#   15  capacity    quota or capacity
#   16  unknown     no classifiable signal
#
# Only platform fields are printed (state, provisioningError, runningState,
# runningStateDetails, restart counts, system-log type/reason/message) plus the
# deployment's own error text. Each block of Azure text is wrapped in
# ::stop-commands:: with a fresh random token, and GUIDs are masked. Nothing in
# it is specific to one cloud; the boundary-specific pointer is --diagnostics-hint.
#
# ENVIRONMENT (tests shorten these)
#   LOOM_REVISION_WAIT_ATTEMPTS  default 20
#   LOOM_REVISION_WAIT_SECONDS   default 15
# =============================================================================
set -uo pipefail

CMD="${1:-}"; [ $# -gt 0 ] && shift
APP="" RG="" ACR="" IDN="" DEPLOY_STDERR="" SINCE="" ATTEMPT=1
HINT="read the environment's system log for this app since the deploy started"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --acr) ACR="${2:-}"; shift 2 ;;
    --identity-name) IDN="${2:-}"; shift 2 ;;
    --deploy-stderr) DEPLOY_STDERR="${2:-}"; shift 2 ;;
    --since) SINCE="${2:-}"; shift 2 ;;
    --attempt) ATTEMPT="${2:-1}"; shift 2 ;;
    --diagnostics-hint) HINT="${2:-}"; shift 2 ;;
    *) echo "::error::containerapp-revision-check: unknown argument '$1'"; exit 64 ;;
  esac
done
if [ -z "$APP" ] || [ -z "$RG" ] || { [ "$CMD" != wait ] && [ "$CMD" != diagnose ]; }; then
  echo "::error::usage: containerapp-revision-check.sh wait|diagnose --app NAME --rg RG [--since T] [--attempt N] [--acr NAME] [--identity-name NAME] [--deploy-stderr FILE] [--diagnostics-hint TEXT]"
  exit 64
fi
if [ -n "$SINCE" ] && ! [[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2} ]]; then
  echo "::error::containerapp-revision-check: --since must be a UTC ISO 8601 time (YYYY-MM-DDTHH:MM:SS...), got '$SINCE'"
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

# system_log_since: the environment's system log for this app from --since,
# appended to STATE_TEXT. Reads Log Analytics (the table shape follows the
# environment's log destination).
system_log_since() {
  local env_id dest law tbl appc t
  [ -n "$SINCE" ] || return 0
  azq containerapp show -n "$APP" -g "$RG" --query properties.environmentId -o tsv
  env_id="$AZ_OUT"
  if [ "$AZ_RC" -ne 0 ] || [ -z "$env_id" ]; then
    echo "(system log not read: the environment id could not be read, az exit $AZ_RC)"; return 0
  fi
  azq containerapp env show --ids "$env_id" --query "properties.appLogsConfiguration.destination || ''" -o tsv
  dest="$AZ_OUT"
  azq containerapp env show --ids "$env_id" --query "properties.appLogsConfiguration.logAnalyticsConfiguration.customerId || ''" -o tsv
  law="$AZ_OUT"
  case "$dest" in
    log-analytics) tbl=ContainerAppSystemLogs_CL; appc=ContainerAppName_s
      t="strcat(format_datetime(TimeGenerated,'yyyy-MM-dd HH:mm:ss'),' ',RevisionName_s,' ',tostring(column_ifexists('Type_s','')),' ',tostring(column_ifexists('Reason_s','')),' ',translate('\r\n\t',' ',Log_s))" ;;
    azure-monitor) tbl=ContainerAppSystemLogs; appc=ContainerAppName
      t="strcat(format_datetime(TimeGenerated,'yyyy-MM-dd HH:mm:ss'),' ',RevisionName,' ',Type,' ',Reason,' ',translate('\r\n\t',' ',Log))" ;;
    *) echo "(system log not read: the environment's log destination is '${dest:-unknown}', not a Log Analytics workspace this script reads)"; return 0 ;;
  esac
  if [ -z "$law" ] || [[ "$law" =~ [^0-9A-Fa-f-] ]]; then
    echo "(system log not read: no Log Analytics workspace id on the environment)"; return 0
  fi
  azq extension add -n log-analytics -y --only-show-errors
  azq monitor log-analytics query -w "$law" -o tsv --query "[].line" --analytics-query \
    "$tbl | where TimeGenerated >= datetime(${SINCE:0:19}Z) | where $appc == '$APP' | top 50 by TimeGenerated desc | order by TimeGenerated asc | project line=$t"
  if [ "$AZ_RC" -ne 0 ]; then
    echo "(system log not read: the query exited $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"; return 0
  fi
  if [ -z "$AZ_OUT" ]; then
    echo "(system log since ${SINCE:0:19}Z: 0 rows. Log Analytics ingestion can lag by several minutes, so this is not evidence that no events occurred.)"
    return 0
  fi
  echo "--- system log for $APP since ${SINCE:0:19}Z (newest 50) ---"
  printf '%s\n' "$AZ_OUT" | shield
  STATE_TEXT="$STATE_TEXT $AZ_OUT"
}

diagnose() {
  local deploy_text="" rev="" created="" cls
  STATE_TEXT=""
  if [ -n "$DEPLOY_STDERR" ] && [ -s "$DEPLOY_STDERR" ]; then
    echo "--- deployment error (first 40 lines) ---"
    head -n 40 "$DEPLOY_STDERR" | shield
    deploy_text=$(head -c 20000 "$DEPLOY_STDERR")
  fi
  # A list multiselect with -o tsv prints one value per line.
  azq containerapp revision list -n "$APP" -g "$RG" --all \
    --query "sort_by([], &properties.createdTime)[-1].[name, properties.createdTime]" -o tsv
  if [ "$AZ_RC" -ne 0 ]; then
    echo "::warning::the revisions of $APP could not be read (az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline)); classifying without them."
  else
    { read -r rev; read -r created; } <<< "$AZ_OUT"
  fi
  if [ -n "$rev" ] && [ -n "$SINCE" ] && [[ "${created:0:19}" < "${SINCE:0:19}" ]]; then
    echo "No revision was created by this deploy: the newest, $rev (created ${created:0:19}Z), predates its start (${SINCE:0:19}Z), so its state is not reported."
    azq containerapp show -n "$APP" -g "$RG" --query properties.provisioningState -o tsv
    echo "$APP provisioningState: ${AZ_OUT:-<not read, az exit $AZ_RC>}"
    rev=""
  fi
  if [ -n "$rev" ]; then
    azq containerapp revision show -n "$APP" -g "$RG" --revision "$rev" \
      --query "{name:name,created:properties.createdTime,active:properties.active,provisioning:properties.provisioningState,provisioningError:properties.provisioningError,running:properties.runningState,runningDetails:properties.runningStateDetails,health:properties.healthState}" -o json
    if [ "$AZ_RC" -eq 0 ]; then
      echo "--- revision $rev ---"
      printf '%s\n' "$AZ_OUT" | shield
      STATE_TEXT="$STATE_TEXT $AZ_OUT"
    else
      echo "(revision $rev could not be read: az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"
    fi
    azq containerapp replica list -n "$APP" -g "$RG" --revision "$rev" \
      --query "[].{name:name,running:properties.runningState,details:properties.runningStateDetails,containers:properties.containers[].{name:name,ready:ready,started:started,restarts:restartCount,state:runningState,details:runningStateDetails}}" -o json
    if [ "$AZ_RC" -eq 0 ]; then
      echo "--- replicas of $rev ---"
      printf '%s\n' "$AZ_OUT" | shield
      STATE_TEXT="$STATE_TEXT $AZ_OUT"
    else
      echo "(replicas of $rev could not be read: az exit $AZ_RC: $(printf '%s' "$AZ_ERR" | oneline))"
    fi
  fi
  system_log_since

  local all="$deploy_text $STATE_TEXT"
  cls=unknown
  shopt -s nocasematch
  if [[ "$deploy_text" =~ OperationInProgress|another\ operation\ is\ in\ progress|operation\ is\ already\ in\ progress ]]; then
    cls=retry
  elif [[ "$all" =~ manifest\ unknown|not\ found:\ manifest ]]; then
    cls=missing
  elif [[ "$all" =~ (ImagePull|failed\ to\ pull|pull\ access|pulling\ image) ]] \
    && [[ "$all" =~ (unauthori[sz]ed|authentication\ required|denied|forbidden|(^|[^0-9])40[13]([^0-9]|$)) ]]; then
    cls=permission
  elif [[ "$all" =~ ImagePullBackOff|ErrImagePull|failed\ to\ pull ]]; then
    cls=pull
  elif [[ "$all" =~ CrashLoopBackOff|Back-off\ restarting|probe\ failed|Probe\ of|ContainerTerminated|exited\ with\ code|OOMKilled ]]; then
    cls=image
  elif [[ "$all" =~ QuotaExceeded|exceeds\ quota|InsufficientCapacity|SubscriptionIsOverQuota ]]; then
    cls=capacity
  fi
  local expired=no
  if [[ "$all" =~ Operation\ expired ]]; then expired=yes; fi
  shopt -u nocasematch

  case "$cls" in
    retry)
      if [ "$ATTEMPT" -ge 2 ]; then
        echo "::error::$APP: classified RETRY again on attempt $ATTEMPT; the one retry is exhausted. Wait for the in-progress operation on the app to finish, then re-dispatch."
      else
        echo "::warning::$APP: classified RETRY. The deployment reported another operation in progress on the app; one retry is valid."
      fi
      return 10 ;;
    permission)
      echo "::error::$APP: classified PERMISSION (image pull refused). The pull identity${IDN:+ $IDN} could not pull from registry ${ACR:-<registry>}. Remediation: grant AcrPull (role definition 7f951dda-4ed3-4680-a7ca-43fe172d538d) on the registry to that identity (az role assignment create --assignee-object-id \"\$(az identity show -n ${IDN:-<identity>} -g $RG --query principalId -o tsv)\" --assignee-principal-type ServicePrincipal --role 7f951dda-4ed3-4680-a7ca-43fe172d538d --scope \"\$(az acr show -n ${ACR:-<registry>} --query id -o tsv)\"), then re-dispatch."
      return 11 ;;
    missing)
      echo "::error::$APP: classified MISSING IMAGE. The registry answered that the image or digest does not exist. Remediation: rebuild and push the image to ${ACR:-the registry}, confirm the digest resolves, then re-dispatch."
      return 12 ;;
    pull)
      echo "::error::$APP: classified PULL FAILURE without an authorization or not-found signal in the fields read. Remediation: check registry reachability from the environment (private endpoint, DNS) and the pull identity's AcrPull on ${ACR:-the registry}, then re-dispatch."
      return 13 ;;
    image)
      echo "::error::$APP: classified IMAGE. The image pulled and the container started; the fault is at or after container start (the image, its entrypoint, or the env and secrets the deployment wired). Remediation: $HINT, fix the cause, then re-dispatch."
      return 14 ;;
    capacity)
      echo "::error::$APP: classified CAPACITY/QUOTA. Remediation: request quota for the environment's workload profile in this region, or reduce the requested replicas or resources, then re-dispatch."
      return 15 ;;
    *)
      local exp_note=""
      if [ "$expired" = yes ]; then
        exp_note=" 'Operation expired' on its own means the revision did not become ready within ARM's provisioning window and does not say why."
      fi
      echo "::error::$APP: UNCLASSIFIED. Neither the deployment error, the state of a revision this deploy created, nor the system log since it started carries a pull, crash, probe, quota or in-progress signal.${exp_note} Remediation: $HINT."
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
