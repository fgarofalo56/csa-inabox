#!/usr/bin/env bash
# SELF-TEST for scripts/ci/assert-acr-image-tags.sh (round-4, #3090).
# ---------------------------------------------------------------------------
# A preflight that never fails is a "gate that measures nothing" — this repo has
# already shipped three of those. But #3090 was the OPPOSITE failure and it is
# the more dangerous one: a preflight that fails LOUDLY, DEFINITIVELY, and
# FALSELY. On deploy-fiab-commercial run 31213089184 (2026-08-07) this script
# reported
#
#   image-preflight: MISSING in acrloomk6mvh5sm6z7do:
#     loom-console:03bab987… loom-copilot-maf:v0.1 loom-wrangler-host:v0.1 loom-duckdb:v0.1
#
# while `loom-console:03bab987…` was the image the LIVE console was running on
# two Healthy revisions. A different random subset failed every run. The cause
# was this branch:
#
#     elif az acr repository list --name "$ACR" -o none 2>/dev/null; then
#       # Registry IS readable, so a non-404 failure on this one ref is still a miss.
#       MISSING+=("$REF")
#
# "Another call to the registry worked" is not evidence about THIS ref. That is
# deploy-integrity.md R7 — an error asserting a cause the code never
# established — and the remediation it printed would have had the operator
# rebuild images that were perfectly fine.
#
# So the three states get MUTATION PROOFS, not just coverage. Each one flips the
# CONTROL (what the registry does), not the expected value, and asserts that the
# verdict CHANGES to the right one:
#
#   M1  tag genuinely absent      -> MISSING  (exit 3) + names the producer
#   M2  registry unreachable      -> UNPROVEN (exit 4) + a DIFFERENT message
#                                    that never says "missing" or "rebuild"
#   M3  tag present, reachable    -> PASS     (exit 0)
#
# plus the regression that defines the bug:
#
#   M4  per-ref lookup fails non-404 WHILE `repository list` SUCCEEDS
#       -> UNPROVEN (4). Under the old code this was MISSING (1). This single
#          case is #3090.
#
# and the R7 pair added for #4056 — the lease block fails in TWO ways and they
# are DIFFERENT FACTS, but it emitted ONE message for both:
#
#   A1  the readiness probe never came up      -> "never became reachable"
#   A2  the probe came up READY and `az acr login` then burned its whole retry
#       budget -> a message that says the probe ANSWERED and names the login.
#       This INPUT SHAPE had NO FIXTURE before #4056: every --lease case here
#       either succeeded at both steps or died at lease ACQUIRE, so the branch
#       was never executed and the untrue message went unmeasured.
#   A3  the collapse detector — each claim must appear in EXACTLY ONE of the
#       two, so folding them back into one message goes red in either direction.
#
# No Azure, no network, no credentials, no wall-clock waiting.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
UNDER_TEST="$HERE/assert-acr-image-tags.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

# ── stub `az` ───────────────────────────────────────────────────────────────
# MODE:
#   ok             registry reachable; PRESENT_REF resolves, everything else 404s
#   no-registry    `az acr show` fails with ARM's ResourceNotFound
#   show-denied    control plane readable but `acr show` fails for a NON-404
#                  reason (RBAC) — must never be read as "from-scratch"
#   unreachable    data plane refuses every call, `list` also fails
#   partial-deny   THE #3090 CONDITION: `repository show` is DENIED for every
#                  ref, but `repository list` SUCCEEDS. The old code called this
#                  MISSING. It is UNPROVEN.
#   login-denied   #4056: the data-plane readiness probe SUCCEEDS and `az acr
#                  login` is then refused by IP for its whole retry budget. This
#                  INPUT SHAPE had no fixture — every --lease case here either
#                  succeeded at both steps or failed at lease ACQUIRE — so the
#                  branch that fires for it was never executed by this suite.
#   throttled      429 on the per-ref lookup; `list` succeeds
#   corr404        a non-404 error whose CORRELATION ID contains "404" — the
#                  loose regex read this as absence
# The readiness probe (scripts/ci/acr-dataplane-ready.sh) makes a real HTTPS call
# to <acr>.azurecr.io, which no stub can serve — so it is injected through the
# LOOM_ACR_DATAPLANE_READY_SCRIPT seam, the same way the lease script is. It
# mirrors the az stub's view of the firewall: reachable except in the modes where
# the registry is denying this runner.
cat > "$STUB_DIR/ready" <<'READY'
#!/usr/bin/env bash
case "${MODE}" in
  unreachable|partial-deny)
    echo "::error::acr-dataplane-ready: still refusing this runner (stub)" >&2
    exit 1 ;;
