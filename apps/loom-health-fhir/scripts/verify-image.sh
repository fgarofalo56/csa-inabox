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
# Same launcher + loader.path as the image ENTRYPOINT, with loader.main pointed at the probe,
# so the plugin loads against the HAPI classes the server really ships (LoomPlugin links
# IInterceptorService, which a bare -cp of the plugin jar does not have).
OUT=$(docker run --rm --network none --entrypoint java "$IMG" \
  --class-path /app/main.war \
  "-Dloader.path=main.war!/WEB-INF/classes/,main.war!/WEB-INF/,/app/extra-classes" \
  -Dloader.main=ai.loom.health.fhir.LoomPlugin \
  org.springframework.boot.loader.PropertiesLauncher)
echo "$OUT"
# Expected count is lifted from the plugin source (one svc.registerInterceptor( per
# interceptor), never hard-coded; it must be >0 so a plugin registering none fails.
EXPECTED=$(grep -cE '^[[:space:]]*svc\.registerInterceptor\(' "$HERE/plugin/src/main/java/ai/loom/health/fhir/LoomPlugin.java")
[ "$EXPECTED" -gt 0 ] || { echo "FAIL plugin source registers no interceptor"; exit 1; }
echo "$OUT" | grep -q "\"interceptors\":$EXPECTED}" || { echo "FAIL plugin probe (expected $EXPECTED interceptors)"; exit 1; }

echo "== Entra JDBC auth plugin probe (loads + constructs against the server's own pgjdbc)"
JOUT=$(docker run --rm --network none --entrypoint java "$IMG" \
  --class-path /app/main.war \
  "-Dloader.path=main.war!/WEB-INF/classes/,main.war!/WEB-INF/,/app/extra-classes" \
  -Dloader.main=ai.loom.health.fhir.JdbcAuthProbe \
  org.springframework.boot.loader.PropertiesLauncher)
echo "$JOUT"
echo "$JOUT" | grep -q '"loadable":true' || { echo "FAIL JDBC auth plugin probe"; exit 1; }

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
