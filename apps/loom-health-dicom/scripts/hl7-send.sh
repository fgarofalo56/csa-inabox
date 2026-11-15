#!/bin/sh
# Send one synthetic HL7 ADT^A04 over MLLP and print the ACK segments. Test helper for
# verify-image.sh; runs inside a container that has busybox nc.
#   hl7-send.sh <host> <sending-app> <sending-facility>
HOST="$1"
CR=$(printf '\r')
MSG="MSH|^~\\&|$2|$3|DCM4CHEE|DCM4CHEE|20261115010101||ADT^A04|M$$|P|2.5${CR}PID|1||SYN1^^^LOOM||SYNTHETIC^TEST||19700101|M"
printf '\013%s\034\r' "$MSG" | nc -w 5 "$HOST" 2575 | tr '\r' '\n'
