#!/usr/bin/env bash
# Stage, build, ES256-sign and verify the PDP policy bundle.
# Usage: OPA=<opa binary> tools/build-bundle.sh <private-key.pem> <public-key.pem> <revision> [outdir]
# Needs apps/loom-health-cp/src/auth/role-scope-map.v1.json (W1-4, single mapping
# source). The private key is supplied by the caller (Key Vault download in the
# pipeline); it is never stored in this repo. Tests are not part of the bundle.
# data.lhds.config and data.lhds.stamp are NOT in the bundle: the control plane adds
# them per stamp at distribution time (README). Without them every request denies.
set -euo pipefail
OPA="${OPA:-opa}"
priv="${1:?private key pem}"; pub="${2:?public key pem}"; rev="${3:?revision}"
out="${4:-dist}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
node "$here/tools/stage-policies.mjs" "$out/stage"
"$OPA" build -b "$out/stage" -o "$out/lhds-pdp.tar.gz" \
  --revision "$rev" --signing-key "$priv" --signing-alg ES256
# Verification doubles as the distribution gate: a bundle that does not verify is not published.
"$OPA" build -b "$out/lhds-pdp.tar.gz" -o "$out/.verify.tar.gz" \
  --verification-key "$pub" --verification-key-id global --signing-key "$priv" --signing-alg ES256
rm -f "$out/.verify.tar.gz"
echo "bundle $out/lhds-pdp.tar.gz revision=$rev signed+verified"
