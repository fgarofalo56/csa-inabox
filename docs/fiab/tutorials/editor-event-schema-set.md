# Tutorial: Event schema set editor

> CSA Loom `event-schema-set` editor — a schema registry (Avro / JSON Schema /
> Protobuf) shared across Eventstream sources, KQL ingestion, and downstream
> consumers. **No Microsoft Fabric required.**

## What it is

An Event schema set is a schema registry for event streams: subjects (named
schema contracts) with versioned Avro, JSON Schema, or Protobuf definitions.
In Loom subjects and schemas persist to Cosmos and the eventstream runtime
reads them to validate ingress payloads — the contract layer that powers
DeltaFlow CDC.

## When to use it

- You need producers and consumers to agree on an event shape and evolve it
  safely.
- You want ingress payload validation on an Eventstream instead of schema
  drift discovered downstream.
- You already run a registry (Confluent, Apicurio, Event Hubs schema registry)
  and want the contracts visible in Loom.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Event schema set** (Real-Time
   Intelligence). The editor opens at `/items/event-schema-set/<id>`.
2. **Register a subject.** Create a subject under the **Subjects** tab to name
   the schema contract.
3. **Add a schema version.** Add an Avro, JSON Schema, or Protobuf definition;
   versions are tracked under the **Versions** tab.
4. **Set compatibility.** Choose a compatibility mode; if an external registry
   (Confluent, Apicurio, Event Hubs) is attached, the **Compatibility** tab
   links the docs.
5. **Wire to streams.** Reference the schema from Eventstream sources so
   ingress payloads are validated against the contract.

## The Azure backend it rides on

- **Store:** subjects + versioned schemas persist to the Loom Cosmos DB store.
- **Enforcement:** the eventstream runtime validates ingress payloads against
  the registered contract.

## No Fabric required

The registry is Cosmos-backed and enforced by the Azure-native eventstream
runtime (Event Hubs + Stream Analytics); no Fabric capacity or workspace is
involved.

## Learn more

- Eventstream overview (parity source):
  <https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview>
