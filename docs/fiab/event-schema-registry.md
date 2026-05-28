# Event schema registry

The Loom **Event Schema Set** editor surfaces schema registry CRUD without
requiring a tenant to stand up an external registry day-one. This page
sketches how the editor maps to a "real" registry when one is attached, and
what the current Cosmos-backed mode does today.

## Today (v3.x, Cosmos-backed)

- Loom's `event-schema-set` item stores subjects + versions in the Cosmos
  `items` container under each item's `state.subjects` array.
- Versions are append-only.
- Compatibility (`BACKWARD`, `FORWARD`, `FULL`, `NONE`) is a per-set
  attribute persisted to Cosmos but **not yet enforced server-side** — the
  editor surfaces this in a MessageBar.
- The eventstream runtime reads these schemas to validate ingress payloads
  via the existing `loom-eventstream-engine` worker.

## When a tenant attaches an external registry

Two flavours are supported:

### Confluent Schema Registry (CSR)

1. Provision a CSR-compatible endpoint (Confluent Cloud, Apicurio Registry
   on AKS, or Azure Event Hubs Schema Registry).
2. Store the endpoint URL in the item's `state.externalRegistry.endpoint`.
3. The editor's "Sync from registry" button pulls subjects via
   `GET /subjects` and persists them as Loom subjects.

### Azure Event Hubs Schema Registry

1. Provision Schema Registry via Event Hubs namespace.
2. Grant the Loom Console UAMI the `Schema Registry Reader` role.
3. Store the namespace + schema group in
   `state.externalRegistry.eventHubsNamespace` /
   `state.externalRegistry.schemaGroup`.

## Compatibility check (planned)

When `state.compatibility` is `BACKWARD` or stricter, registering a new
version should call:

- CSR: `POST /compatibility/subjects/{subject}/versions/latest`
- Event Hubs SR: equivalent compatibility-check call

Loom returns a 400 if the new schema is incompatible. **This check is not
yet wired in v3.x.** A follow-up PR will land it; the editor MessageBar
links here so the gap is honestly disclosed.
