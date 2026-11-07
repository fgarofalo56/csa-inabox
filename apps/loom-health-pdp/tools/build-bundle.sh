#!/usr/bin/env bash
# Stage, build, ES256-sign and verify the PDP policy bundle.
# Usage: OPA=<opa binary> tools/build-bundle.sh <private-key.pem> <public-key.pem> <revision> [outdir]
# Needs apps/loom-health-cp/src/auth/role-scope-map.v1.json (W1-4, single mapping
# source). The private key is supplied by the caller (Key Vault download in the
# pipeline); it is never stored in this repo. Tests are not part of the bundle.
# Per-stamp mode: STAMP_INPUTS=<PdpStampInputs json> stages data.lhds.config and
# data.lhds.stamp into the bundle (apps/loom-health-cp pdp-stamp-inputs-cli makes the
# file). PUBLISH_DIR=<dir> additionally publishes the signed+verified bundle as
# <dir>/<stampId>.tar.gz (the dir the control plane serves, atomic rename), and
# requires STAMP_INPUTS. Without STAMP_INPUTS the bundle is policy-only and every
# request denies.
set -euo pipefail
OPA="${OPA:-opa}"
priv="${1:?private key pem}"; pub="${2:?public key pem}"; rev="${3:?revision}"
out="${4:-dist}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
if [ -n "${PUBLISH_DIR:-}" ] && [ -z "${STAMP_INPUTS:-}" ]; then
  echo "PUBLISH_DIR requires STAMP_INPUTS: a policy-only bundle would deny everything" >&2; exit 2
fi
stage_args=()
[ -n "${STAMP_INPUTS:-}" ] && stage_args+=(--stamp-inputs "$STAMP_INPUTS")
node "$here/tools/stage-policies.mjs" "$out/stage" ${stage_args[@]+"${stage_args[@]}"}
"$OPA" build -b "$out/stage" -o "$out/lhds-pdp.tar.gz" \
  --revision "$rev" --signing-key "$priv" --signing-alg ES256
# Verification doubles as the distribution gate: a bundle that does not verify is not published.
"$OPA" build -b "$out/lhds-pdp.tar.gz" -o "$out/.verify.tar.gz" \
  --verification-key "$pub" --verification-key-id global --signing-key "$priv" --signing-alg ES256
rm -f "$out/.verify.tar.gz"
echo "bundle $out/lhds-pdp.tar.gz revision=$rev signed+verified"
if [ -n "${PUBLISH_DIR:-}" ]; then
  stamp_id="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stampId)' "$STAMP_INPUTS")"
  mkdir -p "$PUBLISH_DIR"
  cp "$out/lhds-pdp.tar.gz" "$PUBLISH_DIR/.$stamp_id.tar.gz.tmp"
  mv -f "$PUBLISH_DIR/.$stamp_id.tar.gz.tmp" "$PUBLISH_DIR/$stamp_id.tar.gz"
  echo "published $PUBLISH_DIR/$stamp_id.tar.gz"
fi
