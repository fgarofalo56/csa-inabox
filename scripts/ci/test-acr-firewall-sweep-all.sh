#!/usr/bin/env bash
# =============================================================================
# test-acr-firewall-sweep-all.sh — regression test for #2836
# =============================================================================
#
# The lease script's own semantics are covered by test-acr-firewall-lease.sh.
# What NOTHING covered was the DISCOVERY step that decides which registries get
# swept at all — it lived inline in acr-firewall-sweeper.yml, and it inferred
# "there is nothing to sweep" from an empty command substitution. A failing
# `az` (expired token, throttling, transient 5xx) therefore took the same
# branch as an empty subscription and the scheduled security job went GREEN.
#
# These cases pin the distinction that bug erased:
#
#   * `az group list` FAILS                       -> non-zero exit, loud
#   * `az acr list` FAILS                          -> non-zero exit, loud
#   * an admin RG with ZERO acrloom* registries     -> non-zero exit (discovery
#     bug, not an empty estate — the registry lives in that RG)
#   * CONTROL: `az` SUCCEEDS and truthfully reports no admin RG -> exit 0
#     (this is the one legitimate "nothing to sweep"; a fix that just made
#     everything fail would break this case)
#   * CONTROL: the happy path still sweeps every registry and exits 0
#   * a failing sweep of one registry still fails the run
#
# Runs against a FAKE `az` — no Azure, no credentials, no network.
# Run locally: bash scripts/ci/test-acr-firewall-sweep-all.sh
# =============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SWEEPALL="$REPO/scripts/csa-loom/acr-firewall-sweep-all.sh"
[ -f "$SWEEPALL" ] || { echo "missing $SWEEPALL" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STATE="$WORK/state.vars"
export SWEEPLOG="$WORK/swept.log"
export ARGVLOG="$WORK/argv.log"
export PATH="$WORK/bin:$PATH"

# ── fake az ───────────────────────────────────────────────────────────────────
# GROUP_RC / ACR_RC drive the failure injection; RGS / ACRS are ','-separated
# lists (a flat, sourceable state file cannot hold real newlines).
cat > "$WORK/bin/az" <<'FAKEAZ'
#!/usr/bin/env bash
set -uo pipefail
STATE="${STATE:?}"
. "$STATE"
case "${1:-}:${2:-}" in
  group:list)
    if [ "$GROUP_RC" != "0" ]; then
      echo "ERROR: AADSTS700082 The refresh token has expired." >&2
      exit "$GROUP_RC"
    fi
    [ -n "$RGS" ] && printf '%s\n' "$RGS" | tr ',' '\n'
    exit 0 ;;
  acr:list)
    if [ "$ACR_RC" != "0" ]; then
      echo "ERROR: (ServiceUnavailable) The service is temporarily unavailable." >&2
      exit "$ACR_RC"
    fi
    [ -n "$ACRS" ] && printf '%s\n' "$ACRS" | tr ',' '\n'
    exit 0 ;;
esac
exit 0
FAKEAZ
chmod +x "$WORK/bin/az"

# ── fake lease script ────────────────────────────────────────────────────────
# The real one is exercised by test-acr-firewall-lease.sh; here we only need to
# observe WHICH registries discovery handed it, and to be able to make one fail.
cat > "$WORK/lease.sh" <<'FAKELEASE'
#!/usr/bin/env bash
set -uo pipefail
STATE="${STATE:?}"
. "$STATE"
echo "$*" >> "${ARGVLOG:?}"
ACR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$ACR" >> "${SWEEPLOG:?}"
[ "$ACR" = "$SWEEPFAIL" ] && exit 1
exit 0
FAKELEASE
chmod +x "$WORK/lease.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want=$2 got=$3)"; fi; }
grep_ok() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1 — output lacked '$2'" ;; esac; }

# NB: the RG list variable is RGS, not GROUPS. `GROUPS` is a bash BUILT-IN array
# (the caller's numeric group ids); a sourced `GROUPS=''` does not take, so the
# fake would have reported a group id as the resource-group name and case 4
# could never reach its empty branch.
reset() {
  printf "GROUP_RC='0'\nACR_RC='0'\nRGS='rg-csa-loom-admin-centralus'\nACRS='acrloomtest01'\nSWEEPFAIL=''\n" > "$STATE"
  : > "$SWEEPLOG"
  : > "$ARGVLOG"
}
put() { sed -i "s|^${1}=.*|${1}='${2}'|" "$STATE"; }

# Run the script under test with the fake lease script swapped in for the real
# one. The script resolves the lease script relative to ITSELF, so copy it into
# a scratch dir next to the fake.
mkdir -p "$WORK/sut"
cp "$SWEEPALL" "$WORK/sut/acr-firewall-sweep-all.sh"
cp "$WORK/lease.sh" "$WORK/sut/acr-firewall-lease.sh"
run() { bash "$WORK/sut/acr-firewall-sweep-all.sh" "$@" 2>&1; }

