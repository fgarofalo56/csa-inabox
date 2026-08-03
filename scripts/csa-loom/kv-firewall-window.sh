#!/usr/bin/env bash
# =============================================================================
# kv-firewall-window.sh — VERIFIED, fail-loud open/close of a Loom Key Vault's
#                         network ACLs
# =============================================================================
#
# WHY THIS EXISTS (issue #2855)
#
# The Loom Key Vault is deployed publicNetworkAccess=Disabled + networkAcls
# defaultAction=Deny (private endpoint only). Several bootstrap paths have to
# write a secret into it from a public GitHub-hosted runner, so they open a
# single-IP window and re-lock it afterwards.
#
# SIX call sites did that. Not ONE of them checked that the re-lock applied:
#
#   csa-loom-post-deploy-bootstrap.yml  (MSAL app-reg trap)   `... -o none || true`
#   csa-loom-post-deploy-bootstrap.yml  (posture Function)    `set +e` + `2>/dev/null`
#                                                            + continue-on-error
#   csa-loom-post-deploy-bootstrap.yml  (always() safety net) `|| echo ::warning::`
#   dr-drill.yml                        (always() re-lock)    trailing `echo` became
#                                                            the step's exit status
#   gov-provision-posture.yml           (inline)              `set +e` + `2>/dev/null`
#   scripts/csa-loom/wire-spark-telemetry.sh (trap)           `... || true`
#
# Three of them printed a SUCCESS line ("re-asserted private", "Vault re-locked",
# "(restored Key Vault private)") on the path where the mutation may have failed.
# So a transient ARM error during bootstrap left the vault holding
# loom-msal-client-secret / session-secret / loom-posture-function-key publicly
# reachable, the workflow green, and the log claiming it was locked.
#
# That is the repo's recurring defect shape (#2836, #2837, the 2026-07-28
# "gates that measure nothing" sweep): a control runs, its verdict is discarded,
# and success is reported.
#
# -----------------------------------------------------------------------------
# THE DESIGN
# -----------------------------------------------------------------------------
#
# Three invariants:
#
#   1. VERIFY, DON'T TRUST. `close` does not believe `az keyvault update`'s exit
#      code. It RE-READS publicNetworkAccess, networkAcls.defaultAction and the
#      ipRules count and asserts all three. The mutation reporting success while
#      ARM did not apply it is precisely the case that was invisible.
#
#   2. UNREADABLE IS A FAILURE, NEVER A PASS. Every judgement comes from ONE read
#      that must return a non-empty publicNetworkAccess. An `az` that fails
#      yields an empty string, and an empty string can NEVER satisfy the
#      assertion — so a broken token or a throttled ARM cannot be mistaken for
#      "0 ip rules, locked". Reading an `az` failure as "empty means fine" is
#      literally bug #2836.
#
#   3. LOUD AND FATAL. On final failure `close` emits `::error::` AND exits
#      non-zero, so the step — and therefore the job — goes red. An annotation
#      alone is not a control (#2837).
#
# Bounded retry: ARM network-ACL writes are eventually consistent and can 409/429
# under a concurrent deploy, so `close` retries LOOM_KV_WINDOW_CLOSE_ATTEMPTS
# times with a fixed backoff before failing. Retry makes a flake a slow success
# instead of a false failure; it never turns a real failure into a pass, because
# the verdict is always the read-back.
#
# The logic lives HERE, in a script with a fake-`az` regression suite
# (scripts/ci/test-kv-firewall-window.sh, run in the Loom Guardrails lane),
# rather than inline in YAML — the same lesson acr-firewall-sweeper.yml records:
# "inline YAML cannot be tested and this step was silently broken (#2836)".
#
# RELATION TO THE ACR PRIOR ART. scripts/csa-loom/acr-firewall-lease.sh solves a
# DIFFERENT half of the same problem — ownership, so a cancelled run's cleanup
# cannot re-lock a live holder's registry mid-push (#2603) — plus a scheduled
# sweeper for a holder that dies. Its own `_lease_close_firewall` does NOT verify
# either; it relies on the sweeper. Key Vault has no sweeper, and no ownership
# problem to solve (the writes here are seconds long, not 14-minute pushes), so
# the piece worth adopting is the SCRIPT-NOT-YAML shape, and the piece worth
# ADDING is the verification neither path had. See docs/fiab/kv-firewall-window.md
# for the residual (a job force-killed before its always() step runs) — that one
# still wants a scheduled sweeper.
#
# -----------------------------------------------------------------------------
# USAGE
# -----------------------------------------------------------------------------
#
#   kv-firewall-window.sh open   --vault <name> [--subscription <sub>]
#   kv-firewall-window.sh close  --vault <name> [--subscription <sub>]
#   kv-firewall-window.sh verify --vault <name> [--subscription <sub>]
#
# Exit codes:
#   open    0 window is open (or the vault was already public); 1 could not open
#   close   0 VERIFIED private (Disabled + Deny + zero ipRules); 1 otherwise
#   verify  0 VERIFIED private; 1 state unreadable; 2 readable and NOT private
#
# Tunables (env):
#   LOOM_KV_WINDOW_OPEN_SECONDS      20   firewall-rule propagation wait after open
#   LOOM_KV_WINDOW_CLOSE_ATTEMPTS     3   verified-close attempts before failing
#   LOOM_KV_WINDOW_RETRY_SECONDS      8   backoff between close attempts
#   LOOM_KV_WINDOW_SOFT_FAIL          0   1 = a failed close annotates ::warning::
#                                         instead of ::error::. The RETURN CODE is
#                                         1 either way. Only for the inline
#                                         mid-job closes, whose verdict is
#                                         re-derived and enforced by the always()
#                                         restore step.
#
# Related: docs/fiab/kv-firewall-window.md, scripts/ci/test-kv-firewall-window.sh,
#          scripts/ci/check-kv-firewall-restore.mjs, issue #2855
# =============================================================================
set -uo pipefail

