#!/usr/bin/env bash
# =============================================================================
# test-check-mcr-image-pins.sh — MUTATION PROOF for MCR0
# =============================================================================
#
# A guard that stays green on the mutant is worthless, and that exact failure is
# this repo's most repeated defect (see memory: gates_that_cannot_fail,
# gates_that_measure_nothing, proto_pollution_test_that_cannot_fail). So this
# script does not assert that check-mcr-image-pins.mjs passes on a good tree —
# anything passes on a good tree. It BREAKS the tree six different ways and
# requires the guard to go RED each time, then restores and requires GREEN.
#
# THE FIXTURE IS A COPY OF THE REAL FILES, NEVER INVENTED CONTENT. A scratch git
# repo is built by copying the actual scanned files out of this repo, so it cannot
# drift into "a fixture that models the code instead of reality" — if the real
# bicep changes shape, the copies change with it. `git init` + `git add` is what
# makes the guard's `git ls-files` scan work inside the scratch tree.
#
# NO `|| true`, NO `2>/dev/null`, NO `continue-on-error`. Every verdict below is
# read, not discarded.
# -----------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/ci/check-mcr-image-pins.mjs"
MANIFEST_REL='platform/fiab/images/mcr-images.json'

SCRATCH="$(mktemp -d)"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

FAILURES=0

# --- build the scratch repo from the REAL files -------------------------------
build_scratch() {
  rm -rf "$SCRATCH/tree"
  mkdir -p "$SCRATCH/tree"
  ( cd "$REPO_ROOT" && git ls-files \
      "platform/fiab/bicep/**/*.bicep" "platform/fiab/bicep/*.bicep" \
      "deploy/bicep/**/*.bicep" \
      "apps/fiab-console/deploy-templates/*.json" ) > "$SCRATCH/files.txt"
  if [ ! -s "$SCRATCH/files.txt" ]; then
    echo "FATAL: git ls-files matched no scanned files in $REPO_ROOT — the self-test cannot prove anything." >&2
    exit 1
  fi
  ( cd "$REPO_ROOT" && tar -cf - -T "$SCRATCH/files.txt" ) | ( cd "$SCRATCH/tree" && tar -xf - )
  # The manifest is copied DIRECTLY, not via `git ls-files`, so the self-test works
  # on a working tree where it has been edited but not yet staged — the state a
  # developer is actually in when they run this.
  if [ ! -f "$REPO_ROOT/$MANIFEST_REL" ]; then
    echo "FATAL: $MANIFEST_REL not found under $REPO_ROOT — the registry of record is the subject of this test." >&2
    exit 1
  fi
  mkdir -p "$SCRATCH/tree/$(dirname "$MANIFEST_REL")"
  cp "$REPO_ROOT/$MANIFEST_REL" "$SCRATCH/tree/$MANIFEST_REL"
  # core.autocrlf=false REMOVES the line-ending rewrite rather than hiding its
  # warning — the fixture must be byte-identical to the real files it copies.
  ( cd "$SCRATCH/tree" \
      && git init -q . \
      && git config core.autocrlf false \
      && git config user.email ci@localhost \
      && git config user.name ci \
      && git add -A \
      && git -c commit.gpgsign=false commit -qm fixture )
}

# run the guard against the scratch tree; echo its exit code
run_guard() {
  local rc=0
  MCR_PINS_ROOT="$SCRATCH/tree" node "$GUARD" > "$SCRATCH/out.txt" 2>&1 || rc=$?
  echo "$rc"
}

expect() { # expect <wanted-rc> <label>
  local want="$1" label="$2" got
  got="$(run_guard)"
  if [ "$got" = "$want" ]; then
    printf '  PASS  %-56s (exit %s)\n' "$label" "$got"
  else
    printf '  FAIL  %-56s (exit %s, wanted %s)\n' "$label" "$got" "$want"
    sed 's/^/          | /' "$SCRATCH/out.txt"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "[test-check-mcr-image-pins] mutation proof — the guard must FAIL on each mutant"

# --- 0. baseline: the unmutated tree passes -----------------------------------
build_scratch
expect 0 "baseline (unmutated real tree)"

# --- 1. drop the inline digest from a bicep ref -------------------------------
build_scratch
perl -0pi -e 's/(data-api-builder:2\.0\.9)\@sha256:[0-9a-f]{64}/$1/' \
  "$SCRATCH/tree/platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep"
expect 1 "MUTANT: digest stripped from dab-runtime.bicep"

# --- 2. reintroduce a floating :latest ----------------------------------------
build_scratch
perl -0pi -e 's/data-api-builder:2\.0\.9\@sha256:[0-9a-f]{64}/data-api-builder:latest/' \
  "$SCRATCH/tree/platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep"
expect 1 "MUTANT: :latest reintroduced in dab-runtime.bicep"

# --- 3. a NEW, never-seen MCR image with a version tag and no digest ----------
#     This is the case a ':latest'-keyed grep would sail straight past.
build_scratch
printf "\nparam newThing string = 'mcr.microsoft.com/oss/kubernetes/pause:3.9'\n" \
  >> "$SCRATCH/tree/platform/fiab/bicep/modules/admin-plane/dab-runtime.bicep"
expect 1 "MUTANT: new un-registered mcr ref pinned only by version tag"

# --- 4. corrupt the digest in the registry of record --------------------------
build_scratch
perl -0pi -e 's/sha256:ad5ac1793049f95fdd4210ca50d3c913855553139b64992046a071cd63eeead0/sha256:0000000000000000000000000000000000000000000000000000000000000000/' \
  "$SCRATCH/tree/$MANIFEST_REL"
expect 1 "MUTANT: manifest digest no longer matches the bicep ref"

# --- 5. blank the written reason on the inlineDigest:false escape hatch -------
build_scratch
perl -0pi -e 's/"inlineDigestBlockedBy": ".*?",/"inlineDigestBlockedBy": "",/s' \
  "$SCRATCH/tree/$MANIFEST_REL"
expect 1 "MUTANT: inlineDigest:false with no written reason"

# --- 6. ANTI-HOLLOW: a scan that observes nothing must not report success -----
#     Delete every scanned bicep/ARM file but keep the manifest. A guard that
#     matches zero refs and prints OK is the exact defect this repo keeps hitting.
build_scratch
( cd "$SCRATCH/tree" && git rm -r -q --cached platform/fiab/bicep deploy/bicep apps/fiab-console \
  && rm -rf platform/fiab/bicep deploy/bicep apps/fiab-console )
expect 1 "MUTANT: zero refs observed (regex/globs broken)"

# --- 7. restore -> GREEN again ------------------------------------------------
build_scratch
expect 0 "restored (all mutations reverted)"

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "[test-check-mcr-image-pins] FAIL — $FAILURES mutation(s) did not change the guard's verdict. A guard whose verdict does not change when you break its subject is not watching it." >&2
  exit 1
fi
echo "[test-check-mcr-image-pins] OK — 8 checks; the guard is RED on all 6 mutants and GREEN on both clean runs."
