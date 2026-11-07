#!/usr/bin/env bash
# fhir-engine-bytes.sh - W0-1: disk bytes per stored FHIR resource, measured from PostgreSQL.
#
# Usage:
#   ENGINE=hapi PG_DOCKER_CONTAINER=lhds-w0-l1-pg [PG_SCHEMA=public] bash scripts/measure/health/fhir-engine-bytes.sh
#   ENGINE=medplum PGHOST=... PGUSER=... PGDATABASE=... PGPASSWORD=<from env> bash ...
#
# Method: gross = sum(pg_total_relation_size) over every table/matview in PG_SCHEMA (heap + indexes
# + TOAST) / live resource count. If fhir-engine-load.sh recorded pg_bytes_before_load, net =
# (after - before) / count is also recorded; net removes the empty-schema floor, which dominates at
# small cohorts and is why a tiny-cohort number must not be compared with the 4.5 KB assumption.
#
# FAILS (exit 1) when the live resource count is 0 (a divide-by-nothing would print a fake number).

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fhir-engine-lib.sh
source "$HERE/fhir-engine-lib.sh"
lib_init

total=$(lib_pg_total_bytes)
count=$(lib_pg_resource_count)
[ "$count" -gt 0 ] || lib_die "engine reports 0 live resources in schema '$PG_SCHEMA' (wrong schema, wrong ENGINE, or nothing loaded)"

lib_record pg_bytes_total "$total" bytes
lib_record resources_counted_sql "$count" resources
lib_record bytes_per_resource_gross "$(lib_py "import sys; print('%.1f' % (int(sys.argv[1])/int(sys.argv[2])))" "$total" "$count")" bytes/resource

before=$(awk -F'\t' '$1=="pg_bytes_before_load"{print $2}' "$RESULT_FILE")
if [ -n "$before" ]; then
  net=$(lib_py "import sys; print('%.1f' % ((int(sys.argv[1])-int(sys.argv[2]))/int(sys.argv[3])))" "$total" "$before" "$count")
  lib_record bytes_per_resource "$net" bytes/resource
else
  echo "pg_bytes_before_load not recorded: bytes_per_resource (net) NOT written; only the gross figure exists" >&2
fi
