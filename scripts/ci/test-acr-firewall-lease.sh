#!/usr/bin/env bash
# =============================================================================
# test-acr-firewall-lease.sh — regression test for the ACR firewall lease (#2603)
# =============================================================================
#
# Exercises scripts/csa-loom/acr-firewall-lease.sh end to end against a FAKE
# `az` that models one registry's firewall state + ARM tags in a temp file. No
# Azure, no credentials, no network — so it runs in the Loom Guardrails lane on
# every PR and pins the failure modes a reviewer of #2603 asks about:
#
#   * a NON-HOLDER's release must not re-lock (the cancelled-run bug)
#   * the holder's release re-locks and clears the lease
#   * release with no LIVE holder still re-locks (fail closed)
#   * acquire behind a live lease is BOUNDED and fails loudly
#   * a stale lease is taken over, a same-owner acquire is reentrant
#   * sweep leaves a leased-open registry alone but re-locks an unleased one
#   * degraded mode (unwritable tags) opens unleased but never clobbers a live
#     foreign lease, and LOOM_ACR_LEASE_FALLBACK=fail refuses to open
#
# Run locally: bash scripts/ci/test-acr-firewall-lease.sh
# =============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LEASE="$REPO/scripts/csa-loom/acr-firewall-lease.sh"
[ -f "$LEASE" ] || { echo "missing $LEASE" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STATE="$WORK/state.env"
export PATH="$WORK/bin:$PATH"

# ── fake az ───────────────────────────────────────────────────────────────────
cat > "$WORK/bin/az" <<'FAKEAZ'
#!/usr/bin/env bash
set -uo pipefail
STATE="${STATE:?}"
. "$STATE"
_put() { sed -i "s|^${1}=.*|${1}=${2}|" "$STATE"; }
QUERY=""; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --query) QUERY="$2"; shift 2 ;;
    --subscription) shift 2 ;;
    -o|--output) shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]:-}"
case "${1:-}:${2:-}" in
  acr:show)
    case "$QUERY" in
      id)                           printf '/subscriptions/0/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrtest\n' ;;
      publicNetworkAccess)          printf '%s\n' "$PNA" ;;
      networkRuleSet.defaultAction) printf '%s\n' "$DA" ;;
      tags.loomAcrFwOwner)          printf '%s\n' "$OWNER" ;;
      tags.loomAcrFwExpiresEpoch)   printf '%s\n' "$EXPIRES" ;;
      tags.loomAcrFwHolderUrl)      printf '%s\n' "$URL" ;;
      *) printf '\n' ;;
    esac ;;
  acr:update)
    PREV=""
    for a in "$@"; do
      case "$a" in
        true)  [ "$PREV" = "--public-network-enabled" ] && _put PNA Enabled ;;
        false) [ "$PREV" = "--public-network-enabled" ] && _put PNA Disabled ;;
        Allow) _put DA Allow ;;
        Deny)  _put DA Deny ;;
      esac
      PREV="$a"
    done ;;
  tag:update)
    [ "$TAGWRITE" = "ok" ] || { echo "AuthorizationFailed" >&2; exit 1; }
    for a in "$@"; do
      case "$a" in
        loomAcrFwOwner=*)        _put OWNER "${a#*=}" ;;
        loomAcrFwExpiresEpoch=*) _put EXPIRES "${a#*=}" ;;
        loomAcrFwHolderUrl=*)    _put URL "${a#*=}" ;;
      esac
    done ;;
esac
exit 0
FAKEAZ
chmod +x "$WORK/bin/az"

# Keep the test fast: no propagation sleeps, zero settle, immediate acquire
# deadline (which is precisely what proves the wait is BOUNDED).
export LOOM_ACR_LEASE_OPEN_SECONDS=0
export LOOM_ACR_LEASE_SETTLE_SECONDS=0
export LOOM_ACR_LEASE_WAIT_MINUTES=0
export LOOM_ACR_LEASE_TTL_MINUTES=60

