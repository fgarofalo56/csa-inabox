#!/usr/bin/env bash
# =============================================================================
# test-resolve-msal-client-id.sh — the present / absent / UNKNOWN contract of
#                                  scripts/csa-loom/resolve-msal-client-id.sh
# =============================================================================
#
# WHY THIS FILE EXISTS. #4127 taught the resolver to distinguish "no app
# registration exists" from "I could not look", which is right and load-bearing:
# rendering an empty LOOM_MSAL_CLIENT_ID drops the env var from the Container App
# template and takes sign-in dark. It shipped with only STATIC checks —
# check-deploy-input-safety.mjs asserts the step is wired, check-deploy-staleness
# .mjs asserts the file is watched — and nothing executed the script's decision
# table. So when the same change made a failed source TERMINAL, no test noticed.
#
# It broke deploy-fiab-commercial run 33199055298 the next day (#4163). Measured
# at the time: the Key Vault carries publicNetworkAccess=Disabled and
# networkAcls.defaultAction=Deny, `az monitor activity-log` shows ZERO vault
# writes since 2026-08-25, and `actions/runners` reports total_count 0 — so the
# vault had been unreachable from the hosted runner all along, and the two
# previous runs passed only because the pre-#4127 code fell through to the
# Container App. The estate did not change; the fall-through was removed.
#
# Runs OFFLINE against a stub `az` on PATH. No Azure, no credentials, no network.
#
# THE DECISION TABLE UNDER TEST, in the order the script consults sources:
#   1 LOOM_MSAL_CLIENT_ID in the environment
#   2 Key Vault secret        (data plane — the source a firewall can refuse)
#   3 live Console Container App env  (ARM control plane — reachable from a
#                                      hosted runner, and what actually answered)
#
#   any source returns a VALUE            -> exit 0, print it
#   all return NOTHING, a read FAILED     -> exit 3, print nothing   (#4127)
#   all return NOTHING, all SUCCEEDED     -> exit 0, print nothing   (absence)
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/../csa-loom/resolve-msal-client-id.sh"
[ -f "$SUT" ] || { echo "cannot find $SUT"; exit 1; }

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
FAILED=0
pass() { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; FAILED=$((FAILED + 1)); }

# `az` stub. Each source's outcome is set independently so a case can make the
# Key Vault refuse while the Container App answers — which is the whole point.
#   AZ_KV_SECRET_RC / AZ_KV_SECRET_OUT / AZ_KV_SECRET_ERR
#   AZ_APP_RC       / AZ_APP_OUT       / AZ_APP_ERR
# Every call appends to .calls so a case can prove the script actually consulted
# a source rather than short-circuiting past it.
cat > "$STUB_DIR/az" <<'AZ'
#!/usr/bin/env bash
SELF_DIR="$(dirname "$0")"
echo "$*" >> "$SELF_DIR/.calls"
case "$1 ${2:-}" in
  "group list")
    printf '%s' "${AZ_RG_OUT-rg-csa-loom-admin-centralus}"; exit "${AZ_RG_RC:-0}" ;;
  "keyvault list")
    printf '%s' "${AZ_KVLIST_OUT-kv-loom-test}"; exit "${AZ_KVLIST_RC:-0}" ;;
  "keyvault secret")
    [ -n "${AZ_KV_SECRET_ERR:-}" ] && printf '%s' "$AZ_KV_SECRET_ERR" >&2
    printf '%s' "${AZ_KV_SECRET_OUT-}"; exit "${AZ_KV_SECRET_RC:-0}" ;;
  "containerapp show")
    [ -n "${AZ_APP_ERR:-}" ] && printf '%s' "$AZ_APP_ERR" >&2
    printf '%s' "${AZ_APP_OUT-}"; exit "${AZ_APP_RC:-0}" ;;
esac
exit 0
AZ
chmod +x "$STUB_DIR/az"

