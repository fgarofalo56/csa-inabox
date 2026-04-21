---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0005 — Event Hubs over open-source Kafka for streaming ingestion

## Context and Problem Statement

Several vertical examples (IoT streaming, EPA air-quality, NOAA weather,
casino analytics) require a durable, high-throughput streaming buffer in
front of Bronze. We must pick a default streaming broker that works in
Azure Government on day one, survives burst ingestion, integrates with our
Purview/Unity Catalog governance, and does not force customers to operate
a stateful distributed system.

## Decision Drivers

- **Azure Government availability** — broker must be a Gov-GA PaaS with
  FedRAMP High inheritance.
- **Operational burden** — a managed broker eliminates ZooKeeper/KRaft,
  broker patching, and partition rebalancing as customer responsibilities.
- **Kafka protocol compatibility** — customers with existing Kafka clients
  must be able to connect without code rewrites.
- **Native integration** with Stream Analytics, Azure Functions, ADX, and
  Databricks Structured Streaming.
- **Cost predictability** — throughput-unit or auto-inflate pricing should
  be simpler to forecast than self-hosted MSK/Confluent Cloud equivalents.

## Considered Options

1. **Azure Event Hubs (chosen)** — Managed PaaS, Gov-GA, Kafka-protocol
   endpoint for drop-in clients, native connectors to Stream Analytics,
   ADX, Functions, and Databricks.
2. **Self-hosted Apache Kafka on AKS** — Full control, open-source, but
   customer-owned cluster management.
3. **Confluent Cloud on Azure** — Managed Kafka with full Kafka ecosystem
   (Connect, Schema Registry, ksqlDB).
4. **Azure Service Bus** — Reliable queuing/pub-sub for business messaging
   but not a data-stream broker.

## Decision Outcome

Chosen: **Option 1 — Event Hubs** as the default streaming broker, with a
Kafka-protocol endpoint enabled so Kafka-client code connects without
changes. Event Hubs Capture writes directly to Bronze (ADLS Gen2) as
Avro/Parquet. A Service Bus lane is reserved for transactional/business
messaging and is not considered for data streaming.

## Consequences

- Positive: Managed PaaS in Azure Gov; FedRAMP High inheritance; no broker
  operations.
- Positive: Kafka-protocol endpoint means existing producers/consumers
  (librdkafka, kafka-python, Spark kafka source) work unmodified.
- Positive: Event Hubs Capture gives zero-code Bronze ingestion — no
  bespoke consumer needed for archival.
- Positive: First-class integration with ADX (for hot-path analytics),
  Databricks Structured Streaming, and Stream Analytics.
- Negative: Event Hubs is a narrower subset of Kafka — no Kafka Connect,
  no Kafka Streams, no KSQL, no broker-side transactions across topics.
- Negative: Partition counts are fixed at creation (premium tier relaxes
  this) — capacity planning matters.
- Negative: Schema Registry is available (Event Hubs Schema Registry) but
  less mature than Confluent's; we pair it with dbt contracts where
  possible.
- Neutral: If a customer requires the full Kafka ecosystem, Confluent Cloud
  on Azure remains a viable alternate path.

## Pros and Cons of the Options

### Option 1 — Event Hubs
- Pros: Managed PaaS; Gov-GA; Kafka-protocol compatible; Capture to ADLS;
  native ADX/Databricks integration; predictable throughput-unit pricing.
- Cons: Subset of Kafka features; no Kafka Connect; fixed partition counts
  on standard tier.

### Option 2 — Self-hosted Kafka on AKS
- Pros: Full Kafka feature set; Kafka Connect ecosystem; no vendor markup.
- Cons: Customer-owned cluster operations, upgrades, and HA; stateful
  workload on AKS is operationally expensive.

### Option 3 — Confluent Cloud on Azure
- Pros: Managed full Kafka; Schema Registry; Kafka Connect; ksqlDB.
- Cons: Third-party service; Gov-GA story is weaker; additional vendor
  procurement; cross-account networking complexity.

### Option 4 — Service Bus
- Pros: Strong business-messaging semantics (FIFO, sessions, DLQ).
- Cons: Not a streaming broker; no partitioned append log; wrong tool for
  high-throughput ingest.

## Validation

We will know this decision is right if:
- All streaming vertical examples ingest with zero custom broker-management
  code.
- Event Hubs Capture covers >90% of Bronze-archival use cases.
- If two or more customers blocked on Kafka Connect or transactional
  cross-topic writes, revisit with Confluent Cloud as the alternate.

## References

- Decision tree:
  [Kafka vs. Event Hubs vs. Service Bus](../decisions/kafka-vs-eventhubs-vs-servicebus.md)
- Decision tree:
  [Batch vs. Streaming](../decisions/batch-vs-streaming.md)
- Related code: `examples/iot-streaming/`, `examples/noaa/`,
  `examples/epa/`, `examples/casino-analytics/` (streaming ingestion
  patterns)
- Framework controls: NIST 800-53 **SC-7** (boundary protection via
  Private Endpoints on the Event Hubs namespace), **AU-2** (diagnostic
  logs to Log Analytics), **SC-8** (TLS in transit). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
