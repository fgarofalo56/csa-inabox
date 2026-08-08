#!/usr/bin/env bash
# CSA Loom — resolve the estate's LIVE shared internal trust token so a deploy
# ADOPTS it instead of minting a new one.  (#3056)
#
# ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
# `LOOM_INTERNAL_TOKEN` had TWO writers and no owner, and it broke the estate
# three times in two days:
#
#   * bicep minted it as `guid(loomGeneratedSecretSeed, 'loom-maf-internal-token-v1')`.
#     `loomGeneratedSecretSeed` defaults to `newGuid()`, which the compiled
#     template carries as `"defaultValue": "[newGuid()]"` — ARM re-evaluates it
#     on EVERY deployment.  The comment claiming the value was "deterministic"
#     was true only WITHIN a single deployment: the console and the jobs matched
#     each other, and every holder outside that deployment was silently
#     invalidated.  Every admin-plane deploy was an unannounced rotation.
#   * out-of-band rotations (an operator / an agent writing the console secret
#     directly) wrote a different, longer value.
#
# Whichever ran last won.  Container Apps does NOT restart replicas on a secret
# write, so the mismatch sat latent and detonated hours later when the console
# revision happened to cycle — 153/153 eval probes 401'd on 2026-08-06, and
# #2929's `reindex rejected (HTTP 401)` had the same single root.
#
# ── THE OWNERSHIP MODEL ────────────────────────────────────────────────────────
# The LIVE ESTATE owns the value.  bicep only adopts it.  This script is the
# single existing-value lookup that every deploy path calls before
# `az deployment sub create`, and it feeds `main.bicep`'s
# `loomInternalTokenValue` parameter.
#
# The lookup is an ARM CONTROL-plane read of the running console's Container
# Apps secret.  That matters: the Loom Key Vault is created with
# `publicNetworkAccess: Disabled`, so a Key-Vault-backed source of truth would
# be unreachable from the GitHub-hosted runners that run the deploys (which is
# precisely why `ops-kv-secret-sync.yml` needs the in-VNet runner).  The
# Container Apps secret is reachable from anywhere with RBAC on the app, so this
# lookup works on hosted runners, on the self-hosted in-VNet runner, in
# Commercial and in Gov, with no extra hop.
#
# ── SECRET HYGIENE ─────────────────────────────────────────────────────────────
# The value is NEVER printed.  Only a sha256 fingerprint (first 12 hex chars)
# and the length reach stdout / the workflow log — the same comparison the
# 2026-08-06/07 triage used.  Under GitHub Actions the value is registered with
# `::add-mask::` before it is written anywhere.
#
# ── USAGE ──────────────────────────────────────────────────────────────────────
#   # 1. Deploy paths — resolve, mask, export, then pass to ARM:
#   eval "$(scripts/csa-loom/resolve-internal-token.sh --export)"
#   #   -> exports LOOM_INTERNAL_TOKEN (empty on a greenfield estate)
#   #   -> under Actions also appends it to $GITHUB_ENV, masked
#   [ -n "$LOOM_INTERNAL_TOKEN" ] && add --parameters "loomInternalTokenValue=$LOOM_INTERNAL_TOKEN"
#
#   # 2. Fingerprint only (drift checks, receipts) — never emits the value:
#   scripts/csa-loom/resolve-internal-token.sh --fingerprint
#
#   # 3. Deliberate rotation (the ONLY supported rotation path).  Writes a new
#   #    value to the console secret; the NEXT deploy adopts it:
#   scripts/csa-loom/resolve-internal-token.sh --rotate
#
# Environment:
#   CONSOLE_APP   Container App holding the secret   (default: loom-console)
#   ADMIN_RG      Resource group                     (default: auto-discovered)
#   SECRET_NAME   Secret name                        (default: loom-internal-token)
#
# Exit codes: 0 = resolved (or honestly greenfield), 1 = an error we will not
# paper over.  There is deliberately no `|| true` and no `2>/dev/null` anywhere
# in this file: per deploy-integrity.md R7 a discarded stderr is how a permission
# denial gets reported as "the secret does not exist", which sent two separate
# investigations down the wrong path on 2026-08-05.

set -euo pipefail

CONSOLE_APP="${CONSOLE_APP:-loom-console}"
SECRET_NAME="${SECRET_NAME:-loom-internal-token}"
ADMIN_RG="${ADMIN_RG:-}"

MODE="${1:---export}"

log() { printf '[resolve-internal-token] %s\n' "$*" >&2; }

fingerprint() {
  # sha256 of the exact bytes, first 12 hex chars. Matches the comparison used
  # in the 2026-08-06/07 triage so receipts are directly comparable.
  printf '%s' "$1" | sha256sum | cut -c1-12
}

# ── Locate the app ─────────────────────────────────────────────────────────────
# `az containerapp list` returns [] for "no such app" AND for "no read access".
# Those are different facts and must not collapse into the same message (R7).
#
# stderr is captured to a FILE rather than folded in with `2>&1`: the az
# containerapp extension prints a "The behavior of this command has been altered
# by the following extension" WARNING on stderr on every invocation, and folding
# that into stdout makes the warning text itself look like a resource group /
# secret value. It is still reported verbatim on failure — captured, not
# discarded, so R7 holds.
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

