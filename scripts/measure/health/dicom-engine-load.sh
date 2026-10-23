#!/usr/bin/env bash
# dicom-engine-load.sh - LHDS W0-2: STOW-RS / QIDO-RS / WADO-RS throughput at N concurrent senders.
#
# Test instances: GENERATED here by dicom-engine-gen.py (synthetic CT, 512 KiB pixel payload at
# ROWS=512, fabricated names/IDs, seeded UIDs). No real patient image is ever used.
#
# Load driver: curl via xargs -P (one request per instance, per-request latency from
# curl %{time_total}). A first pass of 3 instances is also sent with the real dcm4che
# `stowrs` client (docker image dcm4che/dcm4che-tools) as a client-conformance check.
#
# Required env (no defaults):
#   LHDS_DICOM_BASE_URL     e.g. http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs  (no trailing /)
#   LHDS_DICOM_RESULTS_DIR  directory for work files + metrics (use temp/...; created)
#   LHDS_DICOM_ENV_LABEL    sandbox | local-smoke   (recorded with every metric; the report
#                           refuses to call local-smoke numbers pass-bar evidence)
# Optional env:
#   LHDS_DICOM_CONCURRENCY=100  LHDS_DICOM_INSTANCES=1000  LHDS_DICOM_SEED=42  LHDS_DICOM_ROWS=512
#   LHDS_DICOM_QIDO_REQUESTS (default = INSTANCES)  LHDS_DICOM_WADO_REQUESTS (default = INSTANCES)
#   LHDS_DICOM_AUTH_HEADER   full header line, e.g. "Authorization: Bearer ..." (from env only)
#   LHDS_DICOM_TOOLS_IMAGE=dcm4che/dcm4che-tools:5.35.1  LHDS_DICOM_TOOLS_URL (default: BASE with
#   localhost -> host.docker.internal)  LHDS_DICOM_TOOLS_NETWORK (docker network to join, e.g. the
#   compose network, when TOOLS_URL is an in-network name)  LHDS_DICOM_SKIP_TOOL_PASS=1 to skip the stowrs pass (disclosed).
#
# Writes metrics to $LHDS_DICOM_RESULTS_DIR/metrics.tsv. Exits non-zero if any request class
# has zero successes or the instance-count delta in the archive != successful STOWs.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dicom-engine-lib.sh
source "$here/dicom-engine-lib.sh"

need_env LHDS_DICOM_BASE_URL LHDS_DICOM_RESULTS_DIR LHDS_DICOM_ENV_LABEL
[[ "$LHDS_DICOM_ENV_LABEL" == "sandbox" || "$LHDS_DICOM_ENV_LABEL" == "local-smoke" ]] \
  || die "LHDS_DICOM_ENV_LABEL must be 'sandbox' or 'local-smoke' (got '$LHDS_DICOM_ENV_LABEL')"
BASE="${LHDS_DICOM_BASE_URL%/}"
CONC="${LHDS_DICOM_CONCURRENCY:-100}"
N="${LHDS_DICOM_INSTANCES:-1000}"
SEED="${LHDS_DICOM_SEED:-42}"
ROWS="${LHDS_DICOM_ROWS:-512}"
NQ="${LHDS_DICOM_QIDO_REQUESTS:-$N}"
NW="${LHDS_DICOM_WADO_REQUESTS:-$N}"
[[ "$CONC" =~ ^[0-9]+$ && "$CONC" -ge 1 ]] || die "LHDS_DICOM_CONCURRENCY must be a positive integer"
[[ "$N" =~ ^[0-9]+$ && "$N" -ge 1 ]] || die "LHDS_DICOM_INSTANCES must be a positive integer"
command -v curl >/dev/null || die "curl not found"
command -v python >/dev/null || die "python not found (use 'python', not python3, on this host)"

OUT="$LHDS_DICOM_RESULTS_DIR"
WORK="$OUT/work"
mkdir -p "$WORK"
M="$OUT/metrics.tsv"
CTX="env=$LHDS_DICOM_ENV_LABEL base=$BASE conc=$CONC"

