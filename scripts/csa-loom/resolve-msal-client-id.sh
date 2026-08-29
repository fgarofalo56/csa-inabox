#!/usr/bin/env bash
# =====================================================================
# CSA Loom — resolve the estate's EXISTING Entra (MSAL) app-registration
# client id, for re-runs of the push-button deploy.
# =====================================================================
# svc-loom-unity-authz (round 2). An Entra app registration is a Microsoft Graph
# object; ARM/bicep cannot create one. Deploy phase 3
# (scripts/csa-loom/bootstrap-msal-app-reg.sh) creates it and stamps
# LOOM_MSAL_CLIENT_ID onto the running Console Container App.
#
# The problem this script fixes: every LATER `az deployment sub create` re-renders
# the whole ACA template from `readEnvironmentVariable('LOOM_MSAL_CLIENT_ID','')`.
# With that env unset the template renders an EMPTY client id, which
# blanking the Console's LOOM_MSAL_CLIENT_ID and taking sign-in dark — silently
# undoing phase 3. A declarative ACA template removes any env var it does not
# declare, so this is not hypothetical.
#
# Resolution order (first non-empty wins), all READ-ONLY:
#   1. $LOOM_MSAL_CLIENT_ID already in the environment (explicit operator/CI value)
#   2. Key Vault secret `loom-msal-client-id` in the estate's admin Key Vault
#      (written by bootstrap-msal-app-reg.sh)
#   3. The LOOM_MSAL_CLIENT_ID env var on the live Console Container App
#      (covers estates bootstrapped before the Key Vault record existed)
#
# ── ABSENT IS NOT UNKNOWN (deploy-integrity.md R7) ────────────────────────────
# Until 2026-08-27 every read above ended `2>/dev/null`, and the script had
# exactly one outcome for failure and for absence: print nothing, `exit 0`. So an
# expired token, an RBAC denial, a throttle, or the wrong subscription context all
# rendered as "no app registration exists" — and line 92 SAID so, in those words,
# without having established it. That is verbatim the construct R7 was written
# about ("the tag does not exist" when the truth was "I could not reach the
# registry"), and the blast radius here is larger: an empty result makes the next
# ACA template render drop LOOM_MSAL_CLIENT_ID and take sign-in dark, and it also
# empties LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE (admin-plane/main.bicep
# :4718-4719), which fails the Loom Unity catalog closed on every call.
#
# So this script now distinguishes THREE states, the same present/absent/unknown
# model scripts/ci/internal-token-drift-verdict.mjs already uses:
#
#   exit 0 + a client id on stdout  PRESENT — resolved.
#   exit 0 + empty stdout           ABSENT  — the reads SUCCEEDED and there is no
#                                             registration. Correct on a genuinely
#                                             fresh subscription; the deploy renders
#                                             an empty client id and the catalog
#                                             deploys sealed rather than open.
#   exit 3 + empty stdout           UNKNOWN — a read FAILED. The caller must NOT
#                                             treat this as absence. Rendering an
#                                             empty client id here is destructive,
#                                             so this fails the step instead.
#
# Callers must therefore NOT wrap this in `|| true`. That construct predates the
# unknown state and would convert it straight back into a silent empty.
#
# Usage:
#   CID=$(bash scripts/csa-loom/resolve-msal-client-id.sh)          # auto-discover
#   CID=$(bash scripts/csa-loom/resolve-msal-client-id.sh --rg rg-csa-loom-admin-eastus2)
#   echo "LOOM_MSAL_CLIENT_ID=$CID" >> "$GITHUB_ENV"
# =====================================================================
set -uo pipefail

RG="${LOOM_ADMIN_RG:-}"
KV="${LOOM_ADMIN_KEYVAULT:-}"
CONSOLE_APP="${CONSOLE_APP_NAME:-loom-console}"
SECRET_NAME="${MSAL_CLIENT_ID_SECRET_NAME:-loom-msal-client-id}"

EXIT_UNKNOWN=3

