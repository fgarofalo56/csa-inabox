# Image for the LHDS FHIR engine (apps/loom-health-fhir) - LHDS W2-1.
#
# BUILD CONTEXT IS THE APP DIRECTORY (every COPY below is relative to it; none
# reaches outside apps/loom-health-fhir, unlike loom-health-cp which needs the
# repo root, #5171):
#
#   docker build -t loom-health-fhir apps/loom-health-fhir
#
# WHAT THIS IS. The upstream HAPI FHIR JPA server, pinned BY DIGEST to the exact
# image W0-7 measured (server 8.12.0, FHIR R4 4.0.1; PRPs/active/loom-health-data-
# services/W0-RECEIPT.md section 1; same digest as scripts/measure/health/
# fhir-engine-deploy.sh), plus:
#   - /app/extra-classes/loom-health-fhir-plugin.jar  Loom plugin jar: registers the PDP
#     authorization interceptor, then the AuditEvent interceptor (W2-3).
#   - /opt/loom/fhir/packages/*.tgz   US Core 6.1.0 + its dependency closure.
#   - /opt/loom/fhir/validator/validator_cli.jar   HL7 validator 6.9.12 (the same
#     org.hl7.fhir.core version the pinned server ships).
# Every baked artifact is sha256-checked at BUILD time (validator.lock,
# packages.lock.tsv); the runtime image performs NO download. The build FAILS if the
# baked validator cannot pass a valid US Core Patient and reject an invalid one,
# offline.
#
# The base image is distroless (no shell, user 65532, java 21, entrypoint
# PropertiesLauncher with /app/extra-classes on loader.path). Configuration is
# environment-only and arrives in W2-2; nothing tenant-specific is baked in.

# ---- tools stage: fetch + verify assets, build the plugin, run the baked check
FROM maven:3.9.9-eclipse-temurin-21 AS tools
WORKDIR /build

COPY validator.lock otel-agent.lock packages.lock.tsv ./
COPY scripts/fetch-baked-assets.sh ./scripts/fetch-baked-assets.sh
RUN sh ./scripts/fetch-baked-assets.sh /build /baked

COPY plugin/pom.xml ./plugin/pom.xml
COPY plugin/src ./plugin/src
# Tests are skipped here: the plugin tests start Jetty and run in the CI/test lanes
# (mvn -f plugin/pom.xml test). The expected interceptor count is LIFTED from the plugin
# source (one svc.registerInterceptor( call per interceptor), never hard-coded, and must be
# >0, so a plugin that registers none fails the build; the load probe must report the same.
# The probe runs with the plugin's provided HAPI deps on the class path: LoomPlugin.register()
# links IInterceptorService, so the class cannot initialise without them (the runtime image
# supplies them via PropertiesLauncher; see scripts/verify-image.sh).
RUN set -eu; \
    EXPECTED=$(grep -cE '^[[:space:]]*svc\.registerInterceptor\(' plugin/src/main/java/ai/loom/health/fhir/LoomPlugin.java); \
    [ "$EXPECTED" -gt 0 ] || { echo "FAIL: LoomPlugin.java registers no interceptor"; exit 1; }; \
    mvn -B -q -f plugin/pom.xml package -DskipTests; \
    mvn -B -q -f plugin/pom.xml dependency:build-classpath -Dmdep.outputFile=/tmp/plugin-cp.txt; \
    java -cp "plugin/target/loom-health-fhir-plugin.jar:$(cat /tmp/plugin-cp.txt)" ai.loom.health.fhir.LoomPlugin | tee /tmp/plugin-load.json; \
    grep -q "\"interceptors\":$EXPECTED}" /tmp/plugin-load.json

COPY check ./check
RUN sh ./check/check-validator.sh /baked/validator/validator_cli.jar /baked/home /build/check

# ---- os-patch stage: fixed libbrotli1 for the distroless base (CVE-2026-111497) ---
# The base has no package manager, so the fixed .deb is downloaded here, checked
# against the sha256 in os-patch.lock (apt also verifies the archive signature), and
# unpacked; the runtime stage overlays the libraries and the dpkg status entry so
# scanners see the fixed version. Digest = debian:13-slim.
FROM debian:13-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS ospatch
COPY os-patch.lock /os-patch.lock
RUN set -eu; \
    PKG=$(sed -n 's/^package=//p' /os-patch.lock | tr -d '[:cntrl:]'); \
    VER=$(sed -n 's/^version=//p' /os-patch.lock | tr -d '[:cntrl:]'); \
    SUM=$(sed -n 's/^sha256=//p' /os-patch.lock | tr -d '[:cntrl:]'); \
    apt-get update -qq; \
    cd /tmp && apt-get download "$PKG=$VER"; \
    echo "$SUM  ${PKG}_${VER}_amd64.deb" | sha256sum -c -; \
    mkdir -p /out/status.d; \
    dpkg-deb -x "${PKG}_${VER}_amd64.deb" /out/root; \
    dpkg-deb -f "${PKG}_${VER}_amd64.deb" > "/out/status.d/$PKG"; \
    dpkg-deb -e "${PKG}_${VER}_amd64.deb" /tmp/ctl; \
    cp /tmp/ctl/md5sums "/out/status.d/$PKG.md5sums"

# ---- runtime stage ---------------------------------------------------------
# Digest = the W0-measured HAPI 8.12.0 image. Bump tag-equivalent and digest together
# with the plugin pom's HAPI version (W2-3) and tests/image-contract.test.mjs.
FROM hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e AS runtime

COPY --from=tools /build/plugin/target/loom-health-fhir-plugin.jar /app/extra-classes/loom-health-fhir-plugin.jar
COPY --from=tools /baked/packages /opt/loom/fhir/packages
COPY --from=tools /baked/validator /opt/loom/fhir/validator
COPY --from=tools /baked/home /opt/loom/fhir/home
# Patched layers (no .trivyignore): libbrotli1 and the OpenTelemetry agent.
COPY --from=ospatch /out/root/usr/lib/x86_64-linux-gnu/ /usr/lib/x86_64-linux-gnu/
COPY --from=ospatch /out/status.d/ /var/lib/dpkg/status.d/
COPY --from=tools /baked/agent/opentelemetry-javaagent.jar /app/opentelemetry-javaagent.jar

LABEL org.opencontainers.image.title="Loom Health FHIR Engine (HAPI FHIR JPA)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL ai.loom.health.hapi-version="8.12.0"
LABEL ai.loom.health.validator-version="6.9.12"
LABEL ai.loom.health.plugin-state="pdp-audit-interceptors"
