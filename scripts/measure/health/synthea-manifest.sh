#!/usr/bin/env bash
# synthea-manifest.sh - LHDS W0-5: write a cohort manifest next to a generated Synthea cohort.
#
# Usage: SYNTHEA_OUT_DIR=<dir from synthea-generate.sh> bash synthea-manifest.sh
#
# Reads $SYNTHEA_OUT_DIR/generate-result.env and $SYNTHEA_OUT_DIR/fhir/*.json. Writes
#   $SYNTHEA_OUT_DIR/manifest.json        seed, Synthea version, jar sha256, host label, resource counts
#                                         by type, one sha256 per file
#   $SYNTHEA_OUT_DIR/manifest.sha256      the manifest hash: sha256 over the sorted per-file sha256 values
#                                         (stored separately because a file cannot contain its own hash)
# Resource counts are textual occurrences of the "resourceType" key in the bundles (each bundle counts
# once as Bundle; nested resources count under their own type).
# Exits non-zero if: no files, Patient count is 0, any file hash is missing/not 64 hex chars, or the
# Patient count differs from patient_bundles in generate-result.env (a bundle with no Patient would pass a
# bare "files > 0" check).
#
# Blob upload is NOT here: it is the separate explicit step synthea-upload.sh.
set -euo pipefail
die() { echo "ERROR: $*" >&2; exit 1; }
[[ -n "${SYNTHEA_OUT_DIR:-}" ]] || die "SYNTHEA_OUT_DIR is not set"
D="$SYNTHEA_OUT_DIR"
[[ -f "$D/generate-result.env" ]] || die "$D/generate-result.env missing - run synthea-generate.sh first"
[[ -d "$D/fhir" ]] || die "$D/fhir missing"
# shellcheck disable=SC1091
source "$D/generate-result.env"

cd "$D"
mapfile -t files < <(find fhir -maxdepth 1 -name '*.json' | LC_ALL=C sort)
[[ "${#files[@]}" -ge 1 ]] || die "no FHIR json files under $D/fhir"

hashes="$(mktemp)"
counts="$(mktemp)"
trap 'rm -f "$hashes" "$counts"' EXIT
for f in "${files[@]}"; do
  h="$(sha256sum "$f" | cut -d' ' -f1)"
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || die "missing or malformed sha256 for $f ('$h')"
  printf '%s  %s\n' "$h" "$f" >> "$hashes"
  grep -o '"resourceType" *: *"[A-Za-z]*"' "$f" | sed -E 's/.*: *"([A-Za-z]*)"/\1/' >> "$counts"
done
[[ -s "$counts" ]] || die "no resourceType keys found in any file"

patients="$(awk '$1=="Patient"{n++} END{print n+0}' "$counts")"
[[ "$patients" -ge 1 ]] || die "Patient resource count is 0 - not a usable cohort"
[[ "$patients" -eq "$patient_bundles" ]] || die "Patient count $patients != patient_bundles $patient_bundles from generate-result.env"
total="$(wc -l < "$counts")"
[[ "$total" -ge "$patients" ]] || die "total resources $total < patients $patients"

# Content-addressed: hash of the sorted per-file sha256 values only. File NAMES are excluded on purpose because
# Synthea names hospital/practitioner files with a wall-clock timestamp, which would change the hash of an
# otherwise byte-identical cohort (measured 2026-10-22: two same-seed runs, identical patient bundles).
mhash="$(cut -d' ' -f1 "$hashes" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
[[ "$mhash" =~ ^[0-9a-f]{64}$ ]] || die "manifest hash malformed"

{
  printf '{\n'
  printf '  "schema": "lhds-synthea-cohort-manifest/1",\n'
  printf '  "synthea_version": "%s",\n  "synthea_jar_sha256": "%s",\n' "$version" "$jar_sha256"
  printf '  "seed": %s,\n  "reference_date": "%s",\n  "state": "%s",\n' "$seed" "$ref_date" "$state"
  printf '  "patients_requested": %s,\n  "patient_bundles": %s,\n' "$patients_requested" "$patient_bundles"
  printf '  "generation": {"host_label": "%s", "seconds": %s, "patients_per_hour": %s, "runner": "%s", "threads": "%s"},\n' \
    "$host_label" "$seconds" "$patients_per_hour" "$runner" "$threads"
  printf '  "total_resources": %s,\n' "$total"
  printf '  "resource_counts": {'
  sort "$counts" | uniq -c | awk '{printf "%s\"%s\": %d", (NR>1?", ":""), $2, $1}'
  printf '},\n'
  printf '  "files": [\n'
  awk '{printf "%s    {\"path\": \"%s\", \"sha256\": \"%s\"}", (NR>1?",\n":""), $2, $1}' "$hashes"
  printf '\n  ]\n}\n'
} > manifest.json
printf '%s  manifest.json(files-hash)\n' "$mhash" > manifest.sha256
echo "manifest: $D/manifest.json  files=${#files[@]} patients=$patients resources=$total"
echo "manifest hash (sha256 of sorted file-hash list): $mhash"