while [ $# -gt 0 ]; do
  case "$1" in
    --rg) RG="${2:-}"; shift 2 ;;
    --keyvault) KV="${2:-}"; shift 2 ;;
    --console-app) CONSOLE_APP="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

log() { echo "[resolve-msal-client-id] $*" >&2; }

ERRF="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '$ERRF'" EXIT

# Stderr from a failed `az` read, trimmed. Never carries a secret VALUE: every
# call below is a control-plane read whose error text names the resource, and on
# the one call that could return a value (`keyvault secret show`) a non-zero exit
# means no value was produced at all.
az_err() { tr '\n' ' ' < "$ERRF" | cut -c1-400; }

# A read that returned non-zero because the thing genuinely is not there, as
# opposed to one that could not be performed. Keyed to the ARM/Graph error CODES,
# not to prose, so a reworded message does not silently reclassify a failure as
# an absence.
is_not_found() {
  grep -qE 'SecretNotFound|ResourceNotFound|ParentResourceNotFound|\(NotFound\)|ResourceGroupNotFound' "$ERRF"
}

unknown() {
  log "UNKNOWN — $1"
  log "This is NOT 'no app registration exists'. Rendering an empty LOOM_MSAL_CLIENT_ID"
  log "would drop the env var from the ACA template and take sign-in dark, and would"
  log "also empty LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE. Failing closed instead."
  printf ''
  exit "$EXIT_UNKNOWN"
}

# ── A FAILED SOURCE ENDS THAT SOURCE, NOT THE SEARCH (#4163) ──────────────────
#
# deploy-fiab-commercial run 33199055298 (2026-08-28) failed here, and the two
# runs before it had SUCCEEDED. Measured, the estate had not changed: the
# Key Vault carries publicNetworkAccess=Disabled with networkAcls.defaultAction
# =Deny, and `az monitor activity-log` records ZERO vault writes since
# 2026-08-25. It has been unreachable from a hosted runner the whole time, and
# `actions/runners` reports total_count 0, so there is no in-VNet runner either.
#
# What changed was this script. #4127 correctly stopped it reporting "no app
# registration" when a read had FAILED — but it wired that verdict to exit
# IMMEDIATELY, so a Key Vault the runner cannot reach ended the search before
# source 3. Source 3 is the live Console Container App, an ARM CONTROL-plane
# read that the runner CAN make, and it is what had been answering all along.
#
# So the #4127 invariant is kept exactly — an unreadable source is never an
# absence — but it is now evaluated over ALL sources rather than the first one
# that fails. A failure is REMEMBERED and only becomes the verdict if nothing
# else resolves a value.
#
# The asymmetry is deliberate and is the whole safety argument:
#
#   a later source returns a VALUE   -> exit 0. The question was "which client
#                                       id", and it has been answered. An
#                                       unreadable Key Vault does not make a
#                                       present, live answer less true.
#   every source returns NOTHING and
#     at least one FAILED            -> UNKNOWN. This is the case that must not
#                                       collapse to absence: the durable record
#                                       could not be read, so "nothing found"
#                                       is not the same as "nothing exists".
#   every source returns NOTHING and
#     all SUCCEEDED                  -> absence, exit 0 with empty output.
DEFERRED_UNKNOWN=""

defer_unknown() {
  # The message is captured NOW. `az_err` reads $ERRF, which the next az call
  # overwrites — deferring the read would report a later command's stderr as
  # this failure's cause, which is the R7 error this file exists to prevent.
  [ -n "$DEFERRED_UNKNOWN" ] || DEFERRED_UNKNOWN="$1"
  log "source unreadable, continuing to the next source — $1"
}

# 1 — already supplied.
if [ -n "${LOOM_MSAL_CLIENT_ID:-}" ]; then
  log "using LOOM_MSAL_CLIENT_ID from the environment"
  printf '%s' "${LOOM_MSAL_CLIENT_ID}"
  exit 0
fi