KVW_OPEN_SECONDS="${LOOM_KV_WINDOW_OPEN_SECONDS:-20}"
KVW_CLOSE_ATTEMPTS="${LOOM_KV_WINDOW_CLOSE_ATTEMPTS:-3}"
KVW_RETRY_SECONDS="${LOOM_KV_WINDOW_RETRY_SECONDS:-8}"

# ONE read, three fields, tab separated: publicNetworkAccess, defaultAction,
# ipRule count. Single-quoted so bash leaves the JMESPath backtick literals alone.
#
# Every field is defaulted so NONE can come back empty on a successful read.
# That matters twice over:
#   * `-o tsv` collapses adjacent tabs (tab is IFS whitespace), so one null field
#     would silently shift the others and mis-parse the state.
#   * an absent publicNetworkAccess / defaultAction means "public" in Azure, and
#     the literal "unset" fails the Disabled/Deny assertion — which is the
#     correct, fail-closed reading.
# `|| `[]`` keeps length() valid when networkAcls.ipRules is null.
KVW_STATE_QUERY='[properties.publicNetworkAccess || `"unset"`, properties.networkAcls.defaultAction || `"unset"`, length(properties.networkAcls.ipRules || `[]`)]'

# --- logging -----------------------------------------------------------------
_kvw_note() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::notice::[kv-window] %s\n' "$*"
  else printf '[kv-window] %s\n' "$*" >&2; fi
}
_kvw_warn() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::warning::[kv-window] %s\n' "$*"
  else printf '[kv-window] WARNING: %s\n' "$*" >&2; fi
}
_kvw_err() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then printf '::error::[kv-window] %s\n' "$*"
  else printf '[kv-window] ERROR: %s\n' "$*" >&2; fi
}

# A failed `close` is reported at ::error:: severity by DEFAULT, because the
# vault is open at that moment. The inline mid-job closes set
# LOOM_KV_WINDOW_SOFT_FAIL=1 to downgrade the ANNOTATION only — the return code
# is 1 either way. Those steps deliberately do not abort the bootstrap on a
# transient re-lock miss: the authoritative, fail-loud verdict is the always()
# "Restore Loom Key Vault private (verified)" step, which re-derives the posture
# from the vault itself and fails the job if it is genuinely still open. Printing
# a bare ::error:: from a step that cannot fail would be the #2837 shape — an
# annotation with no teeth — so the severity follows where the teeth actually are.
_kvw_fail() {
  if [ "${LOOM_KV_WINDOW_SOFT_FAIL:-0}" = "1" ]; then
    _kvw_warn "$* (the always() verified-restore step is the enforcing check for this run)"
  else
    _kvw_err "$*"
  fi
}

# --- state -------------------------------------------------------------------

