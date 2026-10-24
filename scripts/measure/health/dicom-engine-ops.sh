#!/usr/bin/env bash
# dicom-engine-ops.sh - LHDS W0-2 operational probes. Subcommands:
#
#   ldap   LDAP backup + restore-check + restart probe (ADR-002 pass bar: "LDAP/WildFly cannot be
#          run as a supportable workload (no clean restart, no backup path)").
#   blob   Blob 503-onset probe: ramp concurrent 512 KiB PUTs straight at a storage account and
#          record the first concurrency step that returns any HTTP 503 (ServerBusy).
#
# Usage: bash dicom-engine-ops.sh ldap|blob
#
# Common required env:  LHDS_DICOM_RESULTS_DIR (metrics.tsv lives here)  LHDS_DICOM_ENV_LABEL
#
# ldap env:
#   LHDS_RUNTIME=docker|k8s (required)
#   LHDS_DICOM_BASE_URL (required; archive RS base, used to prove the archive recovers)
#   docker: LHDS_LDAP_CONTAINER (required)
#   k8s:    LHDS_K8S_NAMESPACE LHDS_LDAP_STATEFULSET (required); LHDS_LDAP_IMAGE optional (default: the
#           StatefulSet's own image). Run from a workstation with kubectl; LHDS_DICOM_BASE_URL may be a
#           `kubectl port-forward` URL. The dumps contain whatever is in LDAP, INCLUDING a Blob storage
#           credential property: keep $LHDS_DICOM_RESULTS_DIR under temp/ and never publish it.
#   LHDS_LDAP_BASE_DN=dc=dcm4che,dc=org (image default)  LHDS_OPS_TIMEOUT=300 (bounded waits, s)
#   Backup uses slapcat inside the LDAP pod/container: no LDAP credential is needed or used.
#   Restore check loads the dump into a THROWAWAY container of the same image
#   (LHDS_LDAP_IMAGE, required for docker runtime) and compares entry counts.
#
# blob env (sandbox only; NOT exercised in this session - no storage account was approved):
#   LHDS_BLOB_ACCOUNT (required) LHDS_BLOB_CONTAINER (required) LHDS_BLOB_SAS (required, a SAS
#   query string without the leading '?', read from env only, never printed)
#   LHDS_BLOB_ENDPOINT (default https://$LHDS_BLOB_ACCOUNT.blob.core.windows.net; override only for the
#   positive-control fake server) LHDS_BLOB_RAMP="25 50 100 200 400 800" LHDS_BLOB_REQS_PER_WORKER=20
#   Direct-to-Blob is the account's own limit; it is separate from the archive path (dicom-engine-load.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dicom-engine-lib.sh
source "$here/dicom-engine-lib.sh"

sub="${1:-}"
[[ "$sub" == "ldap" || "$sub" == "blob" ]] || die "usage: dicom-engine-ops.sh ldap|blob"
need_env LHDS_DICOM_RESULTS_DIR LHDS_DICOM_ENV_LABEL
OUT="$LHDS_DICOM_RESULTS_DIR"
mkdir -p "$OUT/ops"
M="$OUT/metrics.tsv"
CTX="env=$LHDS_DICOM_ENV_LABEL probe=$sub"
now() { date +%s.%N; }
TMO="${LHDS_OPS_TIMEOUT:-300}"

