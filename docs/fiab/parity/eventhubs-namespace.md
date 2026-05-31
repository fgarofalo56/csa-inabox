# eventhubs-namespace — parity with Azure Event Hubs namespace

Source UI: Azure portal → Event Hubs namespace blade
(`portal.azure.com` → Microsoft.EventHub/namespaces/{ns}), grounded in
Microsoft Learn:
- ARM resource: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces>
- Event hubs: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/eventhubs>
- Consumer groups: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/eventhubs/consumergroups>
- Authorization rules: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/eventhubs/authorizationrules>
- Schema groups: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/schemagroups>
- Network rule sets: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/networkrulesets>
- Geo-DR configs: <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces/disasterrecoveryconfigs>

Loom surface: `lib/components/eventhubs/eventhubs-tree.tsx`
(`EventHubsNamespaceTree`), hosted as the left navigator of the **Eventstream**
editor (`lib/editors/phase3-editors.tsx` → `EventstreamEditor`). Event Hubs is
the underlying Azure service that feeds Fabric Eventstream sources, so the
namespace navigator lives alongside the topology canvas.

Auth: `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)` → ARM token `https://management.azure.com/.default`.
API version `2024-01-01`. Namespace pinned by `LOOM_EVENTHUB_NAMESPACE` +
`LOOM_EVENTHUB_SUB` (or `LOOM_SUBSCRIPTION_ID`) + `LOOM_EVENTHUB_RG` (or
`LOOM_DLZ_RG`). The Loom UAMI must hold **Azure Event Hubs Data Owner**
(data plane) + **Contributor** (control plane) on the namespace.

## Azure feature inventory (every capability)

| # | Capability (Azure portal) | Notes |
|---|---------------------------|-------|
| 1 | **Event Hubs** list | Each entity: name, partition count, message retention, status, capture state |
| 2 | Create event hub | name + partition count (fixed at create) + retention; Capture optional |
| 3 | Delete event hub | |
| 4 | **Consumer groups** (per event hub) list | Includes the built-in `$Default` group |
| 5 | Create consumer group | name (+ optional user metadata) |
| 6 | Delete consumer group | `$Default` cannot be deleted |
| 7 | **Schema Registry → Schema groups** list | name, schema type (Avro/Json), compatibility |
| 8 | Create schema group | name + schema type + compatibility |
| 9 | Delete schema group | |
| 10 | **Shared access policies (Authorization rules)** list | namespace-level + per-event-hub; rights Listen/Send/Manage |
| 11 | Create / regenerate SAS policy + keys | key authoring + rotation |
| 12 | **Networking** — firewall (IP / VNet rules) | default action, public network access, rule counts |
| 13 | **Geo-recovery (Geo-DR)** configs list | alias, role, partner namespace, provisioning state |
| 14 | Geo-DR pairing (create alias / break-pair / failover) | |
| 15 | **Capture** configuration on an event hub | archive to Blob/ADLS |
| 16 | **Private endpoints** | private link connections to the namespace |

## Loom coverage

