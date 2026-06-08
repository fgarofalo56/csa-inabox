# governance-policies — parity with Microsoft Purview DLP + access policies (F22 + access enforcement)

**Source UI:** Microsoft Purview portal → **Data Loss Prevention policies** and
**Data Policy / access policies**, plus the Azure data-plane access-grant
experience (Storage RBAC, SQL GRANT, ADX database roles). Grounded in Microsoft
Learn:
- https://learn.microsoft.com/purview/dlp-learn-about-dlp
- https://learn.microsoft.com/purview/concept-data-owner-policies
- https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access
- https://learn.microsoft.com/azure/data-explorer/manage-database-security-roles

**Loom surface:** `app/governance/policies/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`, access-policy wizard).

## No-Fabric / no-Purview reality

Policy definitions live in Cosmos `tenant-settings`; **Access**-kind policies
are enforced as **real Azure-native data-plane grants** — no Fabric, no Purview.
Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

## Inventory → Loom coverage → backend per control

| Purview / access-policy capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Policy inventory (name / type / scope / rule / status) | `LoomDataTable` — Name, Kind badge, Scope, Rule (+ enforcement badge), Enabled switch, Delete | `GET /api/governance/policies` → Cosmos `tenant-settings` (`policies:<tenantId>`) | ✅ BUILT |
| Create policy — DLP | "New policy" wizard, kind=DLP: Detect `Dropdown` (Email/SSN/Credit card/Phone/IP/Custom) + Action `Dropdown` (Audit/Block/Notify/Quarantine) | `POST /api/governance/policies` → Cosmos | ✅ BUILT |
| Create policy — Dynamic Data Masking | kind=Masking: Column + Masking-function `Dropdown` (Full/Partial/Email/Hash/Random) | `POST /api/governance/policies` → Cosmos | ✅ BUILT |
| Create policy — Row-Level Security | kind=RLS: Column + Operator `Dropdown` (=/!=/IN/LIKE) + Value | `POST /api/governance/policies` → Cosmos | ✅ BUILT |
| Create policy — Retention | kind=Retention: Keep-for + Unit `Dropdown` (Days/Months/Years) + Then `Dropdown` (Delete/Archive/Review) | `POST /api/governance/policies` → Cosmos | ✅ BUILT |
| Create policy — Access (real grant) | kind=Access: Entra principal search (User/Group), data-plane scope `Dropdown` (ADLS container / Warehouse / KQL database), Permission `Dropdown` (Read/Write/Admin) | `POST /api/governance/policies` → `access-policy-client.enforceAccessGrant()` | ✅ BUILT |
| → Access on ADLS container | container `Input` | Storage RBAC role assignment on the ADLS container | ✅ BUILT |
| → Access on Warehouse | (configured Synapse dedicated SQL pool) | Synapse SQL Entra DB user + `db_datareader/writer/owner` via TDS | ✅ BUILT |
| → Access on KQL database | KQL DB `Dropdown` (live items) | ADX `.add database` viewers/users/admins | ✅ BUILT |
| Entra principal picker | User/Group search box | `GET /api/admin/permissions/principals` → Microsoft Graph | ✅ BUILT |
| Scope selection (tenant / domain / workspace) | "Applies to" `Dropdown` + target `Dropdown` | `/api/workspaces`, `/api/admin/domains` (Cosmos) | ✅ BUILT |
| Enable / disable a policy | per-row `Switch` (revokes RBAC on disable for Access) | `PUT /api/governance/policies` → Cosmos (+ `revokeAccessGrant` for Access) | ✅ BUILT |
| Delete a policy (symmetric revoke) | per-row Delete | `DELETE /api/governance/policies?id=` → Cosmos + `revokeStructuredGrant()` | ✅ BUILT |
| Enforcement status surfacing | enforcement badge (enforced · role / pending / error) | `policy.enforcement` from the real grant result | ✅ BUILT |
| DLP policy tips + violations + trigger-scan | (extension to DLP read) | `dlp-graph-client` (Microsoft Graph / Purview DLP) + Cosmos cache | ⚠️ honest-gate (DLP read leg; definition + Cosmos cache work today, live-violation/trigger-scan gated on Purview DLP roles) |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate = the
DLP-tips/live-violation leg names the exact Purview DLP grant required; policy
definition + the Access-kind real RBAC enforcement work with no Purview. No MISSING rows.

## Grade

**A** — full policy CRUD with a dropdown/wizard (no freeform JSON) and **real**
Azure-native enforcement across three data planes (Storage RBAC, Synapse SQL,
ADX); symmetric revoke on disable/delete. DLP live-violation feed is the only
honest-gated leg.