# ============================ LDAP ============================
# shellcheck disable=SC2016  # the sh -c bodies below are expanded by the shell INSIDE the pod, on purpose
ldap_probe() {
  need_env LHDS_RUNTIME LHDS_DICOM_BASE_URL
  local base_dn="${LHDS_LDAP_BASE_DN:-dc=dcm4che,dc=org}"
  local BASE="${LHDS_DICOM_BASE_URL%/}"
  case "$LHDS_RUNTIME" in
    docker)
      need_env LHDS_LDAP_CONTAINER LHDS_LDAP_IMAGE
      ex() { docker exec "$LHDS_LDAP_CONTAINER" "$@"; }
      restart() { docker restart "$LHDS_LDAP_CONTAINER" > /dev/null; } ;;
    k8s)
      need_env LHDS_K8S_NAMESPACE LHDS_LDAP_STATEFULSET
      export MSYS_NO_PATHCONV=1   # Git Bash would rewrite the /tmp/... directory names passed back to kubectl exec
      ex() { kubectl -n "$LHDS_K8S_NAMESPACE" exec "statefulset/$LHDS_LDAP_STATEFULSET" -- "$@"; }
      restart() {
        kubectl -n "$LHDS_K8S_NAMESPACE" rollout restart "statefulset/$LHDS_LDAP_STATEFULSET"
        kubectl -n "$LHDS_K8S_NAMESPACE" rollout status "statefulset/$LHDS_LDAP_STATEFULSET" --timeout="${TMO}s"
      } ;;
    *) die "LHDS_RUNTIME must be docker or k8s" ;;
  esac

  # --- backup: config (-n 0) and data (-n 1) via slapcat ---
  ex slapcat -n 0 > "$OUT/ops/ldap-config.ldif"
  ex slapcat -n 1 > "$OUT/ops/ldap-data.ldif"
  local cfg_entries data_entries
  cfg_entries="$(awk '/^dn:/{n++} END{print n+0}' "$OUT/ops/ldap-config.ldif")"
  data_entries="$(awk '/^dn:/{n++} END{print n+0}' "$OUT/ops/ldap-data.ldif")"
  metric "$M" ldap_backup_entries "$data_entries" entries "$CTX; config_entries=$cfg_entries"
  # Assertion: a dump with no archive device entry is not a usable backup (value that breaks it: 0 or
  # a dump missing dicomDeviceName=dcm4chee-arc).
  if [[ "$data_entries" -lt 1 ]] || ! grep -q 'dicomDeviceName: dcm4chee-arc' "$OUT/ops/ldap-data.ldif"; then
    metric "$M" ldap_backup_ok 0 bool "$CTX; dump has $data_entries entries / no dcm4chee-arc device"
    die "LDAP data dump unusable: $data_entries entries, archive device entry present? see $OUT/ops/ldap-data.ldif"
  fi

  # --- restore check: load both dumps into a throwaway container of the same image ---
  if [[ "$LHDS_RUNTIME" == "docker" ]]; then
    local rname="lhds-w0-l2-ldap-restore"
    if [[ -n "$(docker ps -a --filter "name=^${rname}$" -q)" ]]; then docker rm -f "$rname" > /dev/null; fi   # stale container from an aborted run
    MSYS_NO_PATHCONV=1 docker run --name "$rname" --entrypoint sh \
      -v "$(host_path "$OUT/ops"):/dump:ro" "$LHDS_LDAP_IMAGE" -c '
        set -e
        cfg="$(mktemp -d)"   # db -n 1 lands in the olcDbDirectory named by the dump (/var/lib/openldap/openldap-data)
        slapadd -n 0 -F "$cfg" -l /dump/ldap-config.ldif >/dev/null
        slapadd -n 1 -F "$cfg" -l /dump/ldap-data.ldif  >/dev/null
        slapcat -n 1 -F "$cfg" | grep -c "^dn:"' > "$OUT/ops/ldap-restore-count.txt" 2> "$OUT/ops/ldap-restore.err" \
      || { cat "$OUT/ops/ldap-restore.err" >&2; docker rm -f "$rname" > /dev/null; metric "$M" ldap_backup_ok 0 bool "$CTX; restore into a fresh container failed"; die "restore of the LDAP dump into a fresh container FAILED (see $OUT/ops/ldap-restore.err)"; }
    docker rm -f "$rname" > /dev/null
    local restored
    restored="$(tr -d '[:space:]' < "$OUT/ops/ldap-restore-count.txt")"
    metric "$M" ldap_restored_entries "$restored" entries "$CTX"
    if [[ "$restored" != "$data_entries" ]]; then
      metric "$M" ldap_backup_ok 0 bool "$CTX; restored=$restored dumped=$data_entries"
      die "restored $restored entries but dump had $data_entries"
    fi
    metric "$M" ldap_backup_ok 1 bool "$CTX; dump=$data_entries restored=$restored in a fresh container"
  else
    # Throwaway pod of the SAME image as the StatefulSet (read from the StatefulSet unless LHDS_LDAP_IMAGE is set).
    local rpod="lhds-w0-ldap-restore" rimg="${LHDS_LDAP_IMAGE:-}" rdir rcount rfail=""
    if [[ -z "$rimg" ]]; then
      rimg="$(kubectl -n "$LHDS_K8S_NAMESPACE" get "statefulset/$LHDS_LDAP_STATEFULSET" -o jsonpath='{.spec.template.spec.containers[0].image}')"
    fi
    [[ -n "$rimg" ]] || die "could not determine the LDAP image for the restore pod (set LHDS_LDAP_IMAGE)"
    kubectl -n "$LHDS_K8S_NAMESPACE" delete pod "$rpod" --ignore-not-found --wait=true > /dev/null   # stale pod from an aborted run
    kubectl -n "$LHDS_K8S_NAMESPACE" run "$rpod" --image="$rimg" --restart=Never --command -- sleep 600 > /dev/null
    if ! kubectl -n "$LHDS_K8S_NAMESPACE" wait --for=condition=Ready "pod/$rpod" --timeout="${TMO}s" > "$OUT/ops/ldap-restore.err" 2>&1; then
      rfail="restore pod never became Ready"
    else
      # No fixed /tmp path: the working directory inside the pod comes from mktemp -d (check-temp-artifact-safety).
      rdir="$(kubectl -n "$LHDS_K8S_NAMESPACE" exec "$rpod" -- mktemp -d)"
      [[ -n "$rdir" ]] || die "mktemp -d inside $rpod returned nothing"
      # push FILE: stream a dump into the pod and PROVE it arrived whole (value that breaks it: remote bytes != local).
      # Measured: in this busybox image `sh -c 'cat > file'` is exec-optimised to a bare cat that dies when kubectl closes
      # stdin, leaving a 0-byte file (kubectl: "Copying stdin failed ... websocket: close sent"); the trailing `sync`
      # keeps the shell alive until cat has drained stdin. A 0-byte config then surfaced as the misleading
      # "Database number selected via -n is out of range" from slapadd.
      push() {
        local f="$1" name want got try
        name="$(basename "$f")"; want="$(wc -c < "$f" | tr -d '[:space:]')"
        for try in 1 2 3; do
          cat "$f" | kubectl -n "$LHDS_K8S_NAMESPACE" exec -i "$rpod" -- sh -c 'cat > "$0/$1"; sync' "$rdir" "$name" 2>> "$OUT/ops/ldap-restore.err" || true
          got="$(kubectl -n "$LHDS_K8S_NAMESPACE" exec "$rpod" -- sh -c 'wc -c < "$0/$1"' "$rdir" "$name" | tr -d '[:space:]')"
          [[ "$got" == "$want" ]] && return 0
          echo "push $name try $try: $got of $want bytes arrived" >> "$OUT/ops/ldap-restore.err"
        done
        return 1
      }
      push "$OUT/ops/ldap-config.ldif" && push "$OUT/ops/ldap-data.ldif" || rfail="dump transfer into the restore pod was truncated"
      if [[ -z "$rfail" ]]; then
        : > "$OUT/ops/ldap-restore-count.txt"
        # db -n 1 lands in the olcDbDirectory named by the dump (/var/lib/openldap/openldap-data) inside THIS pod, not the live one.
        kubectl -n "$LHDS_K8S_NAMESPACE" exec "$rpod" -- sh -c '
          set -e
          cfg="$(mktemp -d)"
          slapadd -n 0 -F "$cfg" -l "$0/ldap-config.ldif" >/dev/null
          slapadd -n 1 -F "$cfg" -l "$0/ldap-data.ldif"  >/dev/null
          slapcat -n 1 -F "$cfg" | grep -c "^dn:"' "$rdir" > "$OUT/ops/ldap-restore-count.txt" 2>> "$OUT/ops/ldap-restore.err" \
          || rfail="slapadd/slapcat inside the restore pod failed"
      fi
    fi
    kubectl -n "$LHDS_K8S_NAMESPACE" delete pod "$rpod" --ignore-not-found --wait=false > /dev/null
    if [[ -n "$rfail" ]]; then
      cat "$OUT/ops/ldap-restore.err" >&2
      metric "$M" ldap_backup_ok 0 bool "$CTX; $rfail"
      die "restore of the LDAP dump into a fresh pod FAILED: $rfail (see $OUT/ops/ldap-restore.err)"
    fi
    rcount="$(tr -d '[:space:]' < "$OUT/ops/ldap-restore-count.txt")"
    metric "$M" ldap_restored_entries "$rcount" entries "$CTX"
    # Value that breaks it: any restored count different from the dumped count (a truncated dump, or an empty restore = 0).
    if [[ -z "$rcount" || "$rcount" != "$data_entries" ]]; then
      metric "$M" ldap_backup_ok 0 bool "$CTX; restored=$rcount dumped=$data_entries"
      die "restored '$rcount' entries but dump had $data_entries"
    fi
    metric "$M" ldap_backup_ok 1 bool "$CTX; dump=$data_entries restored=$rcount in a fresh pod of $rimg"
  fi

  # --- restart: time to LDAP serving, then time until the archive accepts a STOW again ---
  local t0 t1 deadline
  t0="$(now)"
  restart
  deadline=$(( $(date +%s) + TMO ))
  until ex ldapsearch -x -H ldap://localhost:389 -b "" -s base namingContexts > /dev/null 2>&1; do
    [[ "$(date +%s)" -lt "$deadline" ]] || { metric "$M" ldap_restart_ok 0 bool "$CTX; LDAP not serving after ${TMO}s"; die "LDAP not serving ${TMO}s after restart"; }
    sleep 1
  done
  t1="$(now)"
  metric "$M" ldap_restart_seconds "$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')" s "$CTX; base_dn=$base_dn"

  local gdir="$OUT/ops/gen"
  rm -rf "$gdir"
  python -I "$(host_path "$here")/dicom-engine-gen.py" "$gdir" 1 "$(( $(date +%s) % 100000 ))" 64 > /dev/null
  local body
  body="$(ls "$gdir"/body-*.mp)"
  until [[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: multipart/related; type="application/dicom"; boundary=LHDSW0BOUNDARY' \
        -H 'Accept: application/dicom+json' --data-binary "@$body" "$BASE/studies")" == "200" ]]; do   # a failed curl prints 000, which keeps the loop waiting
    [[ "$(date +%s)" -lt "$deadline" ]] || { metric "$M" ldap_restart_ok 0 bool "$CTX; archive did not accept STOW within ${TMO}s of restart"; die "archive did not accept a STOW within ${TMO}s of the LDAP restart"; }
    sleep 1
  done
  t1="$(now)"
  metric "$M" archive_recovery_seconds "$(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.1f", b-a}')" s "$CTX; first HTTP 200 STOW after LDAP restart began (includes restart time)"
  metric "$M" ldap_restart_ok 1 bool "$CTX; no manual step between restart and a successful STOW"
}

