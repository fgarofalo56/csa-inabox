#!/usr/bin/env bash
# SELF-TEST for scripts/ci/assert-acr-image-tags.sh (round-3, PR #2640).
# ---------------------------------------------------------------------------
# A preflight that never fails is a "gate that measures nothing" — this repo has
# already shipped three of those (see the 2026-07-28 incident: a REQUIRED vitest
# job passing in 13s because every real command was swallowed by `2>/dev/null`).
# So the image preflight gets the same treatment the ACR firewall lease got in
# #2603: a hermetic self-test with a stubbed `az`, wired into loom-guardrails.
#
# Exercises all five outcomes the preflight has to distinguish:
#   1. every referenced tag present                       -> exit 0
#   2. a referenced tag absent (the round-2 Gov tag bug)  -> exit 1
#   3. registry exists but is unreadable                  -> exit 1 (NOT a pass)
#   4. registry absent + --skip-if-registry-absent        -> exit 0 (from-scratch)
#   5. registry absent, no flag                           -> exit 1
#
# No Azure, no network, no credentials.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
UNDER_TEST="$HERE/assert-acr-image-tags.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

# ── stub `az` ───────────────────────────────────────────────────────────────
cat > "$STUB_DIR/az" <<'STUB'
#!/usr/bin/env bash
# MODE: ok | no-registry | unreachable      PRESENT_REF: the one tag that exists
case "$1 $2" in
  "acr show")
     if [ "${MODE}" = "no-registry" ]; then exit 1; fi
     exit 0 ;;
  "acr login") exit 0 ;;
  "acr repository")
     if [ "$3" = "show" ]; then
       if [ "${MODE}" = "unreachable" ]; then
         echo "denied: client with IP is not allowed access" >&2; exit 1
       fi
       REF=""; i=1
       for a in "$@"; do
         if [ "$a" = "--image" ]; then j=$((i+1)); eval "REF=\${$j}"; fi
         i=$((i+1))
       done
       if [ "$REF" = "${PRESENT_REF:-}" ]; then echo '{"digest": "sha256:deadbeef"}'; exit 0; fi
       echo "ManifestUnknown: manifest tagged not found" >&2; exit 1
     fi
     if [ "$3" = "list" ]; then
       if [ "${MODE}" = "unreachable" ]; then exit 1; fi
       exit 0
     fi
     exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/az"
export PATH="$STUB_DIR:$PATH"

FAILURES=0
check() { # check <label> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1 (exit $3)"
  else
    echo "  FAIL $1 — expected exit $2, got $3" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

cd "$REPO_ROOT"

MODE=ok PRESENT_REF="loom-duckdb:v0.1" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1
check "all referenced tags present" 0 $?

# The exact round-2 defect: the template pulls :v0.1 while the Gov producer only
# ever stamped the short SHA. The preflight MUST catch this.
OUT=$(MODE=ok PRESENT_REF="loom-duckdb:1a2b3c4d" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 loom-console:v0.7 2>&1)
check "missing tag is refused" 1 $?
case "$OUT" in
  *"MISSING in stubacr"*"loom-duckdb:v0.1"*) echo "  ok   refusal names the missing tag" ;;
  *) echo "  FAIL refusal did not name the missing tag" >&2; FAILURES=$((FAILURES + 1)) ;;
esac
case "$OUT" in
  *gov-provision-dataplane-images.yml*) echo "  ok   refusal names the producer workflow" ;;
  *) echo "  FAIL refusal did not name the producer workflow" >&2; FAILURES=$((FAILURES + 1)) ;;
esac

MODE=unreachable PRESENT_REF="loom-duckdb:v0.1" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1
check "unreadable registry is NOT a silent pass" 1 $?

MODE=no-registry PRESENT_REF="x" \
  bash "$UNDER_TEST" --acr stubacr --skip-if-registry-absent loom-duckdb:v0.1 >/dev/null 2>&1
check "absent registry + --skip-if-registry-absent (from-scratch)" 0 $?

MODE=no-registry PRESENT_REF="x" \
  bash "$UNDER_TEST" --acr stubacr loom-duckdb:v0.1 >/dev/null 2>&1
check "absent registry without the flag is refused" 1 $?

bash "$UNDER_TEST" --acr stubacr >/dev/null 2>&1
check "no refs supplied is a usage error" 2 $?

if [ "$FAILURES" -gt 0 ]; then
  echo "[assert-acr-image-tags] SELF-TEST FAILED — $FAILURES case(s)." >&2
  exit 1
fi
echo "[assert-acr-image-tags] self-test OK — all five outcomes distinguished, refusal text verified."
