#!/usr/bin/env bash
# =============================================================================
# mirror-upstream-images.sh — mirror every DEPLOY-PATH upstream image into the
#                             estate ACR, BY DIGEST, in any cloud.
# =============================================================================
#
# WHY (issue #2682 / FINISHLINE D14). No Loom deploy path may pull a third-party
# container image from a public registry: a federal estate should not egress to
# Docker Hub at runtime, an air-gapped enclave cannot, and an anonymous pull gets
# no ACR firewall lease, no Trivy scan and no cosign verification. `az acr import`
# is a SERVER-SIDE registry-to-registry copy, so the only Docker Hub egress is
# this one-time import into the registry — never from a running Container App.
#
# WHY BY DIGEST. `az acr import --source docker.io/apache/airflow:2.10.5-python3.12`
# copies whatever that TAG points at at import time. Docker Hub tags are mutable,
# so two runs of the same workflow can mirror different bits under the same
# reviewed licence and the same passed CVE scan — the supply-chain hole the mirror
# exists to close, reopened one level down. Every import here resolves
# `<registry>/<repo>@<digest>` from platform/fiab/images/upstream-images.json and
# then VERIFIES the digest that actually landed in ACR.
#
# WHY A SHARED SCRIPT. The mirror was previously a hard-coded bash array
# duplicated in full-app-deploy-commercial.yml and gov-provision-dataplane-images.yml,
# with the same refs written a third time in the bicep modules. Three copies of one
# fact drift silently: bump the bicep ref and the ACR never receives that tag, so
# the Container App points at a nonexistent image and cannot activate a revision.
# scripts/ci/check-upstream-image-mirror.mjs fails the build if either workflow
# stops calling this script, or if a bicep-pinned ref has no manifest entry.
#
# FAIL CLOSED. A failed import is a hard error (exit 1). It is NOT swallowed and
# it is NOT reported as a warning: a deploy that proceeds past a failed mirror
# produces a Container App that can never start, and the operator learns about it
# from a revision-provisioning failure instead of from the step that caused it
# (deploy-integrity.md R6/R7 — the message must be true, and it must be actionable).
#
# FIREWALL. The ACRs are publicNetworkAccess=Disabled / defaultAction=Deny. Callers
# MUST already hold the #2603 lease (scripts/csa-loom/acr-firewall-lease.sh acquire)
# when they invoke this — the import is a control-plane call on the registry
# resource, but the caller's surrounding build steps are data-plane and share the
# lease window. This script deliberately does NOT acquire/release: nesting leases
# under a holder is how the #2603 incident (a cancelled run's release closing the
# registry under a live one) happened.
#
# USAGE
#   bash scripts/ci/mirror-upstream-images.sh --acr <acrName> [--manifest <path>] [--dry-run]
#
# Exit codes: 0 all images mirrored + digest-verified; 1 any failure.
# -----------------------------------------------------------------------------
set -uo pipefail

ACR=""
MANIFEST=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --acr) ACR="${2:-}"; shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *) echo "mirror-upstream-images: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

if [ -z "$ACR" ]; then
  echo "::error::mirror-upstream-images: --acr <registryName> is required." >&2
  exit 2
fi

# Repo root = two levels up from scripts/ci.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -n "$MANIFEST" ] || MANIFEST="$REPO_ROOT/platform/fiab/images/upstream-images.json"

if [ ! -f "$MANIFEST" ]; then
  echo "::error::mirror-upstream-images: manifest not found at $MANIFEST" >&2
  exit 1
fi