# ============================ BLOB ============================
blob_probe() {
  need_env LHDS_BLOB_ACCOUNT LHDS_BLOB_CONTAINER
  # One credential, either a SAS or a full Authorization header (an Entra bearer token). Shared key / account SAS
  # are refused by accounts with allowSharedKeyAccess=false, which the DLZ policy forces (W0-RECEIPT s3 DEV run).
  [[ -n "${LHDS_BLOB_SAS:-}" || -n "${LHDS_BLOB_AUTH_HEADER:-}" ]] \
    || die "set LHDS_BLOB_SAS (query string, no leading ?) or LHDS_BLOB_AUTH_HEADER (full header line, e.g. 'Authorization: Bearer ...')"
  local endpoint="${LHDS_BLOB_ENDPOINT:-https://$LHDS_BLOB_ACCOUNT.blob.core.windows.net}"
  local ramp="${LHDS_BLOB_RAMP:-25 50 100 200 400 800}"
  local per="${LHDS_BLOB_REQS_PER_WORKER:-20}"
  local work="$OUT/ops/blob"
  rm -rf "$work"; mkdir -p "$work"
  head -c 524288 /dev/urandom > "$work/payload.bin"   # random bytes, no patient data
  cat > "$work/put.sh" <<'PUT'
#!/usr/bin/env bash
# usage: put.sh STEP N ; env: URL PAYLOAD and one of SAS / AUTH (full header line)
set -u
hdr=(); q=""
[[ -n "${AUTH:-}" ]] && hdr=(-H "$AUTH")
[[ -n "${SAS:-}" ]] && q="?$SAS"
# Exactly ONE line per PUT: curl -w prints 000 itself when the connection fails, so a bare `|| printf` made two.
if o="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${hdr[@]}" -H 'x-ms-blob-type: BlockBlob' \
  -H 'x-ms-version: 2023-11-03' --data-binary "@$PAYLOAD" "$URL/lhds-w0-probe/step-$1-$2$q")" && [[ -n "$o" ]]; then
  printf '%s\n' "$o"