# ---- one-request helper (kept as a file so xargs -P can call it) -------------------------
cat > "$WORK/one.sh" <<'ONE'
#!/usr/bin/env bash
# usage: one.sh KIND IDX ; env: BASE WORK AUTH (optional)
set -u
kind="$1"; idx="$2"
hdr=()
[[ -n "${AUTH:-}" ]] && hdr=(-H "$AUTH")
fmt='%{time_total}\t%{http_code}\t%{size_download}\n'
case "$kind" in
  stow)
    f="$WORK/body-$(printf '%05d' "$idx").mp"
    curl -s -o /dev/null -w "$fmt" -X POST "${hdr[@]}" \
      -H 'Content-Type: multipart/related; type="application/dicom"; boundary=LHDSW0BOUNDARY' \
      -H 'Accept: application/dicom+json' --data-binary "@$f" "$BASE/studies" \
      || printf '0\t000\t0\n' ;;
  qido)
    row="$(awk -F'\t' -v i="$idx" 'NR==i{print $2}' "$WORK/uids.tsv")"
    curl -s -o /dev/null -w "$fmt" "${hdr[@]}" -H 'Accept: application/dicom+json' \
      "$BASE/studies?StudyInstanceUID=$row" || printf '0\t000\t0\n' ;;
  wado)
    read -r st se so < <(awk -F'\t' -v i="$idx" 'NR==i{print $2, $3, $4}' "$WORK/uids.tsv")
    curl -s -o /dev/null -w "$fmt" "${hdr[@]}" -H 'Accept: multipart/related; type="application/dicom"' \
      "$BASE/studies/$st/series/$se/instances/$so" || printf '0\t000\t0\n' ;;
esac
ONE
chmod +x "$WORK/one.sh"

# ---- 1. generate synthetic instances ------------------------------------------------------
rm -f "$WORK"/body-*.mp "$WORK"/inst-*.dcm "$WORK/uids.tsv"
python -I "$here/dicom-engine-gen.py" "$WORK" "$N" "$SEED" "$ROWS"
INST_BYTES="$(awk -F'\t' 'NR==1{print $5}' "$WORK/uids.tsv")"
[[ "$(wc -l < "$WORK/uids.tsv")" -eq "$N" ]] || die "generator wrote $(wc -l < "$WORK/uids.tsv") UID rows, expected $N"

count_instances() {
  local h=()
  [[ -n "${LHDS_DICOM_AUTH_HEADER:-}" ]] && h=(-H "$LHDS_DICOM_AUTH_HEADER")
  # dcm4chee-arc RESTful count endpoint: {"count":N}
  curl -sf "${h[@]}" "$BASE/instances/count" | sed -E 's/.*"count" *: *([0-9]+).*/\1/'
}
BEFORE="$(count_instances)" || die "cannot read $BASE/instances/count before load (is the archive up? auth?)"
[[ "$BEFORE" =~ ^[0-9]+$ ]] || die "instances/count returned non-numeric '$BEFORE'"

export BASE WORK
export AUTH="${LHDS_DICOM_AUTH_HEADER:-}"

# summarise KIND FILE CONTEXT_EXTRA MINBYTES : writes metrics, echoes req/s
summarise() {
  local kind="$1" file="$2" wall="$3" minbytes="$4"
  # success = HTTP 200 and (for wado) a body at least as large as the instance
  awk -F'\t' -v mb="$minbytes" '$2=="200" && $3>=mb {print $1*1000}' "$file" > "$file.ok_ms"
  local total ok
  total="$(wc -l < "$file")"
  ok="$(wc -l < "$file.ok_ms")"
  metric "$M" "${kind}_requests" "$total" count "$CTX"
  metric "$M" "${kind}_fail_count" "$((total - ok))" count "$CTX; non-200, or body < $minbytes B"
  [[ "$ok" -ge 1 ]] || die "$kind: zero successful requests out of $total (see $file)"
  metric "$M" "${kind}_p50_ms" "$(pctl "$file.ok_ms" 50)" ms "$CTX"
  metric "$M" "${kind}_p95_ms" "$(pctl "$file.ok_ms" 95)" ms "$CTX"
  metric "$M" "${kind}_p99_ms" "$(pctl "$file.ok_ms" 99)" ms "$CTX"
  metric "$M" "${kind}_req_s" "$(awk -v o="$ok" -v w="$wall" 'BEGIN{printf "%.2f", o/w}')" req/s "$CTX; wall=${wall}s"
  if [[ "$kind" == "stow" || "$kind" == "wado" ]]; then
    metric "$M" "${kind}_mb_s" "$(awk -v o="$ok" -v b="$INST_BYTES" -v w="$wall" 'BEGIN{printf "%.2f", o*b/1048576/w}')" MiB/s "$CTX; instance=${INST_BYTES}B"
  fi
  echo "$kind: $ok/$total ok, wall ${wall}s"
}

now() { date +%s.%N; }

# ---- 2. STOW-RS at N concurrent senders ---------------------------------------------------
: > "$OUT/stow.raw"
t0="$(now)"
seq 1 "$N" | xargs -P "$CONC" -I{} bash "$WORK/one.sh" stow {} >> "$OUT/stow.raw"
t1="$(now)"
wall="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", b-a}')"
metric "$M" stow_concurrency "$CONC" senders "$CTX"
metric "$M" stow_instance_bytes "$INST_BYTES" bytes "$CTX; synthetic CT, random pixel data"
summarise stow "$OUT/stow.raw" "$wall" 0

