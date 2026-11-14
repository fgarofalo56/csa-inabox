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
#   - /app/extra-classes/loom-health-fhir-plugin.jar  Loom plugin jar. SKELETON:
#     it loads, it registers no interceptor (W2-3 adds PDP + audit).
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

COPY validator.lock packages.lock.tsv ./
COPY scripts/fetch-baked-assets.sh ./scripts/fetch-baked-assets.sh
RUN sh ./scripts/fetch-baked-assets.sh /build /baked

COPY plugin/pom.xml ./plugin/pom.xml
COPY plugin/src ./plugin/src
RUN mvn -B -q -f plugin/pom.xml package \
 && java -cp plugin/target/loom-health-fhir-plugin.jar ai.loom.health.fhir.LoomPlugin | tee /tmp/plugin-load.json \
 && grep -q '"interceptors":0' /tmp/plugin-load.json

COPY check ./check
RUN sh ./check/check-validator.sh /baked/validator/validator_cli.jar /baked/home /build/check

# ---- runtime stage ---------------------------------------------------------
# Digest = the W0-measured HAPI 8.12.0 image. Bump tag-equivalent and digest together
# with the plugin pom's HAPI version (W2-3) and tests/image-contract.test.mjs.
FROM hapiproject/hapi@sha256:0ff86aac4c7bd13a1ee226444a70263bb46ed1c28ef543c30a44f865b80ca04e AS runtime

COPY --from=tools /build/plugin/target/loom-health-fhir-plugin.jar /app/extra-classes/loom-health-fhir-plugin.jar
COPY --from=tools /baked/packages /opt/loom/fhir/packages
COPY --from=tools /baked/validator /opt/loom/fhir/validator
COPY --from=tools /baked/home /opt/loom/fhir/home

LABEL org.opencontainers.image.title="Loom Health FHIR Engine (HAPI FHIR JPA)"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL ai.loom.health.hapi-version="8.12.0"
LABEL ai.loom.health.validator-version="6.9.12"
LABEL ai.loom.health.plugin-state="skeleton-no-interceptors"
