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
| 3 | built ✅ | tiers `manager → privacy → approver → access-provider` (`lib/types/access-request-workflow.ts`) |
| 4 | **BROKEN ❌** | `GET /api/access-requests?tier=<tier>&status=open`; the inbox tab strip filters per tier, but the query is scoped to the **signed-in user's own object id** while requests are written under the **requester's** — so a cross-user approver's inbox returns zero rows. See [the defect](#known-defect-cross-user-approval-does-not-work) below. |
| 5 | **BROKEN ❌** | `POST /api/access-requests/[id]/decision` advances `tier` in Cosmos — but reads the doc with the approver's object id as the partition key, so a cross-user decision 404s before any approver logic runs. Same root cause as #4. |
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
| Submit request | Cosmos `access-request-workflow` (PK `/tenantId`) + `audit-log` + `notifications` |
| Inbox per tier | Cosmos query filtered by `tier` + `status` |
| Approve / deny | Cosmos read-modify-replace state machine |
| Final RBAC grant (adls-container) | ARM `PUT .../roleAssignments` via `grantContainerRole` (Storage Blob Data Reader/Contributor/Owner) |
| Final RBAC grant (warehouse) | Synapse Dedicated SQL `CREATE USER … FROM EXTERNAL PROVIDER` + `ALTER ROLE` |
| Final RBAC grant (kql-database) | ADX `.add database <role>` management command |
| Audit trail | Cosmos `audit-log` |

Bicep: `storage-rbac-admin.bicep` grants the Console UAMI a **constrained**
RBAC-Administrator (ABAC condition limits it to the three Storage Blob Data
roles only — no self-escalation), wired in `landing-zone/main.bicep`.

## Known defect — cross-user approval does not work

**Re-measured 2026-08-08 against `e73d976c`.** Rows 4 and 5 above were previously
recorded as built ✅. They are not, and this doc asserted a parity Loom does not
currently have.

Three routes disagree about what the `access-request-workflow` partition key
holds:

| Route | Value written / read |
|---|---|
| `POST /api/catalog/request-access` (line 141) | writes `tenantId: s.claims.oid` — the **requester's** object id |
| `POST /api/access-packages/[id]/request` (line 98) | writes `tenantId: requesterId` — the **requester's** object id |
| `GET /api/access-requests` (line 39) | queries `c.tenantId = s.claims.oid` — the **approver's** object id |
| `POST /api/access-requests/[id]/decision` (lines 65, 72) | reads `c.item(id, s.claims.oid)` — the **approver's** object id |

`oid` is the Entra **user** object id, not the tenant id. Unless approver and
requester are the same identity, the inbox query matches zero rows and the
decision read returns 404.

The platform already ships the right helper: `tenantScopeId(session)` in
`lib/auth/session.ts` returns `claims.tid || claims.oid` and exists, per its own
doc comment, so that state written by one user "resolves for any grantee in the
same tenant". It is adopted by 84 API route files; these four are not among them.
The fix is to adopt it consistently here, plus a one-time repartition sequenced
with `POST /api/access-governance/backfill`.

CI does not catch this because the decision-route unit test builds its fixture
with the document's `tenantId` equal to the approver session's `oid` — modelling
the code's assumption rather than what the creating routes write.

**Status: INFERRED from code, not reproduced on the estate.**

## Related

- [Access requests — the multi-tier approval inbox](../governance/access-requests.md)
  — the user-facing guide for this surface.
