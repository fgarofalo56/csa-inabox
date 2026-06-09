# admin-overview — parity with the admin portal home (live section tiles)

Source UI:
- Microsoft **Fabric Admin portal** landing + **Azure portal** service-blade
  "home" tiles that surface a live count per area
  (https://learn.microsoft.com/fabric/admin/admin-center ,
  https://learn.microsoft.com/fabric/admin/feature-usage-adoption).
- The pattern: an admin home that does NOT dead-end on an empty state — every
  governance area is a tile with a real count + a click-through to manage it.

Loom builds this 1:1 on **Azure-native backends only** — Cosmos for the
tenant-scoped governance data, Microsoft Graph for the directory user count and
sensitivity labels, and ARM for the Azure resource + fired-alert counts.
**No Microsoft Fabric / Power BI tenant is required** (per
`.claude/rules/no-fabric-dependency.md`): the "Capacity & compute" tile counts
Azure resources via ARM `listResources()`, NOT `api.fabric.microsoft.com`.

## Source feature inventory (every capability)

| # | Capability (Fabric/Azure admin home) | Notes |
|---|--------------------------------------|-------|
| 1 | Landing shows a tile per admin area (no empty "pick an area" dead-end) | |
| 2 | Each tile shows a live count from that area's backend | not a static number |
| 3 | Each tile links to the section to manage it | click-through |
| 4 | Tiles are role/session-gated server-side | 401 when unauthenticated |
| 5 | A tile whose backend isn't provisioned shows an honest gate, not a fake 0 | env/role remediation |
| 6 | Counts are tenant-isolated | one tenant never sees another's totals |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `lib/panes/admin-overview.tsx` renders 12 Fluent Card tiles; `app/admin/page.tsx` mounts it (replaces the old `EmptyState`) |
| 2 | built ✅ | `GET /api/admin/overview` returns `tiles[key] = { count, gated, hint }`; UI renders the count Badge |
| 3 | built ✅ | each tile is a Next.js `<Link>` to its `/admin/*` route (mirrors `admin-shell` SECTIONS) |
| 4 | built ✅ | route calls `getSession()` → 401; page shows `<SignInRequired>` on 401 |
| 5 | built ✅ (honest-gate ⚠️) | any backend failure → `{ count: null, gated: true, hint }`; UI shows a Lock badge + tooltip naming the exact env var / role |
| 6 | built ✅ | every Cosmos query binds `s.claims.oid` as the `/tenantId` partition key |

## Backend per tile (which REST/data-plane each count calls)

| Tile | Route key | Backend | Gate (env / role) |
|------|-----------|---------|-------------------|
| Workspaces | `workspaces` | Cosmos `workspaces` `COUNT(1) WHERE tenantId` | `LOOM_COSMOS_ENDPOINT` |
| Domains | `domains` | Cosmos `tenant-settings` doc `domains:<t>` `.items.length` | `LOOM_COSMOS_ENDPOINT` |
| Usage & items | `items` | Cosmos: tenant workspaces → `COUNT(1)` items via `ARRAY_CONTAINS` | `LOOM_COSMOS_ENDPOINT` |
| Audit logs (30d) | `auditEvents` | Cosmos `audit-log` `COUNT(1) WHERE tenantId AND at>=since` | `LOOM_COSMOS_ENDPOINT` |
| Feature permissions | `permissions` | Cosmos `feature-permissions` `COUNT(1) WHERE tenantId` | `LOOM_COSMOS_ENDPOINT` |
| Custom attributes | `attributeGroups` | Cosmos `attribute-groups` `COUNT(1) WHERE tenantId` | `LOOM_COSMOS_ENDPOINT` |
| Batch labeling | `labeledItems` | Cosmos `label-assignments` `COUNT(1) WHERE tenantId` | `LOOM_COSMOS_ENDPOINT` |
| Tenant settings | `tenantSettings` | Cosmos `tenant-settings` doc `<t>` — count of `true` switches | `LOOM_COSMOS_ENDPOINT` |
| Users & licenses | `users` | Microsoft Graph `GET /v1.0/users/$count` (`ConsistencyLevel: eventual`) | `LOOM_IDENTITY_PICKER_ENABLED` + Graph `User.Read.All` |
| Capacity & compute | `capacity` | ARM `listResources()` across Loom RGs | `LOOM_SUBSCRIPTION_ID` (+ `LOOM_*_RG`) + Reader |
| Health & self-audit | `openAuditItems` | ARM AlertsManagement `listAlertHistory({days:30})` — `Fired` only | `LOOM_SUBSCRIPTION_ID` + Monitoring Reader |
| Security & governance | `sensitivityLabels` | Microsoft Graph MIP `listSensitivityLabels()` | `LOOM_MIP_ENABLED` + `InformationProtectionPolicy.Read.All` |

All twelve env vars / roles above are **already wired** by the existing bicep
(`platform/fiab/bicep/modules/admin-plane/main.bicep` apps[] env + the Graph
AppRole grant scripts) — this feature adds **no new** Azure resource, env var,
Cosmos container, or role assignment, so there is no bicep drift to reconcile.

## Verification

`vitest` (`app/api/admin/__tests__/admin-overview.test.ts`) covers: 401,
all-12-tiles real counts, the four honest-gates (users / capacity /
openAuditItems / sensitivityLabels), Fired-only alert filtering, and the Cosmos
endpoint-missing gate. tsc clean on all touched files.
