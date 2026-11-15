# LDAP configuration store for dcm4chee-arc-light, plus the Loom hardening script.
# Digest = dcm4che/slapd-dcm4chee:2.6.15-35.2 pulled 2026-11-15 (the W0 recipe used the tag).
FROM dcm4che/slapd-dcm4chee@sha256:a9c28ec51052979844158eacf78458a3438f7f4b6cfe4d4d4f458642ddda8417

COPY harden.sh /opt/loom/harden.sh
RUN chmod 0555 /opt/loom/harden.sh

LABEL org.opencontainers.image.title="Loom Health DICOM LDAP config store"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL ai.loom.health.slapd-dcm4chee-version="2.6.15-35.2"