esac
echo "[acr-dataplane-ready] READY (stub)"
exit 0
READY
chmod +x "$STUB_DIR/ready"
export LOOM_ACR_DATAPLANE_READY_SCRIPT="$STUB_DIR/ready"

cat > "$STUB_DIR/az" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "cloud show") echo ".azurecr.io"; exit 0 ;;
  "acr show")
     case "${MODE}" in
       no-registry) echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.ContainerRegistry/registries/stubacr' under resource group 'rg' was not found." >&2; exit 1 ;;
       show-denied) echo "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.ContainerRegistry/registries/read'." >&2; exit 1 ;;
     esac
     exit 0 ;;
  "acr login")
     case "${MODE}" in
       unreachable|partial-deny) echo "denied: client with IP '20.1.2.3' is not allowed access." >&2; exit 1 ;;
       login-denied)
         # The #3676 signature, in the DAEMON's words (acr-login-retry.sh:151).
         # `az acr login` shells out to the Docker daemon when one is present,
         # so a firewall refusal arrives worded by the daemon, not by the AAD
         # client. It matches acr-login-retry's TRANSIENT set on `is not allowed
         # access`, so it burns the FULL 12-attempt budget rather than exiting
         # on attempt 1 — which is exactly what #4052 changed and what makes the
         # READY-passed/login-exhausted branch reachable in practice.
         printf '%s\n' 'WARNING: Error response from daemon: Get "https://stubacr.azurecr.io/v2/": denied: {"errors":[{"code":"DENIED","message":"client with IP 20.1.2.3 is not allowed access. Refer https://aka.ms/acr/firewall to grant access."}]}' >&2
         printf '%s\n' 'ERROR: Login failed.' >&2
         exit 1 ;;
     esac
     exit 0 ;;
  "acr repository")
     if [ "$3" = "list" ]; then
       # NOTE: in partial-deny / throttled / corr404 this SUCCEEDS. That is the
       # whole point — the old code used this success to convict individual refs.
       case "${MODE}" in unreachable) exit 1 ;; esac
       exit 0
     fi
     if [ "$3" = "show" ]; then
       case "${MODE}" in
         unreachable|partial-deny)
           echo "denied: client with IP '20.1.2.3' is not allowed access. Refer to https://aka.ms/acr/firewall for details." >&2; exit 1 ;;
         throttled)
           echo "ERROR: TooManyRequests: Too many requests. Retry after 30 seconds." >&2; exit 1 ;;
         corr404)
           echo "ERROR: An unexpected error occurred while processing the request. Correlation id: 404abc12-3456-7890-abcd-ef0123456789" >&2; exit 1 ;;
       esac
       REF=""; i=1
       for a in "$@"; do
         if [ "$a" = "--image" ]; then j=$((i+1)); eval "REF=\${$j}"; fi
         i=$((i+1))
       done
       if [ "$REF" = "${PRESENT_REF:-}" ]; then echo '{"digest": "sha256:deadbeef"}'; exit 0; fi
       echo "ResourceNotFoundError: The manifest '${REF#*:}' does not exist for the repository '${REF%%:*}' in the registry 'stubacr'." >&2
       exit 1
     fi
     exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/az"

# ── stub `sleep` — never waits ──────────────────────────────────────────────
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_DIR/sleep"
chmod +x "$STUB_DIR/sleep"

