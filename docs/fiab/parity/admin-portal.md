# admin-portal — parity with the Microsoft Fabric Admin portal + Azure tenant admin surfaces

Source UI:
- Fabric Admin portal — https://learn.microsoft.com/fabric/admin/admin-center
- Microsoft Fabric domains — https://learn.microsoft.com/fabric/governance/domains
- Microsoft Purview business domains — https://learn.microsoft.com/purview/concept-business-domains
- Azure portal: subscription resources, Activity log, Entra users, role assignments

CSA Loom surface: `apps/fiab-console/app/admin/**` (11 tabs) behind the shared
`AdminShell` (`apps/fiab-console/lib/components/admin-shell.tsx`). BFF routes
under `apps/fiab-console/app/api/admin/**`. Every tab calls a real backend
(Cosmos / ARM / Microsoft Graph / Purview / GitHub releases) or renders an
honest Fluent `MessageBar intent="warning"` infra-gate per
`.claude/rules/no-vaporware.md` — the full surface still renders behind the gate.

Legend: ✅ built & wired to a real backend · ⚠️ honest infra-gate (full UI still
renders, MessageBar names the exact env var / role / resource) · ❌ missing.

---

## Per-tab intended function → coverage

### 1. Tenant settings — `/admin/tenant-settings`
**Intended:** Fabric Admin portal "Tenant settings" — per-area switches
(Power BI, Fabric, OneLake, Real-Time, AI, Mirroring, Git) that admins flip to
enable/disable features tenant-wide, with audit of every change.
**Coverage:** ✅ 15 categories / ~50 toggles, search, dirty-tracking, Ctrl+S,
discard. **Backend:** `GET/PUT /api/admin/tenant-settings` → Cosmos
`tenant-settings` container (one doc per tenant); every toggle delta writes a
`tenant-settings.toggle` row to the Cosmos `audit-log` container. Forward-compatible
default-merge on read.

### 2. Capacity & compute — `/admin/capacity`
**Intended:** Inventory of the Azure services Loom orchestrates (ACA, Databricks,
Synapse, ADF, Cosmos, ACR…) with provisioning state, like the Azure portal
resource-group blade.
**Coverage:** ✅ live inventory, filter, provider grouping, per-row Azure-portal
deep link. ⚠️ Cost + utilization gated (honest MessageBar — needs Cost
Management + Azure Monitor; deliberately not faked). **Backend:**
`GET /api/admin/azure-resources` → ARM
`GET /subscriptions/{sub}/resourceGroups/{rg}/resources?api-version=2024-03-01`
via `ChainedTokenCredential` (UAMI). 503 honest gate when `LOOM_SUBSCRIPTION_ID`
unset.

### 3. Scale by SKU — `/admin/scaling`
**Intended:** Change the SKU/scale of each scalable backing service from inside
Loom (Fabric/Power BI capacity, Synapse DWU, ADX, Databricks cluster+warehouse,
AI Search, APIM, Cosmos, Container Apps, Foundry).
**Coverage:** ✅ per-service cards with SKU pickers, cost preview, Apply.
⚠️ any service not configured surfaces an honest MessageBar with the precise
env var + bicep module. **Backend:** `POST /api/admin/scaling/{service}` →
real Azure REST PATCH per service.