# Print "<pna>\t<defaultAction>\t<ipRuleCount>" and return 0, or print nothing
# and return 1 when the vault's ACLs cannot be read.
#
# The non-empty publicNetworkAccess is the READ-SUCCEEDED sentinel. It is what
# stops an `az` failure (empty stdout) from being scored as "0 ip rules, locked".
# It also covers an az/JMESPath version that rejects KVW_STATE_QUERY outright:
# no output means unreadable means FAIL, never a silent pass.
_kvw_read_state() {
  local out pna da rules
  # shellcheck disable=SC2086
  out="$(az keyvault show -n "$_KVW_VAULT" $_KVW_SUB_ARG --query "$KVW_STATE_QUERY" -o tsv 2>/dev/null | tr -d '\r' | head -1)"
  IFS=$'\t' read -r pna da rules <<<"${out:-}"
  [ -n "${pna:-}" ] || return 1
  case "${rules:-}" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\t%s\t%s\n' "$pna" "${da:-}" "$rules"
}

# --- public: verify ----------------------------------------------------------
# 0 = VERIFIED private, 1 = unreadable, 2 = readable and NOT private.
kvw_verify() {
  local state pna da rules
  _KVW_LAST_STATE=""
  if ! state="$(_kvw_read_state)"; then
    _kvw_err "cannot READ the network ACLs of Key Vault '$_KVW_VAULT'. Refusing to report it as locked — an unreadable vault is treated as OPEN. Check the identity's read access on the vault, the subscription/cloud, and ARM availability."
    return 1
  fi
  IFS=$'\t' read -r pna da rules <<<"$state"
  _KVW_LAST_STATE="publicNetworkAccess=$pna defaultAction=$da ipRules=$rules"
  if [ "$pna" = "Disabled" ] && [ "$da" = "Deny" ] && [ "$rules" = "0" ]; then
    return 0
  fi
  return 2
}

# --- public: open ------------------------------------------------------------
kvw_open() {
  local state pna da rules ip rc=0
  if ! state="$(_kvw_read_state)"; then
    _kvw_err "cannot read Key Vault '$_KVW_VAULT' — not opening a firewall window against a vault whose state is unknown."
    return 1
  fi
  IFS=$'\t' read -r pna da rules <<<"$state"
  if [ "$pna" = "Enabled" ]; then
    _kvw_note "Key Vault '$_KVW_VAULT' is already publicNetworkAccess=Enabled (defaultAction=$da) — leaving it as the caller found it."
    return 0
  fi

  _kvw_note "opening a single-IP window on Key Vault '$_KVW_VAULT' (publicNetworkAccess=Enabled, defaultAction stays Deny) ..."
  # shellcheck disable=SC2086
  az keyvault update -n "$_KVW_VAULT" $_KVW_SUB_ARG \
    --public-network-access Enabled --default-action Deny -o none || rc=1

  ip="$(curl -sS https://ifconfig.me 2>/dev/null || curl -sS https://api.ipify.org 2>/dev/null || true)"
  ip="$(printf '%s' "${ip:-}" | tr -d '\r\n')"
  if [ -n "$ip" ]; then
    # shellcheck disable=SC2086
    az keyvault network-rule add -n "$_KVW_VAULT" $_KVW_SUB_ARG --ip-address "$ip" -o none || rc=1
    _kvw_note "allowed runner egress IP for the write window."
  else
    # Behaviour preserved from the call sites this replaces, but no longer
    # whispered: defaultAction=Allow opens the vault to the WHOLE INTERNET for
    # the duration of the window, which is a materially worse posture than the
    # single-IP allow. `close` re-asserts Deny and VERIFIES it, so the window is
    # bounded — but a reviewer should see this happened.
    _kvw_warn "runner egress IP unresolved — falling back to defaultAction=Allow, which exposes Key Vault '$_KVW_VAULT' to the whole internet for the write window. The verified close re-asserts Deny."
    # shellcheck disable=SC2086
    az keyvault update -n "$_KVW_VAULT" $_KVW_SUB_ARG --default-action Allow -o none || rc=1
  fi

  sleep "$KVW_OPEN_SECONDS"

  # Confirm the window is actually open; otherwise the caller's secret write
  # fails for a reason nobody would connect to the firewall.
  if ! state="$(_kvw_read_state)"; then
    _kvw_warn "opened the window on '$_KVW_VAULT' but could not read back its state — the write may not be reachable."
    return 1
  fi
  IFS=$'\t' read -r pna da rules <<<"$state"
  if [ "$pna" != "Enabled" ]; then
    _kvw_warn "Key Vault '$_KVW_VAULT' is still publicNetworkAccess=$pna after the open — the secret write will not be reachable from this runner."
    return 1
  fi
  return "$rc"
}

