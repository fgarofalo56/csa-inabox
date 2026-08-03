#!/usr/bin/env bash
# =============================================================================
# test-kv-firewall-window.sh — regression test for the verified Key Vault
#                              firewall window (#2855)
# =============================================================================
#
# Exercises scripts/csa-loom/kv-firewall-window.sh against a FAKE `az` that
# models one vault's publicNetworkAccess / defaultAction / ipRules in a temp
# file, with failure injection. No Azure, no credentials, no network — so it
# runs in the Loom Guardrails lane on every PR and pins the failure modes that
# made #2855 invisible in production:
#
#   * `az keyvault update` returns 0 but ARM does NOT apply it  -> close FAILS
#     (this is the one the old `... -o none || true` scored as success)
#   * the vault's state is UNREADABLE                            -> close FAILS
#     (an `az` failure must never be read as "empty means locked" — bug #2836)
#   * a residual ipRule survives the strip                       -> close FAILS
#     even though publicNetworkAccess/defaultAction look right
#   * eventual consistency: applies on attempt 2                 -> close SUCCEEDS
#     (retry turns a flake into a slow pass; it never turns a real failure into
#     a pass, because the verdict is always the read-back)
#   * the open path keeps defaultAction=Deny when the runner IP resolves, and
#     LOUDLY discloses the whole-internet Allow fallback when it does not
#
#   CONTROLS (must pass BOTH before and after any change to the script, so an
#   over-broad "just always fail / always succeed" edit is caught):
#     * a vault that is already private VERIFIES green and closes green
#     * a vault that is open VERIFIES as open (rc 2), not as unreadable (rc 1)
#
# Run locally: bash scripts/ci/test-kv-firewall-window.sh
# =============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/csa-loom/kv-firewall-window.sh"
[ -f "$SCRIPT" ] || { echo "missing $SCRIPT" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STATE="$WORK/state.env"
export PATH="$WORK/bin:$PATH"

# ── fake az ───────────────────────────────────────────────────────────────────
# Knobs (all in $STATE):
#   PNA / DA / RULES        the modelled vault state (RULES = comma list)
#   SHOW_RC                 non-zero => `az keyvault show` fails (UNREADABLE)
#   UPDATE_RC               exit code of `az keyvault update`
#   APPLY_FROM              attempt number from which updates actually apply;
#                           999 => never applies (mutation reports success, ARM
#                           silently drops it) ; 1 => always applies
#   RULE_REMOVE_APPLIES     no => `network-rule remove` succeeds but no-ops
#   ATTEMPT                 incremented by every `az keyvault update`
cat > "$WORK/bin/az" <<'FAKEAZ'
#!/usr/bin/env bash
set -uo pipefail
STATE="${STATE:?}"
. "$STATE"
_put() { sed -i "s|^${1}=.*|${1}=${2}|" "$STATE"; }

QUERY=""; ARGS=(); PNA_NEW=""; DA_NEW=""; IP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --query)                 QUERY="$2"; shift 2 ;;
    --subscription)          shift 2 ;;
    -o|--output)             shift 2 ;;
    -n|--name|--vault-name)  shift 2 ;;
    --public-network-access) PNA_NEW="$2"; shift 2 ;;
    --default-action)        DA_NEW="$2"; shift 2 ;;
    --ip-address)            IP="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]:-}"

case "${1:-}:${2:-}" in
  keyvault:show)
    [ "${SHOW_RC:-0}" = "0" ] || { echo "AuthorizationFailed" >&2; exit 1; }
    # FAITHFUL az RENDERING. Real az -o tsv renders a top-level JMESPath LIST as one
    # element PER LINE, and a multiselect HASH as ONE tab-separated row. The previous
    # stub matched the LIST form and emitted a TAB ROW -- a shape real az never
    # produces -- so it modelled the bug as correct and could not detect that the
    # shipped query returned three lines. Both forms are now modelled honestly, so
    # reverting the query to a list turns these tests RED.
    case "$QUERY" in
      \{*)
        n=0
        [ -n "${RULES:-}" ] && n=$(printf '%s' "$RULES" | tr ',' '
' | grep -c .)
        printf '%s	%s	%s
' "$PNA" "$DA" "$n" ;;
      \[*)
        n=0
        [ -n "${RULES:-}" ] && n=$(printf '%s' "$RULES" | tr ',' '
' | grep -c .)
        printf '%s
%s
%s
' "$PNA" "$DA" "$n" ;;
      *) printf '
' ;;
    esac ;;

  keyvault:update)
    ATTEMPT=$(( ${ATTEMPT:-0} + 1 )); _put ATTEMPT "$ATTEMPT"
    if [ "$ATTEMPT" -ge "${APPLY_FROM:-1}" ]; then
      [ -n "$PNA_NEW" ] && _put PNA "$PNA_NEW"
      [ -n "$DA_NEW" ]  && _put DA  "$DA_NEW"
    fi
    exit "${UPDATE_RC:-0}" ;;

  keyvault:network-rule)
    case "${3:-}" in
      list) [ -n "${RULES:-}" ] && printf '%s\n' "$RULES" | tr ',' '\n' | grep . ; exit 0 ;;
      add)
        if [ -z "${RULES:-}" ]; then _put RULES "$IP"; else _put RULES "${RULES},${IP}"; fi
        exit 0 ;;
      remove)
        if [ "${RULE_REMOVE_APPLIES:-yes}" = "yes" ]; then
          left="$(printf '%s' "${RULES:-}" | tr ',' '\n' | grep -v "^${IP}$" | paste -sd, -)"
          _put RULES "${left}"
        fi
        exit 0 ;;
    esac ;;
