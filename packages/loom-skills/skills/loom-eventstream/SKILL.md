---
name: loom-eventstream
description: Azure-native eventstream in CSA Loom — back it with Azure Event Hubs (+ Stream Analytics for processing), never Fabric Eventstream. Call eventhubs-client.ts + stream-analytics-client.ts via /api/eventhubs. Triggers on eventstream, Event Hubs, streaming, real-time ingestion, consumer group, Stream Analytics, capture, schema registry.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-eventstream — Azure Event Hubs (the Azure-native Fabric Eventstream)

A Loom **eventstream** is an **Azure Event Hubs** namespace + hub, with **Azure
Stream Analytics** for in-stream processing. It is NOT a Fabric Eventstream.

## Clients

`apps/fiab-console/lib/azure/eventhubs-client.ts` (ARM + data plane) and
`stream-analytics-client.ts` (ASA jobs), plus `asa-query-compiler.ts`.

Real exported symbols:

```ts
// eventhubs-client.ts
export class EventHubsArmError extends Error {}
export interface EventHubsConfig { /* namespace, resourceGroup, ... */ }
export function eventhubsConfigGate(): { missing: string } | null;   // honest gate
export function readEventHubsConfig(): EventHubsConfig;
export interface EventHubEntity { /* name, partitionCount, status, ... */ }
export async function listEventHubs(): Promise<EventHubEntity[]>;
export interface CreateEventHubSpec { /* name, partitionCount, retention */ }
export async function createEventHub(spec: CreateEventHubSpec): Promise<EventHubEntity>;
export async function deleteEventHub(name: string): Promise<void>;
export interface ConsumerGroup { /* name */ }
export async function listConsumerGroups(eventHub: string): Promise<ConsumerGroup[]>;
export async function createConsumerGroup(/* eventHub, name */): Promise<...>;
```

The namespace FQDN is built with `serviceBusFqdn(namespace)` (sovereign-correct
`serviceBusSuffix()`); never write `servicebus.windows.net` directly.

## Auth

UAMI-first chain. Data-plane (send/receive) uses the Event Hubs `.default` scope;
ARM ops use `armScope()`. The UAMI needs **Azure Event Hubs Data Owner** + ARM
**Contributor** on the namespace (bicep `integration`).

## BFF routes

`/api/eventhubs/**` — `hubs`, `consumergroups`, `authrules`, `capture`,
`schemagroups`, `network`, `private-endpoints`, `geodr`. Validate session →
`eventhubsConfigGate()` (`LOOM_EVENTHUBS_NAMESPACE`) → real ARM/data-plane call →
`{ ok, data }`.

## Do / don't

- DO create hubs/consumer groups via the ARM client and process with Stream
  Analytics (`asa-query-compiler.ts` compiles the routing/processing query).
- DO gate on `LOOM_EVENTHUBS_NAMESPACE` honestly when unset.
- DON'T call the Fabric Eventstream REST API on the default path.
- DON'T hard-code the Service Bus suffix; use `serviceBusFqdn()`.

## Cross-links

UI parity: `docs/fiab/parity/eventstream.md`. Backend map row: eventstream in
`.claude/rules/no-fabric-dependency.md`.
