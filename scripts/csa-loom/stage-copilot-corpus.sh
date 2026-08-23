#!/usr/bin/env bash
# Stage the in-product Copilot RAG corpus into the Docker build context.
#
# The loom-console image is built with `apps/fiab-console` as the build context,
# but the Copilot corpus lives at repo-root `docs/` + `PRPs/completed/csa-loom-pillar/` +
# `PRPs/active/` + `PRPs/archive/` — OUTSIDE that context. Without this step those
# files are never
# packaged into the image, so lib/azure/loom-docs-index.ts walks an empty FS and
# the `loom-docs` AI Search index stays empty ("No corpus chunks discovered").
# Run this BEFORE `az acr build` (CI does this in full-app-deploy-commercial.yml;
# the local roll recipe runs it too). Markdown-only to keep the image lean.
#
# ── THIS LIST MUST MATCH `detectRoots()` (2026-08-22) ───────────────────────
#
# `SOURCES` below and the roots declared in
# `apps/fiab-console/lib/azure/loom-docs-corpus.ts` are TWO HAND-MAINTAINED
# LISTS DESCRIBING ONE THING, and they have already drifted once. The omnibus
# consolidation (57fa48f6 / #3881) moved 22 PRP units into `PRPs/archive/`; the
# walker gained an archive root, and had this file not gained the matching
# source the production image would have shipped a root that resolves to a
# MISSING DIRECTORY — `walkMarkdown` returns [] and the fix looks applied while
# the live Copilot sees nothing. That is strictly worse than the original bug,
# because it looks fixed.
#
# The equality is asserted by
# `apps/fiab-console/lib/azure/__tests__/corpus-staging-parity.test.ts`, which
# fails if a walker root has no staged source or vice versa. Add a root there
# and here in the SAME PR.
#
# (Note the neighbouring guard `scripts/ci/check-console-corpus-staged.mjs`
# answers a DIFFERENT question — whether each console-building workflow invokes
# this script at all. It has nothing to say about which roots the script copies,
# which is why that drift went unnoticed.)
#
# WS-G1 (2026-07-22): INCREMENTAL. Previously this did a full `rm -rf` + tar
# re-copy of all ~2453 md every run. Now it batch-content-hashes every source md
# (one `xargs sha256sum` per source tree — fast) and, via a persisted manifest,
# copies ONLY changed/new files + deletes staged files whose source is gone, then
# writes `.corpus-manifest.json` (git commit + counts + per-file hash) that the
# WS-G2 freshness guard reads. A no-change run copies zero files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/apps/fiab-console/copilot-corpus"
MANIFEST="$DEST/.corpus-manifest.json"
HASHES="$DEST/.corpus-hashes.tsv"   # flat "<relpath>\t<sha>" for fast diffing

mkdir -p "$DEST/docs" "$DEST/PRPs/completed/csa-loom-pillar" "$DEST/PRPs/active" "$DEST/PRPs/archive"

SHA_CMD="sha256sum"; command -v sha256sum >/dev/null 2>&1 || SHA_CMD="shasum -a 256"

# Sources → staged subdir. Markdown-only, recursive.
# Every entry here must have a matching root in `detectRoots()` — see the note
# at the top of this file.
SOURCES="
$ROOT/docs|docs
$ROOT/PRPs/completed/csa-loom-pillar|PRPs/completed/csa-loom-pillar
$ROOT/PRPs/active|PRPs/active
$ROOT/PRPs/archive|PRPs/archive
"

# ── INTERNAL WORKING MATERIAL IS NOT PRODUCT DOCUMENTATION (#3084) ──────────
#
# These trees are how the TEAM tracks work — parity gaps, PRP drafts, audits.
# Staged into the corpus they do not merely add noise, they DISPLACE real
# answers, because they are numerous and share boilerplate headings that match
# almost any question.
#
# The measured case: `rbac-007` ("What happens to undecided items when a review
# expires?") retrieved EIGHT chunks, every one of them headed "What actually
# happens", from eight unrelated docs/fiab/parity-gap/app-*.md files. Eight of
# the top-K slots went to documents about rag-builder, lakehouse-inspector,
# healthcare-popmgt, fabric-mirror-onboard, fedramp-tracker, finops-cost,
# pipeline-designer and iot-realtime — none of which is about review expiry.
#
# Excluding them was measured to lift 4 surfaces and regress none (#3084).
#
# Pruned by `find`, so the exclusion happens at HASH time: an excluded file is
# never in NEW, so the existing comm -13 / comm -23 diff deletes any copy a
# previous run staged. No separate cleanup step, and no way for the two lists to
# disagree.
# An ARRAY, not a string. An unquoted string expands its `*` against the CWD
# before find ever sees it — the first attempt did exactly that and find died
# with `paths must precede expression: ./fiab/parity-gap/_global-summary-….md`,
# having silently staged everything anyway.
EXCLUDE_FIND=(
  -not -path './fiab/parity-gap/*'
  -not -path './fiab/prp/*'
  -not -path './fiab/audit/*'
)

