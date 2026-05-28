# Catalog — Business domains

CRUD over Microsoft Purview business domains.

## Endpoints

- `GET /api/catalog/domains` — list every business domain in the configured Purview account
- `POST /api/catalog/domains` body `{ name, description?, type?, parentId? }` — create a new domain
- `DELETE /api/catalog/domains?id=<guid>` — delete

Backed by `lib/azure/purview-client.ts → listBusinessDomains / createBusinessDomain / deleteBusinessDomain`. The Purview API path is `/datagovernance/businessdomains`.

## NotConfigured gate

When `LOOM_PURVIEW_ACCOUNT` is not set, every endpoint returns `HTTP 501` with the structured `hint` payload (missing env var, bicep module path, required RBAC roles, follow-up admin action). The UI surfaces the hint inside a Fluent UI `MessageBar intent="warning"` — no fake domains rendered.

## UI

`/catalog/domains` → table of domains + create form (name + description). Each row has a delete button.

## Future

Domain → catalog/workspace assignment lands in phase 2. The current page surfaces only Purview-native domains; UC catalogs and OneLake workspaces will be assignable from this same form once we land `domainAssignments` Cosmos container.