# ── stub lease script — LEASE_MODE: ok | fail ───────────────────────────────
cat > "$STUB_DIR/lease.sh" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  acquire)
    if [ "${LEASE_MODE:-ok}" = "fail" ]; then
      echo "[acr-lease] could not write the lease tags — missing Microsoft.Resources/tags/write" >&2
      exit 1
    fi
    exit 0 ;;
  release)
    [ "${LEASE_RELEASE_MODE:-ok}" = "fail" ] && exit 1
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/lease.sh"

export PATH="$STUB_DIR:$PATH"
# Small, zero-latency retry budget. The resolver's own self-test proves the
# backoff maths; this suite is about the VERDICT.
export LOOM_PREFLIGHT_ATTEMPTS=2
export LOOM_PREFLIGHT_ABSENT_ATTEMPTS=1
export LOOM_PREFLIGHT_BACKOFF_SECONDS=0

FAILURES=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; FAILURES=$((FAILURES + 1)); }
check() { # check <label> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then pass "$1 (exit $3)"; else fail "$1 — expected exit $2, got $3"; fi
}

cd "$REPO_ROOT"

# run <MODE> [extra args...] -> sets RC / OUT (stdout+stderr merged)
run() {
  local mode="$1"; shift
  OUT=$(env MODE="$mode" bash "$UNDER_TEST" "$@" 2>&1)
  RC=$?
  return 0
}

echo "assert-acr-image-tags self-test (#3090 three-state contract)"

# ── M3. PASS — tag present and the registry answers ─────────────────────────
run ok --acr stubacr loom-duckdb:v0.1
# PRESENT_REF is read by the stub from the environment.
OUT=$(env MODE=ok PRESENT_REF="loom-duckdb:v0.1" bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 2>&1); RC=$?
check "M3 MUTATION: present tag + reachable registry -> PASS" 0 "$RC"
case "$OUT" in
  *"all 1 referenced tag(s) present"*) pass "M3 says every tag is present" ;;
  *) fail "M3 did not report all tags present — got: $OUT" ;;
esac

# ── M1. MISSING — the registry ANSWERS and the tag is absent ────────────────
# The exact round-2 defect: the template pulls :v0.1 while the Gov producer only
# ever stamped the short SHA.
OUT=$(env MODE=ok PRESENT_REF="loom-duckdb:1a2b3c4d" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 loom-console:v0.7 2>&1); RC=$?
check "M1 MUTATION: registry answers 'no such tag' -> MISSING" 3 "$RC"
case "$OUT" in
  *"MISSING in stubacr"*"loom-duckdb:v0.1"*) pass "M1 refusal names the missing tag" ;;
  *) fail "M1 refusal did not name the missing tag — got: $OUT" ;;
esac
case "$OUT" in
  *gov-provision-dataplane-images.yml*) pass "M1 refusal names the producer workflow" ;;
  *) fail "M1 refusal did not name the producer workflow" ;;
esac
case "$OUT" in
  *"registry ANSWERED"*) pass "M1 states that the registry ANSWERED (not that a lookup failed)" ;;
  *) fail "M1 did not state that the registry answered" ;;
esac

# ── M2 + M4. UNPROVEN — the registry never answers ──────────────────────────
# M4 IS #3090: `repository show` is denied for every ref while `repository list`
# SUCCEEDS. The deleted `elif` used exactly that `list` success to convict each
# ref. If this case ever returns 3 again, the defect is back.
OUT=$(env MODE=partial-deny PRESENT_REF="loom-duckdb:v0.1" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 loom-console:v0.7 2>&1); RC=$?
check "M4 MUTATION (#3090): per-ref denial while 'repository list' SUCCEEDS -> UNPROVEN" 4 "$RC"
[ "$RC" != "3" ] || fail "M4 REGRESSION: a failed lookup was reported as MISSING — this is the #3090 defect verbatim"
case "$OUT" in
  *"UNPROVEN"*) pass "M4 says UNPROVEN" ;;
  *) fail "M4 did not say UNPROVEN — got: $OUT" ;;
esac
case "$OUT" in
  *"MISSING in stubacr"*) fail "M4 REGRESSION: printed a MISSING verdict for refs it could not read" ;;
  *) pass "M4 does NOT print a MISSING verdict" ;;
