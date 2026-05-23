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

FROM quay.io/debezium/connect:2.7.0

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

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD /usr/local/bin/loom-health

LABEL org.opencontainers.image.title="Loom Mirroring Engine"
LABEL org.opencontainers.image.source="https://github.com/fgarofalo56/csa-inabox"
LABEL csa.loom.component="mirroring-engine"
LABEL csa.loom.version="0.1.0"