| # | Capability | Status | Surface |
|---|------------|--------|---------|
| 1 | Event hubs list | ✅ built | `Event hubs` group, live count + per-hub partition/retention/capture/status badges |
| 2 | Create event hub | ✅ built | ＋New → dialog (name + partition SpinButton 1–32 + retention SpinButton 1–7) → `PUT …/eventhubs/{eh}` |
| 3 | Delete event hub | ✅ built | inline trash → `DELETE …/eventhubs/{eh}` |
| 4 | Consumer groups list (per hub) | ✅ built | nested `Consumer groups` branch under each event hub, lazy-loaded on expand |
| 5 | Create consumer group | ✅ built | ＋New (parent-hub picker, or the per-hub ＋) → `PUT …/eventhubs/{eh}/consumergroups/{cg}` |
| 6 | Delete consumer group | ✅ built | inline trash (hidden for `$Default`) → `DELETE …/consumergroups/{cg}` |
| 7 | Schema groups list | ✅ built | `Schema groups` group, type + compatibility badges |
| 8 | Create schema group | ✅ built | ＋New → dialog (name + type Avro/Json + compatibility) → `PUT …/schemagroups/{sg}` |
| 9 | Delete schema group | ✅ built | inline trash → `DELETE …/schemagroups/{sg}` |
| 10 | Authorization rules list | ✅ built (read-only) | `Authorization rules` group, rights badges; namespace-scope (per-hub via `?eventHub=`) |
| 11 | SAS policy create / key rotation | ⚠️ honest-gate | "Not yet wired" row: `PUT …/authorizationRules/{rule}` + `regenerateKeys/listKeys` |
| 12 | Networking firewall summary | ✅ built (read-only) | `Networking` group, default action + public access + IP/VNet counts |
| 13 | Geo-DR configs list | ✅ built (read-only) | `Geo-recovery` group, role + provisioning state |
| 14 | Geo-DR pairing actions | ⚠️ honest-gate | "Not yet wired" row: `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `failover` |
| 15 | Capture configuration | ⚠️ honest-gate | "Not yet wired" row: `PUT …/eventhubs/{eh}` captureDescription (list still shows a `capture` badge when enabled) |
| 16 | Private endpoints | ⚠️ honest-gate | "Not yet wired" row: `Microsoft.Network/privateEndpoints` + `privateEndpointConnections` |

Zero ❌. Every row is built ✅ or honest-gated ⚠️ with the exact ARM REST named.

## Backend per control

| Control | BFF route | ARM REST |
|---------|-----------|----------|
| List / create / delete event hub | `/api/eventhubs/hubs` | `GET/PUT/DELETE …/Microsoft.EventHub/namespaces/{ns}/eventhubs[/{eh}]?api-version=2024-01-01` |
| List / create / delete consumer group | `/api/eventhubs/consumergroups` | `GET/PUT/DELETE …/eventhubs/{eh}/consumergroups[/{cg}]` |
| List / create / delete schema group | `/api/eventhubs/schemagroups` | `GET/PUT/DELETE …/schemagroups[/{sg}]` |
| List authorization rules | `/api/eventhubs/authrules` | `GET …/authorizationRules` (+ `…/eventhubs/{eh}/authorizationRules` via `?eventHub=`) |
| Network rule set summary | `/api/eventhubs/network` | `GET …/networkRuleSets/default` (404 → "Allow all") |
| Geo-DR configs | `/api/eventhubs/geodr` | `GET …/disasterRecoveryConfigs` |

Each route is session-guarded (`getSession()` → 401), 503s via
`eventhubsConfigGate()` with `code: 'not_configured'` + the exact missing env
var when the namespace is unset, and returns `{ ok, … }` JSON. No mocks; the
client (`lib/azure/eventhubs-client.ts`) issues real ARM calls only.

## Deferred (honest-gated)

- **SAS key authoring / rotation** — touches privileged `listKeys` /
  `regenerateKeys`; surfaced as a "Not yet wired" row (rules are listed
  read-only).
- **Geo-DR pairing / failover** — destructive multi-namespace actions;
  surfaced as a "Not yet wired" row (configs listed read-only).
- **Capture configuration** — Blob/ADLS archival authoring; surfaced as a
  "Not yet wired" row (enabled state shown via a `capture` badge on the hub).
- **Private endpoints** — `Microsoft.Network` cross-provider; surfaced as a
  "Not yet wired" row (firewall summary shown under Networking).

## Bicep sync

`platform/fiab/bicep/modules/admin-plane/main.bicep` adds params
`loomEventHubNamespace` / `loomEventHubRg` / `loomEventHubSub` and wires
`LOOM_EVENTHUB_NAMESPACE` / `LOOM_EVENTHUB_RG` / `LOOM_EVENTHUB_SUB` into the
loom-console Container App env list (RG/sub fall back to `LOOM_DLZ_RG` /
`LOOM_SUBSCRIPTION_ID`). The namespace resource + the UAMI role assignments
(Data Owner + Contributor) still need an `eventhubs*.bicep` landing-zone module
— tracked as the next infra step; until provisioned the navigator shows its
honest config gate.
