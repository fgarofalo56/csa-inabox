#!/bin/sh
# Post-build verification of a built loom-health-fhir image, with NO network.
#   verify-image.sh <image-ref>
# Needs a docker CLI. The distroless image has no shell, so each probe overrides the
# entrypoint with `java`. Fixtures are mounted from this app's check/ directory.
set -eu
IMG="$1"
# Stops MSYS shells on Windows from rewriting the container paths below.
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)

echo "== plugin load probe"
OUT=$(docker run --rm --network none --entrypoint java "$IMG" \
  -cp /app/extra-classes/loom-health-fhir-plugin.jar ai.loom.health.fhir.LoomPlugin)
echo "$OUT"
echo "$OUT" | grep -q '"interceptors":0' || { echo "FAIL plugin probe"; exit 1; }

run_validator() { # <fixture>
  # --user 0: the validator takes lock files inside its package cache, which the image
  # owns as root; the server itself never uses this cache.
  docker run --rm --network none --user 0 -v "$HERE/check:/chk:ro" --entrypoint java "$IMG" \
    -Duser.home=/opt/loom/fhir/home -jar /opt/loom/fhir/validator/validator_cli.jar \
    "/chk/$1" -version 4.0.1 -ig hl7.fhir.us.core#6.1.0 \
    -profile http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient -tx n/a 2>&1
}

echo "== validator: valid fixture must pass, offline"
run_validator valid-us-core-patient.json > /dev/null || { echo "FAIL valid fixture"; exit 1; }
echo "== validator: invalid fixture must fail on Patient.identifier, offline"
if run_validator invalid-us-core-patient.json | tee /dev/stderr | grep -q "Patient.identifier"; then
  echo "ok"
else
  echo "FAIL invalid fixture not rejected for Patient.identifier"; exit 1
fi