esac
# The remediation must not send the operator to rebuild images that are fine —
# that false advice is half of why #3090 mattered.
case "$OUT" in
  *gov-provision-dataplane-images.yml*|*"PRODUCERS"*)
    fail "M4 REGRESSION: told the operator to run an image PRODUCER for tags whose absence was never established" ;;
  *) pass "M4 remediation is about REACHING the registry, not rebuilding images" ;;
esac
case "$OUT" in
  *"do NOT rebuild"*) pass "M4 explicitly warns against rebuilding on this verdict" ;;
  *) fail "M4 lacks the do-not-rebuild warning" ;;
esac

run unreachable --acr stubacr loom-duckdb:v0.1
check "M2 MUTATION: registry wholly unreachable -> UNPROVEN, never a silent pass" 4 "$RC"

# A throttle is not an absence.
OUT=$(env MODE=throttled bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 2>&1); RC=$?
check "throttling (429) -> UNPROVEN, not MISSING" 4 "$RC"

# The loose-regex false positive: a correlation id containing '404'.
OUT=$(env MODE=corr404 bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 2>&1); RC=$?
check "a correlation id containing '404' -> UNPROVEN, not MISSING" 4 "$RC"

# ── The three verdicts must be DISTINGUISHABLE by exit code ─────────────────
# loom-roll-and-validate.yml branches on these numbers. When it matched on prose
# instead, a wording change silently turned "unproven" into "refuse to roll".
A=$(env MODE=ok PRESENT_REF="loom-duckdb:v0.1" bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1; echo $?)
B=$(env MODE=ok PRESENT_REF="none:none"        bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1; echo $?)
C=$(env MODE=partial-deny                      bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1; echo $?)
if [ "$A" != "$B" ] && [ "$B" != "$C" ] && [ "$A" != "$C" ]; then
  pass "PASS/MISSING/UNPROVEN have three DISTINCT exit codes ($A/$B/$C)"
else
  fail "the three outcomes are not distinguishable by exit code ($A/$B/$C) — a caller cannot branch on them"
fi

# ── Registry existence: absent vs unreadable are different facts ────────────
run no-registry --acr stubacr --skip-if-registry-absent loom-duckdb:v0.1
check "ARM answers ResourceNotFound + --skip-if-registry-absent (from-scratch)" 0 "$RC"

run no-registry --acr stubacr loom-duckdb:v0.1
check "ARM answers ResourceNotFound without the flag is refused" 3 "$RC"

# An RBAC denial on `acr show` must NOT be laundered into "from-scratch deploy,
# nothing to do" — that would skip the whole gate on an unreadable estate.
run show-denied --acr stubacr --skip-if-registry-absent loom-duckdb:v0.1
check "MUTATION: unreadable registry + --skip-if-registry-absent is NOT a pass" 4 "$RC"
case "$OUT" in
  *"not established whether the registry exists"*) pass "unreadable registry says it is not established" ;;
  *) fail "unreadable registry did not distinguish itself from absent — got: $OUT" ;;
esac

# ── The lease is load-bearing: a failed acquire must not 'probe anyway' ─────
OUT=$(env MODE=ok PRESENT_REF="loom-duckdb:v0.1" LEASE_MODE=fail \
  LOOM_ACR_LEASE_SCRIPT="$STUB_DIR/lease.sh" \
  bash "$UNDER_TEST" --acr stubacr --lease loom-duckdb:v0.1 2>&1); RC=$?
check "MUTATION: lease acquire FAILS -> UNPROVEN (never 'probing anyway')" 4 "$RC"
case "$OUT" in
  *"Tag Contributor"*) pass "lease failure names the exact missing permission (OP-15)" ;;
  *) fail "lease failure did not name the missing permission — got: $OUT" ;;
esac
case "$OUT" in
  *"MISSING in stubacr"*) fail "REGRESSION: a lease failure produced a MISSING verdict" ;;
  *) pass "a lease failure does not produce a MISSING verdict" ;;
esac