esac
exit 0
FAKEAZ
chmod +x "$WORK/bin/az"

# ── fake curl (runner-IP discovery) ───────────────────────────────────────────
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
[ "${FAKE_RUNNER_IP:-}" = "" ] && exit 1
printf '%s\n' "$FAKE_RUNNER_IP"
FAKECURL
chmod +x "$WORK/bin/curl"

# Keep the suite fast; zero waits are also what proves the retry is BOUNDED.
export LOOM_KV_WINDOW_OPEN_SECONDS=0
export LOOM_KV_WINDOW_RETRY_SECONDS=0
export LOOM_KV_WINDOW_CLOSE_ATTEMPTS=3
# Model the environment that matters: under Actions the script must emit real
# `::error::` annotations, because that is the form check-annotation-teeth.mjs
# and a human reading a run log depend on.
export GITHUB_ACTIONS=true

PASS=0; FAIL=0
reset() {
  cat > "$STATE" <<EOF
PNA=${1:-Enabled}
DA=${2:-Allow}
RULES=${3:-}
SHOW_RC=0
UPDATE_RC=0
APPLY_FROM=1
RULE_REMOVE_APPLIES=yes
ATTEMPT=0
EOF
}
knob() { sed -i "s|^${1}=.*|${1}=${2}|" "$STATE"; }
field() { . "$STATE"; printf '%s' "${!1}"; }

run() { OUT="$(bash "$SCRIPT" "$@" 2>&1)"; RC=$?; }

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     rc=%s\n     out: %s\n' "$1" "${RC:-?}" "${OUT:-}" >&2; }
want_rc()   { [ "$RC" = "$1" ] && ok "$2" || bad "$2 (wanted rc=$1)"; }
want_out()  { printf '%s' "$OUT" | grep -qF -- "$1" && ok "$2" || bad "$2 (missing: $1)"; }
want_noout(){ printf '%s' "$OUT" | grep -qF -- "$1" && bad "$2 (unexpected: $1)" || ok "$2"; }
want_field(){ [ "$(field "$1")" = "$2" ] && ok "$3" || bad "$3 ($1=$(field "$1"), wanted $2)"; }

echo "kv-firewall-window: verified close"

# 1. Happy path: an open vault is re-locked and the close reports success.
reset Enabled Allow "20.1.2.3"
run close --vault kv-loom-test
want_rc 0 "close: re-locks an open vault"
want_field PNA Disabled "close: publicNetworkAccess=Disabled"
want_field DA  Deny     "close: defaultAction=Deny"
want_field RULES ""     "close: ipRules stripped"

# 2. THE #2855 BUG. `az keyvault update` exits 0, ARM never applies it.
#    The old call sites (`... -o none || true`) scored this as a successful
#    re-lock and printed "re-asserted private" over a PUBLIC vault.
reset Enabled Allow ""
knob APPLY_FROM 999
run close --vault kv-loom-test
want_rc 1 "close: FAILS when the update reports success but does not apply"
want_out "::error::" "close: emits ::error:: on that path"
want_out "PUBLICLY REACHABLE" "close: names the exposure"
want_field PNA Enabled "close: vault genuinely still open (test double is honest)"

# 3. UNREADABLE state must never be scored as locked (the #2836 shape: an `az`
#    failure produces an empty string, and empty must not satisfy the assertion).
reset Enabled Allow ""
knob SHOW_RC 1
run close --vault kv-loom-test
want_rc 1 "close: FAILS when the vault state is unreadable"
want_out "::error::" "close: unreadable emits ::error::"