# --- public: close -----------------------------------------------------------
# Re-lock and PROVE it. Unconditional: the Loom Key Vault rests private, so this
# also cleans up a window some other process left behind.
kvw_close() {
  local attempt=1 vrc ip
  _KVW_LAST_STATE=""
  while [ "$attempt" -le "$KVW_CLOSE_ATTEMPTS" ]; do
    # Strip every ipRule, not just one we happen to remember adding — a rule
    # left by a crashed run is exactly what this has to clean up. A failure to
    # LIST is not swallowed: the read-back below counts the rules that remain,
    # so a missed removal fails the close rather than passing it.
    # shellcheck disable=SC2086
    for ip in $(az keyvault network-rule list -n "$_KVW_VAULT" $_KVW_SUB_ARG --query "ipRules[].value" -o tsv 2>/dev/null | tr -d '\r'); do
      # shellcheck disable=SC2086
      az keyvault network-rule remove -n "$_KVW_VAULT" $_KVW_SUB_ARG --ip-address "$ip" -o none >/dev/null 2>&1 || true
    done
    # shellcheck disable=SC2086
    az keyvault update -n "$_KVW_VAULT" $_KVW_SUB_ARG \
      --public-network-access Disabled --default-action Deny -o none >/dev/null 2>&1 || true

    kvw_verify >/dev/null 2>&1
    vrc=$?
    if [ "$vrc" -eq 0 ]; then
      _kvw_note "Key Vault '$_KVW_VAULT' VERIFIED private (publicNetworkAccess=Disabled, defaultAction=Deny, 0 ipRules) after attempt $attempt."
      return 0
    fi
    if [ "$attempt" -lt "$KVW_CLOSE_ATTEMPTS" ]; then
      _kvw_warn "attempt $attempt/$KVW_CLOSE_ATTEMPTS did not leave Key Vault '$_KVW_VAULT' verifiably private (${_KVW_LAST_STATE:-state unreadable}) — retrying in ${KVW_RETRY_SECONDS}s."
      sleep "$KVW_RETRY_SECONDS"
    fi
    attempt=$((attempt + 1))
  done

  _kvw_fail "FAILED to re-lock Key Vault '$_KVW_VAULT' after $KVW_CLOSE_ATTEMPTS attempts (${_KVW_LAST_STATE:-state unreadable}). The vault may be PUBLICLY REACHABLE and it holds Loom's sign-in secrets. Re-lock it by hand NOW: az keyvault update -n $_KVW_VAULT --public-network-access Disabled --default-action Deny; then az keyvault network-rule list -n $_KVW_VAULT to confirm no ipRules remain."
  return 1
}

# --- CLI ---------------------------------------------------------------------
_kvw_usage() {
  cat >&2 <<'USAGE'
usage: kv-firewall-window.sh <open|close|verify> --vault <name> [--subscription <sub>]

  open    open a single-IP window for a secret write (verified reachable)
  close   re-lock and VERIFY (Disabled + Deny + zero ipRules); non-zero on failure
  verify  read-only assertion; 0 private, 1 unreadable, 2 open
USAGE
}

_KVW_VAULT=""
_KVW_SUB_ARG=""
_KVW_LAST_STATE=""

kvw_main() {
  local verb="${1:-}" sub=""
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --vault|-n)     _KVW_VAULT="${2:-}"; shift 2 ;;
      --subscription) sub="${2:-}"; shift 2 ;;
      -h|--help)      _kvw_usage; return 0 ;;
      *) _kvw_err "unknown argument: $1"; _kvw_usage; return 2 ;;
    esac
  done
  [ -n "$_KVW_VAULT" ] || { _kvw_err "--vault is required"; _kvw_usage; return 2; }
  [ -n "$sub" ] && _KVW_SUB_ARG="--subscription $sub"

  case "$verb" in
    open)   kvw_open ;;
    close)  kvw_close ;;
    verify)
      kvw_verify
      local rc=$?
      case $rc in
        0) _kvw_note "Key Vault '$_KVW_VAULT' is private (publicNetworkAccess=Disabled, defaultAction=Deny, 0 ipRules)." ;;
        2) _kvw_err "Key Vault '$_KVW_VAULT' is NOT private: ${_KVW_LAST_STATE}." ;;
      esac
      return $rc ;;
    *) _kvw_err "unknown command: ${verb:-<none>}"; _kvw_usage; return 2 ;;
  esac
}

kvw_main "$@"
