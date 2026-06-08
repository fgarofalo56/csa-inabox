# access-requests — parity with the data-asset access-request / approval workflow

Source UI:
- Microsoft Purview / Fabric **data-product "Request access"** + the data
  steward **request approval** experience
  (https://learn.microsoft.com/purview/how-to-request-access ,
  https://learn.microsoft.com/fabric/governance/data-product-request-access).
- Azure **access package approval** (Entra Identity Governance) multi-stage
  approval model (https://learn.microsoft.com/entra/id-governance/entitlement-management-access-package-approval-policy).

Loom builds the **multi-tier approval** model 1:1 on Azure-native backends
(Cosmos for the workflow + audit trail, Azure ARM RBAC for the final grant) —
**no Microsoft Fabric / Purview tenant required**.

## Source feature inventory (every capability)

| # | Capability (Purview/Fabric/Entra) | Notes |
|---|-----------------------------------|-------|
| 1 | Consumer requests access to a catalog data asset with a justification | from the asset detail surface |
| 2 | Request carries the requested permission (read / write / admin) | |
| 3 | Multi-stage approval (manager → reviewer → approver → provider) | Entra access-package multi-stage |
| 4 | Approver inbox filtered to the requests awaiting **their** stage | |
| 5 | Approve advances the request to the next stage | |
| 6 | Deny closes the request with a required reason | |
| 7 | Final approval **provisions the actual grant** on the backing store | real RBAC, not a record |
| 8 | Requester becomes a subscriber / is notified on completion | |
| 9 | Full audit trail of every decision | who / when / decision / reason |
| 10 | History of completed + denied requests with the receipt | role-assignment id / denial reason |
| 11 | Provider confirms / binds the concrete scope before granting | which container / db |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `POST /api/catalog/request-access` (Governance → Data catalog → Request access) creates the workflow doc |
| 2 | built ✅ | `permission` field persisted on the request |
| 3 | built ✅ | tiers `manager → privacy → approver → access-provider` (`lib/types/access-request.ts`) |
| 4 | built ✅ | `GET /api/access-requests?tier=<tier>&status=open`; inbox tab strip filters per tier |
| 5 | built ✅ | `POST /api/access-requests/[id]/decision` advances `tier` in Cosmos |
| 6 | built ✅ | deny → `status:denied` + required `denialReason` + `deniedAtTier` |
| 7 | built ✅ | final tier calls `enforceAccessGrant` → **real Azure RBAC role assignment** (ARM PUT) |
| 8 | built ✅ | `subscribedAt` set + success notification to the requester |
| 9 | built ✅ | one `audit-log` doc per decision (itemId = requestId) |
| 10 | built ✅ | inbox **History** tab (completed + denied) shows the ARM assignment id / denial reason |
| 11 | built ✅ | final-tier approve dialog: Scope type dropdown + backing container/db input |

Honest infra-gate ⚠️ (no-vaporware): if the final grant returns `pending`
(e.g. `LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` unset, or the Console UAMI lacks
the constrained **Role Based Access Control Administrator** grant from
`platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep`), the
request stays at the access-provider tier and the dialog surfaces a MessageBar
naming the exact thing to provision — never a false "completed".

## Backend per control

| Control | Backend |
|---------|---------|
| Submit request | Cosmos `access-requests` (PK `/tenantId`) + `audit-log` + `notifications` |
| Inbox per tier | Cosmos query filtered by `tier` + `status` |
| Approve / deny | Cosmos read-modify-replace state machine |
| Final RBAC grant (adls-container) | ARM `PUT .../roleAssignments` via `grantContainerRole` (Storage Blob Data Reader/Contributor/Owner) |
| Final RBAC grant (warehouse) | Synapse Dedicated SQL `CREATE USER … FROM EXTERNAL PROVIDER` + `ALTER ROLE` |
| Final RBAC grant (kql-database) | ADX `.add database <role>` management command |
| Audit trail | Cosmos `audit-log` |

Bicep: `storage-rbac-admin.bicep` grants the Console UAMI a **constrained**
RBAC-Administrator (ABAC condition limits it to the three Storage Blob Data
roles only — no self-escalation), wired in `landing-zone/main.bicep`.