calls()      { [ -f "$STUB_DIR/.calls" ] && wc -l < "$STUB_DIR/.calls" | tr -d '[:space:]' || echo 0; }
saw()        { [ -f "$STUB_DIR/.calls" ] && grep -q "$1" "$STUB_DIR/.calls"; }
reset_calls() { rm -f "$STUB_DIR/.calls"; }

# The exact stderr Azure returned in run 33199055298. Kept VERBATIM: the
# classifier keys on error CODES, and a paraphrase would not exercise the same
# string. Note it contains no 'NotFound' code — that is what makes it UNKNOWN
# rather than an absence.
FIREWALL_DENIAL='ERROR: (Forbidden) Public network access is disabled and request is not from a trusted service nor via an approved private link.'

echo "== resolve-msal-client-id self-test =="

# ---------------------------------------------------------------------------
# 0. POPULATION FLOOR. Every case below reads an exit code and a stdout value,
#    and BOTH are producible by a script that never consulted Azure at all — an
#    early `exit 0` would satisfy the absence case and a syntax error would
#    satisfy the UNKNOWN case. Prove the stub is genuinely on the path first.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID AZ_APP_OUT=aaaaaaaa-1111-2222-3333-444444444444 \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>/dev/null)"; RC=$?
N="$(calls)"
[ "$N" -ge 3 ] && pass "population: the script made ${N} az call(s) through the stub" \
  || fail "population: only ${N} az call(s) — the stub is not on the path and every case below is vacuous"
saw "containerapp show" && pass "population: source 3 (the Container App) is actually consulted" \
  || fail "population: the script never called 'containerapp show'; the source this fix turns on is unreachable in the harness"

# ---------------------------------------------------------------------------
# 1. THE #4163 REGRESSION. Key Vault refused by the firewall; the Container App
#    holds the client id. This is run 33199055298 exactly, and it MUST resolve.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID \
  AZ_KV_SECRET_RC=1 AZ_KV_SECRET_ERR="$FIREWALL_DENIAL" \
  AZ_APP_OUT=aaaaaaaa-1111-2222-3333-444444444444 \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>"$STUB_DIR/.err")"; RC=$?
[ $RC -eq 0 ] && pass "#4163: an unreadable Key Vault does not end the search (exit 0)" \
  || fail "#4163 THE REGRESSION: a firewall-denied Key Vault ended the search with exit $RC, so deploy-fiab-commercial stays broken"
[ "$OUT" = "aaaaaaaa-1111-2222-3333-444444444444" ] \
  && pass "#4163: the client id came from the live Container App" \
  || fail "#4163: expected the Container App's client id on stdout, got '${OUT}'"
saw "containerapp show" && pass "#4163: source 3 was reached after the Key Vault failure" \
  || fail "#4163: the Container App was never consulted after the Key Vault failed"
grep -q "could not read" "$STUB_DIR/.err" \
  && pass "#4163: the unreadable source is still REPORTED, not silently swallowed" \
  || fail "#4163: the Key Vault failure vanished from the log — the operator cannot see that the durable record is unreadable: $(cat "$STUB_DIR/.err")"

# ---------------------------------------------------------------------------
# 2. THE #4127 INVARIANT, WHICH THIS FIX MUST NOT WEAKEN. Same firewall denial,
#    but now NOTHING else answers. Absence cannot be distinguished from an
#    unreadable estate, so it must stay UNKNOWN — never a silent empty.
#
#    This is the control for case 1. Without it, "the Key Vault failure no
#    longer exits 3" would be equally satisfied by deleting the check entirely.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID \
  AZ_KV_SECRET_RC=1 AZ_KV_SECRET_ERR="$FIREWALL_DENIAL" \
  AZ_APP_OUT= \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>"$STUB_DIR/.err")"; RC=$?
[ $RC -eq 3 ] && pass "#4127 preserved: unreadable Key Vault + nothing else => UNKNOWN (exit 3)" \
  || fail "#4127 BROKEN: an unreadable estate with no fallback value exited $RC instead of 3. Rendering an empty client id takes sign-in dark."
