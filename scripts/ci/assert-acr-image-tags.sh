#!/usr/bin/env bash
# CSA Loom — IMAGE PREFLIGHT (round-3, PR #2640).
# ---------------------------------------------------------------------------
# Assert that every image tag a template is about to reference ACTUALLY EXISTS
# in the target Azure Container Registry, and FAIL LOUDLY when it does not.
#
# WHY THIS EXISTS. `platform/fiab/bicep/modules/admin-plane/main.bicep` now
# deploys `loom-duckdb` (and, once a lake is bound, `loom-s3-gateway`) BY
# DEFAULT, pulling `<acr>/loom-duckdb:<appImageTags.duckdb>` and
# `<acr>/s3proxy:3.3.0`. A subscription-scoped re-deploy over a LIVE estate
# ADOPTS every running app in that estate. If one of those tags is missing, the
# new Container App can never pull an image, the nested deployment fails, and it
# takes the surrounding deployment — the one that is also re-PUTting the live
# `loom-console` / `loom-unity` / … apps — down with it.
#
# The Gov data-plane image producer (.github/workflows/gov-provision-dataplane-images.yml)
# HAS NEVER BEEN EXECUTED, so on the live GCC-High estate the assumption "the
# image is there because a build lane exists" is provably false. This script is
# the check that turns that assumption into evidence.
#
# THREE OUTCOMES, ALL EXPLICIT:
#   * tag present                       -> OK
#   * registry reachable, tag absent    -> FAIL (exit 1) with the exact producer
#                                          workflow to run
#   * registry NOT reachable            -> FAIL (exit 1). "I could not prove the
#                                          image exists" is NOT a pass — the
#                                          whole point is to refuse to adopt a
#                                          live estate on an unverified image.
#     Pass --skip-if-registry-absent to downgrade the *registry does not exist
#     at all* case (a genuine from-scratch deploy, nothing live to adopt) to a
#     notice + exit 0. A registry that exists but cannot be read still FAILS.
#
# NETWORK NOTE. Tag enumeration is an ACR **data-plane** call, so a
# private-endpoint-only registry is unreachable from a hosted runner. Pass
# --lease to acquire the shared ACR firewall lease (scripts/csa-loom/acr-firewall-lease.sh,
# #2603) for the duration of the probe and release it on exit — the same
# mechanism the build lanes use, so it cannot slam the door on a concurrent push.
#
# USAGE
#   scripts/ci/assert-acr-image-tags.sh --acr <acrName> [--lease] \
#     [--skip-if-registry-absent] [--rg <adminRg>] <repo:tag> [<repo:tag> ...]
#
# EXAMPLES
#   scripts/ci/assert-acr-image-tags.sh --acr acrloomabc --lease \
#     loom-duckdb:v0.1 s3proxy:3.3.0
set -uo pipefail

ACR=""
RG=""
USE_LEASE=0
SKIP_IF_REGISTRY_ABSENT=0
REFS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --rg) RG="${2:-}"; shift 2 ;;
    --lease) USE_LEASE=1; shift ;;
    --skip-if-registry-absent) SKIP_IF_REGISTRY_ABSENT=1; shift ;;
    -h|--help) sed -n '1,45p' "$0"; exit 0 ;;
    *) REFS+=("$1"); shift ;;
  esac
done

if [ -z "$ACR" ] || [ "${#REFS[@]}" -eq 0 ]; then
  echo "::error::assert-acr-image-tags.sh: --acr <name> and at least one <repo:tag> are required." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LEASE_SCRIPT="$REPO_ROOT/scripts/csa-loom/acr-firewall-lease.sh"

release_lease() {
  if [ "$USE_LEASE" = "1" ] && [ -f "$LEASE_SCRIPT" ]; then
    bash "$LEASE_SCRIPT" release --acr "$ACR" >/dev/null 2>&1 || true
  fi
}
trap release_lease EXIT

# ── Does the registry even exist? (control plane — works through the firewall) ─
if ! az acr show -n "$ACR" ${RG:+-g "$RG"} -o none 2>/dev/null; then
  if [ "$SKIP_IF_REGISTRY_ABSENT" = "1" ]; then
    echo "::notice::image-preflight: ACR '$ACR' does not exist yet — this is a from-scratch deploy with no live estate to adopt. Skipping (the two-phase image path builds it next)."
    exit 0
  fi
  echo "::error::image-preflight: ACR '$ACR' not found (or no permission to read it). Cannot prove ${REFS[*]} exist; refusing to continue." >&2
  exit 1
