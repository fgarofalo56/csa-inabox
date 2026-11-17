#!/bin/sh
# Loom hardened defaults for dcm4chee-arc-light (LHDS W3-1). Runs against the archive's LDAP
# configuration store BEFORE the archive boots (Helm initContainer). Idempotent.
#
# Settings (env), all read here and nowhere else:
#   LDAP_URL            default ldap://ldap:389        LDAP_ROOTPASS  required (never printed)
#   AE_ENFORCE          true|false, default true. true = only registered calling AE titles are
#                       accepted; false removes the allow-list (accept any).
#   AE_TITLE            the archive's own AE title (default DCM4CHEE; must already exist in LDAP)
#                       The calling-AE allow-list is applied to EVERY archive AE enumerated under
#                       the device (dicomAETitle=*, e.g. DCM4CHEE_ADMIN, IOCM_*), not to this one only.
#   AE_ALLOWED_CALLING  comma list of calling AE titles accepted when enforced (default LOOMGW)
#   HL7_AUTH            true|false, default true. true = hl7AcceptedSendingApplication is set
#   HL7_ALLOWED_SENDING comma list of "Application|Facility" (default LOOMGW|LOOM)
#   DIMSE_ENABLED       true|false, default false. false = the DICOM listeners get no port, so
#                       the archive binds nothing on 11112 (a dcm4che connection with no dicomPort
#                       is not a server connection).
set -eu
LDAP_URL="${LDAP_URL:-ldap://ldap:389}"
: "${LDAP_ROOTPASS:?LDAP_ROOTPASS is required}"
AE_ENFORCE="${AE_ENFORCE:-true}"
AE_TITLE="${AE_TITLE:-DCM4CHEE}"
AE_ALLOWED_CALLING="${AE_ALLOWED_CALLING:-LOOMGW}"
HL7_AUTH="${HL7_AUTH:-true}"
HL7_ALLOWED_SENDING="${HL7_ALLOWED_SENDING:-LOOMGW|LOOM}"
DIMSE_ENABLED="${DIMSE_ENABLED:-false}"
for v in AE_ENFORCE HL7_AUTH DIMSE_ENABLED; do
  eval "val=\$$v"
  case "$val" in true|false) ;; *) echo "FAIL $v must be true or false (got '$val')" >&2; exit 2 ;; esac
done
BASE="cn=Devices,cn=DICOM Configuration,dc=dcm4che,dc=org"
DEV="dicomDeviceName=dcm4chee-arc,$BASE"
AEDN="dicomAETitle=$AE_TITLE,$DEV"
AUTH="-x -H $LDAP_URL -D cn=admin,dc=dcm4che,dc=org -y /tmp/.rootpw"
umask 077
printf '%s' "$LDAP_ROOTPASS" > /tmp/.rootpw
trap 'rm -f /tmp/.rootpw /tmp/harden.ldif' EXIT

# Wait until the configuration store answers AND holds the archive AE (not just an open port).
i=0
until ldapsearch -LLL $AUTH -b "$AEDN" -s base dn 2>/dev/null | grep -q '^dn:'; do
  i=$((i + 1)); [ "$i" -le 120 ] || { echo "FAIL LDAP did not return $AEDN within 240s" >&2; exit 1; }
  sleep 2
done

# DNs of the device's children matching a filter. A search error aborts (set -e on the
# assignment); an empty result is the caller's decision.
list_dns() { # filter
  out="$(ldapsearch -LLL -o ldif-wrap=no $AUTH -b "$DEV" -s one "$1" dn)"
  printf '%s\n' "$out" | sed -n 's/^dn: //p'
}
AE_DNS="$(list_dns '(dicomAETitle=*)')"
HL7_DNS="$(list_dns '(hl7ApplicationName=*)')"
printf '%s\n' "$AE_DNS" | grep -qxF "$AEDN" || { echo "FAIL enumeration did not return the archive AE $AEDN" >&2; exit 1; }
[ -n "$HL7_DNS" ] || { echo "FAIL no hl7ApplicationName found under $DEV" >&2; exit 1; }