# Assertion: the archive's instance count rose by exactly the number of 200s. A silent drop or
# a duplicate-collapse (delta != successes) makes this fail.
STOW_OK="$(awk -F'\t' '$2=="200"' "$OUT/stow.raw" | wc -l)"
AFTER="$(count_instances)" || die "cannot read instance count after STOW"
DELTA=$((AFTER - BEFORE))
metric "$M" stow_count_delta "$DELTA" instances "$CTX; before=$BEFORE after=$AFTER successes=$STOW_OK"
if [[ "$DELTA" -ne "$STOW_OK" ]]; then
  metric "$M" stow_count_ok 0 bool "$CTX"
  die "archive instance count rose by $DELTA but $STOW_OK STOWs returned 200 (data not persisted as claimed)"
fi
metric "$M" stow_count_ok 1 bool "$CTX"

# ---- 3. QIDO-RS (study-level point lookup by StudyInstanceUID) ---------------------------
: > "$OUT/qido.raw"
t0="$(now)"
seq 1 "$NQ" | awk -v n="$N" '{print (($1-1)%n)+1}' | xargs -P "$CONC" -I{} bash "$WORK/one.sh" qido {} >> "$OUT/qido.raw"
t1="$(now)"
wall="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", b-a}')"
summarise qido "$OUT/qido.raw" "$wall" 1   # 204 (no match) or empty body = fail

# ---- 4. WADO-RS (retrieve whole instance; body must be >= the stored instance size) ------
: > "$OUT/wado.raw"
t0="$(now)"
seq 1 "$NW" | awk -v n="$N" '{print (($1-1)%n)+1}' | xargs -P "$CONC" -I{} bash "$WORK/one.sh" wado {} >> "$OUT/wado.raw"
t1="$(now)"
wall="$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.3f", b-a}')"
summarise wado "$OUT/wado.raw" "$wall" "$INST_BYTES"

# ---- 5. real-tool client pass (dcm4che stowrs) -------------------------------------------
if [[ "${LHDS_DICOM_SKIP_TOOL_PASS:-}" == "1" ]]; then
  metric "$M" tool_pass_stowrs skipped bool "$CTX; LHDS_DICOM_SKIP_TOOL_PASS=1"
else
  command -v docker >/dev/null || die "docker not found (set LHDS_DICOM_SKIP_TOOL_PASS=1 to skip the stowrs pass)"
  TOOLS_IMAGE="${LHDS_DICOM_TOOLS_IMAGE:-dcm4che/dcm4che-tools:5.35.1}"
  TOOLS_URL="${LHDS_DICOM_TOOLS_URL:-${BASE//localhost/host.docker.internal}}"
  # 3 NEW instances (indexes N+1..N+3) so the tool pass is not a duplicate of the curl pass.
  python -I "$here/dicom-engine-gen.py" "$WORK/tool" 3 "$((SEED + 7))" "$ROWS" "$((N + 1))"
  tool_out="$OUT/stowrs-tool.log"
  net=(); [[ -n "${LHDS_DICOM_TOOLS_NETWORK:-}" ]] && net=(--network "$LHDS_DICOM_TOOLS_NETWORK")
  MSYS_NO_PATHCONV=1 docker run --rm --name lhds-w0-l2-stowrs "${net[@]}" \
    -v "$(host_path "$WORK/tool"):/in:ro" "$TOOLS_IMAGE" \
    stowrs --url "$TOOLS_URL/studies" /in/inst-$(printf '%05d' "$((N + 1))").dcm \
    /in/inst-$(printf '%05d' "$((N + 2))").dcm /in/inst-$(printf '%05d' "$((N + 3))").dcm > "$tool_out" 2>&1 \
    || { cat "$tool_out" >&2; die "dcm4che stowrs failed (log: $tool_out)"; }
  AFTER2="$(count_instances)"
  if [[ "$((AFTER2 - AFTER))" -ne 3 ]]; then
    metric "$M" tool_pass_stowrs 0 bool "$CTX; count delta $((AFTER2 - AFTER)) != 3"
    die "stowrs reported success but instance count rose by $((AFTER2 - AFTER)), expected 3 (log: $tool_out)"
  fi
  metric "$M" tool_pass_stowrs 1 bool "$CTX; tool=$TOOLS_IMAGE sent 3 instances, count +3"
fi
echo "metrics: $M"
