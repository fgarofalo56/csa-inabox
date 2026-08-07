#!/usr/bin/env bash
# =============================================================================
# resolve-upstream-digest.sh — resolve a Docker Hub tag to its manifest digest
# =============================================================================
#
# Helper for maintaining platform/fiab/images/upstream-images.json. Bumping an
# upstream image means bumping `tag` AND `digest` together; this prints the digest
# so that is a copy-paste, not a guess.
#
#   bash scripts/ci/resolve-upstream-digest.sh apache/airflow 2.10.5-python3.12
#   -> sha256:6499a680...
#
# Uses the anonymous Docker Hub pull token + a HEAD-shaped manifest GET, accepting
# the OCI image INDEX / v2 manifest LIST media types so the multi-arch digest is
# returned (the digest `az acr import` and `az acr manifest show-metadata` agree
# on), not a single platform's manifest.
# -----------------------------------------------------------------------------
set -euo pipefail

REPO="${1:-}"
TAG="${2:-}"
if [ -z "$REPO" ] || [ -z "$TAG" ]; then
  echo "usage: resolve-upstream-digest.sh <namespace/repo> <tag>" >&2
  exit 2
fi

TOKEN="$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -z "$TOKEN" ]; then
  echo "error: could not obtain a Docker Hub pull token for ${REPO} — this is a token failure, not a missing image." >&2
  exit 1
fi

DIGEST="$(curl -fsS -o /dev/null -D - \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' \
  "https://registry-1.docker.io/v2/${REPO}/manifests/${TAG}" \
  | grep -i '^docker-content-digest:' | tr -d '\r' | awk '{print $2}')"

if [ -z "$DIGEST" ]; then
  echo "error: registry returned no Docker-Content-Digest header for ${REPO}:${TAG} — could not resolve the digest (the tag may not exist, or the registry did not send the header)." >&2
  exit 1
fi
echo "$DIGEST"