### 4. Domains — `/admin/domains`
**Intended (the operator's question, answered):** A **domain** is a
governance-scoped, labeled grouping of data products and workspaces (Finance,
Operations, Mission-Ops). It carries **owners**, a description, and a color, and
is the unit Loom uses to organize the tenant's data estate — the same concept
Microsoft Purview calls a *business domain* and Fabric calls a *domain*.
"Add domain" creates that grouping in Loom's Cosmos store **immediately**;
workspaces tag themselves to it via their `domain` field (shown in the
Workspaces tab). When Microsoft Purview is provisioned, the same domain is
mirrored as a Purview business domain so policies + glossary terms flow with it.
**Coverage:** ✅ create (id+name+description+color+**owners**), list (with Owners
+ Governance columns), delete — all real Cosmos CRUD. ⚠️ Purview business-domain
mirror is honest-gated: `GET` returns a `purview` block that is either
`{configured:true, domains:[…]}` (matched domains badged "Governed") or
`{configured:false, gated:true, hint}` naming `LOOM_PURVIEW_ACCOUNT` + the bicep
module + the data-plane role grant. **Backend:** `GET/POST/DELETE
/api/admin/domains` → Cosmos `tenant-settings` container doc `domains:<tenantId>`;
Purview status via `listBusinessDomains()` (`lib/azure/purview-client`).

### 5. Security & governance — `/admin/security`
**Intended:** Tenant security posture + inline Purview / Information Protection /
DLP management so users never leave Loom for compliance.microsoft.com.
**Coverage:** ✅ Overview KPIs (sensitivity, classification coverage, audit),
Purview / MIP / DLP / Audit tabs. ⚠️ Purview-backed panels honest-gate when
`LOOM_PURVIEW_ACCOUNT` unset; MIP/DLP gate on Microsoft Graph AppRoles.
**Backend:** `/api/admin/security/{purview,mip,dlp}/*` → Purview data plane +
Microsoft Graph; `/api/governance/*` for overview rollups.

### 6. Feature permissions — `/admin/permissions`
**Intended:** Fabric-style RBAC — grant Reader/Contributor/Admin on every editor
type, admin page, and workload to Entra users/groups.
**Coverage:** ✅ capability tree (Domain → Workload → Capability), grant list,
add/remove grant dialog. ⚠️ MessageBar remediation when caller lacks
`admin.permissions` (names `LOOM_TENANT_ADMIN_GROUP_ID` / `LOOM_TENANT_ADMIN_OID`).
**Backend:** `/api/admin/permissions/{capabilities,grants,principals}` →
Cosmos `feature-permissions` container, gated by `enforceCapability`.

### 7. Audit logs — `/admin/audit-logs`
**Intended:** M365-style audit log of every Fabric/Loom operation, filterable +
exportable.
**Coverage:** ✅ free-text + event-kind + time-range filters, distinct-kind
dropdown, CSV export. **Backend:** `GET /api/admin/audit-logs` → Cosmos
`audit-log` container (tenant-scoped, ordered by `at DESC`, `top` clamped 1–1000).

### 8. Usage metrics — `/admin/usage`
**Intended:** Fabric feature-usage & adoption report — items per type/workspace,
activity over time, most-active items.
**Coverage:** ✅ stat cards, items-by-type + items-by-workspace bars, 30-day
activity sparkline, top-10 items table with deep links. **Backend:**
`GET /api/admin/usage` → aggregates Cosmos `workspaces` + `items` + `audit-log`.

### 9. Users & licenses — `/admin/users`
**Intended:** Power BI / Fabric license assignments + user inventory.
**Coverage:** ✅ user list derived from Cosmos (workspace owners + item creators +
workspace-permissions), roles, workspace/item counts, last activity, Entra deep
link, search. ⚠️ display name + department enrichment honest-gated:
MessageBar names `LOOM_GRAPH_USERS_ENABLED` + Graph `Directory.Read.All`; the
page works fully without Graph. **Backend:** `GET /api/admin/users` → Cosmos
derivation + optional Microsoft Graph `GET /users` merge by UPN.

### 10. Workspaces — `/admin/workspaces`
**Intended:** Tenant-wide workspace inventory: every workspace, owner, capacity,
domain, state, item count, last activity, regardless of owner.
**Coverage:** ✅ full table + search + per-row Open link; live item counts.
**Backend:** `GET /api/admin/workspaces` → Cosmos `workspaces` (tenant-scoped) +
per-workspace `items` count/`MAX(updatedAt)`.

### 11. Updates & version sync — `/admin/updates`
**Intended:** Show running build vs latest upstream, release notes, deploy link.
**Coverage:** ✅ current vs latest badges, markdown release-notes renderer,
recent releases list, links to the GitHub release + Actions deploy workflow.
**Backend:** `GET /api/version` → GitHub `GET /repos/{owner}/{repo}/releases`
(optional `LOOM_FEEDBACK_GITHUB_TOKEN` for rate limit).

---

## Backend per control (summary)

| Tab | Route(s) | Backend |
|-----|----------|---------|
| tenant-settings | `GET/PUT /api/admin/tenant-settings` | Cosmos `tenant-settings` + `audit-log` |
| capacity | `GET /api/admin/azure-resources` | ARM resources REST (UAMI) |
| scaling | `POST /api/admin/scaling/*` | per-service Azure REST PATCH |
| domains | `GET/POST/DELETE /api/admin/domains` | Cosmos `tenant-settings` doc + Purview `listBusinessDomains` (gated) |
| security | `/api/admin/security/{purview,mip,dlp}/*` | Purview data plane + Microsoft Graph (gated) |
| permissions | `/api/admin/permissions/*` | Cosmos `feature-permissions` (capability-gated) |
| audit-logs | `GET /api/admin/audit-logs` | Cosmos `audit-log` |
| usage | `GET /api/admin/usage` | Cosmos `workspaces`+`items`+`audit-log` |
| users | `GET /api/admin/users` | Cosmos derivation + Graph `/users` (gated) |
| workspaces | `GET /api/admin/workspaces` | Cosmos `workspaces`+`items` |
| updates | `GET /api/version` | GitHub releases API |

---

## Verification

- **Backend contract tests:** `apps/fiab-console/app/api/admin/__tests__/admin-routes.test.ts`
  — 22 tests covering domains (list+Purview gate, create+owners, dup 409, delete 404),
  users (Cosmos derivation, Graph-disabled), workspaces (item counts), audit-logs
  (filters + top clamp), usage (aggregation), azure-resources (401 / 503 gate / ARM
  call + provider grouping), permissions/grants (capability gate, validation, stable-id
  upsert). All green.
- **Build:** `pnpm build` clean (only the pre-existing `@protobufjs/inquire`
  dependency warning, unrelated to admin).
- **Honest gates verified:** every gate names a concrete env var / role / bicep
  module; the full surface renders behind each gate (no blank tabs, no dead buttons).

## Grade

**A** — every tab functional against a real backend or an honest infra-gate
(zero ❌, zero stub banners), backend contract tests green. Path to **A+**:
add Cost Management + Azure Monitor for capacity cost/utilization, and a
"promote domain to Purview" write action once the Purview bicep module lands.
