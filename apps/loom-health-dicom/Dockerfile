# Loom Health DICOM engine: dcm4chee-arc-light 5.35.2 (ADR-002), PostgreSQL flavour.
# Digest = the manifest list of dcm4che/dcm4chee-arc-psql:5.35.2 pulled 2026-11-15. The W0 recipe
# (scripts/measure/health/dicom-engine-deploy.sh) used the bare tag; a digest is stricter. >= 5.35.2
# is required (CISA ICSMA-26-288-02 fixed in 5.35.2). Bump version label, digest and
# tests/hardened-defaults.test.mjs together. Hardening is NOT done here: it lives in the LDAP
# configuration store, applied by ldap/harden.sh from the chart (see README.md).
#
# JAR PATCH LAYER (no .trivyignore). Upstream 5.35.2 ships two jars with CRITICAL findings:
#   netty-handler 4.1.136.Final  CVE-2026-75595, fixed in 4.1.137.Final
#   bcprov-jdk18on 1.84          CVE-2026-8763,  fixed in 1.85
# Both replace the jar inside the WildFly module tree and the module.xml resource-root is
# rewritten to the new name (a stale name makes the module, and so the archive, fail to load).
# Each jar is verified against the sha256 below at BUILD time (Maven Central publishes the .sha1;
# the sha256 was computed from the same bytes and the sha1 cross-checked 2026-11-15).
# The fix versions are asserted by tests/hardened-defaults.test.mjs, lifted from these ARGs.
# bin/client/jboss-client.jar (a remote-client convenience jar that shades the vulnerable netty,
# loaded by neither the server nor the archive) is removed rather than patched.

# ---- fetch stage: download + verify the replacement jars -------------------------------------
FROM debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS jarpatch
ARG NETTY_HANDLER_VERSION=4.1.137.Final
ARG NETTY_HANDLER_SHA256=d0e4c6ee4779f59f6ab2fb5d388e4f57147c82270164b37945764bb9bda96a44
ARG BCPROV_VERSION=1.85
ARG BCPROV_SHA256=20af26bf6060bb8005cc2389916812c1e0e998dc48d2ced7131b89461b54cff7
RUN set -eu; \
    apt-get update -qq; apt-get install -y -qq --no-install-recommends curl ca-certificates > /dev/null; \
    mkdir -p /out; cd /out; \
    curl -fsSL -O "https://repo1.maven.org/maven2/io/netty/netty-handler/${NETTY_HANDLER_VERSION}/netty-handler-${NETTY_HANDLER_VERSION}.jar"; \
    curl -fsSL -O "https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/${BCPROV_VERSION}/bcprov-jdk18on-${BCPROV_VERSION}.jar"; \
    echo "${NETTY_HANDLER_SHA256}  netty-handler-${NETTY_HANDLER_VERSION}.jar" | sha256sum -c -; \
    echo "${BCPROV_SHA256}  bcprov-jdk18on-${BCPROV_VERSION}.jar" | sha256sum -c -

# ---- runtime stage ---------------------------------------------------------------------------
FROM dcm4che/dcm4chee-arc-psql@sha256:eb348a2a1d0eece6dd85b7f047acbd70b6c5b47f59896464d371e9b42313b536
ARG NETTY_HANDLER_VERSION=4.1.137.Final
ARG BCPROV_VERSION=1.85
ARG MODS=/opt/wildfly/modules/system/layers/base

COPY --from=jarpatch /out/netty-handler-${NETTY_HANDLER_VERSION}.jar ${MODS}/io/netty/netty-handler/main/
COPY --from=jarpatch /out/bcprov-jdk18on-${BCPROV_VERSION}.jar ${MODS}/org/bouncycastle/bcprov/main/
RUN set -eu; \
    cd "${MODS}"; \
    rm io/netty/netty-handler/main/netty-handler-4.1.136.Final.jar org/bouncycastle/bcprov/main/bcprov-jdk18on-1.84.jar; \
    sed -i "s#netty-handler-4.1.136.Final.jar#netty-handler-${NETTY_HANDLER_VERSION}.jar#" io/netty/netty-handler/main/module.xml; \
    sed -i "s#bcprov-jdk18on-1.84.jar#bcprov-jdk18on-${BCPROV_VERSION}.jar#" org/bouncycastle/bcprov/main/module.xml; \
    grep -q "netty-handler-${NETTY_HANDLER_VERSION}.jar" io/netty/netty-handler/main/module.xml; \
    grep -q "bcprov-jdk18on-${BCPROV_VERSION}.jar" org/bouncycastle/bcprov/main/module.xml; \
    chown wildfly:wildfly io/netty/netty-handler/main/* org/bouncycastle/bcprov/main/*; \
    rm -f /opt/wildfly/bin/client/jboss-client.jar

LABEL org.opencontainers.image.title="Loom Health DICOM Engine (dcm4chee-arc-light)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL org.opencontainers.image.licenses="MPL-1.1 OR LGPL-2.1-or-later"
LABEL ai.loom.health.dcm4chee-version="5.35.2"
LABEL ai.loom.health.patched-jars="netty-handler-4.1.137.Final,bcprov-jdk18on-1.85"
