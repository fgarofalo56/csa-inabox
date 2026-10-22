#!/usr/bin/env bash
# carry-forward-retag.sh - give each UNCHANGED app the new <app>:<sha> tag, pointing at
# the IDENTICAL manifest digest that <app>:<src-tag> has now, and PROVE it.
#
# WHY `az acr import`, NOT `docker buildx imagetools create` (run 39820244128).
# imagetools create --tag NEW SRC does not preserve the digest: it writes a new
# manifest / index, so all 12 carried apps read back a different sha256 and the
# digest-equality post-condition (correctly) failed the job. A re-tag that changes
# the digest also drops the Trivy verdict and the cosign signature, which are
# stored against the ORIGINAL digest - so the digest is the whole contract.
#
# `az acr import --force` is ARM control plane and copies the manifest as-is. The
# source is the DIGEST read just now (`<login>/<app>@sha256:...`), not the floating
# `:<src-tag>`, so a concurrent push of that tag cannot change what is carried
# between the read and the copy.
#
# FAILS CLOSED, and every message says only what was established (R7):
#   * source digest unreadable   -> names resolver exit (3 absent / 4 unreadable)
#   * import failed              -> az's own stderr is left in the log (never discarded)
#   * new tag unreadable / digest differs from the source -> "NOT verified"
# Exit 0 only if EVERY listed app verified; otherwise 1, naming each failed app and the
# dispatch that builds it.
#
# usage: carry-forward-retag.sh --acr <name> --login <loginServer> --apps "a b c"
#                               --src-tag <tag> --sha <40hex>
# env (test seams, default to the real tools): AZ, RESOLVER
set -uo pipefail

ACR=""; LOGIN=""; APPS=""; SRC_TAG=""; SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --login) LOGIN="${2:-}"; shift 2 ;;
    --apps) APPS="${2:-}"; shift 2 ;;
    --src-tag) SRC_TAG="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    *) echo "::error::carry-forward-retag.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [ -z "$ACR" ] || [ -z "$LOGIN" ] || [ -z "$APPS" ] || [ -z "$SRC_TAG" ] || [ -z "$SHA" ]; then
  echo "::error::carry-forward-retag.sh: --acr --login --apps --src-tag --sha are all required." >&2
  exit 2
fi

AZ="${AZ:-az}"
RESOLVER="${RESOLVER:-$(dirname "$0")/resolve-acr-digest.sh}"

FAILED_APPS=""
for APP in $APPS; do
  SRC=$(AZ="$AZ" bash "$RESOLVER" --acr "$ACR" --image "$APP:$SRC_TAG")
  RC=$?
  if [ "$RC" != "0" ] || [ -z "$SRC" ]; then
    echo "::error::$APP: could not read $APP:$SRC_TAG (resolver exit $RC; 3 = registry answered and the tag is absent, 4 = could not be read). Nothing was re-tagged for $APP."
    FAILED_APPS="$FAILED_APPS $APP"; continue
  fi
  if ! "$AZ" acr import --name "$ACR" --source "$LOGIN/$APP@$SRC" --image "$APP:$SHA" --force; then
    echo "::error::$APP: az acr import of $APP@$SRC as $APP:$SHA failed (az output above). $APP:$SHA was NOT created by this step."
    FAILED_APPS="$FAILED_APPS $APP"; continue
  fi
  DST=$(AZ="$AZ" bash "$RESOLVER" --acr "$ACR" --image "$APP:$SHA")
  RC=$?
  if [ "$RC" != "0" ] || [ "$DST" != "$SRC" ]; then
    echo "::error::$APP: after the re-tag, $APP:$SHA reads '${DST}' (resolver exit $RC) but the source digest is '$SRC'. The new tag is NOT verified; do not roll it."
    FAILED_APPS="$FAILED_APPS $APP"; continue
  fi
  echo "::notice::$APP: carried forward $APP:$SRC_TAG to $APP:$SHA ($SRC)"
done

if [ -n "$FAILED_APPS" ]; then
  LIST=$(echo "$FAILED_APPS" | xargs | tr ' ' ',')
  echo "::error::carry forward FAILED for: $LIST. These apps have no verified :$SHA tag. Build them with: gh workflow run build-fiab-images-acr-tasks.yml -f apps=$LIST -f tag_override=$SRC_TAG"
  exit 1
fi
exit 0