fi

if [ "$USE_LEASE" = "1" ] && [ -f "$LEASE_SCRIPT" ]; then
  # Short lease — a tag probe is seconds, not a matrix build.
  LOOM_ACR_LEASE_TTL_MINUTES="${LOOM_ACR_LEASE_TTL_MINUTES:-15}" \
    bash "$LEASE_SCRIPT" acquire --acr "$ACR" || \
    echo "::warning::image-preflight: could not acquire the ACR firewall lease — probing anyway."
  for _ in 1 2 3 4 5 6; do az acr login -n "$ACR" >/dev/null 2>&1 && break; sleep 10; done
fi

MISSING=()
UNREADABLE=()
PRESENT=()

for REF in "${REFS[@]}"; do
  REPO="${REF%%:*}"
  # `az acr repository show --image` returns the manifest for repo:tag; a missing
  # tag is a clean 404, an unreachable/denied registry is an auth/network error.
  if OUT=$(az acr repository show --name "$ACR" --image "$REF" -o json 2>&1); then
    DIGEST=$(printf '%s' "$OUT" | tr -d '\n' | sed -n 's/.*"digest": *"\([^"]*\)".*/\1/p')
    PRESENT+=("$REF${DIGEST:+ @ $DIGEST}")
    continue
  fi
  # Distinguish "tag/repo genuinely absent" from "cannot read the registry".
  if printf '%s' "$OUT" | grep -qiE 'not found|does not exist|ManifestUnknown|NAME_UNKNOWN|MANIFEST_UNKNOWN|TagNotFound|404'; then
    MISSING+=("$REF")
  elif az acr repository list --name "$ACR" -o none 2>/dev/null; then
    # Registry IS readable, so a non-404 failure on this one ref is still a miss.
    MISSING+=("$REF")
  else
    UNREADABLE+=("$REF")
  fi
  unset REPO
done

for P in "${PRESENT[@]:-}"; do [ -n "$P" ] && echo "  ✓ $ACR/$P"; done

if [ "${#UNREADABLE[@]}" -gt 0 ]; then
  echo "::error::image-preflight: could not READ registry '$ACR' (private endpoint / RBAC), so the existence of ${UNREADABLE[*]} is UNPROVEN. Refusing to continue — adopting a live estate on an unverified image tag is how a running catalog goes down. Re-run with --lease, or run the probe from inside the VNet." >&2
  exit 1
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "::error::image-preflight: MISSING in $ACR: ${MISSING[*]}" >&2
  cat >&2 <<'REMEDIATION'
::error::The template about to be deployed references image tags that do not exist in this
::error::registry. Deploying anyway creates Container Apps that can never pull, fails the
::error::nested deployment, and takes the surrounding (live-estate-adopting) deployment with it.
::error::
::error::PRODUCERS — run the one for this cloud FIRST, then re-run this deploy:
::error::  Commercial : .github/workflows/full-app-deploy-commercial.yml
::error::               (build matrix stamps loom-duckdb:<tag>; the `mirror-upstream`
::error::                job `az acr import`s s3proxy:3.3.0)
::error::  GCC-High   : .github/workflows/gov-provision-dataplane-images.yml
::error::               boundary=gcc-high  apply=true   [NEVER EXECUTED as of PR #2640]
::error::  IL5        : .github/workflows/gov-provision-dataplane-images.yml
::error::               boundary=il5  apply=true  resource_group=<il5-admin-rg>
::error::
::error::The tag the TEMPLATE pulls is appImageTags.duckdb (LOOM_DUCKDB_TAG, default v0.1)
::error::in platform/fiab/bicep/params/<boundary>.bicepparam. The producer's image_tag input
::error::defaults to the SAME v0.1 — if you override one you must override the other.
REMEDIATION
  exit 1
fi

echo "::notice::image-preflight: all ${#REFS[@]} referenced tag(s) present in $ACR."
exit 0
