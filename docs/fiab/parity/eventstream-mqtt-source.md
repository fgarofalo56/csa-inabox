# eventstream-mqtt-source — parity with Fabric Eventstream MQTT source (mTLS)

Source UI:
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-mqtt
- https://learn.microsoft.com/fabric/real-time-hub/add-source-mqtt

The Real-Time Hub **Connect source → MQTT** connector ingests from any MQTT
broker (IoT) into a Loom-native eventstream. Azure-native by default (Event
Hubs-backed runtime, no Microsoft Fabric / capacity required, per
`no-fabric-dependency.md`). mTLS certificates come from Azure Key Vault.

## Fabric feature inventory (grounded in Learn)

| # | Capability | Notes |
|---|------------|-------|
| 1 | MQTT Broker URL | Protocols `ssl://`, `wss://`, `tcp://` |
| 2 | Connection name | Cloud connection identity |
| 3 | Username + Password | Broker credentials (password is a secret) |
| 4 | Topic name | Single topic subscription |
| 5 | Version | V5 / V3 selector |
| 6 | TLS/mTLS settings (toggle) | Expandable section (Preview) |
| 7 | Trust CA certificate | Subscription + RG + Key Vault + **certificate name** |
| 8 | Client certificate and key | Same KV fields; "use same vault" checkbox |
| 9 | Stream/source details | Eventstream name, auto `-stream` stream name |
| 10 | Review + connect | Creates the eventstream carrying the source |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | MQTT Broker URL | ✅ built | `source-catalog.ts` field `brokerUrl` |
| 2 | Connection name | ✅ built (Eventstream name) | dialog `displayName` |
| 3 | Username + Password | ✅ built — password is `kind:'password'`, written to KV as `passwordSecretRef` | `connect-source/route.ts` |
| 4 | Topic name | ✅ built | field `topic` |
| 5 | Version | ✅ built — `kind:'select'` V5/V3 | field `protocolVersion` |
| 6 | TLS/mTLS settings toggle | ✅ built — `kind:'toggle'` reveals the cert pickers | field `useMtls` |
| 7 | Trust CA certificate (KV) | ✅ built — `kind:'cert'` picker from live KV cert list | field `caCertName` |
| 8 | Client certificate and key (KV) | ✅ built — `kind:'cert'` picker, same vault | field `clientCertName` |
| 9 | Stream/source details | ✅ built — workspace + eventstream name; topology emits `<name>-stream` | `buildSourceTopology` |
| 10 | Review + connect | ✅ built — Connect POSTs and shows the created item link | `connect-source-dialog.tsx` |
| — | Cert vault not configured | ⚠️ honest-gate — MessageBar names `LOOM_EVENTSTREAM_CERT_VAULT` + role | `keyvault-certificates/route.ts` |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Cert pickers (CA + client) | `GET /api/realtime-hub/keyvault-certificates` → `kv-secrets-client.listKeyVaultCertificates()` → KV REST `/certificates?api-version=7.4` |
| Password | `putKeyVaultSecret()` → KV REST `PUT /secrets/{name}` (stores `passwordSecretRef`) |
| Connect | `POST /api/realtime-hub/connect-source` → `createOwnedItem('eventstream', …)` (Cosmos) carrying `{ sources:[{ type:'Mqtt', properties }] }` |
| Fabric opt-in | `LOOM_EVENTSTREAM_BACKEND=fabric` + `fabricWorkspaceId` → `connectEventstreamSource()` (Fabric REST) |

## Infra / RBAC (bicep-synced)

- Env: `LOOM_EVENTSTREAM_CERT_VAULT` (admin-plane `main.bicep`, param
  `loomEventstreamCertKeyVaultUri`, defaults to admin-plane vault).
- Role: Console UAMI **Key Vault Certificate User**
  (`db79e9a7-68ee-4b58-9aeb-b90e7c24fcba`) on the vault — `keyvault.bicep`.
- Bootstrap: `docs/fiab/v3-tenant-bootstrap.md#eventstream-mtls-certs`.

## Tests

`app/api/realtime-hub/__tests__/routes.test.ts`:
- Mqtt source type accepted; CA/client cert refs persisted in topology.
- Broker password written to KV; only `passwordSecretRef` kept.
- 503 when a password is supplied but no KV is configured.
- `keyvault-certificates`: 401 unauth, honest-gate when unconfigured, real list when configured.