[ -z "$OUT" ] && pass "#4127 preserved: UNKNOWN prints nothing on stdout" \
  || fail "#4127 BROKEN: UNKNOWN emitted '${OUT}' — a caller would render it"
# R7 — the verdict must carry the cause it actually observed.
grep -q "Public network access is disabled" "$STUB_DIR/.err" \
  && pass "#4127 R7: the UNKNOWN names the real az error it saw" \
  || fail "#4127 R7: the UNKNOWN does not carry the observed cause, so the operator cannot act on it: $(cat "$STUB_DIR/.err")"

# ---------------------------------------------------------------------------
# 3. ABSENCE IS STILL ABSENCE. Every read SUCCEEDS and returns nothing. A fresh
#    estate must proceed with an empty id, not fail the deploy — otherwise this
#    fix would turn every greenfield deploy into an exit 3.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID AZ_KV_SECRET_OUT= AZ_APP_OUT= \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>"$STUB_DIR/.err")"; RC=$?
[ $RC -eq 0 ] && [ -z "$OUT" ] \
  && pass "absence: all reads succeeded and found nothing => exit 0, empty (greenfield still deploys)" \
  || fail "absence: a clean fresh estate returned exit $RC / '${OUT}' — greenfield deploys would break"

# ---------------------------------------------------------------------------
# 4. A GENUINELY MISSING SECRET IS AN ABSENCE, NOT AN UNKNOWN — the distinction
#    is keyed to the error CODE, so this must still fall through and resolve.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID \
  AZ_KV_SECRET_RC=1 AZ_KV_SECRET_ERR='ERROR: (SecretNotFound) A secret with (name/id) loom-msal-client-id was not found.' \
  AZ_APP_OUT=bbbbbbbb-1111-2222-3333-444444444444 \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>/dev/null)"; RC=$?
[ $RC -eq 0 ] && [ "$OUT" = "bbbbbbbb-1111-2222-3333-444444444444" ] \
  && pass "SecretNotFound is an absence: falls through and resolves from source 3" \
  || fail "a genuinely-missing secret should fall through, got exit $RC / '${OUT}'"

# ---------------------------------------------------------------------------
# 5. THE HAPPY PATH IS UNTOUCHED, and source 3 is NOT consulted once source 2
#    answers — asserted so the fix cannot quietly turn one read into two on
#    every deploy.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(env -u LOOM_MSAL_CLIENT_ID AZ_KV_SECRET_OUT=cccccccc-1111-2222-3333-444444444444 \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>/dev/null)"; RC=$?
[ $RC -eq 0 ] && [ "$OUT" = "cccccccc-1111-2222-3333-444444444444" ] \
  && pass "happy path: a readable Key Vault still resolves from source 2" \
  || fail "happy path broken: exit $RC / '${OUT}'"
saw "containerapp show" \
  && fail "the Container App was consulted even though the Key Vault answered — an extra ARM read per deploy" \
  || pass "happy path: source 3 is not consulted once source 2 answers"

# ---------------------------------------------------------------------------
# 6. An explicit environment value short-circuits everything.
# ---------------------------------------------------------------------------
reset_calls
OUT="$(LOOM_MSAL_CLIENT_ID=dddddddd-1111-2222-3333-444444444444 \
  PATH="$STUB_DIR:$PATH" bash "$SUT" 2>/dev/null)"; RC=$?
[ $RC -eq 0 ] && [ "$OUT" = "dddddddd-1111-2222-3333-444444444444" ] && [ "$(calls)" -eq 0 ] \
  && pass "an explicit LOOM_MSAL_CLIENT_ID wins with zero az calls" \
  || fail "explicit env value: exit $RC / '${OUT}' / $(calls) az call(s)"

echo
if [ $FAILED -eq 0 ]; then echo "resolve-msal-client-id: ALL CASES PASS"; else echo "resolve-msal-client-id: FAILURES ABOVE"; fi
exit $FAILED
