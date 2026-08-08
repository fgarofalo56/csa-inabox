#!/usr/bin/env bash
# =============================================================================
# resolve-mcr-digest.sh — resolve an mcr.microsoft.com tag to its manifest digest
# =============================================================================
#
# Helper for maintaining platform/fiab/images/mcr-images.json. Bumping an MCR
# image means bumping `tag` AND `digest` together AND the bicep ref; this prints
# the digest so that is a copy-paste, not a guess.
#
#   bash scripts/ci/resolve-mcr-digest.sh azure-databases/data-api-builder 2.0.9
#   -> sha256:ad5ac179...
#
# MCR serves the Docker Registry v2 API anonymously — no token dance, unlike
# Docker Hub (see the sibling resolve-upstream-digest.sh). The OCI image INDEX /
# v2 manifest LIST media types are requested first so a multi-arch repo returns
# the index digest (the one `az acr import` and `docker pull` agree on), not one
# platform's manifest.
#
# NO `2>/dev/null` ANYWHERE IN THIS FILE. deploy-integrity.md R7: a suppressed
# stderr is what turned "I could not reach the registry" into the false claim
# "the tag does not exist" and sent two investigations down the wrong path.
# -----------------------------------------------------------------------------
set -euo pipefail

REPO="${1:-}"
TAG="${2:-}"
if [ -z "$REPO" ] || [ -z "$TAG" ]; then
  echo "usage: resolve-mcr-digest.sh <repo> <tag>   e.g. resolve-mcr-digest.sh cbl-mariner/busybox 2.0" >&2
  exit 2
fi

ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
URL="https://mcr.microsoft.com/v2/${REPO}/manifests/${TAG}"

# -f makes a 4xx/5xx a non-zero exit (so `set -e` stops here rather than letting
# an error page be parsed as headers). Headers to stdout, body discarded.
if ! HEADERS="$(curl -fsS -o /dev/null -D - -H "Accept: ${ACCEPT}" "$URL")"; then
  echo "error: the request to ${URL} FAILED. That is a transport/HTTP failure — it does NOT establish that ${REPO}:${TAG} is absent. curl's own message is above." >&2
  exit 1
fi

DIGEST="$(printf '%s' "$HEADERS" | grep -i '^docker-content-digest:' | tr -d '\r' | awk '{print $2}')"

if [ -z "$DIGEST" ]; then
  echo "error: ${URL} answered, but sent no Docker-Content-Digest header, so the digest is UNKNOWN. Response headers follow:" >&2
  printf '%s\n' "$HEADERS" >&2
  exit 1
fi

echo "$DIGEST"
