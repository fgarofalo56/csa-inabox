# azure-connections — parity with Fabric/Data Factory connections (gateways)

Source UI: Fabric **Manage connections and gateways** / Data Factory connectors
Reference: <https://learn.microsoft.com/fabric/data-factory/connector-overview>
Run date: 2026-06-09

Loom surfaces:

- Page: `/connections` → `app/connections/page.tsx`
- BFF: `app/api/connections/route.ts` (GET/POST/DELETE)
- Store: `lib/azure/connections-store.ts` → `listConnections`,
  `createConnection`, `deleteConnection`
- Secrets: `lib/azure/kv-secrets-client.ts` → `putKeyVaultSecret`,
  `deleteKeyVaultSecret`, `kvSecretsConfigGate`
- Builder: `lib/components/connections/connection-builder.tsx`

Connections are **Azure-native**: metadata in Cosmos, secrets in Azure Key Vault.
There is **no dependency on real Microsoft Fabric** — connection management works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. List connections to data sources
2. Create a connection (source type, server/host, database, auth method,
   credentials)
3. Multiple authentication methods (managed identity, basic, key, SP)
4. Securely store credentials (never expose secrets)
5. Delete a connection

## Loom coverage

Source types: `azure-sql`, `synapse-dedicated`, `synapse-serverless`,
`databricks-sql`, `postgres`, `storage-adls`, `cosmos`, `generic-sql`.
Auth methods: `entra-mi`, `sql-password`, `connection-string`, `account-key`,
`service-principal`.

| Capability | Status | Backend |
|---|---|---|
| List connections (no secrets) | ✅ Built | `GET /api/connections` → Cosmos `connections` |
| Create connection (name, type, auth method, host, database, credentials) | ✅ Built | `POST /api/connections` → KV `putKeyVaultSecret()` + Cosmos metadata |
| 8 data-source types | ✅ Built | `TYPES` const validated in route |
| 5 auth methods | ✅ Built | `METHODS` const validated; `authNeedsSecret()` guard |
| Secret isolation (KV only — never in Cosmos or UI) | ✅ Built | only `secretRef` stored in Cosmos; raw secret → Key Vault |
| Delete connection (+ KV secret delete) | ✅ Built | `DELETE /api/connections?id=` → `deleteKeyVaultSecret` (best-effort) + Cosmos delete |
| Honest gate when Key Vault not configured | ⚠️ Honest gate | `kvSecretsConfigGate()` → 503 naming `LOOM_KEY_VAULT_URI/URL/NAME` + `Key Vault Secrets Officer` role |

Zero ❌ rows. The single ⚠️ gate (Key Vault unconfigured) is honest — it names
the exact env var + role; with KV configured the full create/list/delete surface
works, per `no-vaporware.md`.

## Backend per control

- **Create** — `POST` validates the type + auth method; for methods that carry a
  secret (`authNeedsSecret()`), the raw credential is written to Key Vault via
  `putKeyVaultSecret()` and only the resulting `secretRef` (plus host / database /
  method metadata) is persisted to the Cosmos `connections` container. The secret
  is never echoed back.
- **List** — `GET` returns connection metadata with `secretRef` but never the
  secret value.
- **Delete** — `DELETE` best-effort deletes the Key Vault secret then removes the
  Cosmos record.
- **Gate** — `kvSecretsConfigGate()` returns a 503 naming
  `LOOM_KEY_VAULT_URI`/`URL`/`NAME` and the `Key Vault Secrets Officer` role when
  no vault is resolvable.

## Per-cloud notes

| Cloud | Key Vault endpoint |
|---|---|
| Commercial / GCC | `*.vault.azure.net` (resolved from `LOOM_KEY_VAULT_URI/URL/NAME`) |
| GCC-High / IL5 | `*.vault.usgovcloudapi.net`; `kv-secrets-client.ts` resolves the gov endpoint from the same env vars |

`entra-mi` auth needs no stored secret in any cloud and is the recommended
default per `no-fabric-dependency.md` MI-first guidance.

## Bicep sync

- No new resource — the connections use the existing Cosmos `connections`
  container and the admin-plane Key Vault.
- `LOOM_KEY_VAULT_URI`/`URL`/`NAME` are already in the `apps[]` env list.
- The console UAMI needs **Key Vault Secrets Officer** on the vault (granted in
  the admin-plane Key Vault bicep); absent that, the surface honest-gates.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — Cosmos + Key
  Vault only.
- Live walk: open `/connections`, create an `azure-sql` connection with
  `sql-password` auth, confirm the secret lands in Key Vault and only `secretRef`
  is in Cosmos (not the password); create an `entra-mi` connection (no secret);
  delete a connection and confirm the KV secret is removed.

Grade: **A** — full connection lifecycle with real Cosmos + Key Vault secret
isolation; only the honest KV-config gate.
