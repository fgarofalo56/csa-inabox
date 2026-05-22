# Loom Mirroring Engine — Debezium Connect runtime
# Status: SCAFFOLDED — real implementation per PRP-07

FROM quay.io/debezium/connect:2.7.0

USER root

# Cosmos Spark connector (for Cosmos NoSQL CDC)
RUN mkdir -p /kafka/connect/cosmos-cdc/
COPY connectors/cosmos-spark-cdc.json /kafka/connect/cosmos-cdc/

# Per-source Debezium connector configs
COPY connectors/*.json /kafka/connect/

# Custom Snowflake streams poller
COPY connectors/snowflake-streams-poller.yaml /kafka/connect/snowflake/

USER kafka

EXPOSE 8083

LABEL csa.loom.component="mirroring-engine"
LABEL csa.loom.version="0.1.0-scaffold"
