#!/usr/bin/env bash
# dicom-engine-report.sh - LHDS W0-2: print the receipt section-3 table from recorded metrics.
#
# Usage: LHDS_DICOM_RESULTS_DIR=<dir with metrics.tsv> bash dicom-engine-report.sh
#
# Reads $LHDS_DICOM_RESULTS_DIR/metrics.tsv (written by dicom-engine-load.sh and
# dicom-engine-ops.sh). Prints one row per required cell.
# Exit codes:
#   0  every required cell has a value and no probe recorded a failure
#   1  at least one required cell is EMPTY (never measured)  <- the guard this script exists for
#   2  every cell has a value but at least one correctness probe recorded 0 (a measured failure)
# Local-smoke results are printed but the verdict column says NOT PASS-BAR EVIDENCE.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dicom-engine-lib.sh
source "$here/dicom-engine-lib.sh"

need_env LHDS_DICOM_RESULTS_DIR
M="$LHDS_DICOM_RESULTS_DIR/metrics.tsv"
[[ -f "$M" ]] || { echo "EMPTY: no metrics file at $M - nothing was measured" >&2; exit 1; }

# name | label | unit   (every one is a required cell)
CELLS=(
  "stow_concurrency|STOW concurrent senders|senders"
  "stow_instance_bytes|STOW instance size|bytes"
  "stow_p50_ms|STOW p50|ms"
  "stow_p95_ms|STOW p95 (ADR-002 bar <= 300 ms)|ms"
  "stow_p99_ms|STOW p99|ms"
  "stow_req_s|STOW throughput|req/s"
  "stow_mb_s|STOW throughput|MiB/s"
  "stow_fail_count|STOW failed requests|count"
  "stow_count_ok|STOW persisted == acknowledged (1=yes)|bool"
  "qido_p95_ms|QIDO p95 (study point lookup)|ms"
  "qido_req_s|QIDO throughput|req/s"
  "wado_p95_ms|WADO p95 (whole instance)|ms"
  "wado_req_s|WADO throughput|req/s"
  "wado_mb_s|WADO throughput|MiB/s"
  "ldap_backup_ok|LDAP backup (slapcat) taken + restorable (1=yes)|bool"
  "ldap_restart_seconds|LDAP restart to serving|s"
  "archive_recovery_seconds|archive serving STOW again after LDAP restart|s"
  "ldap_restart_ok|archive recovered with no manual step (1=yes)|bool"
  "blob_503_onset_concurrency|Blob 503 onset (first concurrency step with HTTP 503)|senders"
)
# Cells that are 0/1 correctness probes: a recorded 0 is a measured failure (exit 2).
PROBES=(stow_count_ok ldap_backup_ok ldap_restart_ok)

label="$(awk -F'\t' '$1=="stow_p95_ms" {n=split($4,a," "); for(i=1;i<=n;i++) if (a[i] ~ /^env=/) v=substr(a[i],5)} END{print v}' "$M")"
printf 'DICOM engine receipt table (W0-2)  results=%s  env=%s\n' "$M" "${label:-UNKNOWN}"
printf '%-62s | %-12s | %s\n' "cell" "value" "unit"
printf -- '-------------------------------------------------------------- | ------------ | ------\n'

empty=0; failed=0
for c in "${CELLS[@]}"; do
  IFS='|' read -r name lab unit <<< "$c"
  v="$(last_metric "$M" "$name")"
  if [[ -z "$v" ]]; then
    printf '%-62s | %-12s | %s\n' "$lab" "EMPTY" "$unit"
    empty=$((empty + 1))
    continue
  fi
  printf '%-62s | %-12s | %s\n' "$lab" "$v" "$unit"
  for p in "${PROBES[@]}"; do
    if [[ "$name" == "$p" && "$v" != "1" ]]; then failed=$((failed + 1)); fi
  done
done

# ADR-002 verdict: only computable from sandbox evidence at >=100 senders and >=512 KiB.
p95="$(last_metric "$M" stow_p95_ms)"; conc="$(last_metric "$M" stow_concurrency)"; sz="$(last_metric "$M" stow_instance_bytes)"
echo
if [[ "${label:-}" != "sandbox" ]]; then
  echo "ADR-002 STOW bar: NOT PASS-BAR EVIDENCE (env=${label:-UNKNOWN}; only a sandbox AKS+Blob run counts)"
elif [[ -z "$p95" || -z "$conc" || -z "$sz" ]]; then
  echo "ADR-002 STOW bar: NOT COMPUTABLE (missing p95/concurrency/size)"
elif awk -v c="$conc" -v s="$sz" 'BEGIN{exit !(c>=100 && s>=524288)}'; then
  if awk -v p="$p95" 'BEGIN{exit !(p<=300)}'; then echo "ADR-002 STOW bar: PASS (p95=${p95} ms <= 300 ms at ${conc} senders, ${sz} B)"
  else echo "ADR-002 STOW bar: FAIL (p95=${p95} ms > 300 ms at ${conc} senders, ${sz} B)"; fi
else
  echo "ADR-002 STOW bar: NOT PASS-BAR EVIDENCE (needs >=100 senders and >=524288 B instances; got ${conc} / ${sz})"
fi

if [[ "$empty" -gt 0 ]]; then
  echo "RESULT: $empty required cell(s) EMPTY - exit 1" >&2
  exit 1
fi
if [[ "$failed" -gt 0 ]]; then
  echo "RESULT: $failed correctness probe(s) recorded a failure - exit 2" >&2
  exit 2
fi
echo "RESULT: all ${#CELLS[@]} cells populated, no probe failures"
