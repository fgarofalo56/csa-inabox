# sql-data-access-mode — parity with Synapse SQL endpoint identity / "Run as" auth

Source UI: Azure Synapse / SQL — connection identity selection (service vs
user/AAD passthrough). Learn refs:
- https://learn.microsoft.com/azure/synapse-analytics/sql/active-directory-authentication
- https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-overview
- https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control

Feature ID: F10 — SQL endpoint data-access mode (delegated vs user's identity).
Surfaces: `SynapseDedicatedSqlPoolEditor`, `SynapseServerlessSqlPoolEditor`
(`lib/editors/synapse-sql-editors.tsx`), section component
`lib/panes/sql-access-mode-section.tsx`.

## Azure/Fabric feature inventory

Azure data tools let you choose which identity runs a query against a SQL
endpoint: a fixed service/managed identity, or the interactive user's own AAD
identity (so RLS, `SUSER_NAME()`/`USER_NAME()`, and SQL auditing reflect the
caller). Switching to "my identity" is a deliberate, persisted choice and
requires the user to be provisioned in the SQL endpoint.

| # | Capability |
|---|------------|
| 1 | Choose data-access identity: service identity vs user's identity |
| 2 | Persist the choice for the endpoint (survives reload / re-open) |
| 3 | One-time confirmation when switching to user's identity (explains scope) |
| 4 | Queries actually execute under the chosen identity (real token on the wire) |
| 5 | Honest prerequisite surfacing when the user isn't ready (no token / not provisioned) |
| 6 | Restrict who can change the mode (workspace owner/contributor) |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Delegated vs User's-identity radios | built ✅ | `SqlAccessModeSection` RadioGroup |
| 2 | Persist to Cosmos `item.state.accessMode`; re-read on mount | built ✅ | PATCH `/access-mode` + GET item on load |
| 3 | One-time confirmation dialog (names the user, the prerequisite) | built ✅ | Fluent `Dialog`, only on switch → user |
| 4 | Real per-user TDS execution under the caller's token | built ✅ | `executeQueryAsUser` (per-user pool, AAD access-token auth) |
| 5 | Honest gate when no user SQL token | honest-gate ⚠️ | 403 `NO_USER_SQL_TOKEN` + MessageBar; consent/provisioning steps documented |
| 6 | Owner/contributor-only change | built ✅ | `resolveWorkspaceRole` + `canEditWorkspaceConfig` in PATCH route |

Zero ❌. Azure-native default ("service identity") works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no per-user setup — no Fabric
dependency.

## Backend per control

| Control | Backend |
|---------|---------|
| Mode radios → save | `PATCH /api/items/{type}/{id}/access-mode` → Cosmos `items` replace (`state.accessMode`) |
| Mode load | `GET /api/items/{type}/{id}` (Cosmos read) + `GET /api/me` (UPN for dialog) |
| Run query (service) | `executeQuery(target, sql)` — UAMI/SP TDS token |
| Run query (user) | `executeQueryAsUser(target, sql, userSqlToken, oid)` — caller's delegated SQL token via TDS `azure-active-directory-access-token` |
| User token capture | sign-in requests `…/user_impersonation`; callback `captureUserSqlToken` → `saveUserSqlToken` (encrypted, Cosmos `tenant-settings`) |
| Token read at query time | `getUserSqlToken(oid)` (decrypt; 60s expiry margin) |

## One-time tenant config

Delegated SQL permission + admin consent + per-user SQL provisioning — see
`docs/fiab/v3-tenant-bootstrap.md#sql-user-identity-access-mode` and
`scripts/csa-loom/grant-sql-delegated-permission.sh`. `LOOM_SYNAPSE_SQL_TOKEN_SCOPE`
(already per-boundary in `admin-plane/main.bicep`) makes the scope cloud-portable;
no new env var or bicep resource.

## Verification

With mode = User's identity, `SELECT SUSER_NAME() AS me;` returns the signed-in
UPN (not the console identity); the mode persists across reload (Cosmos
`item.state.accessMode`). Wiring covered by
`lib/editors/__tests__/sql-access-mode-f10.test.ts`.
