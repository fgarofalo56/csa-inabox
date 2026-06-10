# eventhubs-namespace (Capture / Geo-DR / SAS rotation / Private endpoints) — parity with Azure Event Hubs namespace

Source UI: Azure portal Event Hubs namespace blades — an event hub's **Capture**
blade, the namespace **Geo-recovery** blade, **Shared access policies** blade, and
**Networking → Private endpoint connections** blade.

Learn grounding:
- https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-overview
- https://learn.microsoft.com/rest/api/eventhub/event-hubs/create-or-update (captureDescription)
- https://learn.microsoft.com/azure/event-hubs/event-hubs-geo-dr
- https://learn.microsoft.com/rest/api/eventhub/disaster-recovery-configs/create-or-update
- https://learn.microsoft.com/rest/api/eventhub/disaster-recovery-configs/fail-over
- https://learn.microsoft.com/rest/api/eventhub/event-hubs/regenerate-keys
- https://learn.microsoft.com/rest/api/eventhub/private-endpoint-connections

## Azure feature inventory

### Capture (per event hub)
- Enable / disable capture
- Destination: Azure Blob Storage or ADLS Gen2
- Storage account + container/filesystem selection
- Time window (60–900 s) and size window (10–500 MB)
- Avro encoding (Parquet only via Stream Analytics no-code editor)
- Archive name format (9 tokens)
- Skip empty archives toggle

### Geo-recovery (namespace)
- Create pairing alias against a secondary namespace
- View alias role (Primary / Secondary / PrimaryNotReplicating) + provisioning state
- Break pairing
- Initiate failover (one-way, non-reversible)

### Shared access policies (namespace + per hub)
- List SAS policies + their rights (Listen / Send / Manage)
- Reveal keys / connection strings
- Regenerate primary key / secondary key

### Networking → Private endpoint connections (namespace)
- List private endpoint connections + status (Pending / Approved / Rejected / Disconnected)
- Approve a connection
- Reject a connection

## Loom coverage

| Capability | Status | Surface |
|---|---|---|
| Capture enable/disable | ✅ | EventHubsNamespaceEditor → Capture tab |
| Capture destination (Blob / ADLS Gen2) | ✅ | Dropdown |
| Capture storage account + container | ✅ | Fields |
| Capture time/size window | ✅ | SpinButtons (clamped 60–900 s / 10–500 MB) |
| Capture archive name format | ✅ | Field (default 9-token format) |
| Skip empty archives | ✅ | Switch |
| Geo-DR create pairing | ✅ | Geo-recovery tab → New pairing |
| Geo-DR view role/state | ✅ | Geo-recovery table |
| Geo-DR break pairing | ✅ | Geo-recovery table action (confirm) |
| Geo-DR failover | ✅ | Geo-recovery table action (confirm, one-way warning) |
| SAS list policies/rights | ✅ | SAS keys tab (namespace + per-hub segments) |
| SAS reveal keys | ✅ | SAS keys table "Reveal keys" |
| SAS rotate primary/secondary | ✅ | SAS keys table rotate menu (confirm) |
| SAS Entra-only honest gate | ⚠️ | MessageBar when `disableLocalAuth: true` |
| PE list connections | ✅ | Private endpoints tab + tree branch |
| PE approve / reject | ✅ | Private endpoints table actions |

Zero ❌. The only non-functional state is the honest `disableLocalAuth` gate
(SAS connection strings can't authenticate under Entra-only) and the standard
namespace-not-configured infra gate — both render the full UI surface.

## Backend per control

| Control | BFF route | ARM REST (api-version 2024-01-01) |
|---|---|---|
| Capture read | GET /api/eventhubs/capture | GET …/eventhubs/{eh} (reads captureDescription) |
| Capture write | PUT /api/eventhubs/capture | PUT …/eventhubs/{eh} captureDescription |
| Geo-DR create | POST /api/eventhubs/geodr-actions | PUT …/disasterRecoveryConfigs/{alias} |
| Geo-DR break | POST /api/eventhubs/geodr-actions | DELETE …/disasterRecoveryConfigs/{alias} |
| Geo-DR failover | POST /api/eventhubs/geodr-actions | POST …/disasterRecoveryConfigs/{alias}/failover |
| SAS reveal | POST /api/eventhubs/authrules/{rule}/keys | POST …/authorizationRules/{rule}/listKeys |
| SAS rotate | POST /api/eventhubs/authrules/{rule}/keys/regenerate | POST …/authorizationRules/{rule}/regenerateKeys |
| PE list | GET /api/eventhubs/private-endpoints | GET …/privateEndpointConnections |
| PE approve/reject | POST /api/eventhubs/private-endpoints | PUT …/privateEndpointConnections/{name} |

## Per-cloud notes

- Commercial: ARM `management.azure.com`; DNS zone `privatelink.servicebus.windows.net`.
- GCC / USGov / IL5: ARM `management.usgovcloudapi.net` (LOOM_ARM_ENDPOINT);
  DNS zone `privatelink.servicebus.usgovcloudapi.net`; `disableLocalAuth: true`
  is the mandatory posture, so the SAS tab surfaces the Entra-only MessageBar.
  Geo-DR secondary namespaces must stay within the same sovereign boundary.
- No Fabric / Power BI dependency: Capture writes to Blob/ADLS, Geo-DR aliases
  are Azure Event Hubs namespaces, SAS + PE are pure ARM. Works fully with
  LOOM_DEFAULT_FABRIC_WORKSPACE unset.

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/eventhubs.bicep`:
  optional `captureStorageAccountId` / `captureBlobContainerName` (form pre-fill +
  Storage Blob Data Contributor RBAC note), optional deploy-time Geo-DR pairing
  (`geoDrSecondaryNamespaceId` / `geoDrAliasName` → `disasterRecoveryConfigs`
  resource), new outputs. The namespace private endpoint (`pe-${ns.name}`) was
  already provisioned.
- `platform/fiab/bicep/modules/admin-plane/main.bicep`: new console env vars
  `LOOM_EVENTHUB_CAPTURE_STORAGE_ID` / `LOOM_EVENTHUB_CAPTURE_CONTAINER` +
  matching params.
