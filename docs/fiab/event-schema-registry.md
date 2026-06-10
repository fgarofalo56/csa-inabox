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
  attribute persisted to Cosmos and **enforced before a new version is
  persisted** (see "Compatibility check" below).
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

## Compatibility check (implemented)

When `state.compatibility` is not `NONE` and the subject already has at least
one version, registering a new version is **checked and blocked if it is a
breaking change** — before anything is written to Cosmos. There are two
backends, selected automatically; neither requires Microsoft Fabric:

### Default — in-process Avro validator (Azure-native, no extra infra)

`lib/azure/schema-compat-validator.ts` implements the same structural Avro
rules the Event Hubs / Confluent registries enforce:

| Mode       | Add field                       | Remove field                    | Type change |
|------------|---------------------------------|---------------------------------|-------------|
| `BACKWARD` | allowed only **with a default** | allowed                         | must be Avro-promotable (int→long→float→double, string↔bytes) |
| `FORWARD`  | allowed                         | allowed only if it **had a default** | promotable in the reverse direction |
| `FULL`     | with default                    | had a default                   | promotable both ways |
| `NONE`     | always allowed                  | always allowed                  | always allowed |

`POST /api/items/event-schema-set/{id}/versions` runs this check and returns
**HTTP 409** with the specific violations when the new schema breaks the
policy. A read-only pre-check is also exposed at
`POST /api/items/event-schema-set/{id}/check-compat` (returns
`{ compatible, violations, checkedVia }` without persisting).

EH SR only evolution-checks **Avro**; JSON Schema and Protobuf sets use
`NONE` semantics (always compatible), matching the real service.

### Opt-in — Azure Event Hubs Schema Registry (server-side enforcement)

Set `LOOM_EH_SCHEMA_GROUP` (plus `LOOM_EVENTHUB_NAMESPACE`). The version
route then PUTs the schema into the Event Hubs schema group on the data plane
(`PUT https://{ns}.{serviceBusSuffix}/$schemagroups/{group}/schemas/{name}`,
api-version `2023-07-01`, token scope `https://eventhubs.azure.net/.default`).
The service enforces the group's `Backward`/`Forward` policy and returns 400
on a violation, which Loom surfaces as the 409 + message.

Bicep wiring:

- `modules/landing-zone/eventhubs.bicep` creates the schema group
  (`schemaGroupName`, default `loom-schemas`) with `schemaGroupCompatibility`
  (default `Backward`) and grants the Console UAMI **Schema Registry
  Contributor** (`5dffeca3-4936-4216-b2bc-10343a5abb25`) on the namespace.
  It outputs `loomSchemaGroupName`.
- `modules/admin-plane/main.bicep` exposes `loomEhSchemaGroup` and wires it to
  the console app's `LOOM_EH_SCHEMA_GROUP` env var.

The token scope is cloud-invariant; the FQDN follows the cloud via
`serviceBusSuffix()` (Commercial/GCC `servicebus.windows.net`,
GCC-High/DoD `servicebus.usgovcloudapi.net`).