# A verified-present run whose RE-LOCK could not be confirmed must not be green
# (C24 / #3088 — the class of defect where a green job sits on an open registry).
OUT=$(env MODE=ok PRESENT_REF="loom-duckdb:v0.1" LEASE_RELEASE_MODE=fail \
  LOOM_ACR_LEASE_SCRIPT="$STUB_DIR/lease.sh" \
  bash "$UNDER_TEST" --acr stubacr --lease loom-duckdb:v0.1 2>&1); RC=$?
check "MUTATION: tags present but re-lock UNVERIFIED -> not green" 5 "$RC"

# ── A1/A2/A3 (#4056). The lease block fails in TWO ways, and they are two
# DIFFERENT FACTS. Before these cases the READY-passed/login-exhausted path had
# NO FIXTURE AT ALL: every --lease run above either succeeds at both steps
# (MODE=ok) or dies at lease ACQUIRE (LEASE_MODE=fail), so the branch was never
# executed — and it emitted the OTHER branch's message, "the ACR DATA PLANE
# never became reachable within the 120s probe budget", one line after
# acr-dataplane-ready.sh had printed READY. That is deploy-integrity.md R7 in
# its purest form: the error asserts the OPPOSITE of what the code measured.
#
# The mutation is on the CONTROL — which of the two steps the registry refuses —
# and the assertion is that the PROSE changes with it while the EXIT CODE does
# not (both are UNPROVEN; loom-roll-and-validate.yml branches on the number).
#
#   A1  probe FAILS   -> "never became reachable"
#   A2  probe PASSES, `az acr login` burns its budget -> a message that says the
#       probe ANSWERED, names the login as what failed, and points at #3676
#   A3  THE COLLAPSE DETECTOR: "never became reachable" must appear in EXACTLY
#       ONE of the two, and so must "DID answer the readiness probe". Fold the
#       branches back into a single message — in EITHER direction — and one of
#       those counts goes to 2 or 0 and this check goes red.

# A1 — the probe genuinely never came up. Note --lease: without it the whole
# block is skipped, which is why MODE=unreachable further up (no --lease) does
# not exercise this at all.
OUT_A1=$(env MODE=unreachable LOOM_ACR_LEASE_SCRIPT="$STUB_DIR/lease.sh" \
  bash "$UNDER_TEST" --acr stubacr --lease loom-duckdb:v0.1 2>&1); RC_A1=$?
check "A1: readiness probe never came up -> UNPROVEN" 4 "$RC_A1"
case "$OUT_A1" in
  *"never became reachable"*) pass "A1 keeps the unreachable-data-plane wording where it is TRUE" ;;
  *) fail "A1 lost the unreachable-data-plane wording — got: $OUT_A1" ;;
esac

# A2 — the #4056 case. The probe answers READY; `az acr login` is then refused
# by IP for the full retry budget (the #3676 mid-run lease-erasure signature).
OUT_A2=$(env MODE=login-denied PRESENT_REF="loom-duckdb:v0.1" LOOM_ACR_LEASE_SCRIPT="$STUB_DIR/lease.sh" \
  bash "$UNDER_TEST" --acr stubacr --lease loom-duckdb:v0.1 2>&1); RC_A2=$?
check "A2 MUTATION (#4056): probe READY + login exhausts its budget -> UNPROVEN" 4 "$RC_A2"
case "$OUT_A2" in
  *"never became reachable"*)
    fail "A2 R7 VIOLATION: claimed the data plane never became reachable in the branch where the probe SUCCEEDED — got: $OUT_A2" ;;
  *) pass "A2 does NOT claim the data plane was unreachable" ;;
esac
case "$OUT_A2" in
  *"DID answer the readiness probe"*) pass "A2 states what was MEASURED — the probe answered" ;;
  *) fail "A2 does not say the probe answered — got: $OUT_A2" ;;
esac
case "$OUT_A2" in
  *"'az acr login'"*"retry budget"*) pass "A2 names az acr login + its own retry budget as what failed" ;;
  *) fail "A2 does not name the login retry budget as the failure — got: $OUT_A2" ;;
