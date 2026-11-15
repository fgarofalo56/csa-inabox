#!/bin/sh
# Live acceptance of the hardened loom-health-dicom image (LHDS W3-1). Needs docker, curl, python.
#   verify-image.sh <arc-image> <ldap-image>
# Starts LDAP + PostgreSQL + the archive on a private docker network, applies ldap/harden.sh with
# the CHART DEFAULTS, then proves the defaults by behaviour, each with a positive control:
#   A  DICOMweb: STOW to a registered AE title is 200; to an unregistered one is rejected (4xx).
#   B  Ports: 8080 accepts (control); 11112 refuses (DIMSE listener off).
#   C  HL7: a registered sending application gets AA; an unregistered one gets AE/AR.
#   D  DIMSE overlay (DIMSE_ENABLED=true, archive restarted): storescu from a registered calling
#      AE succeeds; from an unregistered one is A-ASSOCIATE-RJ calling-AE-title-not-recognized.
# Env: LHDS_VERIFY_AE_ENFORCE=false runs the harden step with enforcement OFF. That is the
# mutation arm: section D must then FAIL (the script exits non-zero). C is governed by HL7_AUTH, not this flag.
set -eu
ARC="$1"; LDAPIMG="$2"
export MSYS_NO_PATHCONV=1
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PY="${PYTHON:-python}"
ENF="${LHDS_VERIFY_AE_ENFORCE:-true}"
S="lhdsv$$"
SCRATCH="${LHDS_VERIFY_TMP:-$ROOT/temp/dicom-verify-$$}"
mkdir -p "$SCRATCH"
cleanup() { docker rm -f "$S-arc" "$S-ldap" "$S-db" > /dev/null 2>&1 || true; docker network rm "$S-net" > /dev/null 2>&1 || true; rm -rf "$SCRATCH"; }
trap cleanup EXIT
fail() { echo "FAIL $*"; exit 1; }
host_path() { case "$(uname -s)" in MINGW*|MSYS*) (cd "$1" && pwd -W) ;; *) (cd "$1" && pwd) ;; esac; }

"$PY" -I "$(host_path "$ROOT")/scripts/measure/health/dicom-engine-gen.py" "$(host_path "$SCRATCH")" 2 31 64 > /dev/null
[ -s "$SCRATCH/inst-00001.dcm" ] || fail "synthetic instance not generated"
{ printf -- '--BNDRY\r\nContent-Type: application/dicom\r\n\r\n'; cat "$SCRATCH/inst-00001.dcm"; printf '\r\n--BNDRY--\r\n'; } > "$SCRATCH/stow.body"

RP=verify-only   # throwaway credential for a local, unpublished docker network; not a deployed value
docker network create "$S-net" > /dev/null
docker run -d --name "$S-ldap" --network "$S-net" -e LDAP_ROOTPASS="$RP" "$LDAPIMG" > /dev/null
docker cp "$(host_path "$HERE")/scripts/hl7-send.sh" "$S-ldap:/tmp/hl7-send.sh"
docker run -d --name "$S-db" --network "$S-net" -e POSTGRES_DB=pacsdb -e POSTGRES_USER=pacs -e POSTGRES_PASSWORD=pacs dcm4che/postgres-dcm4chee:17.9-35 > /dev/null
harden() { docker run --rm --network "$S-net" -e LDAP_URL="ldap://$S-ldap:389" -e LDAP_ROOTPASS="$RP" -e AE_ENFORCE="$ENF" "$@" --entrypoint sh "$LDAPIMG" /opt/loom/harden.sh; }
start_arc() {
  docker rm -f "$S-arc" > /dev/null 2>&1 || true
  docker run -d --name "$S-arc" --network "$S-net" -p 127.0.0.1::8080 \
    -e POSTGRES_HOST="$S-db" -e POSTGRES_DB=pacsdb -e POSTGRES_USER=pacs -e POSTGRES_PASSWORD=pacs \
    -e LDAP_URL="ldap://$S-ldap:389" -e LDAP_ROOTPASS="$RP" -e WILDFLY_WAIT_FOR="$S-ldap:389 $S-db:5432" "$ARC" > /dev/null
  PORT=$(docker port "$S-arc" 8080/tcp | head -1 | sed 's/.*://')
  i=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/dcm4chee-arc/aets/DCM4CHEE/rs/instances/count")" = 200 ]; do
    i=$((i + 1)); [ "$i" -le 90 ] || fail "archive REST layer not ready after 450s"; sleep 5
  done
}
stow() { # <aet> -> http code
  curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/dcm4chee-arc/aets/$1/rs/studies" \
    -H 'Content-Type: multipart/related; type="application/dicom"; boundary=BNDRY' -H 'Accept: application/dicom+json' \
    --data-binary "@$(host_path "$SCRATCH")/stow.body"
}
tcp_open() { docker exec "$S-ldap" nc -z -w 2 "$S-arc" "$1" > /dev/null 2>&1; }
hl7() { # <app> <facility> -> MSA ack code
  docker exec "$S-ldap" sh /tmp/hl7-send.sh "$S-arc" "$1" "$2" | sed -n 's/^MSA|\([A-Z][A-Z]\).*/\1/p' | head -1
}

echo "== harden (AE_ENFORCE=$ENF), DIMSE off"
harden
start_arc
echo "== A: DICOMweb STOW by AE title"
c=$(stow DCM4CHEE || true); echo "registered DCM4CHEE -> $c"; [ "$c" = 200 ] || fail "registered AE STOW expected 200, got $c"
c=$(stow NOSUCH || true); echo "unregistered NOSUCH -> $c"
case "$c" in 4??) ;; *) fail "unregistered AE STOW expected 4xx, got $c" ;; esac
echo "== B: ports"
tcp_open 8080 || fail "control: 8080 must accept (else the 11112 result proves nothing)"
if tcp_open 11112; then fail "DIMSE port 11112 is OPEN with DIMSE_ENABLED=false"; fi
echo "8080 open (control), 11112 refused"
echo "== C: HL7 sending-application allow-list"
a=$(hl7 LOOMGW LOOM || true); echo "registered LOOMGW|LOOM -> MSA|$a"; [ "$a" = AA ] || fail "registered HL7 sender expected AA, got '$a'"
a=$(hl7 ROGUE FAC || true); echo "unregistered ROGUE|FAC -> MSA|$a"
case "$a" in AE|AR) ;; *) fail "unregistered HL7 sender expected AE/AR, got '$a'" ;; esac

echo "== D: DIMSE overlay (DIMSE_ENABLED=true) to prove calling-AE enforcement"
harden -e DIMSE_ENABLED=true
start_arc
tcp_open 11112 || fail "overlay control: 11112 must accept with DIMSE_ENABLED=true"
SCR=$(host_path "$SCRATCH")
store() { docker run --rm --network "$S-net" -v "$SCR:/d:ro" dcm4che/dcm4che-tools:5.35.1 storescu -b "$1" -c "DCM4CHEE@$S-arc:11112" /d/inst-00002.dcm 2>&1; }
out=$(store LOOMGW) || fail "registered calling AE LOOMGW was refused: $(echo "$out" | tail -2)"
echo "registered LOOMGW -> stored"
if out=$(store ROGUE); then fail "unregistered calling AE ROGUE was ACCEPTED (AE enforcement not in effect)"; fi
echo "$out" | grep -q 'calling-AE-title-not-recognized' || fail "ROGUE refused, but not for calling-AE-title-not-recognized: $(echo "$out" | tail -2)"
echo "unregistered ROGUE -> A-ASSOCIATE-RJ calling-AE-title-not-recognized"
echo "OK verify-image"
