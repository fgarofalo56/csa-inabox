#!/usr/bin/env bash
# Build and sign the PDP policy bundle (ES256), then verify it.
# Usage: OPA=<opa binary> tools/build-bundle.sh <private-key.pem> <public-key.pem> <revision> [outdir]
# The private key is supplied by the caller (Key Vault download in the pipeline);
# it is never stored in this repo. Tests are excluded from the bundle.
set -euo pipefail
OPA="${OPA:-opa}"
priv="${1:?private key pem}"; pub="${2:?public key pem}"; rev="${3:?revision}"
out="${4:-dist}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
"$OPA" build -b "$here/policies" -o "$out/lhds-pdp.tar.gz" \
  --revision "$rev" --signing-key "$priv" --signing-alg ES256
# Verification doubles as the distribution gate: a bundle that does not verify is not published.
"$OPA" build -b "$out/lhds-pdp.tar.gz" -o "$out/.verify.tar.gz" \
  --verification-key "$pub" --verification-key-id global --signing-key "$priv" --signing-alg ES256
rm -f "$out/.verify.tar.gz"
echo "bundle $out/lhds-pdp.tar.gz revision=$rev signed+verified"
