#!/usr/bin/env bash
# Stage, build, ES256-sign and verify the PDP policy bundle.
# Usage: OPA=<opa binary> tools/build-bundle.sh <private-key.pem> <public-key.pem> <revision> [outdir]
#        OPA=<opa binary> tools/build-bundle.sh --unsigned <revision> [outdir]
# --unsigned builds the archive WITHOUT a signature and holds no key: the control plane signs it with its
# Key Vault key when it is PUT (apps/loom-health-cp src/pdp/bundle-sign.ts, #5422), so no pipeline or
# GitHub secret ever holds the private key. The signed form below stays for the CI gate and the e2e check.
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
unsigned=""
if [ "${1:-}" = "--unsigned" ]; then
  unsigned=1; shift
  priv=""; pub=""; rev="${1:?revision}"; out="${2:-dist}"
else
  priv="${1:?private key pem}"; pub="${2:?public key pem}"; rev="${3:?revision}"
  out="${4:-dist}"
fi
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$out"
if [ -n "$unsigned" ] && [ -n "${PUBLISH_DIR:-}" ]; then
  echo "PUBLISH_DIR serves bundles to OPA as-is, so it needs a SIGNED bundle; --unsigned is for the control-plane PUT" >&2; exit 2
fi
if [ -n "${PUBLISH_DIR:-}" ] && [ -z "${STAMP_INPUTS:-}" ]; then
  echo "PUBLISH_DIR requires STAMP_INPUTS: a policy-only bundle would deny everything" >&2; exit 2
fi
stage_args=()
[ -n "${STAMP_INPUTS:-}" ] && stage_args+=(--stamp-inputs "$STAMP_INPUTS")
node "$here/tools/stage-policies.mjs" "$out/stage" ${stage_args[@]+"${stage_args[@]}"}
if [ -n "$unsigned" ]; then
  # Built from INSIDE the stage dir so module names in the archive are /lhds/... and not the runner's absolute path.
  abs_out="$(cd "$out" && pwd)"
  (cd "$out/stage" && "$OPA" build -b . -o "$abs_out/lhds-pdp.tar.gz" --revision "$rev")
  echo "bundle $out/lhds-pdp.tar.gz revision=$rev UNSIGNED (the control plane signs it on PUT)"
  exit 0
fi
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
