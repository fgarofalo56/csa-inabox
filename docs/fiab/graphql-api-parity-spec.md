# Loom GraphQL API Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Fabric "API for GraphQL" = auto-generated GraphQL data layer over Fabric SQL DB / Warehouse / Lakehouse / Mirrored DB / Azure SQL, with managed resolvers, schema explorer, and a Monaco-style query playground.

## Overview

Fabric API for GraphQL exposes a single managed GraphQL endpoint per item. Fabric introspects the chosen data sources, generates SDL (types, queries, mutations) automatically, and serves resolvers without any backend code. Mutations are only generated for Fabric Data Warehouse sources (SQL analytics endpoints are read-only). Authentication is Entra-ID-only (`GraphQLApi.Execute.All` permission), and the editor supports SSO or saved credentials per item. The whole stack is meant to replace hand-written REST/Node backends for application developers consuming lakehouse / warehouse data.

## UI components

### Header chrome
- **Item name** + workspace breadcrumb
- **Share** button (Share / Edit / Execute permissions)
- **Settings** (description, sensitivity label, endorsement, authentication mode, CORS allowlist, monitoring toggle)
- **Endpoint URL** copy field (the public `https://*.graphql.fabric.microsoft.com/...` URL)

### Mode switcher (lower-left)
- **Query** — open the editor / playground
- **Schema** — open read-only SDL view + schema explorer

### Schema explorer (left pane, both modes)
- Tree-grouped by **data source name** (e.g., `AdventureWorks SQL endpoint`)
- Three top-level nodes:
  - **Types**: GraphQL types generated from tables/views/stored procs
  - **Queries**: auto-generated list / single / filtered read operations
  - **Mutations**: create / update / delete (Warehouse only — requires PK)
- Per-type expansion shows fields, types, nullability, and relationships
- Right-click → **Add to query** drops a query template into the playground
- "Expose / hide" toggle per object to modify what's served

### Data source connection panel ("Get data")
- **OneLake catalog browser** — workspace-scoped picker for Lakehouses, Warehouses, Mirrored DBs, Fabric SQL DBs, Azure SQL DBs
- Filter by type · search by name
- **Auth mode picker** (one-time, locked after first source):
  - **Single sign-on (SSO)** — caller's Entra identity flows through
  - **Saved credentials** — shared cached credential (required for Azure SQL)
- Per-source object picker: tables / views / stored procedures with multi-select checkboxes ("Choose data" screen)
- Folder-level select-all toggle

### Query playground (Query mode main pane)
- **Monaco editor** with GraphQL syntax highlighting
- Intellisense / autocomplete (Ctrl/Cmd+Space) over schema types, fields, arguments
- **Query variables** pane (JSON)
- **Run** button executes against the live endpoint
- **Results** pane with JSON tree viewer
- Tabs for multiple parallel queries
- Saved query history

### Relationship designer (Schema mode)
- Add/edit/delete relationships between types
- One-to-one · one-to-many · many-to-many (with linking type)
- "From type / From field" → "To type / To field" picker
- For M:N: linking type + linking-from / linking-to field pickers
- Nested query traversal is auto-wired once a relationship exists

### Resolver layer (read-only)
- Resolvers are **generated**, not authored — there is no custom-resolver code editor inside Fabric (as of 2026-05)
- Custom business logic = expose a stored procedure from the source warehouse instead
- FAQ explicitly: "it's not possible to customize resolvers directly"

### Settings panel
- Authentication mode (SSO vs saved credentials)
- CORS allowed origins (for browser clients)
- Throttling / rate-limit hints (most enforcement is in front-of APIM)
- Monitoring toggle (request logs, performance dashboard)
- Schema export (introspection JSON / SDL)

### Invocation helpers
- "Generate client code" → Python / C# / Node.js with MSAL token acquisition
- OpenAPI/SDL export
- Local MCP server scaffold (for AI agents)

## What Loom has

- `apps/fiab-console/lib/editors/phase4-editors.tsx` lines 410-485: `GraphqlApiEditor`
- Cosmos persistence of: `displayName`, `path`, `serviceUrl`, `sdl` (raw textarea), `description`, `subscriptionRequired`, `lastPublishedAt`, `lastPublishedTo`
- **Real publish path**: `POST /api/items/graphql-api/{id}/publish` pushes the SDL to **Azure APIM** as a GraphQL API surface (not Fabric — APIM-backed)
- One ribbon group: Schema (Reload / Publish to APIM) + Auth (Subscription required)
- Plain `<textarea>` for SDL — no Monaco, no intellisense
- B-grade verdict — publish to APIM works end-to-end; no Fabric integration, no schema explorer, no playground, no relationship designer

## Gaps for parity

1. **OneLake data-source picker** — no UI to bind a Lakehouse / Warehouse / SQL DB; today the user pastes a `serviceUrl` string
2. **Auto schema generation** — Loom does not introspect the source; SDL is user-typed
3. **Schema explorer tree** — no Types / Queries / Mutations browser
4. **Monaco query playground** — no Run button, no results pane, no variables JSON
5. **Intellisense over schema** — Ctrl/Cmd+Space autocomplete not wired
6. **Relationship designer UI** — no 1:1 / 1:N / M:N visual builder
7. **Auth mode picker** — Loom only exposes "subscription required" (APIM-side); no SSO vs saved-credentials concept
8. **CORS / throttling settings** — no surface beyond APIM defaults
9. **Generate-client-code dialog** — no Python / C# / Node.js / OpenAPI export
10. **Mutation gating on PK presence** — no warning when warehouse table lacks PK
11. **Endpoint URL copy** — not surfaced in the editor chrome

## Backend mapping

- **Primary backend = Azure APIM** (already wired): `POST /api/items/graphql-api/{id}/publish` calls `Microsoft.ApiManagement/service/{svc}/apis` with `apiType=graphql` and `value=<SDL>`. Subscription-required and gateway URL flow through.
- **Schema introspection** for true Fabric parity would require either:
  - Calling the source Fabric SQL endpoint via TDS and reflecting `INFORMATION_SCHEMA` → generate SDL server-side, or
  - Calling Azure Data API Builder (DAB) which is the OSS engine Fabric uses under the hood (`dab init` + `dab update --relationship`)
- **Query execution playground** can either:
  - Hit APIM directly with caller's Entra token (true server-side resolution), or
  - Use a Loom-side GraphQL proxy that introspects + executes against the configured backend
- **Resolver customization** = stored-procedure exposure on the warehouse, not in Loom (matches Fabric's stance)

## Required Azure resources

- **Azure APIM** instance (Consumption SKU minimum) — already provisioned in v1.9 APIM-first surface
- **Source data store** — one of: Fabric SQL Analytics endpoint, Fabric Warehouse, Azure SQL DB, Synapse Serverless. All real-REST wired in v2.0/v2.1.
- **App registration** with `GraphQLApi.Execute.All` (Power BI service) for any Fabric-native consumer code paths
- **Storage** — Cosmos container `items` (already in use) keeps the editor state

## Estimated effort

3-4 sessions for B+ parity (no Fabric introspection):
- Session 1: Monaco SDL editor + endpoint copy + auth-mode picker UI (2 h)
- Session 2: OneLake-style source picker reusing existing Lakehouse/Warehouse list endpoints, generate SDL from source schema via TDS (4 h)
- Session 3: Query playground — Run button proxying to APIM with caller token + JSON results pane (3 h)
- Session 4: Relationship designer + generate-client-code dialog (3 h)

A+ parity (true Fabric-style auto-resolvers across multi-source fan-out) requires standing up DAB as a sidecar — defer to v4.x.