NEW="$(mktemp)"   # desired staged files: "<relpath>\t<sha>", sorted
OLD="$(mktemp)"   # previous run's manifest (empty on first run)
[ -f "$HASHES" ] && sort "$HASHES" > "$OLD" || : > "$OLD"

# ── 1. batch-hash every source md (one process per source tree) → NEW ──
while IFS='|' read -r src destsub; do
  [ -n "$src" ] && [ -d "$src" ] || continue
  ( cd "$src" && find . -name '*.md' "${EXCLUDE_FIND[@]}" -print0 | xargs -0 $SHA_CMD 2>/dev/null ) \
    | while IFS= read -r line; do
        h="${line%% *}"; p="${line#* }"; p="${p#\*}"; p="${p# }"; p="${p#./}"
        printf '%s\t%s\n' "$destsub/$p" "$h"
      done
done <<< "$SOURCES" | sort > "$NEW"

# ── 2. copy new+changed via tar-stream (fast bulk copy of ONLY changed files) ──
CHANGED="$(mktemp)"
comm -13 "$OLD" "$NEW" | cut -f1 > "$CHANGED"   # dest-relative paths that differ/new
copied="$(wc -l < "$CHANGED" | tr -d ' ')"
SUBLIST="$(mktemp)"
while IFS='|' read -r src destsub; do
  [ -n "$src" ] && [ -d "$src" ] || continue
  # source-relative paths of changed files under this destsub
  grep "^$destsub/" "$CHANGED" | sed "s#^$destsub/##" > "$SUBLIST" || :
  [ -s "$SUBLIST" ] || continue
  mkdir -p "$DEST/$destsub"
  ( cd "$src" && tr '\n' '\0' < "$SUBLIST" | tar --null -T - -cf - ) | ( cd "$DEST/$destsub" && tar -xf - )
done <<< "$SOURCES"
rm -f "$CHANGED" "$SUBLIST"

# ── 3. delete staged files whose (relpath) is gone from NEW ──
deleted=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  rm -f "$DEST/$rel"; deleted=$((deleted+1))
done < <(comm -23 <(cut -f1 "$OLD" | sort -u) <(cut -f1 "$NEW" | sort -u))
find "$DEST/docs" "$DEST/PRPs" -type d -empty -delete 2>/dev/null || true

# ── 4. persist manifests: flat tsv (diffing) + JSON (WS-G2 freshness guard) ──
cp "$NEW" "$HASHES"
COMMIT="$(cd "$ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)"
TOTAL="$(wc -l < "$NEW" | tr -d ' ')"
{
  printf '{\n  "sourceCommit": "%s",\n  "fileCount": %s,\n  "files": {\n' "$COMMIT" "$TOTAL"
  awk -F'\t' 'NR>1{printf ",\n"} {printf "    \"%s\": \"%s\"", $1, $2}' "$NEW"
  printf '\n  }\n}\n'
} > "$MANIFEST"
skipped=$(( TOTAL - copied ))
rm -f "$NEW" "$OLD"

# ── 5. stage golden eval sets (E1): content/evals → copilot-corpus/evals ──
# Small tree (10 JSONL + schema + README) — full copy each run, with removal of
# staged files whose source is gone, so the E2 evaluator Function reads the
# sets from the same in-image FS the corpus uses.
EVAL_SRC="$ROOT/content/evals"
EVAL_DEST="$DEST/evals"
evals=0
if [ -d "$EVAL_SRC" ]; then
  mkdir -p "$EVAL_DEST"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$EVAL_SRC/$f" ] || rm -f "$EVAL_DEST/$f"
  done < <(cd "$EVAL_DEST" && find . -type f | sed 's#^\./##')
  ( cd "$EVAL_SRC" && tar -cf - . ) | ( cd "$EVAL_DEST" && tar -xf - )
  find "$EVAL_DEST" -type d -empty -delete 2>/dev/null || true
  evals="$(find "$EVAL_DEST" -type f | wc -l | tr -d ' ')"
fi

echo "staged corpus incrementally: copied=$copied skipped=$skipped deleted=$deleted total=$TOTAL evals=$evals (commit ${COMMIT:0:8}) → apps/fiab-console/copilot-corpus/"
