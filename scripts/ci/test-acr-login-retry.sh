#!/usr/bin/env bash
# =============================================================================
# test-acr-login-retry.sh — self-test for scripts/ci/acr-login-retry.sh
# =============================================================================
#
# WHY THIS EXISTS (#3383). acr-login-retry.sh had 25 call sites and NO test, so
# its retry budget was a number nobody could change safely and nobody could
# verify. On 2026-08-13 that budget (6x10s) was too small for the ACR
# AAD->token-exchange propagation tail; loom-roll-and-validate run 31732873272
# exhausted it and rolled the estate back two commits.
#
# The budget was raised to 12x15s. This test pins it BEHAVIOURALLY — it counts
# how many times the loop actually invokes `az`, rather than grepping the source
# for `ATTEMPTS=12`. A grep-based assertion passes on a file where the literal is
# present but unreachable; only running the loop proves the default is the one
# that governs. (Same reasoning as guard_with_zero_population_needs_embedded_control:
# an assertion that cannot observe the thing it names is not an assertion.)
#
# `az` is stubbed via a PATH shim, so this runs anywhere — no Azure, no network,
# no credentials. Total runtime is ~0s: every case overrides backoff to 0, EXCEPT
# the one that measures the default backoff, which uses --attempts 1 (the loop
# never sleeps after its final attempt, so the default is observable for free).
#
# Usage: bash scripts/ci/test-acr-login-retry.sh
# Exit:  0 all cases passed / 1 a case failed
# -----------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/acr-login-retry.sh"
[ -f "$TARGET" ] || { echo "FAIL: $TARGET not found"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SHIM="$TMP/bin"
mkdir -p "$SHIM"

# The `az` stub. Appends one line per invocation so the caller can count, then
# succeeds or fails according to the env the case sets.
cat > "$SHIM/az" <<'SHIMEOF'
#!/usr/bin/env bash
printf 'call\n' >> "$AZ_CALLS"
n=$(wc -l < "$AZ_CALLS" | tr -d ' ')
if [ -n "${AZ_SUCCEED_ON:-}" ] && [ "$n" -ge "$AZ_SUCCEED_ON" ]; then
  echo "Login Succeeded"
  exit 0
fi
printf '%s\n' "${AZ_FAIL_MSG:-generic failure}"
exit 1
SHIMEOF
chmod +x "$SHIM/az"

TRANSIENT_MSG='WARNING: Unable to get AAD authorization tokens with message: CONNECTIVITY_REFRESH_TOKEN_ERROR. Access to registry '"'"'x.azurecr.io'"'"' was denied. Response code: 403.'
# Deliberately contains none of the transient tokens (no 403/503/504/throttling).
PERMANENT_MSG="ERROR: The registry 'nope' could not be resolved: the resource with that name does not exist in this subscription."

# The Docker-daemon IP-denial shape (loom-roll-and-validate run 32819789544,
# 2026-08-25). Until that run this suite had exactly ONE transient fixture - the
# AAD shape above - so it proved the retry MECHANICS exhaustively and the
# CLASSIFICATION SET not at all. Single-fixture cardinality is why the gap
# shipped: `az acr login` routed through the Docker daemon, whose refusal text
# shares no needle with the AAD client's, and the loop called it permanent.
# The IP here is TEST-NET-3 (RFC 5737) - never a real runner address.
IPDENY_MSG='WARNING: Error response from daemon: Get "https://x.azurecr.io/v2/": denied: {"errors":[{"code":"DENIED","message":"client with IP '"'"'203.0.113.9'"'"' is not allowed access. Refer https://aka.ms/acr/firewall to grant access."}]}  ERROR: Login failed.'

# The NEGATIVE control for the same needle: ACR's repo-permission denial. It is
# also daemon-worded, also says `denied:`, also ends `ERROR: Login failed.` -
# and it must stay PERMANENT, because no amount of retrying grants a role.
# Without this fixture the two IP-denial cases pin only the needle's PRESENCE:
# replacing `is not allowed access` with `denied`, `DENIED`, `daemon` or
# `Login failed` keeps the whole suite green while making the script retry
# essentially every docker-path failure for the full budget. This case goes red
# under all four.
PERMDENY_MSG='WARNING: Error response from daemon: Get "https://x.azurecr.io/v2/": denied: requested access to the resource is denied  ERROR: Login failed.'

# --- #4055 fixtures --------------------------------------------------------
#
# The two wordings Microsoft's own troubleshooting page documents
# (container-registry-troubleshoot-access) that the pre-#4055 needle set matched
# NOWHERE, so the canonical daemon-side firewall refusal and the private-endpoint
# DNS failure both classified as PERMANENT and exited on attempt 1.
#
# Note the first: `status: 403 Forbidden` - NOT `Response code: 403`. The AAD
# client and the Docker daemon phrase the same condition differently, which is
# exactly the #4052 miss repeating in a second wording.
DAEMON403_MSG='WARNING: Error response from daemon: login attempt to https://x.azurecr.io/v2/ failed with status: 403 Forbidden  ERROR: Login failed.'
# Private endpoint / DNS. Recorded decision (#4055): TRANSIENT - the reasoning is
# in acr-login-retry.sh next to the needle.
UNREACHABLE_MSG='ERROR: Failed to connect to MSI. Please make sure MSI is configured correctly. Get "https://x.azurecr.io/v2/": dial tcp: lookup x.azurecr.io: host is not reachable'

# BREADTH controls, not presence controls. #4052's own finding was that a test
# pinning a needle's PRESENCE does not stop the next person WIDENING it, and a
# widened needle is how the repo-permission denial starts getting retried for
# 165s and then reported as a transient.
#
#   PERMDENY_LINK_MSG - an RBAC denial carrying an aka.ms/acr/* link. Broadening
#     `aka\.ms/acr/firewall` to `aka\.ms/acr` or `aka\.ms` flips this to TRANSIENT
#     and this case goes red. (ACR points permission problems at
#     /acr/authorization and network problems at /acr/firewall.)
#   NOHOST_MSG - a registry that does not exist, worded with the word `host` in
#     it. Broadening `host is not reachable` to `host` or `not reachable` flips
#     this to TRANSIENT and this case goes red.
PERMDENY_LINK_MSG='WARNING: Error response from daemon: Get "https://x.azurecr.io/v2/": denied: requested access to the resource is denied. Refer https://aka.ms/acr/authorization to check your role assignments.  ERROR: Login failed.'
NOHOST_MSG='ERROR: The registry host "nope.azurecr.io" does not exist in subscription 00000000-0000-0000-0000-000000000000. Verify the registry name.'
#   DIGEST403_MSG - a permanent manifest error whose HEX DIGEST contains the
#     digits 403. The status-code alternate is bounded by non-alphanumerics
#     precisely so this cannot satisfy it; dropping those boundaries (a bare
#     `403`, as `503|504` used to be) flips this to TRANSIENT and this case goes
#     red after burning the full retry budget on an error that will never clear.
DIGEST403_MSG='ERROR: manifest for x.azurecr.io/loom-console@sha256:be403fa91c2d4e778bb1ac9e5d6f0071a2c3b4d5e6f708192a3b4c5d6e7f8091 not found: manifest unknown.'

PASS=0
FAIL=0

run_case() {
  # run_case <name> <succeed_on|""> <fail_msg> <expect_rc> <expect_calls> [extra args...]
  local name="$1" succeed_on="$2" fail_msg="$3" want_rc="$4" want_calls="$5"
  shift 5
  local calls="$TMP/calls.$$"
  : > "$calls"
  local out rc got
  out="$(AZ_CALLS="$calls" AZ_SUCCEED_ON="$succeed_on" AZ_FAIL_MSG="$fail_msg" \
        PATH="$SHIM:$PATH" bash "$TARGET" --acr testacr "$@" 2>&1)"
  rc=$?
  got="$(wc -l < "$calls" | tr -d ' ')"
  if [ "$rc" = "$want_rc" ] && [ "$got" = "$want_calls" ]; then
    echo "  ok   $name (rc=$rc, az calls=$got)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $name — expected rc=$want_rc calls=$want_calls, got rc=$rc calls=$got"
    printf '%s\n' "$out" | sed 's/^/         | /'
    FAIL=$((FAIL + 1))
  fi
  LAST_OUT="$out"
}

echo "== acr-login-retry self-test"

# --- behaviour -------------------------------------------------------------
run_case "succeeds on first attempt"                1  "$TRANSIENT_MSG" 0 1  --attempts 5 --backoff 0
run_case "retries a transient, then succeeds"       3  "$TRANSIENT_MSG" 0 3  --attempts 5 --backoff 0
run_case "exhausts the budget and fails CLOSED"     "" "$TRANSIENT_MSG" 1 5  --attempts 5 --backoff 0
run_case "non-transient exits on attempt 1"         "" "$PERMANENT_MSG" 1 1  --attempts 5 --backoff 0

# --- the classification set, not just the mechanics ------------------------
# Removing `is not allowed access` from TRANSIENT turns both of these red:
# the first gets rc=1/calls=1 instead of rc=0/calls=3. That is the mutation
# the single-fixture suite could not make.
run_case "IP denial (docker shape) is TRANSIENT"    3  "$IPDENY_MSG" 0 3  --attempts 5 --backoff 0
run_case "IP denial still fails CLOSED on budget"   "" "$IPDENY_MSG" 1 5  --attempts 5 --backoff 0
run_case "repo-permission denial stays PERMANENT"   "" "$PERMDENY_MSG" 1 1  --attempts 5 --backoff 0

# --- #4055: the two documented wordings the set used to miss entirely --------
# Removing `status: 403 Forbidden` turns the first pair red (rc=1/calls=1
# instead of rc=0/calls=3); removing `host is not reachable` turns the second.
run_case "daemon 403 Forbidden is TRANSIENT"        3  "$DAEMON403_MSG" 0 3  --attempts 5 --backoff 0
run_case "daemon 403 still fails CLOSED on budget"  "" "$DAEMON403_MSG" 1 5  --attempts 5 --backoff 0
run_case "PE/DNS 'host is not reachable' is TRANSIENT" 3 "$UNREACHABLE_MSG" 0 3 --attempts 5 --backoff 0
run_case "PE/DNS unreachable fails CLOSED on budget" "" "$UNREACHABLE_MSG" 1 5 --attempts 5 --backoff 0

# --- #4055 BREADTH controls: widening a needle must go RED ------------------
# These two are the reason this suite constrains the set from ABOVE as well as
# below. Both must stay PERMANENT.
run_case "RBAC denial w/ an aka.ms/acr link stays PERMANENT" "" "$PERMDENY_LINK_MSG" 1 1 --attempts 5 --backoff 0
run_case "'registry host does not exist' stays PERMANENT"    "" "$NOHOST_MSG"        1 1 --attempts 5 --backoff 0
# The third breadth control (#4214), guarding the status-code alternate's
# boundaries rather than its presence. Replacing the bounded alternate with a
# bare `403` — the shape `503|504` carried until this change — turns this red.
run_case "403 inside a hex digest stays PERMANENT"          "" "$DIGEST403_MSG"     1 1 --attempts 5 --backoff 0

# --- the defaults, measured through the loop (the #3383 regression guard) ---
run_case "DEFAULT attempts is 12 (not 6)"           "" "$TRANSIENT_MSG" 1 12 --backoff 0
run_case "DEFAULT backoff is observable"            "" "$TRANSIENT_MSG" 1 1  --attempts 1
if printf '%s' "$LAST_OUT" | grep -q 'budget 1x15s'; then
  echo "  ok   DEFAULT backoff is 15s (not 10s)"
  PASS=$((PASS + 1))
else
  echo "  FAIL DEFAULT backoff is not 15s — exhaustion message did not report 'budget 1x15s'"
  printf '%s\n' "$LAST_OUT" | sed 's/^/         | /'
  FAIL=$((FAIL + 1))
fi

# --- R7: the exhaustion message must not assert an unmeasured duration ------
# With backoff 0 the loop takes ~0s. A message claiming otherwise is the exact
# class of untrue error string deploy-integrity.md R7 exists to stop.
if printf '%s' "$LAST_OUT" | grep -qE 'after [0-9]+ attempts over [0-9]+s'; then
  echo "  ok   exhaustion message reports MEASURED elapsed time"
  PASS=$((PASS + 1))
else
  echo "  FAIL exhaustion message does not report measured elapsed time (R7)"
  FAIL=$((FAIL + 1))
fi

# --- usage ------------------------------------------------------------------
PATH="$SHIM:$PATH" bash "$TARGET" >/dev/null 2>&1
if [ $? -eq 3 ]; then
  echo "  ok   missing --acr exits 3"
  PASS=$((PASS + 1))
else
  echo "  FAIL missing --acr did not exit 3"
  FAIL=$((FAIL + 1))
fi

# --- CONTROL: the harness itself must be able to fail -----------------------
# Without this, a broken shim (never invoked, always exiting 0) would make every
# case above pass vacuously. Assert the stub really is what `az` resolves to.
if [ "$(PATH="$SHIM:$PATH" command -v az)" = "$SHIM/az" ]; then
  echo "  ok   CONTROL: az resolves to the stub, so the cases above measured it"
  PASS=$((PASS + 1))
else
  echo "  FAIL CONTROL: az did not resolve to the stub — every case above is meaningless"
  FAIL=$((FAIL + 1))
fi

echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
