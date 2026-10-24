#!/usr/bin/env bash
# gh-runner-buildx-push.sh - build an image on the GitHub-hosted runner with a
# REGISTRY layer cache and push it to the Gov ACR (#5102).
#
# Used by gov-console-roll.yml and gov-build-images.yml when builder=gh-runner
# (the default: ACR Tasks' own backend is out of standardDDSv5Family capacity in
# usgovvirginia). Callers have ALREADY taken the ACR firewall lease, passed the
# data-plane gate, and run acr-login-retry.sh.
#
# Usage: gh-runner-buildx-push.sh --acr-login <host> --cache-image <name> -- <buildx build args...>
#   <buildx build args> carry the tags, --file, --build-arg and the context,
#   exactly as the matching `az acr build` leg passes them.
#
# What it guarantees:
#   * docker-container buildx driver (the default `docker` driver cannot export a
#     registry cache). Credentials: `az acr login` writes ~/.docker/config.json;
#     the buildx CLIENT reads it and hands it to BuildKit over the build session,
#     so the container driver needs no login of its own. That is asserted below
#     (an auths entry for the login server must exist) rather than assumed.
#   * --cache-from is soft by nature (a missing cache is a warning, not an error).
#   * A cache-EXPORT failure must not fail the build, but a PUSH failure must.
#     BuildKit reports both as a failed solve, so on failure the log is read: if
#     it names a cache exporter problem the build is re-run ONCE without
#     --cache-to (layers are in the builder's local cache, so it is quick) and
#     that run's exit status is the verdict. A push failure fails both runs.
#   * --platform linux/amd64 --push are always passed.
#
# Test seam: GH_RUNNER_DOCKER (default `docker`), GH_RUNNER_DOCKER_CONFIG,
# GH_RUNNER_SKIP_DISK_FREE (never set in workflows).
set -uo pipefail

DOCKER="${GH_RUNNER_DOCKER:-docker}"
ACR_LOGIN=""
CACHE_IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr-login) ACR_LOGIN="${2:-}"; shift 2 ;;
    --cache-image) CACHE_IMAGE="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) echo "::error::gh-runner-buildx-push: unknown argument '$1'" >&2; exit 3 ;;
  esac
done
if [ -z "$ACR_LOGIN" ] || [ -z "$CACHE_IMAGE" ] || [ $# -eq 0 ]; then
  echo "::error::gh-runner-buildx-push: --acr-login, --cache-image and the buildx args after -- are all required." >&2
  exit 3
fi

CACHE_REF="${ACR_LOGIN}/buildcache/${CACHE_IMAGE}:cache"
CFG="${GH_RUNNER_DOCKER_CONFIG:-${DOCKER_CONFIG:-$HOME/.docker}/config.json}"
BUILDER="loom-gh-runner"

# Runner disk: the console image build needs ~15 GB. Free the large preinstalled
# toolchains when under 30 GB is available. Best effort by design - the build
# itself is the verdict on whether there was enough.
echo "::group::runner disk (before)"; df -h / || true; echo "::endgroup::"
AVAIL_KB=$(df --output=avail / 2>/dev/null | tail -1 | tr -d ' ')
if [ -z "${GH_RUNNER_SKIP_DISK_FREE:-}" ] && [ -n "${AVAIL_KB:-}" ] && [ "$AVAIL_KB" -lt 31457280 ] 2>/dev/null; then
  echo "::notice::only $((AVAIL_KB / 1048576)) GB free; removing unused preinstalled toolchains."
  sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup 2>/dev/null || true
  df -h / || true
fi

# `az acr login` must have left credentials in the docker config the buildx
# client reads. Do not print the file - only whether the entry exists.
if [ ! -f "$CFG" ] || ! grep -q "\"${ACR_LOGIN}\"" "$CFG"; then
  echo "::error::no docker credentials for ${ACR_LOGIN} in ${CFG}. 'az acr login' did not write them where the buildx client reads them, so the push (and the cache export) would be anonymous and fail. Not building." >&2
  exit 1
fi

if ! "$DOCKER" buildx inspect "$BUILDER" >/dev/null 2>&1; then
  "$DOCKER" buildx create --name "$BUILDER" --driver docker-container --use >/dev/null || {
    echo "::error::could not create the docker-container buildx builder." >&2; exit 1; }
fi
"$DOCKER" buildx use "$BUILDER" || exit 1
"$DOCKER" buildx inspect --bootstrap >/dev/null || { echo "::error::buildx builder $BUILDER failed to bootstrap." >&2; exit 1; }

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# The caller's buildx args (tags, --file, --build-arg, context), kept verbatim.
BUILD_ARGS=("$@")
build() {
  local mode="$1"
  local flags=(--builder "$BUILDER" --platform linux/amd64 --push
    --cache-from "type=registry,ref=${CACHE_REF}")
  if [ "$mode" = "cache" ]; then
    flags+=(--cache-to "type=registry,ref=${CACHE_REF},mode=max,image-manifest=true,oci-mediatypes=true")
  fi
  "$DOCKER" buildx build "${flags[@]}" "${BUILD_ARGS[@]}" 2>&1 | tee "$LOG"
  return "${PIPESTATUS[0]}"
}

build cache
RC=$?
if [ $RC -ne 0 ]; then
  if grep -qiE 'cache exporter|exporting cache|error writing (layer blob|manifest blob|config blob).*buildcache|ref=[^ ]*/buildcache/' "$LOG"; then
    echo "::warning::registry cache export to ${CACHE_REF} failed (exit $RC); the build is NOT failed for that. Re-running once without --cache-to; a push failure will fail that run too."
    build nocache-export
    RC=$?
    [ $RC -eq 0 ] || echo "::error::the build/push still failed without the cache export (exit $RC), so the failure is not the cache." >&2
  else
    echo "::error::docker buildx build failed (exit $RC) and the log does not name the cache exporter; not retrying." >&2
  fi
fi
echo "::group::runner disk (after)"; df -h / || true; echo "::endgroup::"
exit $RC
