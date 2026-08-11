#!/usr/bin/env bash
# SELF-TEST for scripts/ci/mirror-upstream-images.sh digest read-back (#3090).
# ---------------------------------------------------------------------------
# THE BUG THIS PINS. The read-back was written as
#
#     LANDED="$(az acr manifest show-metadata … --query digest -o tsv 2>&1)"
#
# to keep the error text for its (correct, R7-shaped) "could not READ BACK"
# message. But `az acr manifest` is a PREVIEW command group, so az prints
#
#     WARNING: Command group 'acr manifest' is in preview and under development…
#
# to stderr on every SUCCESSFUL call. Merged into stdout by `2>&1`, that banner
# was prepended to the digest, so the equality test was always false. Measured
# on full-app-deploy-commercial run 31229911331: the step failed 3-of-3 with the
# expected and actual digests IDENTICAL inside a message claiming they differed
# and blaming an out-of-band re-tag. It blocked the whole deploy.
#
# The invariant: STDOUT IS THE VALUE, STDERR IS THE EVIDENCE, and a message must
# never claim "mismatch" for a read it could not perform or did not understand.
#
# No Azure, no network, no credentials.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
UNDER_TEST="$HERE/mirror-upstream-images.sh"
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT

# The real digest of the first manifest row, read from the manifest itself so
# this test cannot drift from the data it is asserting about.
MANIFEST="$REPO_ROOT/platform/fiab/images/upstream-images.json"
if [ ! -f "$MANIFEST" ]; then
  echo "::error::mirror self-test: $MANIFEST is missing." >&2
  exit 1
fi

# ── stub `az` ───────────────────────────────────────────────────────────────
# MODE:
#   preview-warning  import OK; show-metadata prints the CORRECT digest on
#                    stdout AND the preview banner on stderr, exits 0.
#                    THE REGRESSION CASE — this must PASS.
#   unreadable       show-metadata fails (data plane denied) -> must report
#                    "could NOT READ BACK", never "mismatch".
#   empty            show-metadata exits 0 printing nothing -> UNVERIFIED,
#                    never "mismatch".
#   real-mismatch    show-metadata returns a DIFFERENT digest -> must report
#                    "digest mismatch". (Proves the check still has teeth.)
cat > "$STUB_DIR/az" <<'STUB'
#!/usr/bin/env bash
sub="$1 $2"
case "$sub" in
  # Real `az cloud show --query suffixes.acrLoginServerEndpoint -o tsv` prints
  # the active cloud's registry suffix. The script derives it rather than
  # hardcoding `.azurecr.io`, which is what made the Gov mirror's read-back fail
  # (#3209), so the stub has to answer it like the real CLI does.
  "cloud show") echo ".azurecr.io"; exit 0 ;;
  "acr import") exit 0 ;;
  "acr manifest")
    case "${MODE}" in
      preview-warning)
        echo "WARNING: Command group 'acr manifest' is in preview and under development. Reference and support levels: https://aka.ms/CLI_refstatus" >&2
        echo "${WANT_DIGEST}"
        exit 0 ;;
      unreadable)
        echo "denied: client with IP '20.1.2.3' is not allowed access." >&2
        exit 1 ;;
      empty)
        echo "WARNING: Command group 'acr manifest' is in preview and under development." >&2
        exit 0 ;;
      real-mismatch)
        echo "WARNING: Command group 'acr manifest' is in preview and under development." >&2
        echo "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$STUB_DIR/az"
export PATH="$STUB_DIR:$PATH"

FAILURES=0
pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; FAILURES=$((FAILURES + 1)); }

cd "$REPO_ROOT"