esac
case "$OUT_A2" in
  *"#3676"*) pass "A2 names the mid-run lease-erasure hypothesis (#3676)" ;;
  *) fail "A2 does not point at the lease as the leading hypothesis — got: $OUT_A2" ;;
esac
# The login VERDICT is the LAST line acr-login-retry prints; a head-anchored
# excerpt showed "attempt 1/12 … waiting 15s" and dropped it entirely.
#
# NOTE FOR ANYONE SPEEDING THIS UP: A2 runs the REAL acr-login-retry.sh, and it
# must keep doing so — the assertion below is on THAT script's verdict wording,
# so stubbing it would delete the evidence the check exists to read. The cost is
# PROCESS SPAWNS, not wall-clock waiting: the `sleep` stub returns immediately
# (measured here — `sleep 15` elapses 0s), and the ~40s this case takes on Git
# Bash under Windows is 12 x (az stub + grep + sleep) spawn overhead.
case "$OUT_A2" in
  *"acr-login-retry: could NOT authenticate"*) pass "A2 surfaces the login VERDICT line" ;;
  *) fail "A2 does not surface the login verdict — got: $OUT_A2" ;;
esac
# Keyed on the per-attempt warning's PREFIX, not on "1/12" — the attempt count
# is a tunable (#3383 already moved it once) and an assertion keyed to it would
# quietly stop discriminating the next time it moves.
case "$OUT_A2" in
  *"acr-login-retry: attempt "*)
    fail "A2 excerpt is HEAD-anchored: it shows a per-attempt warning instead of the exhaustion verdict" ;;
  *) pass "A2 excerpt is the verdict, not the first attempt's warning" ;;
esac
case "$OUT_A2" in
  *"UNPROVEN"*) pass "A2 says UNPROVEN" ;;
  *) fail "A2 did not say UNPROVEN — got: $OUT_A2" ;;
esac
case "$OUT_A2" in
  *"MISSING in stubacr"*) fail "A2 REGRESSION: a login failure produced a MISSING verdict" ;;
  *) pass "A2 does not produce a MISSING verdict" ;;
esac

# A3 — the collapse detector. Two-sided on purpose: collapsing to EITHER wording
# drives one of these counts off 1.
N_UNREACHABLE=0
N_ANSWERED=0
case "$OUT_A1" in *"never became reachable"*) N_UNREACHABLE=$((N_UNREACHABLE + 1)) ;; esac
case "$OUT_A2" in *"never became reachable"*) N_UNREACHABLE=$((N_UNREACHABLE + 1)) ;; esac
case "$OUT_A1" in *"DID answer the readiness probe"*) N_ANSWERED=$((N_ANSWERED + 1)) ;; esac
case "$OUT_A2" in *"DID answer the readiness probe"*) N_ANSWERED=$((N_ANSWERED + 1)) ;; esac
if [ "$N_UNREACHABLE" = "1" ] && [ "$N_ANSWERED" = "1" ]; then
  pass "A3 COLLAPSE DETECTOR: each claim appears in exactly ONE of the two branches"
else
  fail "A3: the two lease-failure branches are not distinct (unreachable-claim in $N_UNREACHABLE/2, probe-answered-claim in $N_ANSWERED/2) — collapsing them back into one message is the #4056 defect"
fi
# Both are UNPROVEN, so the CALLER contract must not have moved.
if [ "$RC_A1" = "$RC_A2" ] && [ "$RC_A1" = "4" ]; then
  pass "A3 both lease-failure branches still exit 4 — the PROSE differs, the caller contract does not"
else
  fail "A3 the two branches no longer share the UNPROVEN exit code ($RC_A1/$RC_A2) — a caller branching on 4 would break"
fi

# ── Usage ───────────────────────────────────────────────────────────────────
bash "$UNDER_TEST" --acr stubacr >/dev/null 2>&1
check "no refs supplied is a usage error" 2 "$?"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "::error::[assert-acr-image-tags] SELF-TEST FAILED — $FAILURES check(s)." >&2
  exit 1
fi
echo "[assert-acr-image-tags] self-test OK — PASS/MISSING/UNPROVEN mutation-proved and distinguishable, and the two lease-failure branches state what was measured (#4056)."