values() { # attr csv -> one "attr: v" line per value
  echo "$2" | tr ',' '\n' | while read -r v; do [ -n "$v" ] && echo "$1: $v"; done
}
{
  printf '%s\n' "$AE_DNS" | while IFS= read -r dn; do
    echo "dn: $dn"; echo "changetype: modify"
    echo "replace: dcmAcceptedCallingAETitle"
    if [ "$AE_ENFORCE" = true ]; then values dcmAcceptedCallingAETitle "$AE_ALLOWED_CALLING"; fi
    echo
  done
  printf '%s\n' "$HL7_DNS" | while IFS= read -r dn; do
    echo "dn: $dn"; echo "changetype: modify"
    echo "replace: hl7AcceptedSendingApplication"
    if [ "$HL7_AUTH" = true ]; then values hl7AcceptedSendingApplication "$HL7_ALLOWED_SENDING"; fi
    echo
  done
  for c in dicom dicom-tls; do
    echo "dn: cn=$c,$DEV"; echo "changetype: modify"
    echo "replace: dicomPort"
    if [ "$DIMSE_ENABLED" = true ]; then
      if [ "$c" = dicom ]; then echo "dicomPort: 11112"; else echo "dicomPort: 2762"; fi
    fi
    echo
  done
} > /tmp/harden.ldif
ldapmodify $AUTH -f /tmp/harden.ldif > /dev/null

# Read back: never report a hardened state that was not observed. A failed search is a failed
# read-back, never a count of 0 (which would satisfy every absence check below).
get() { # dn attr -> number of "attr:" lines
  if ! out="$(ldapsearch -LLL -o ldif-wrap=no $AUTH -b "$1" -s base "$2")"; then
    echo "FAIL ldapsearch exited non-zero reading $2 from $1" >&2; exit 1
  fi
  printf '%s\n' "$out" | grep -c "^$2:" || :
}
n_ae=0; n_hl7=0; n_port=0
while IFS= read -r dn; do
  n="$(get "$dn" dcmAcceptedCallingAETitle)"
  if [ "$AE_ENFORCE" = true ]; then
    [ "$n" -ge 1 ] || { echo "FAIL AE allow-list empty after write on $dn" >&2; exit 1; }
  else
    [ "$n" -eq 0 ] || { echo "FAIL AE allow-list still present on $dn with AE_ENFORCE=false" >&2; exit 1; }
  fi
  n_ae=$((n_ae + n))
done <<EOF_AE
$AE_DNS
EOF_AE
# HL7 is read back whether or not HL7_AUTH is on: off must read as absent.
while IFS= read -r dn; do
  n="$(get "$dn" hl7AcceptedSendingApplication)"
  if [ "$HL7_AUTH" = true ]; then
    [ "$n" -ge 1 ] || { echo "FAIL HL7 allow-list empty after write on $dn" >&2; exit 1; }
  else
    [ "$n" -eq 0 ] || { echo "FAIL HL7 allow-list still present on $dn with HL7_AUTH=false" >&2; exit 1; }
  fi
  n_hl7=$((n_hl7 + n))
done <<EOF_HL7
$HL7_DNS
EOF_HL7
# Both DICOM connections (plain and TLS) are read back.
for c in dicom dicom-tls; do
  n="$(get "cn=$c,$DEV" dicomPort)"
  if [ "$DIMSE_ENABLED" = false ]; then
    [ "$n" -eq 0 ] || { echo "FAIL DICOM listener cn=$c still has a port" >&2; exit 1; }
  else
    [ "$n" -ge 1 ] || { echo "FAIL DICOM listener cn=$c has no port with DIMSE_ENABLED=true" >&2; exit 1; }
  fi
  n_port=$((n_port + n))
done
echo "hardened: ae_enforce=$AE_ENFORCE ae_allowed=$n_ae hl7_auth=$HL7_AUTH hl7_allowed=$n_hl7 dimse_port_attrs=$n_port"
