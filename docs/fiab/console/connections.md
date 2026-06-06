# Loom Connections (Key Vault-backed)

Reusable, **Key Vault-backed** connections to data sources. A user enters
credentials **once**; any secret (password / connection string / account key /
service-principal secret) is written to **Azure Key Vault** and only a reference
(`secretRef`) is stored in Cosmos. Connections are reused across mirroring, ADF /
Synapse linked services, and datasets — no plaintext secrets in item config.

## Surface

- **`/connections`** (left nav → *Connections*) — list / create / delete.
- **`ConnectionBuilder`** dialog (`lib/components/connections/connection-builder.tsx`)
  is reusable: it's also mounted in the mirrored-database create wizard, and any
  editor that needs source creds can mount it.

## Auth methods

| Method | Secret → Key Vault | Use |
|--------|--------------------|-----|
| `entra-mi` | none | the Console managed identity connects (source must allow the Entra principal) |
| `sql-password` | password | SQL / PG username + password |
| `connection-string` | the full string | any source |
| `account-key` | storage key | ADLS / Storage |
| `service-principal` | client secret | Entra app (tenant + client id non-secret) |

Source types: Azure SQL, Synapse Dedicated/Serverless, Databricks SQL, PostgreSQL,
ADLS Gen2, Cosmos DB, generic SQL Server.

## Backend

- `lib/azure/kv-secrets-client.ts` — KV REST `put`/`get`/`delete` secret (no
  `@azure/keyvault-secrets` dependency), same UAMI→DefaultAzureCredential chain.
- `lib/azure/connections-store.ts` + the `connections` Cosmos container (PK
  `/tenantId`); `secretRef` only — never the secret value.
- `app/api/connections/route.ts` — GET / POST / DELETE.

## Bicep / setup (no partial config)

- `LOOM_KEY_VAULT_URI` → console env (`admin-plane/main.bicep`, from the keyvault
  module output).
- The Console UAMI is granted **Key Vault Secrets Officer** on the vault
  (`keyvault.bicep`, `consolePrincipalId` param).

See `docs/fiab/v3-tenant-bootstrap.md` for the one-time setup on an existing
deployment.

## Why

Fixes the recurring source-auth failure *"Login failed for user
'\<token-identified principal\>'… not configured to accept this token"* — the
caller picks a non-Entra auth method (SQL password / connection string / SPN)
backed by Key Vault instead of relying on the Entra-token-only path.