if [ -z "$ADMIN_RG" ]; then
  if ! LIST_OUT=$(az containerapp list --query "[?name=='${CONSOLE_APP}'].resourceGroup" -o tsv 2>"$ERR_FILE"); then
    log "ERROR: could not list Container Apps. This is NOT the same as 'the console does not exist' —"
    log "       it means the lookup could not be performed at all. az said:"
    cat "$ERR_FILE" >&2
    exit 1
  fi
  ADMIN_RG="$(printf '%s' "$LIST_OUT" | head -n1 | tr -d '\r')"
fi

if [ -z "$ADMIN_RG" ]; then
  # Genuinely nothing to adopt: greenfield. bicep mints, and that is correct.
  log "GREENFIELD — no '${CONSOLE_APP}' Container App is visible in this subscription."
  log "             bicep will mint the internal token on this deploy. Nothing is being clobbered."
  case "$MODE" in
    --fingerprint) echo "absent" ;;
    --rotate)
      log "ERROR: --rotate needs an existing console. Deploy the estate first."
      exit 1
      ;;
    *)
      echo "export LOOM_INTERNAL_TOKEN=''"
      if [ -n "${GITHUB_ENV:-}" ]; then echo "LOOM_INTERNAL_TOKEN=" >> "$GITHUB_ENV"; fi
      ;;
  esac
  exit 0
fi

# ── Read the live value (control plane; no VNet, no KV data plane) ─────────────
read_live() {
  local out
  if ! out=$(az containerapp secret list -n "$CONSOLE_APP" -g "$ADMIN_RG" --show-values \
        --query "[?name=='${SECRET_NAME}'].value | [0]" -o tsv 2>"$ERR_FILE"); then
    log "ERROR: reading the '${SECRET_NAME}' secret on ${CONSOLE_APP} FAILED. This is not evidence"
    log "       that the secret is absent — it is evidence the read did not happen. az said:"
    cat "$ERR_FILE" >&2
    return 1
  fi
  printf '%s' "$out" | tr -d '\r\n'
}

case "$MODE" in
  --rotate)
    NEW="$(openssl rand -hex 32)"
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$NEW"; fi
    az containerapp secret set -n "$CONSOLE_APP" -g "$ADMIN_RG" \
      --secrets "${SECRET_NAME}=${NEW}" -o none
    NEW_FP="$(fingerprint "$NEW")"
    log "ROTATED ${CONSOLE_APP}/${SECRET_NAME} -> fingerprint ${NEW_FP} (len ${#NEW})."
    log "NEXT STEPS — the rotation is not complete until every holder converges:"
    log "  1. Redeploy (or run the deploy workflow): bicep ADOPTS this value and"
    log "     re-stamps the consumer jobs in the same deployment."
    log "  2. Update the LOOM_INTERNAL_TOKEN GitHub Actions secret to the same value."
    log "  3. Restart the console revision so replicas stop serving the OLD value"
    log "     (Container Apps does not restart on a secret write — that lag is what"
    log "     detonated on 2026-08-06)."
    log "  4. Run .github/workflows/loom-internal-token-drift.yml to confirm convergence."
    echo "$NEW_FP"
    ;;

  --fingerprint)
    VAL="$(read_live)"
    if [ -z "$VAL" ]; then
      log "The console exists but holds NO '${SECRET_NAME}' secret."
      echo "absent"
      exit 0
    fi
    log "${CONSOLE_APP}/${SECRET_NAME}: fingerprint $(fingerprint "$VAL") len ${#VAL}"
    fingerprint "$VAL"
    ;;

  --export)
    VAL="$(read_live)"
    if [ -z "$VAL" ]; then
      log "The console exists but holds NO '${SECRET_NAME}' secret — bicep will mint one."
      echo "export LOOM_INTERNAL_TOKEN=''"
      if [ -n "${GITHUB_ENV:-}" ]; then echo "LOOM_INTERNAL_TOKEN=" >> "$GITHUB_ENV"; fi
      exit 0
    fi
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$VAL"; fi
    log "ADOPTING live token: fingerprint $(fingerprint "$VAL") len ${#VAL} (value never printed)."
    printf 'export LOOM_INTERNAL_TOKEN=%q\n' "$VAL"
    if [ -n "${GITHUB_ENV:-}" ]; then
      # Multi-line-safe heredoc form; the value is already masked above.
      {
        echo "LOOM_INTERNAL_TOKEN<<__LOOM_TOKEN_EOF__"
        printf '%s\n' "$VAL"
        echo "__LOOM_TOKEN_EOF__"
      } >> "$GITHUB_ENV"
    fi
    ;;

  *)
    log "ERROR: unknown mode '$MODE'. Use --export | --fingerprint | --rotate."
    exit 1
    ;;
esac
