#!/usr/bin/env bash
# dicom-engine-lib.sh - helpers sourced by the dicom-engine-*.sh scripts (LHDS W0-2).
# Not meant to be run directly. Provides: die, need_env, host_path, pctl, metric,
# last_metric.
#
# Metric file format (TSV, append-only, last write wins per name):
#   name <TAB> value <TAB> unit <TAB> context

die() { echo "ERROR: $*" >&2; exit 1; }

need_env() {
  local v
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || die "required env var $v is not set (no default by design)"
  done
}

# Absolute path usable by docker -v on Windows Git Bash, plain pwd elsewhere.
host_path() {
  case "$(uname -s)" in
    MINGW*|MSYS*) (cd "$1" && pwd -W) ;;
    *) (cd "$1" && pwd) ;;
  esac
}

# pctl FILE PERCENT : nearest-rank percentile of the numbers in column 1.
# Exits 3 on an empty sample, so an empty sample can never print a number.
pctl() {
  sort -n "$1" | awk -v p="$2" '{a[NR]=$1} END{
    if (NR==0) exit 3
    r=(p/100)*NR; i=int(r); if (i<r) i++; if (i<1) i=1; print a[i] }'
}

# metric FILE NAME VALUE UNIT CONTEXT
metric() {
  [[ -n "$3" ]] || die "refusing to record an empty value for metric $2"
  printf '%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" >> "$1"
}

# last_metric FILE NAME : prints the last recorded value, or nothing.
last_metric() {
  [[ -f "$1" ]] || return 0
  awk -F'\t' -v n="$2" '$1==n {v=$2} END{ if (v!="") print v }' "$1"
}
