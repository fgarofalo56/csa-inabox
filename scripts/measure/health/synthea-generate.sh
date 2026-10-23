#!/usr/bin/env bash
# synthea-generate.sh - LHDS W0-5: run Synthea with a fixed seed + pinned version, measure patients/hour.
#
# Required env (no defaults):
#   SYNTHEA_JAR        path to synthea-with-dependencies.jar (a release asset, e.g. v4.0.0)
#   SYNTHEA_VERSION    release label recorded in the manifest, e.g. v4.0.0 (must match the jar you downloaded)
#   SYNTHEA_JAR_SHA256 expected sha256 of the jar (the pin; a mismatch aborts)
#   SYNTHEA_POPULATION number of patients to request (-p)
#   SYNTHEA_OUT_DIR    output directory (created; must be empty or absent)
# Optional env:
#   SYNTHEA_SEED=20261022  (-s and -cs)   SYNTHEA_REF_DATE=20261022 (-r, fixed so output is reproducible)
#   SYNTHEA_STATE=Massachusetts   SYNTHEA_THREADS (default: 1 = Synthea default; recorded)
#   SYNTHEA_RUNNER=docker|local (default docker: eclipse-temurin:17-jre)   SYNTHEA_CONTAINER=lhds-w0-l2-synthea
#   SYNTHEA_HOST_LABEL  free text naming where this ran, e.g. "laptop-docker" or "aks-pool-<sku>" (required:
#                       throughput numbers are meaningless without it)
#   SYNTHEA_JAVA_OPTS   e.g. "-Xmx4g"
#
# Output: $SYNTHEA_OUT_DIR/fhir/*.json plus $SYNTHEA_OUT_DIR/generate-result.env with
#   patients_requested, patient_bundles, seconds, patients_per_hour, host_label, seed, version, jar_sha256.
# Wall time INCLUDES JVM start and module load (a fixed cost that shrinks as a share on big cohorts), so
# patients_per_hour from a tiny cohort understates large-cohort throughput. Recorded, not corrected.
# Exits non-zero if the jar sha256 differs from the pin or zero patient bundles were produced.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
for v in SYNTHEA_JAR SYNTHEA_VERSION SYNTHEA_JAR_SHA256 SYNTHEA_POPULATION SYNTHEA_OUT_DIR SYNTHEA_HOST_LABEL; do
  [[ -n "${!v:-}" ]] || die "required env var $v is not set"
done
SEED="${SYNTHEA_SEED:-20261022}"
REF="${SYNTHEA_REF_DATE:-20261022}"
STATE="${SYNTHEA_STATE:-Massachusetts}"
RUNNER="${SYNTHEA_RUNNER:-docker}"
NAME="${SYNTHEA_CONTAINER:-lhds-w0-l2-synthea}"
[[ "$SYNTHEA_POPULATION" =~ ^[0-9]+$ && "$SYNTHEA_POPULATION" -ge 1 ]] || die "SYNTHEA_POPULATION must be a positive integer"
[[ "$SEED" =~ ^[0-9]+$ ]] || die "SYNTHEA_SEED must be an integer"
[[ -f "$SYNTHEA_JAR" ]] || die "jar not found: $SYNTHEA_JAR"

actual="$(sha256sum "$SYNTHEA_JAR" | cut -d' ' -f1)"
[[ "$actual" == "$SYNTHEA_JAR_SHA256" ]] || die "jar sha256 $actual != pinned $SYNTHEA_JAR_SHA256"

if [[ -d "$SYNTHEA_OUT_DIR" && -n "$(ls -A "$SYNTHEA_OUT_DIR")" ]]; then
  die "$SYNTHEA_OUT_DIR is not empty (a stale cohort would inflate the count)"
fi
mkdir -p "$SYNTHEA_OUT_DIR"
abs() { case "$(uname -s)" in MINGW*|MSYS*) (cd "$1" && pwd -W) ;; *) (cd "$1" && pwd) ;; esac; }
OUT_ABS="$(abs "$SYNTHEA_OUT_DIR")"
JAR_ABS="$(abs "$(dirname "$SYNTHEA_JAR")")/$(basename "$SYNTHEA_JAR")"

[[ "$RUNNER" == "local" ]] && OUT_IN_RUNNER="$SYNTHEA_OUT_DIR" || OUT_IN_RUNNER="/out"
args=(-s "$SEED" -cs "$SEED" -r "$REF" -p "$SYNTHEA_POPULATION"
      --exporter.baseDirectory="$OUT_IN_RUNNER" --exporter.fhir.export=true
      --exporter.hospital.fhir.export=true --exporter.practitioner.fhir.export=true
      --exporter.fhir.bulk_data=false --exporter.years_of_history=10 "$STATE")
[[ -n "${SYNTHEA_THREADS:-}" ]] && args=(--generate.thread_pool_size="$SYNTHEA_THREADS" "${args[@]}")

t0="$(date +%s.%N)"
case "$RUNNER" in
  docker)
    command -v docker >/dev/null || die "docker not found"
    MSYS_NO_PATHCONV=1 docker run --rm --name "$NAME" \
      -v "$JAR_ABS:/synthea.jar:ro" -v "$OUT_ABS:/out" eclipse-temurin:17-jre \
      java ${SYNTHEA_JAVA_OPTS:-} -jar /synthea.jar "${args[@]}" > "$SYNTHEA_OUT_DIR/synthea.log" 2>&1 \
      || { tail -30 "$SYNTHEA_OUT_DIR/synthea.log" >&2; die "synthea failed (log: $SYNTHEA_OUT_DIR/synthea.log)"; } ;;
  local)
    java ${SYNTHEA_JAVA_OPTS:-} -jar "$SYNTHEA_JAR" "${args[@]}" > "$SYNTHEA_OUT_DIR/synthea.log" 2>&1 \
      || { tail -30 "$SYNTHEA_OUT_DIR/synthea.log" >&2; die "synthea failed (log: $SYNTHEA_OUT_DIR/synthea.log)"; } ;;
  *) die "SYNTHEA_RUNNER must be docker or local" ;;
esac
t1="$(date +%s.%N)"

# Patient bundles = FHIR files that are not the hospital/practitioner infrastructure bundles.
bundles="$(find "$SYNTHEA_OUT_DIR/fhir" -maxdepth 1 -name '*.json' ! -name 'hospitalInformation*' ! -name 'practitionerInformation*' | wc -l)"
[[ "$bundles" -ge 1 ]] || die "zero patient bundles under $SYNTHEA_OUT_DIR/fhir (see synthea.log)"
secs="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')"
pph="$(awk -v n="$bundles" -v s="$secs" 'BEGIN{printf "%.0f", n/s*3600}')"
# %q quoting keeps the file safely source-able even when host_label has spaces or parentheses.
{
  printf 'patients_requested=%q\n' "$SYNTHEA_POPULATION"
  printf 'patient_bundles=%q\n' "$bundles"
  printf 'seconds=%q\n' "$secs"
  printf 'patients_per_hour=%q\n' "$pph"
  printf 'host_label=%q\n' "$SYNTHEA_HOST_LABEL"
  printf 'seed=%q\n' "$SEED"
  printf 'ref_date=%q\n' "$REF"
  printf 'state=%q\n' "$STATE"
  printf 'version=%q\n' "$SYNTHEA_VERSION"
  printf 'jar_sha256=%q\n' "$actual"
  printf 'runner=%q\n' "$RUNNER"
  printf 'threads=%q\n' "${SYNTHEA_THREADS:-default}"
} > "$SYNTHEA_OUT_DIR/generate-result.env"
cat "$SYNTHEA_OUT_DIR/generate-result.env"
