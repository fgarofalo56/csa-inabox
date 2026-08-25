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
# `::add-mask::` is a WORKFLOW COMMAND: the runner registers it only if the line
# reaches the step's output stream.  A caller that redirects this script's stdout
# (`… --export > /dev/null`) therefore DESTROYS the mask while the stderr `log`
# lines survive untouched — which is precisely how #4061 published the live token
# into the job environment of every deploy lane, in a public repo, for weeks.
#
# Two consequences, both load-bearing:
#
#   * `--export` PRINTS THE VALUE BY DESIGN — that is the `eval` contract.  Its
#     stdout must never be redirected, piped, or teed.  `eval "$(… --export)"`
#     is the only correct call shape.  Note that `$(…)` ALSO captures stdout, so
#     a bare `::add-mask::` line emitted here could never reach the runner
#     either — under Actions this mode therefore emits the mask as CODE the
#     `eval` executes, which prints it on the CALLER's stdout where the runner
#     parses it.  `--export` writes NOTHING to `$GITHUB_ENV`: one mode, one
#     effect.  The old dual behaviour is precisely what made `--export
#     > /dev/null` look like a working call site.
#   * Workflows use `--github-env`, which writes `$GITHUB_ENV` directly and puts
#     ONLY the mask on stdout.  The value is never printed at all, so there is
#     nothing to redirect and correctness no longer depends on the mask landing.
#
# `--fingerprint` and `--rotate` emit only a sha256 fingerprint (first 12 hex
# chars) and the length — the same comparison the 2026-08-06/07 triage used.
#
# ── USAGE ──────────────────────────────────────────────────────────────────────
#   # 1. GitHub Actions deploy paths — resolve, mask, write $GITHUB_ENV.  Emits
#   #    no secret value, so it needs NO redirect (and a redirect would eat the
#   #    mask — see SECRET HYGIENE above):
#   scripts/csa-loom/resolve-internal-token.sh --github-env
#   [ -n "$LOOM_INTERNAL_TOKEN" ] && add --parameters "loomInternalTokenValue=$LOOM_INTERNAL_TOKEN"
#
#   # 2. Shell callers — resolve, mask, export into THIS shell:
#   eval "$(scripts/csa-loom/resolve-internal-token.sh --export)"
#   #   -> exports LOOM_INTERNAL_TOKEN (empty on a greenfield estate)
#   #   -> prints the value; NEVER redirect, pipe, or tee this mode's stdout
#   #   -> writes nothing to $GITHUB_ENV; use --github-env for that
#
#   # 3. Fingerprint only (drift checks, receipts) — never emits the value:
#   scripts/csa-loom/resolve-internal-token.sh --fingerprint
#
#   # 4. Deliberate rotation (the ONLY supported rotation path).  Writes a new
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

# ── Mask plumbing ──────────────────────────────────────────────────────────────
# `::add-mask::` is a workflow command the runner parses off THIS PROCESS'S
# STDOUT.  A caller that redirects or pipes our stdout destroys the registration
# silently — the stderr `log` lines above still appear, so the log looks healthy
# while the token is published.  That is #4061, verbatim.
mask() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then printf '::add-mask::%s\n' "$1"; fi
}

# `--export`'s stdout is CAPTURED by the caller's `$(…)` — that is its whole
# contract — so a mask printed here would be swallowed by the substitution
# exactly as `> /dev/null` swallowed it.  Emit the registration as CODE instead:
# the caller's `eval` runs it, so the `::add-mask::` line is written by the
# CALLER's shell, on the step's real stdout, where the runner parses it.  The
# value is read back out of the variable the preceding line just exported, so it
# is never quoted into the log twice.
emit_eval_mask() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    # SC2016 is the POINT: this string is emitted verbatim as code for the
    # caller's `eval` to run, so `$LOOM_INTERNAL_TOKEN` must NOT expand here.
    # shellcheck disable=SC2016
    printf '%s\n' 'printf "::add-mask::%s\n" "$LOOM_INTERNAL_TOKEN"'
  fi
}

