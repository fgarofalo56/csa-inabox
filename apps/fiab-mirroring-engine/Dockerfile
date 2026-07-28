# Loom Mirroring Engine — Debezium Connect runtime
#
# Service: loom-mirroring (the Connect cluster only; the Spark
#          replicator runs as a Databricks job, see databricks/
#          job-template.json)
# Image:   loom/mirroring:v0.1
# Port:    8083 (Kafka Connect REST; VNet-internal only)
#
# The replicator side (PySpark) deploys via Databricks Bundle (azd-style),
# not as a Container App.

# B-SC1' (loom-apex) 2026-07-28 — base bumped 3.0.0.Final -> 3.5.2.Final to burn
# down CVE-2024-47561 (Apache Avro deserialization RCE, fixed in avro 1.11.4).
# Evidence, all fetched live rather than assumed:
#   * debezium/container-images connect-base/3.0/Dockerfile pins
#     APICURIO_VERSION=2.6.2.Final, whose
#     apicurio-registry-distro-connect-converter tarball ships `avro-1.11.3.jar`
#     — that is the jar Trivy flags inside quay.io/debezium/connect:3.0.0.Final.
#   * connect-base/3.5 pins APICURIO_VERSION=2.6.13.Final, whose converter
#     tarball ships `avro-1.12.0.jar` (>= 1.11.4 — patched).
#   * quay.io/debezium/connect:3.5.2.Final exists and is active
#     (manifest sha256:b9c2e73a8598dccc84ec46932e580b03b96de3db64bc4f47101ff0893da4d91c,
#     pushed 2026-07-28).
# 3.5.2.Final is the latest PATCH of the settled 3.5 stable line rather than
# 3.6.0.Final, which GA'd the same day this bump was made — a security bump we
# cannot docker-build locally takes the line with bake time. 3.5 keeps the same
# image contract this Dockerfile depends on: `USER kafka` (uid 1001),
# KAFKA_HOME=/kafka, the Connect REST API on 8083, and the docker-entrypoint.sh
# plugin-path discovery — all verified in debezium/container-images kafka/3.5 +
# connect-base/3.5. Kafka client libs move 3.8 -> 4.2 with this bump; the
# connector JSON templates below use Debezium 3.x-stable properties only.
FROM quay.io/debezium/connect:3.5.2.Final

USER root

# Per-source Debezium connector templates (operator parameterizes
# via env vars at startup or via Kafka Connect REST API POST)
COPY debezium/connectors/*.json /kafka/connect-templates/

# Operator-side helper scripts
COPY landing-zone/publisher_sdk.py /opt/loom/
COPY sources/cosmos_change_feed.py /opt/loom/
COPY sources/snowflake_poller.py /opt/loom/

# Health probe — connects to the Connect REST API
RUN echo '#!/bin/sh' > /usr/local/bin/loom-health && \
    echo 'curl -fsS http://localhost:8083/connectors > /dev/null && exit 0 || exit 1' >> /usr/local/bin/loom-health && \
    chmod +x /usr/local/bin/loom-health

# Make health endpoint available on a known path mounted by the
# loom-health route. Container Apps probes hit /health (not /).
# Kafka Connect's own / returns 200 with a JSON body listing the
# cluster status, which suffices for liveness.

USER kafka

EXPOSE 8083

# Minimum env vars Debezium Connect needs to boot. Operator overrides
# these at deploy-time with real Kafka brokers (Azure Event Hubs Kafka
# surface) and topic names. Defaults let the container reach Ready so
# probes can succeed; no actual mirroring happens until BOOTSTRAP_SERVERS
# points at a real cluster.
ENV BOOTSTRAP_SERVERS=localhost:9092
ENV GROUP_ID=loom-connect-group
ENV CONFIG_STORAGE_TOPIC=loom-connect-configs
ENV OFFSET_STORAGE_TOPIC=loom-connect-offsets
ENV STATUS_STORAGE_TOPIC=loom-connect-status

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD /usr/local/bin/loom-health

LABEL org.opencontainers.image.title="Loom Mirroring Engine"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="mirroring-engine"
LABEL csa.loom.version="0.1.0"