# 4. All THREE fields are asserted: a residual ipRule fails the close even
#    though publicNetworkAccess and defaultAction end up correct.
reset Enabled Deny "20.1.2.3"
knob RULE_REMOVE_APPLIES no
run close --vault kv-loom-test
want_rc 1 "close: FAILS when an ipRule survives the strip"
want_field PNA Disabled "close: (pna was still set correctly)"
want_out "ipRules=1" "close: reports the residual rule count"

# 5. Eventual consistency: the second attempt applies. Retry must turn that
#    into a pass — and the verdict is still the read-back, not the retry.
reset Enabled Allow ""
knob APPLY_FROM 2
run close --vault kv-loom-test
want_rc 0 "close: succeeds when ARM applies on the second attempt"
want_out "attempt 2" "close: says which attempt verified"

# 6. Bounded: it does not retry forever.
reset Enabled Allow ""
knob APPLY_FROM 999
run close --vault kv-loom-test
[ "$(field ATTEMPT)" = "3" ] && ok "close: bounded at LOOM_KV_WINDOW_CLOSE_ATTEMPTS" \
  || bad "close: attempts=$(field ATTEMPT), wanted 3"

# 6b. SOFT_FAIL downgrades the ANNOTATION only. The return code must stay 1 —
#     if the knob could suppress the failure itself it would be a way to make the
#     control unable to fail, which is the defect this whole change exists to
#     remove.
reset Enabled Allow ""
knob APPLY_FROM 999
LOOM_KV_WINDOW_SOFT_FAIL=1 run close --vault kv-loom-test
want_rc 1 "close: SOFT_FAIL still returns non-zero"
want_out "::warning::" "close: SOFT_FAIL annotates ::warning::"
want_noout "::error::" "close: SOFT_FAIL suppresses only the ::error:: severity"

echo "kv-firewall-window: verify"

# 7. CONTROL — an already-private vault verifies green. An over-broad "always
#    fail" close/verify would break here.
reset Disabled Deny ""
run verify --vault kv-loom-test
want_rc 0 "verify: CONTROL — a private vault passes"
want_noout "::error::" "verify: CONTROL — no error annotation on the good path"

# 8. CONTROL — a private vault closes green with no mutation needed.
reset Disabled Deny ""
run close --vault kv-loom-test
want_rc 0 "close: CONTROL — an already-private vault passes"

# 9. An open vault is reported as OPEN (rc 2), distinctly from unreadable (rc 1).
reset Enabled Allow ""
run verify --vault kv-loom-test
want_rc 2 "verify: an open vault is rc=2 (open), not rc=1 (unreadable)"
want_out "is NOT private" "verify: says so"

# 10. Unreadable is rc 1 and is NEVER reported as private.
reset Disabled Deny ""
knob SHOW_RC 1
run verify --vault kv-loom-test
want_rc 1 "verify: unreadable is rc=1"
want_noout "is private" "verify: never claims private when it cannot read"

echo "kv-firewall-window: open"

# 11. Single-IP window: publicNetworkAccess goes Enabled, defaultAction STAYS
#     Deny, and only the runner IP is allowed.
reset Disabled Deny ""
FAKE_RUNNER_IP=20.9.9.9 run open --vault kv-loom-test
want_rc 0 "open: opens a single-IP window"
want_field PNA Enabled "open: publicNetworkAccess=Enabled"
want_field DA  Deny    "open: defaultAction stays Deny"
want_field RULES "20.9.9.9" "open: only the runner IP is allowed"

# 12. IP unresolved: behaviour preserved (defaultAction=Allow so the write can
#     land) but LOUDLY disclosed — it exposes the vault to the whole internet.
reset Disabled Deny ""
FAKE_RUNNER_IP="" run open --vault kv-loom-test
want_rc 0 "open: still opens when the runner IP is unresolved"
want_field DA Allow "open: falls back to defaultAction=Allow"
want_out "whole internet" "open: DISCLOSES the whole-internet fallback"

# 13. An already-public vault is left as the caller found it.
reset Enabled Allow ""
FAKE_RUNNER_IP=20.9.9.9 run open --vault kv-loom-test
want_rc 0 "open: no-ops on an already-public vault"
want_field RULES "" "open: adds no rule to an already-public vault"

echo "kv-firewall-window: CLI"
run close
want_rc 2 "cli: --vault is required"
run bogus --vault kv-loom-test
want_rc 2 "cli: unknown verb is rejected"

echo
if [ "$FAIL" -gt 0 ]; then
  echo "kv-firewall-window: $PASS passed, $FAIL FAILED" >&2
  exit 1
fi
# Self-defence: a suite that silently stops asserting is the same defect class
# it exists to catch.
if [ "$PASS" -lt 30 ]; then
  echo "kv-firewall-window: only $PASS assertions ran — the suite stopped asserting; refusing to pass." >&2
  exit 1
fi
echo "kv-firewall-window: $PASS passed"