# Preconditions for --github-env: it must be able to write the env file, and its
# stdout must actually reach the runner.
require_github_env() {
  if [ -z "${GITHUB_ENV:-}" ]; then
    log "ERROR: --github-env needs \$GITHUB_ENV, which exists only inside a GitHub"
    log "       Actions step. Outside Actions use: eval \"\$(… --export)\"."
    exit 1
  fi
  # Fail CLOSED on the exact regression this mode exists to prevent.  Scoped to
  # Actions because that is the only place the mask means anything, and the only
  # place the runner's stdout is guaranteed to be a pipe (so a /dev/null or a
  # regular file is unambiguously a caller-added redirect, not the normal case).
  [ -n "${GITHUB_ACTIONS:-}" ] || return 0
  [ -e /dev/stdout ] || return 0
  local how=''
  if [ /dev/stdout -ef /dev/null ]; then
    how='redirected to /dev/null'
  elif [ -f /dev/stdout ]; then
    how='redirected into a regular file'
  fi
  if [ -n "$how" ]; then
    log "ERROR: this script's stdout is ${how}, which DESTROYS the ::add-mask::"
    log "       registration and would publish the token into the job environment."
    log "       Remove the redirect — --github-env prints no secret value, so it"
    log "       does not need one. (#4061)"
    exit 1
  fi
}

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
    --github-env)
      # Still validated even though there is no value to protect here: the point
      # is to reject the broken CALL SHAPE on every estate, not only on the ones
      # that happen to hold a token. A catch-all `*)` used to live here, so a new
      # mode fell through to printing `export LOOM_INTERNAL_TOKEN=''` — silently
      # doing the wrong thing rather than saying so.
      require_github_env
      # Empty is the honest greenfield answer; bicep mints. Nothing to mask.
      echo "LOOM_INTERNAL_TOKEN=" >> "$GITHUB_ENV"
      ;;
    --export)
      echo "export LOOM_INTERNAL_TOKEN=''"
      ;;
    *)
      log "ERROR: unknown mode '$MODE'. Use --export | --github-env | --fingerprint | --rotate."
      exit 1
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
    mask "$NEW"
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

  --github-env)
    # THE MODE EVERY WORKFLOW USES. It emits no secret value at all — only the
    # `::add-mask::` line — so there is nothing a caller could want to discard,
    # and a caller that discards it anyway is rejected above rather than
    # silently publishing the token (#4061).
    require_github_env
    VAL="$(read_live)"
    if [ -z "$VAL" ]; then
      log "The console exists but holds NO '${SECRET_NAME}' secret — bicep will mint one."
      echo "LOOM_INTERNAL_TOKEN=" >> "$GITHUB_ENV"
      exit 0
    fi
    mask "$VAL"
    log "ADOPTING live token: fingerprint $(fingerprint "$VAL") len ${#VAL}."
    # Multi-line-safe heredoc form. The mask registration above is what makes
    # this safe, and it reaches the runner only because this mode's stdout is
    # unredirected — the two facts are one fact.
    {
      echo "LOOM_INTERNAL_TOKEN<<__LOOM_TOKEN_EOF__"
      printf '%s\n' "$VAL"
      echo "__LOOM_TOKEN_EOF__"
    } >> "$GITHUB_ENV"
    ;;

  --export)
    VAL="$(read_live)"
    if [ -z "$VAL" ]; then
      log "The console exists but holds NO '${SECRET_NAME}' secret — bicep will mint one."
      echo "export LOOM_INTERNAL_TOKEN=''"
      exit 0
    fi
    # No mask here: this mode's stdout is captured by the caller's `$(…)`, so a
    # `::add-mask::` printed here would never reach the runner. It is emitted
    # below as code the caller's `eval` executes instead.
    log "ADOPTING live token: fingerprint $(fingerprint "$VAL") len ${#VAL}."
    # The value IS printed here — that is the eval contract, and it is why this
    # mode's stdout must never be redirected, piped, or teed.
    printf 'export LOOM_INTERNAL_TOKEN=%q\n' "$VAL"
    emit_eval_mask
    ;;

  *)
    log "ERROR: unknown mode '$MODE'. Use --export | --github-env | --fingerprint | --rotate."
    exit 1
    ;;
esac
