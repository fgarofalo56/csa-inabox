#!/usr/bin/env bash
# CSA Loom — collect the internal-token FINGERPRINT of every holder on a live
# estate and emit the holders.json that scripts/ci/internal-token-drift-verdict.mjs
# renders a verdict from. (#3056)
#
# Values are NEVER emitted — only sha256(value) truncated to 12 hex chars, the
# same comparison the 2026-08-06/07 triage used, so the output is safe to paste
# into an issue or a workflow log.
#
# The GitHub Actions secret cannot be READ back by anyone (GitHub secrets are
# write-only), so its fingerprint is computed in-workflow from the secret the
# runner is given and passed in via GITHUB_SECRET_FINGERPRINT. When that env is
# unset the holder is recorded `unknown` — NOT `ok` — because "we did not look"
# must never render as "it matches".
#
# Usage:
#   ADMIN_RG=rg-csa-loom-admin-centralus \
#   GITHUB_SECRET_FINGERPRINT=$(printf '%s' "$SECRET" | sha256sum | cut -c1-12) \
#   scripts/csa-loom/collect-internal-token-fingerprints.sh > holders.json
#
# No `|| true`, no `2>/dev/null`, no `continue-on-error`: a collector that
# swallows a failed read reports a converged estate it never measured.

set -euo pipefail

CONSOLE_APP="${CONSOLE_APP:-loom-console}"
SECRET_NAME="${SECRET_NAME:-loom-internal-token}"
ESTATE="${ESTATE:-commercial}"
ADMIN_RG="${ADMIN_RG:-}"

ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

log() { printf '[collect-internal-token] %s\n' "$*" >&2; }

fp() { printf '%s' "$1" | sha256sum | cut -c1-12; }

json_escape() { printf '%s' "$1" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

if [ -z "$ADMIN_RG" ]; then
  if ! ADMIN_RG=$(az containerapp list --query "[?name=='${CONSOLE_APP}'].resourceGroup | [0]" -o tsv 2>"$ERR_FILE"); then
    log "ERROR: could not list Container Apps; the collection did not happen."
    cat "$ERR_FILE" >&2
    exit 1
  fi
  ADMIN_RG="$(printf '%s' "$ADMIN_RG" | tr -d '\r')"
fi
if [ -z "$ADMIN_RG" ]; then
  log "ERROR: no '${CONSOLE_APP}' Container App is visible. Refusing to emit an empty holder set —"
  log "       the verdict script fails on an empty set precisely so this cannot read as a pass."
  exit 1
fi

HOLDERS=""
add_holder() { HOLDERS="${HOLDERS:+$HOLDERS,}$1"; }

# ── 1. The console — the owner of record. ─────────────────────────────────────
if CONSOLE_VAL=$(az containerapp secret list -n "$CONSOLE_APP" -g "$ADMIN_RG" --show-values \
      --query "[?name=='${SECRET_NAME}'].value | [0]" -o tsv 2>"$ERR_FILE"); then
  CONSOLE_VAL="$(printf '%s' "$CONSOLE_VAL" | tr -d '\r\n')"
  if [ -n "$CONSOLE_VAL" ]; then
    add_holder "{\"name\":\"${CONSOLE_APP}\",\"kind\":\"console\",\"state\":\"present\",\"fingerprint\":\"$(fp "$CONSOLE_VAL")\"}"
  else
    add_holder "{\"name\":\"${CONSOLE_APP}\",\"kind\":\"console\",\"state\":\"absent\"}"
  fi
else
  DETAIL="$(json_escape "$(cat "$ERR_FILE")")"
  add_holder "{\"name\":\"${CONSOLE_APP}\",\"kind\":\"console\",\"state\":\"unknown\",\"detail\":${DETAIL}}"
fi

# ── 2. Every Container Apps JOB that declares the secret. ─────────────────────
# Enumerated LIVE rather than from a hard-coded list: a new consumer job added by
# a future bicep change is then covered automatically instead of silently
# escaping the guard.
if ! JOBS=$(az containerapp job list -g "$ADMIN_RG" --query "[].name" -o tsv 2>"$ERR_FILE"); then
  log "ERROR: could not list Container Apps jobs; the collection is incomplete."
  cat "$ERR_FILE" >&2
  exit 1
fi

while IFS= read -r JOB; do
  JOB="$(printf '%s' "$JOB" | tr -d '\r')"
  [ -n "$JOB" ] || continue
  if ! JOB_VAL=$(az containerapp job secret list -n "$JOB" -g "$ADMIN_RG" --show-values \
        --query "[?name=='${SECRET_NAME}'].value | [0]" -o tsv 2>"$ERR_FILE"); then
    DETAIL="$(json_escape "$(cat "$ERR_FILE")")"
    add_holder "{\"name\":\"${JOB}\",\"kind\":\"job\",\"state\":\"unknown\",\"detail\":${DETAIL}}"
    continue
  fi
  JOB_VAL="$(printf '%s' "$JOB_VAL" | tr -d '\r\n')"
  # A job with NO such secret is not a consumer at all — record it as absent but
  # NOT required, so the verdict does not fail on the 10 jobs that never had one.
  if [ -z "$JOB_VAL" ]; then
    continue
  fi
  add_holder "{\"name\":\"${JOB}\",\"kind\":\"job\",\"state\":\"present\",\"fingerprint\":\"$(fp "$JOB_VAL")\"}"
done <<< "$JOBS"

# ── 3. The GitHub Actions secret (fingerprint supplied by the workflow). ──────
if [ -n "${GITHUB_SECRET_FINGERPRINT:-}" ]; then
  add_holder "{\"name\":\"LOOM_INTERNAL_TOKEN\",\"kind\":\"github-secret\",\"state\":\"present\",\"fingerprint\":\"${GITHUB_SECRET_FINGERPRINT}\"}"
elif [ "${GITHUB_SECRET_EXPECTED:-true}" = "true" ]; then
  add_holder "{\"name\":\"LOOM_INTERNAL_TOKEN\",\"kind\":\"github-secret\",\"state\":\"unknown\",\"detail\":\"GITHUB_SECRET_FINGERPRINT was not supplied; the repo secret was not compared\"}"
fi

printf '{"estate":"%s","holders":[%s]}\n' "$ESTATE" "$HOLDERS"