# Flatten the manifest to TSV: acrRepo<TAB>tag<TAB>sourceRegistry<TAB>sourceRepo<TAB>digest
# node is guaranteed present on every runner that builds this repo.
ROWS="$(node -e '
const fs = require("node:fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const imgs = Array.isArray(m.images) ? m.images : [];
if (imgs.length === 0) { console.error("manifest lists ZERO images"); process.exit(3); }
for (const i of imgs) {
  for (const k of ["acrRepo","tag","sourceRegistry","sourceRepo","digest"]) {
    if (!i[k]) { console.error(`manifest entry ${i.acrRepo||"?"} missing ${k}`); process.exit(3); }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(i.digest)) {
    console.error(`manifest entry ${i.acrRepo}:${i.tag} digest is not a sha256 manifest digest: ${i.digest}`);
    process.exit(3);
  }
  console.log([i.acrRepo, i.tag, i.sourceRegistry, i.sourceRepo, i.digest].join("\t"));
}
' "$MANIFEST")"
NODE_RC=$?
if [ $NODE_RC -ne 0 ]; then
  echo "::error::mirror-upstream-images: manifest $MANIFEST is invalid (see above)." >&2
  exit 1
fi

echo "::notice::Mirroring $(printf '%s\n' "$ROWS" | wc -l | tr -d ' ') upstream image(s) into $ACR (by digest)."

rc=0
while IFS=$'\t' read -r ACR_REPO TAG SRC_REG SRC_REPO DIGEST; do
  [ -n "$ACR_REPO" ] || continue
  DST="${ACR_REPO}:${TAG}"
  SRC="${SRC_REG}/${SRC_REPO}@${DIGEST}"
  # MCR maintains a Docker Hub mirror reachable from every sovereign cloud. The
  # fallback is by DIGEST too — a fallback that resolved a tag would defeat the
  # pinning it is standing in for.
  MCR_SRC="mcr.microsoft.com/mirror/docker/${SRC_REPO}@${DIGEST}"

  echo "  ${SRC}  ->  ${ACR}/${DST}"
  if [ "$DRY_RUN" = "1" ]; then continue; fi

  if ! az acr import -n "$ACR" --source "$SRC" --image "$DST" --force -o none; then
    echo "::warning::${SRC_REG} import failed for ${DST}; retrying via the MCR Docker Hub mirror ${MCR_SRC}"
    if ! az acr import -n "$ACR" --source "$MCR_SRC" --image "$DST" --force -o none; then
      echo "::error::could not mirror ${DST} into ${ACR} from ${SRC} or ${MCR_SRC}. The consuming Container App pins ${ACR}.azurecr.io/${DST} and cannot activate a revision without it — fix the import, do not deploy past this."
      rc=1
      continue
    fi
  fi

  # VERIFY WHAT LANDED. `az acr import` reports success on the copy request; this
  # asserts the artifact now tagged ${DST} in ACR really is the reviewed digest.
  # Without it a mis-typed manifest entry, a registry-side redirect, or a
  # concurrent --force overwrite would go unnoticed (deploy-integrity.md R6:
  # never report success on an unverified outcome).
  LANDED="$(az acr manifest show-metadata "${ACR}.azurecr.io/${DST}" --query digest -o tsv 2>&1)"
  META_RC=$?
  if [ $META_RC -ne 0 ]; then
    # DO NOT claim the digest is wrong — we could not READ it. R7: an error must
    # not assert a cause it did not establish.
    echo "::error::mirrored ${DST} into ${ACR} but could NOT READ BACK its manifest digest to verify it (az acr manifest show-metadata exited ${META_RC}: ${LANDED}). This is an unverified outcome, not a confirmed mismatch — most often the ACR data plane is not reachable from this runner (firewall lease not held / not yet propagated)."
    rc=1
    continue
  fi
  if [ "$LANDED" != "$DIGEST" ]; then
    echo "::error::digest mismatch for ${DST} in ${ACR}: expected ${DIGEST} (platform/fiab/images/upstream-images.json), registry holds ${LANDED}. Someone re-tagged this repo out of band, or the manifest entry is stale."
    rc=1
    continue
  fi
  echo "    verified ${DIGEST}"
done <<< "$ROWS"

if [ "$DRY_RUN" = "1" ]; then
  # SAY WHAT ACTUALLY HAPPENED. A dry run imported nothing and verified nothing;
  # printing the success line here would be a message asserting something it did
  # not establish (deploy-integrity.md R7).
  echo "::notice::DRY RUN — nothing was imported and no digest was verified. The plan above is what a real run would execute against ${ACR}."
  exit 0
fi

if [ $rc -eq 0 ]; then
  echo "::notice::all upstream images mirrored into ${ACR} and digest-verified."
else
  echo "::error::one or more upstream image mirrors FAILED — see the errors above. Do not deploy past this step."
fi
exit $rc