else
  printf '000\n'
fi
PUT
  export PAYLOAD="$work/payload.bin" SAS="${LHDS_BLOB_SAS:-}" AUTH="${LHDS_BLOB_AUTH_HEADER:-}" URL="$endpoint/$LHDS_BLOB_CONTAINER"
  local onset="" step total
  for step in $ramp; do
    total=$((step * per))
    seq 1 "$total" | xargs -P "$step" -I{} bash "$work/put.sh" "$step" {} > "$work/step-$step.codes"
    local n503 nok
    n503="$(awk '$1=="503"{n++} END{print n+0}' "$work/step-$step.codes")"
    nok="$(awk '$1=="201"{n++} END{print n+0}' "$work/step-$step.codes")"
    # Value that breaks it: a code file with != $total lines (lost or double-printed results).
    [[ "$(wc -l < "$work/step-$step.codes")" -eq "$total" ]] || die "step $step: $(wc -l < "$work/step-$step.codes") result lines for $total PUTs (see $work/step-$step.codes)"
    metric "$M" "blob_step_${step}_503s" "$n503" count "$CTX; of $total PUTs, $nok returned 201"
    [[ "$nok" -ge 1 || "$n503" -ge 1 ]] || die "step $step: no 201 and no 503 in $total PUTs - the probe is not reaching Blob (see $work/step-$step.codes)"
    if [[ -z "$onset" && "$n503" -ge 1 ]]; then onset="$step"; fi
  done
  if [[ -n "$onset" ]]; then
    metric "$M" blob_503_onset_concurrency "$onset" senders "$CTX; first step with >=1 HTTP 503; ramp=[$ramp]"
  else
    metric "$M" blob_503_onset_concurrency "none-up-to-${ramp##* }" senders "$CTX; no 503 observed over ramp=[$ramp]"
  fi
}

case "$sub" in
  ldap) ldap_probe ;;
  blob) blob_probe ;;
esac
echo "metrics: $M"