# Every row must verify, so the stub answers with whatever digest was asked for.
# Extract the FIRST expected digest and drive a single-row run via the manifest
# the script already reads; the stub echoes $WANT_DIGEST for every lookup, which
# is correct for the preview-warning case only when it matches each row — so
# instead the stub is fed the digest the script itself printed in its plan line.
# Simpler and stricter: run the real multi-row manifest with a stub that echoes
# back the digest embedded in the requested reference is not possible (the
# reference carries a TAG, not a digest). So assert on the AGGREGATE outcome
# using a single-row manifest written here.
TMP_MANIFEST="$STUB_DIR/upstream-images.json"
EXPECTED="sha256:6499a680a93463846d3a6be980e85d601dc97b0d81e82eed9ef5e5cb9da31b79"
cat > "$TMP_MANIFEST" <<JSON
{
  "images": [
    {
      "acrRepo": "apache/airflow",
      "tag": "2.10.5-python3.12",
      "sourceRegistry": "docker.io",
      "sourceRepo": "apache/airflow",
      "digest": "$EXPECTED",
      "license": "Apache-2.0",
      "usedBy": "self-test"
    }
  ]
}
JSON

run() { # run <MODE>
  OUT=$(env MODE="$1" WANT_DIGEST="$EXPECTED" \
    bash "$UNDER_TEST" --acr stubacr --manifest "$TMP_MANIFEST" 2>&1)
  RC=$?
  return 0
}

echo "mirror-upstream-images digest read-back self-test (#3090)"

# ── THE REGRESSION. A preview banner on stderr must not become a mismatch. ──
run preview-warning
if [ "$RC" = "0" ]; then
  pass "MUTATION: preview WARNING on stderr + correct digest on stdout -> PASS (exit 0)"
else
  fail "MUTATION: a successful read-back was failed by its own stderr banner — exit $RC. Output: $OUT"
fi
case "$OUT" in
  *"digest mismatch"*) fail "REGRESSION: reported 'digest mismatch' for identical digests (the run-31229911331 defect)" ;;
  *) pass "no false 'digest mismatch' when the digests are identical" ;;
esac
case "$OUT" in
  *"in preview and under development"*)
    fail "REGRESSION: the CLI preview banner leaked into the compared value / message" ;;
  *) pass "the preview banner never reaches the compared value" ;;
esac

# ── The check still has TEETH — a genuine mismatch is caught. ───────────────
run real-mismatch
[ "$RC" != "0" ] && pass "a GENUINE digest mismatch still fails (exit $RC)" \
                 || fail "MUTATION: a real digest mismatch passed — the check measures nothing"
case "$OUT" in
  *"digest mismatch"*) pass "a genuine mismatch is named as a mismatch" ;;
  *) fail "genuine mismatch was not reported as one — got: $OUT" ;;
esac

# ── Unreadable is not a mismatch. ──────────────────────────────────────────
run unreadable
[ "$RC" != "0" ] && pass "an unreadable read-back fails (exit $RC)" \
                 || fail "an unreadable read-back passed"
case "$OUT" in
  *"could NOT READ BACK"*) pass "unreadable says 'could NOT READ BACK', not 'mismatch'" ;;
  *) fail "unreadable did not use the read-back wording — got: $OUT" ;;
esac
case "$OUT" in
  *"digest mismatch"*) fail "REGRESSION: an unreadable registry was reported as a digest mismatch" ;;
  *) pass "an unreadable registry is never called a mismatch" ;;
esac

# ── Exit 0 with no digest is UNVERIFIED, not a mismatch. ───────────────────
run empty
[ "$RC" != "0" ] && pass "an empty digest read-back fails (exit $RC)" \
                 || fail "an empty digest read-back passed"
case "$OUT" in
  *"digest mismatch"*) fail "REGRESSION: an empty read-back was reported as a digest mismatch" ;;
  *) pass "an empty read-back is not called a mismatch" ;;
esac

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "::error::[mirror-upstream-images] SELF-TEST FAILED — $FAILURES check(s)." >&2
  exit 1
fi
echo "[mirror-upstream-images] self-test OK — stdout is the value, stderr is the evidence."