# Discover the admin resource group when not given. This is a LIST: it returns 0
# with an empty result when nothing matches, so non-zero is unambiguously a
# failure to read and never an absence.
if [ -z "${RG}" ]; then
  raw="$(az group list --query "[?starts_with(name,'rg-csa-loom-admin-')].name | [0]" -o tsv 2>"$ERRF")"
  rc=$?
  [ "$rc" -eq 0 ] || unknown "could not list resource groups (az exited $rc): $(az_err)"
  RG="$(printf '%s' "$raw" | tr -d '\r')"
fi
if [ -z "${RG}" ]; then
  log "no rg-csa-loom-admin-* resource group in this subscription — fresh estate, no app registration yet"
  printf ''
  exit 0
fi

# 2 — Key Vault record (the durable one bootstrap-msal-app-reg.sh writes).
if [ -z "${KV}" ]; then
  raw="$(az keyvault list -g "${RG}" --query "[0].name" -o tsv 2>"$ERRF")"
  rc=$?
  [ "$rc" -eq 0 ] || defer_unknown "could not list key vaults in ${RG} (az exited $rc): $(az_err)"
  KV="$(printf '%s' "$raw" | tr -d '\r')"
fi
if [ -n "${KV}" ]; then
  raw="$(az keyvault secret show --vault-name "${KV}" --name "${SECRET_NAME}" --query value -o tsv 2>"$ERRF")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    # A missing secret is a legitimate absence — fall through to source 3.
    # Anything else (403 on the data plane, firewall, expired token) is unknown,
    # and is now DEFERRED rather than terminal: the firewall denial that broke
    # run 33199055298 lands here, and source 3 can still answer.
    if is_not_found; then
      log "no ${SECRET_NAME} secret in ${KV} — trying the live Console app"
    else
      defer_unknown "could not read ${KV}/${SECRET_NAME} (az exited $rc): $(az_err)"
    fi
  else
    CID="$(printf '%s' "$raw" | tr -d '\r')"
    if [ -n "${CID:-}" ]; then
      log "resolved from Key Vault ${KV}/${SECRET_NAME}"
      printf '%s' "${CID}"
      exit 0
    fi
  fi
fi

# 3 — the live Console Container App (pre-Key-Vault estates).
raw="$(az containerapp show -n "${CONSOLE_APP}" -g "${RG}" \
  --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" \
  -o tsv 2>"$ERRF")"
rc=$?
if [ "$rc" -ne 0 ]; then
  # No console app yet is a legitimate absence on a part-built estate.
  if is_not_found; then
    log "no ${CONSOLE_APP} Container App in ${RG} yet"
  else
    defer_unknown "could not read the ${CONSOLE_APP} Container App in ${RG} (az exited $rc): $(az_err)"
  fi
else
  CID="$(printf '%s' "$raw" | tr -d '\r')"
  if [ -n "${CID:-}" ] && [ "${CID}" != "None" ]; then
    # A PRESENT value settles it, even if an earlier source was unreadable —
    # that is the #4163 asymmetry. The unreadable source is still reported,
    # because an estate whose durable record cannot be read is a real condition
    # the operator should see even when the deploy proceeds.
    if [ -n "$DEFERRED_UNKNOWN" ]; then
      log "NOTE — an earlier source could not be read: ${DEFERRED_UNKNOWN}"
      log "Resolving anyway: the live Container App returned a value, which answers the question that source could not."
    fi
    log "resolved from the live ${CONSOLE_APP} Container App (consider re-running bootstrap-msal-app-reg.sh so it is also recorded in Key Vault)"
    printf '%s' "${CID}"
    exit 0
  fi
fi

# Nothing resolved. Whether that is ABSENCE or UNKNOWN turns entirely on whether
# every read actually completed — the distinction #4127 exists to preserve.
if [ -n "$DEFERRED_UNKNOWN" ]; then
  unknown "$DEFERRED_UNKNOWN — and no later source resolved a value either, so absence cannot be distinguished from an unreadable estate"
fi

log "no existing app registration found in ${RG} — every read SUCCEEDED and returned nothing (this is absence, not an unreadable estate). The deploy will render an empty client id; sign-in stays unconfigured until deploy phase 3 runs."
printf ''
exit 0
