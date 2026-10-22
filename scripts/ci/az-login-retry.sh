#!/usr/bin/env bash
# =============================================================================
# az-login-retry.sh - service-principal `az login` with bounded retry.
# =============================================================================
#
# WHY (#5082 item 1). The pool_release job of build-fiab-images-acr-tasks.yml
# logged in through azure/login, which failed once with
#   JSON is invalid: Expecting value: line 1 column 1 (char 0)
# (an empty creds read, transient). The job never reached the scale-down, the
# build pool `loombuild2` stayed at count 2 and kept billing (~$1k/30d per S3
# pool). azure/login has no retry and `continue-on-error` would discard the
# result, so the release job logs in through this script instead: every attempt
# is a real `az login`, the LAST failure is printed (never discarded) and the
# script exits 1 when the budget is spent. It fails closed.
#
# Credentials come from the environment ONLY:
#   AZ_CLIENT_ID  AZ_CLIENT_SECRET  AZ_TENANT_ID  AZ_SUBSCRIPTION_ID
# An EMPTY value is retried like any other failure: the incident was an empty
# read, and a transiently empty secret expansion is exactly that shape.
#
# USAGE  bash scripts/ci/az-login-retry.sh [--cloud AzureUSGovernment]
#                                          [--attempts 5] [--backoff 15]
# Exit:  0 logged in and subscription selected / 1 budget exhausted / 3 usage
# -----------------------------------------------------------------------------
set -uo pipefail

CLOUD=""
ATTEMPTS=5
BACKOFF=15
while [ $# -gt 0 ]; do
  case "$1" in
    --cloud) CLOUD="${2:-}"; shift 2 ;;
    --attempts) ATTEMPTS="${2:-5}"; shift 2 ;;
    --backoff) BACKOFF="${2:-15}"; shift 2 ;;
    *) echo "az-login-retry: unknown argument '$1'" >&2; exit 3 ;;
  esac
done

if [ -n "$CLOUD" ]; then
  if ! az cloud set --name "$CLOUD"; then
    echo "::error::az-login-retry: 'az cloud set --name $CLOUD' failed, so no login was attempted." >&2
    exit 1
  fi
fi

LAST=""
SECONDS=0
for i in $(seq 1 "$ATTEMPTS"); do
  if [ -z "${AZ_CLIENT_ID:-}" ] || [ -z "${AZ_CLIENT_SECRET:-}" ] || [ -z "${AZ_TENANT_ID:-}" ] || [ -z "${AZ_SUBSCRIPTION_ID:-}" ]; then
    OUT="one or more of AZ_CLIENT_ID / AZ_CLIENT_SECRET / AZ_TENANT_ID / AZ_SUBSCRIPTION_ID is empty on this runner"
    RC=1
  else
    OUT="$(az login --service-principal -u "$AZ_CLIENT_ID" -p "$AZ_CLIENT_SECRET" --tenant "$AZ_TENANT_ID" --output none 2>&1 \
      && az account set --subscription "$AZ_SUBSCRIPTION_ID" 2>&1)"
    RC=$?
  fi
  if [ "$RC" -eq 0 ]; then
    [ "$i" -gt 1 ] && echo "::notice::az-login-retry: logged in on attempt ${i}."
    exit 0
  fi
  LAST="$OUT"
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "::warning::az-login-retry: attempt ${i}/${ATTEMPTS} failed; waiting ${BACKOFF}s. $(printf '%s' "$OUT" | tr -d '\r' | tr '\n' ' ' | cut -c1-200)"
    sleep "$BACKOFF"
  fi
done
echo "::error::az-login-retry: could NOT log in after ${ATTEMPTS} attempts over ${SECONDS}s. LAST ERROR: $(printf '%s' "$LAST" | tr -d '\r' | tr '\n' ' ' | cut -c1-400)" >&2
exit 1
