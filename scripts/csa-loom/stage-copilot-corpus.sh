#!/usr/bin/env bash
# Stage the in-product Copilot RAG corpus into the Docker build context.
#
# The loom-console image is built with `apps/fiab-console` as the build context,
# but the Copilot corpus lives at repo-root `docs/` + `PRPs/active/csa-loom/` —
# OUTSIDE that context. Without this step those files are never packaged into
# the image, so lib/azure/loom-docs-index.ts walks an empty FS and the `loom-docs`
# AI Search index stays empty ("No corpus chunks discovered"). Run this BEFORE
# `az acr build` (CI does this in full-app-deploy-commercial.yml; the local roll
# recipe runs it too). Idempotent; markdown-only (streamed via tar) to stay fast
# and keep the image lean.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$ROOT/apps/fiab-console/copilot-corpus"

rm -rf "$DEST/docs" "$DEST/PRPs"
mkdir -p "$DEST/docs" "$DEST/PRPs/active/csa-loom"

# Fast, portable, markdown-only copy preserving structure: find → tar stream.
copy_md() {  # $1 = src dir, $2 = dest dir
  [ -d "$1" ] || return 0
  ( cd "$1" && find . -name '*.md' -print0 | tar --null -T - -cf - ) | ( cd "$2" && tar -xf - )
}
copy_md "$ROOT/docs" "$DEST/docs"
copy_md "$ROOT/PRPs/active/csa-loom" "$DEST/PRPs/active/csa-loom"

echo "staged $(find "$DEST" -name '*.md' | wc -l | tr -d ' ') markdown files into apps/fiab-console/copilot-corpus/"
