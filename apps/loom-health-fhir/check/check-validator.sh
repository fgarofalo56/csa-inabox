#!/bin/sh
# Baked validator check (W2-1 acceptance: `java -jar validator_cli.jar` works offline).
#
# Runs the baked validator_cli.jar against the baked package cache on two fixtures in
# ONE invocation (loading the terminology packages takes minutes, so it is paid once):
#   valid-us-core-patient.json    -> must be reported valid
#   invalid-us-core-patient.json  -> must be reported invalid, naming Patient.identifier
# The pair is the point: a validator that accepts everything, or rejects everything
# (e.g. because the packages were not found), breaks exactly one arm.
#
# Offline is enforced two ways: (1) the JVM proxy is pointed at a closed port, so any
# HTTP(S) attempt is refused; (2) the run FAILS if the validator logs "Installing ...
# to the package cache", which is what it prints when a package is missing from the
# cache and it tries to fetch one.
#
#   check-validator.sh <validator_cli.jar> <home-dir> <fixtures-dir>
#   <home-dir> must contain .fhir/packages/ (seeded by fetch-baked-assets.sh); it is
#   written to (package indexes), which is intended: the indexed cache is what ships.
set -u
JAR="$1"; HOME_DIR="$2"; FIX="$3"
LOG=$(mktemp)

# -tx n/a : no terminology server, so nothing is fetched at runtime. Binding checks
# against VSAC/terminology are therefore NOT exercised; profile structure,
# cardinality and invariants are.
java -Duser.home="$HOME_DIR" \
  -Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=9 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=9 \
  -jar "$JAR" "$FIX/valid-us-core-patient.json" "$FIX/invalid-us-core-patient.json" \
  -version 4.0.1 -ig hl7.fhir.us.core#6.1.0 \
  -profile http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient \
  -tx n/a > "$LOG" 2>&1
RC=$?

fail=0
if grep -q "to the package cache" "$LOG"; then
  echo "FAIL the validator tried to install a package, so the baked cache is incomplete:"
  grep "to the package cache" "$LOG"; fail=1
fi
# Per-file sections look like "-- <path> ---" followed by "Success: ..." or "*FAILURE*: ...".
# "-- $FIX/valid-..." cannot match the invalid file's header ("/invalid-..." differs
# at the character after the slash).
section() { # <file name> -> that file's result block
  sed -n "/^-- $(printf '%s' "$FIX" | sed 's/[.[\*^$/]/\\&/g')\/$1 /,/^----------*\$/p" "$LOG"
}
VALID_SEC=$(section valid-us-core-patient.json)
INVALID_SEC=$(section invalid-us-core-patient.json)
# Breaks if the valid fixture is rejected, or has no result block at all.
case "$VALID_SEC" in *"Success: 0 errors"*) ;; *) echo "FAIL valid fixture not reported as Success"; fail=1 ;; esac
# Breaks if the validator accepts the invalid fixture, or rejects it for another reason.
case "$INVALID_SEC" in *"*FAILURE*"*"Patient.identifier: minimum required = 1"*) ;; *)
  echo "FAIL invalid fixture not rejected for the missing Patient.identifier"; fail=1 ;; esac
# Two files, one invalid: the tool's exit code must be non-zero.
if [ "$RC" -eq 0 ]; then
  echo "FAIL validator exited 0 although one fixture is invalid"; fail=1
fi
if [ "$fail" -ne 0 ]; then tail -60 "$LOG"; exit 1; fi
echo "validator check ok (rc=$RC): invalid fixture rejected on Patient.identifier, no package installed"