echo "acr-firewall-sweep-all (#2836) regression test"

echo "1. THE #2836 BUG: 'az group list' FAILS -> must NOT report 'nothing to sweep'"
reset; put GROUP_RC 1
out=$(run); rc=$?
check "nonzero exit" "1" "$rc"
grep_ok "said the discovery call failed" "'az group list' FAILED" "$out"
grep_ok "refused to call it 'nothing to sweep'" "NOT 'nothing to sweep'" "$out"
case "$out" in
  *"nothing to sweep."*) bad "must not print the benign 'nothing to sweep.' notice" ;;
  *) ok "did not print the benign notice" ;;
esac

echo "2. THE #2836 BUG, second half: 'az acr list' FAILS -> must fail loudly"
reset; put ACR_RC 1
out=$(run); rc=$?
check "nonzero exit" "1" "$rc"
grep_ok "named the failing call" "'az acr list" "$out"
check "swept nothing" "0" "$(wc -l < "$SWEEPLOG" | tr -d ' ')"

echo "3. an admin RG with ZERO acrloom* registries is a discovery bug, not empty"
reset; put ACRS ""
out=$(run); rc=$?
check "nonzero exit" "1" "$rc"
grep_ok "said the sweeper protected nothing" "protected NOTHING" "$out"

echo "4. CONTROL: az SUCCEEDS and truthfully reports no admin RG -> exit 0"
reset; put RGS ""
out=$(run); rc=$?
check "exit 0" "0" "$rc"
grep_ok "benign notice" "nothing to sweep." "$out"

echo "5. CONTROL: happy path sweeps every discovered registry and exits 0"
reset; put ACRS "acrloomtest01,acrloomtest02"
out=$(run); rc=$?
check "exit 0" "0" "$rc"
check "swept both" "2" "$(wc -l < "$SWEEPLOG" | tr -d ' ')"
grep_ok "swept the first"  "acrloomtest01" "$(cat "$SWEEPLOG")"
grep_ok "swept the second" "acrloomtest02" "$(cat "$SWEEPLOG")"

echo "6. a failing sweep of ONE registry still fails the run"
reset; put ACRS "acrloomtest01,acrloomtest02"; put SWEEPFAIL acrloomtest02
out=$(run); rc=$?
check "nonzero exit" "1" "$rc"
check "still tried both" "2" "$(wc -l < "$SWEEPLOG" | tr -d ' ')"
grep_ok "named the registry" "sweep FAILED for registry" "$out"

echo "7. --force and --subscription are actually FORWARDED to the lease script"
reset
out=$(bash "$WORK/sut/acr-firewall-sweep-all.sh" --force 2>&1); rc=$?
check "exit 0" "0" "$rc"
grep_ok "--force reached the lease script" "--force" "$(cat "$ARGVLOG")"
reset
out=$(bash "$WORK/sut/acr-firewall-sweep-all.sh" --subscription sub-test-123 2>&1); rc=$?
check "exit 0" "0" "$rc"
grep_ok "--subscription reached the lease script" "--subscription sub-test-123" "$(cat "$ARGVLOG")"
# ...and the default invocation must NOT smuggle either one in.
reset
out=$(run); rc=$?
case "$(cat "$ARGVLOG")" in
  *--force*)        bad "default run must not pass --force" ;;
  *--subscription*) bad "default run must not pass --subscription" ;;
  *) ok "default run passes neither --force nor --subscription" ;;
esac

# ── 8. WIRING ────────────────────────────────────────────────────────────────
# Everything above tests a SCRIPT. If acr-firewall-sweeper.yml stopped calling
# that script — or grew a second inline copy of the discovery it just lost —
# every case above would still pass while production went back to swallowing az
# failures. A test whose subject nothing invokes is the same defect class as the
# bug it was written for, so assert the wiring too.
echo "8. WIRING: the sweeper workflow delegates to this script, both clouds"
WF="$REPO/.github/workflows/acr-firewall-sweeper.yml"
if [ -f "$WF" ]; then
  calls=$(grep -cE '^\s*bash scripts/csa-loom/acr-firewall-sweep-all\.sh' "$WF" | tr -d ' ')
  check "both jobs call the tested script" "2" "$calls"
  # The exact shape that was broken: a bare `az group list` whose empty result
  # is read as "nothing to sweep". It must not come back inline.
  inline=$(grep -cE '^\s*RG=\$\(az group list' "$WF" | tr -d ' ')
  check "no inline RG discovery remains" "0" "$inline"
  forloop=$(grep -cE 'for +[A-Za-z_]+ +in +\$\(az acr list' "$WF" | tr -d ' ')
  check "no inline acr-list for-loop remains" "0" "$forloop"
else
  bad "acr-firewall-sweeper.yml not found at $WF"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
