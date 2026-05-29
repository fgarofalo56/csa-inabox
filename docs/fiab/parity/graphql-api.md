# graphql-api — parity with APIM GraphQL API / Fabric GraphQL

Source UI: Azure portal → APIM → GraphQL API (synthetic) (https://learn.microsoft.com/azure/api-management/graphql-api),
Fabric GraphQL.

## Feature inventory

| # | Capability | Source surface |
|---|------------|----------------|
| 1 | Schema (SDL) editor | GraphQL schema editor |
| 2 | API config (display name, path, backend resolver URL, subscription required) | Settings |
| 3 | Publish schema to APIM as graphql API | Add API → GraphQL |
| 4 | Test query console (run a query → JSON result) | GraphQL test console |
| 5 | Resolvers (resolver policy mapping) | per-field resolver |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | `MonacoTextarea` language=graphql |
| 2 | built ✅ | form fields incl. `subscriptionRequired` Switch (deferred ribbon button REMOVED) |
| 3 | built ✅ | POST `/api/items/graphql-api/[id]/publish` → `upsertApi(apiType=graphql)` |
| 4 | built ✅ | Test query console → POST `/api/items/graphql-api/[id]/query` proxies a POST to the published gateway endpoint with the query+variables |
| 5 | honest-gate ⚠️ | Resolver policy authoring requires the synthetic-GraphQL `set-graphql-resolver` policy at field scope — surfaced via a MessageBar that deep-links to apim-policy (api scope) where the resolver `<http-data-source>` policy is authored. No disabled button. |

## Backend per control

- Schema/config → Cosmos `state` via PATCH `/api/items/graphql-api/[id]`
- Publish → `upsertApi` (graphql)
- Test query → POST to the resolved APIM gateway GraphQL endpoint (key from `master`).
