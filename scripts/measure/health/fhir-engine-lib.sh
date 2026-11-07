#!/usr/bin/env bash
# fhir-engine-lib.sh - shared helpers for the W0-1 FHIR engine measurement scripts.
# Sourced, never executed. Source it from fhir-engine-{load,bytes,query,export,report}.sh.
#
# Env contract (all scripts):
#   ENGINE        hapi | medplum (required; names the results file and the SQL dialect)
#   FHIR_BASE_URL e.g. http://localhost:8080/fhir  (HAPI) or http://localhost:8103/fhir/R4 (Medplum)
#   FHIR_BEARER_TOKEN  optional; sent as "Authorization: Bearer ..." (Medplum needs it). Never printed.
#   RESULTS_DIR   where <ENGINE>.tsv lives (default ./temp/lhds-w0/results)
#   RECEIPT_CONTEXT  free text stamped into every result file, e.g. "local-smoke" or "sandbox-classS"
#   PG access (only the bytes and load scripts): either
#     PG_DOCKER_CONTAINER=<name>  -> psql runs inside that container (uses the container's own env), or
#     PGHOST/PGPORT/PGUSER/PGDATABASE + PGPASSWORD from the environment (local psql).
#     Credentials are never defaulted or written to disk by these scripts.
#   PG_SCHEMA     schema holding the engine tables (default public)

shopt -s inherit_errexit

# lib_py CODE [ARGS...] -> python -I -c, with CRs stripped: on Windows Python text-mode stdout emits CRLF,
# and a stray CR ends up inside the last field ("req/s<CR>"), so cells silently fail to match.
lib_py() { python -I -c "$@" | tr -d '\r'; }

lib_die() { echo "ERROR: $*" >&2; exit 1; }

lib_require_env() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || lib_die "required env var $v is not set"
  done
}

lib_init() {
  lib_require_env ENGINE
  case "$ENGINE" in hapi | medplum) ;; *) lib_die "ENGINE must be hapi or medplum, got '$ENGINE'" ;; esac
  RESULTS_DIR="${RESULTS_DIR:-./temp/lhds-w0/results}"
  RECEIPT_CONTEXT="${RECEIPT_CONTEXT:-unlabelled}"
  PG_SCHEMA="${PG_SCHEMA:-public}"
  mkdir -p "$RESULTS_DIR"
  RESULT_FILE="$RESULTS_DIR/$ENGINE.tsv"
  export RESULTS_DIR RECEIPT_CONTEXT PG_SCHEMA RESULT_FILE
}

# lib_record METRIC VALUE UNIT  -> replaces any prior line for METRIC (so a rerun cannot double-count)
lib_record() {
  local metric="$1" value="$2" unit="$3" tmp
  [ -n "$value" ] || lib_die "refusing to record empty value for $metric"
  tmp="$RESULT_FILE.tmp"
  touch "$RESULT_FILE"
  awk -F'\t' -v m="$metric" '$1 != m' "$RESULT_FILE" >"$tmp"
  printf '%s\t%s\t%s\t%s\n' "$metric" "$value" "$unit" "$RECEIPT_CONTEXT" >>"$tmp"
  mv "$tmp" "$RESULT_FILE"
  echo "recorded $ENGINE $metric=$value $unit [$RECEIPT_CONTEXT]"
}

# lib_pg SQL -> prints tuples-only, unaligned output; non-zero exit if psql fails
lib_pg() {
  if [ -n "${PG_DOCKER_CONTAINER:-}" ]; then
    docker exec "$PG_DOCKER_CONTAINER" sh -c 'psql -X -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' _ "$1"
  else
    lib_require_env PGHOST PGUSER PGDATABASE PGPASSWORD
    psql -X -v ON_ERROR_STOP=1 -At -c "$1"
  fi
}

# lib_pg_total_bytes -> sum of pg_total_relation_size (table + its indexes + toast) over the engine schema.
# Partition parents (relkind p) report 0 themselves; their partitions are relkind r, so nothing double-counts.
lib_pg_total_bytes() {
  lib_pg "select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='${PG_SCHEMA}' and c.relkind in ('r','m')"
}

# lib_pg_resource_count -> live (non-deleted) current-version resources as the engine stores them
lib_pg_resource_count() {
  case "$ENGINE" in
    hapi)
      lib_pg "select count(*) from ${PG_SCHEMA}.hfj_resource where res_deleted_at is null and res_type is not null"
      ;;
    medplum)
      # Medplum keeps one base table per resource type with a "content" column, plus a
      # "<Type>_History" table (excluded: history rows are not live resources). Medplum also seeds
      # ~4.3 k definitional resources (SearchParameter, StructureDefinition, ValueSet...) into its
      # built-in R4 project; counting them would inflate the denominator of bytes/resource, so rows in
      # that project (fixed UUID in Medplum's source) are excluded. One atomic statement, so a table
      # that disappears mid-count fails the whole query instead of being skipped.
      lib_pg "select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I where deleted is not true and \"projectId\" is distinct from %L::uuid', t.table_schema, t.table_name, '161452d9-43b7-5c29-aa7b-c85680fa45c6'), false, true, '')))[1]::text::bigint),0) from information_schema.tables t where t.table_schema='${PG_SCHEMA}' and t.table_type='BASE TABLE' and t.table_name !~ '_History\$' and exists (select 1 from information_schema.columns c where c.table_schema=t.table_schema and c.table_name=t.table_name and c.column_name='content') and exists (select 1 from information_schema.columns c where c.table_schema=t.table_schema and c.table_name=t.table_name and c.column_name='projectId')"
      ;;
  esac
}