PASS=0; FAIL=0
ok()    { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()   { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want=$2 got=$3)"; fi; }
grep_ok() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 — output lacked '$2'" ;; esac; }

reset() {
  printf 'PNA=Disabled\nDA=Deny\nOWNER=\nEXPIRES=\nURL=\nTAGWRITE=ok\n' > "$STATE"
}
get()  { ( . "$STATE"; eval "printf '%s' \"\${$1}\"" ); }
put()  { sed -i "s|^${1}=.*|${1}=${2}|" "$STATE"; }
open_() { put PNA Enabled; put DA Allow; }
future() { printf '%s' "$(( $(date -u +%s) + 3600 ))"; }
past()   { printf '%s' "$(( $(date -u +%s) - 600 ))"; }

echo "acr-firewall-lease (#2603) regression test"

echo "1. acquire on a free registry opens it and records the lease"
reset
LOOM_ACR_LEASE_OWNER=runA bash "$LEASE" acquire --acr acrtest >/dev/null 2>&1
check "opened"     "Enabled" "$(get PNA)"
check "allowed"    "Allow"   "$(get DA)"
check "owner=runA" "runA"    "$(get OWNER)"

echo "2. THE #2603 BUG: a NON-HOLDER release must NOT re-lock"
out=$(LOOM_ACR_LEASE_OWNER=runB bash "$LEASE" release --acr acrtest 2>&1)
check "still open"    "Enabled" "$(get PNA)"
check "still allowed" "Allow"   "$(get DA)"
check "owner intact"  "runA"    "$(get OWNER)"
grep_ok "warned, naming the holder" "NOT re-locking" "$out"

echo "3. the HOLDER's release re-locks and clears the lease"
LOOM_ACR_LEASE_OWNER=runA bash "$LEASE" release --acr acrtest >/dev/null 2>&1
check "locked"      "Disabled" "$(get PNA)"
check "denied"      "Deny"     "$(get DA)"
check "lease clear" "none"     "$(get OWNER)"

echo "4. release with NO live holder still re-locks (fail closed)"
reset; open_
LOOM_ACR_LEASE_OWNER=runC bash "$LEASE" release --acr acrtest >/dev/null 2>&1
check "locked" "Disabled" "$(get PNA)"
check "denied" "Deny"     "$(get DA)"

echo "5. release under an EXPIRED lease re-locks (fail closed)"
reset; open_; put OWNER runDead; put EXPIRES "$(past)"
LOOM_ACR_LEASE_OWNER=runC bash "$LEASE" release --acr acrtest >/dev/null 2>&1
check "locked" "Disabled" "$(get PNA)"

echo "6. acquire behind a LIVE foreign lease is bounded and fails loudly"
reset; put OWNER runA; put EXPIRES "$(future)"
out=$(LOOM_ACR_LEASE_OWNER=runB bash "$LEASE" acquire --acr acrtest 2>&1); rc=$?
check "nonzero exit" "1"        "$rc"
check "left locked"  "Disabled" "$(get PNA)"
check "owner intact" "runA"     "$(get OWNER)"
grep_ok "bounded, not an infinite wait" "TIMED OUT" "$out"

echo "7. acquire takes over a STALE lease, loudly"
reset; put OWNER runDead; put EXPIRES "$(past)"
out=$(LOOM_ACR_LEASE_OWNER=runB bash "$LEASE" acquire --acr acrtest 2>&1)
check "owner=runB" "runB"    "$(get OWNER)"
check "opened"     "Enabled" "$(get PNA)"
grep_ok "warned about the takeover" "STALE lease" "$out"

echo "8. acquire is reentrant for the same owner"
LOOM_ACR_LEASE_OWNER=runB bash "$LEASE" acquire --acr acrtest >/dev/null 2>&1; rc=$?
check "exit 0"     "0"    "$rc"
check "owner=runB" "runB" "$(get OWNER)"

echo "9. sweep leaves a legitimately-leased open registry alone"
reset; open_; put OWNER runA; put EXPIRES "$(future)"
bash "$LEASE" sweep --acr acrtest >/dev/null 2>&1
check "still open" "Enabled" "$(get PNA)"

echo "10. sweep re-locks a registry left open by an expired/dead holder"
put EXPIRES "$(past)"
bash "$LEASE" sweep --acr acrtest >/dev/null 2>&1
check "locked"      "Disabled" "$(get PNA)"
check "denied"      "Deny"     "$(get DA)"
check "lease clear" "none"     "$(get OWNER)"

echo "11. sweep re-locks a registry opened with NO lease at all"
reset; open_
bash "$LEASE" sweep --acr acrtest >/dev/null 2>&1
check "locked" "Disabled" "$(get PNA)"

echo "12. sweep --force overrides even a live lease"
reset; open_; put OWNER runA; put EXPIRES "$(future)"
bash "$LEASE" sweep --acr acrtest --force >/dev/null 2>&1
check "locked" "Disabled" "$(get PNA)"

echo "13. degraded mode (unwritable tags): opens unleased, names the permission"
reset; put TAGWRITE fail
out=$(LOOM_ACR_LEASE_OWNER=runA bash "$LEASE" acquire --acr acrtest 2>&1); rc=$?
check "exit 0" "0"       "$rc"
check "opened" "Enabled" "$(get PNA)"
grep_ok "named the missing role" "Tag Contributor" "$out"

echo "14. LOOM_ACR_LEASE_FALLBACK=fail refuses to open unleased"
reset; put TAGWRITE fail
LOOM_ACR_LEASE_FALLBACK=fail LOOM_ACR_LEASE_OWNER=runA bash "$LEASE" acquire --acr acrtest >/dev/null 2>&1; rc=$?
check "nonzero exit" "1"        "$rc"
check "left locked"  "Disabled" "$(get PNA)"

echo "15. a degraded release still refuses to clobber a live foreign lease"
reset; open_; put OWNER runA; put EXPIRES "$(future)"; put TAGWRITE fail
LOOM_ACR_LEASE_OWNER=runB bash "$LEASE" release --acr acrtest >/dev/null 2>&1
check "still open" "Enabled" "$(get PNA)"

echo "16. a login server (acrfoo.azurecr.io) is accepted for --acr"
reset
LOOM_ACR_LEASE_OWNER=runA bash "$LEASE" acquire --acr acrtest.azurecr.io >/dev/null 2>&1
check "opened" "Enabled" "$(get PNA)"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
