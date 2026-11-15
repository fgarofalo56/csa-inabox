# Loom Health DICOM engine: dcm4chee-arc-light 5.35.2 (ADR-002), PostgreSQL flavour.
# Digest = the manifest list of dcm4che/dcm4chee-arc-psql:5.35.2 pulled 2026-11-15. The W0 recipe
# (scripts/measure/health/dicom-engine-deploy.sh) used the bare tag; a digest is stricter. >= 5.35.2
# is required (CISA ICSMA-26-288-02 fixed in 5.35.2). Bump version label, digest and
# tests/image-contract.test.mjs together. Hardening is NOT done here: it lives in the LDAP
# configuration store, applied by ldap/harden.sh from the chart (see README.md).
FROM dcm4che/dcm4chee-arc-psql@sha256:eb348a2a1d0eece6dd85b7f047acbd70b6c5b47f59896464d371e9b42313b536

LABEL org.opencontainers.image.title="Loom Health DICOM Engine (dcm4chee-arc-light)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL org.opencontainers.image.licenses="MPL-1.1 OR LGPL-2.1-or-later"
LABEL ai.loom.health.dcm4chee-version="5.35.2"
