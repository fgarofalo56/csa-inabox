# PRP — Access Governance: entitlement-management breadth for CSA Loom

**Status:** DRAFT (design, 2026-07-20). Author: access-audit agent.
**Origin:** the 2026-06→07 ask audit (`temp/ask-audit-2026-07-20.md`) found "user
access requests + management" delivered as a real *request→approve→grant* spine but
**missing the entitlement-management breadth** the operator asked for. This PRP specs
that breadth as an Azure-native, day-one-ON program benchmarked against **Microsoft
Entra ID Governance** and **Palantir Foundry's access model**.

**Die-hard rules that bind every item here:** `no-vaporware.md` (real backend + bicep
sync + E2E receipt per merge), `loom-no-freeform-config` (wizards/pickers, no raw JSON),
`loom-default-on-opt-out` (features ON by default; the only gate is an honest Azure infra
gate with an inline **Fix it** wizard, registered in the gate registry), `ux-baseline.md`
(Fabric-grade floor), `no-fabric-dependency.md` (Azure-native default; Entra/Graph is
Azure, not Fabric — allowed).

---

## (a) Current state — what is ALREADY built (verified in code)

Loom already has a genuinely-wired request-and-grant spine across three entry points,
all persisting to Cosmos and provisioning **real** Azure RBAC / data-plane grants. This
PRP builds ON it — it does not replace it.

| Subsystem | Key files (verified) | Backend | State |
|---|---|---|---|
| **Sign-in onboarding queue** (pre-auth "Request access") | `apps/fiab-console/lib/components/access/request-access-button.tsx`, `app/api/access-requests/public/route.ts`, `app/admin/access-requests/page.tsx`, `app/api/admin/access-requests/[id]/route.ts`, `lib/access/signin-access-request.ts`, `lib/types/signin-access-request.ts` | Cosmos `signin-access-requests`; approve/deny → `audit-log`; returns Entra-group onboarding instruction (does not mutate tenant groups) | Real |
| **F16 multi-tier approval workflow** (governed catalog-asset access) | `app/governance/access-requests/page.tsx`, `lib/editors/access-request-inbox.tsx`, `app/api/catalog/request-access/route.ts`, `app/api/access-requests/route.ts`, `app/api/access-requests/[id]/decision/route.ts`, `lib/types/access-request-workflow.ts` | Cosmos `access-request-workflow` (PK `/tenantId`=requester oid); tiers manager→privacy→approver→access-provider; final tier calls **`enforceAccessGrant`** | Real |
| **F15 data-product access requests** (marketplace subscribe→access) | `app/api/data-products/[id]/access-requests/route.ts`, `app/api/data-products/my-access-requests/route.ts`, `lib/types/access-request.ts`, `lib/editors/components/request-access-dialog.tsx`, `lib/components/marketplace/my-access.tsx` | Cosmos `access-requests` (PK `/dataProductId`); owner approve → zero-touch fulfillment per output-port target | Real |
| **Workspace ACL "Manage access" (F5)** | `lib/panes/manage-access-pane.tsx`, `app/api/workspaces/[id]/role-assignments/route.ts`, `app/api/workspaces/[id]/role-assignments/[principalId]/route.ts`, `lib/azure/workspace-roles-client.ts` | Cosmos `workspace-roles` **mirrored to real Azure RBAC** on the DLZ RG | Real |
| **Enforcement engine (shared primitive)** | `lib/azure/access-policy-client.ts::enforceAccessGrant()` (+ `lib/azure/rbac-client.ts` variant used by the F16 decision route); `revokeAccessGrant` / `revokeStructuredGrant` | ADLS→Storage RBAC; warehouse→Synapse `sp_addrolemember`; kql-database→ADX `.add database` role; item/workspace→Loom workspace-role | Real |

**Fixed alongside this PRP (branch `fix/access-requests-status`):** `my-access-requests`
previously hard-coded `status:'pending'`; it now reads the authoritative F16 + F15 docs
and reflects the true lifecycle. That bug is the smallest instance of the systemic gap
this PRP closes: **status/entitlement truth is scattered and read-only-projected, never
managed as a lifecycle.**

### Gaps this PRP closes (from the audit)
Access packages · access reviews / recertification · time-bound / JIT / PIM ·
Entra group sync · separation-of-duties + configurable approvers · unified
who-has-access report · request-on-item from any 403 · bulk operations & leaver
lifecycle.

---

## (b) Target feature set — benchmarked against Entra ID Governance + Foundry

Each capability lists its **Entra ID Governance** and **Foundry** analog so parity is
concrete, not aspirational.

1. **Access packages (entitlement bundles)** — *Entra: Entitlement Management access
   packages; Foundry: role/permission sets on resources.* A publishable, requestable
   bundle grouping N resources (workspaces, items, data-products) + the role each grant
   confers + the policy that governs who may request, approval flow, and lifetime. A
   consumer requests the *package*, not each resource. AG-1/AG-2.

2. **Access reviews / recertification** — *Entra: Access Reviews; Foundry: periodic
   attestation.* Scheduled campaigns (per package / per resource / per group) that ask
   reviewers to attest or revoke each assignment, with **bulk approve/deny**, reviewer
   delegation, and **auto-revoke on no-response** or on reviewer denial. AG-6/AG-7.

3. **Time-bound / JIT / PIM grants** — *Entra: PIM eligible-vs-active + activation with
   justification; Foundry: time-boxed access.* Every grant may carry `expiresAt`; a sweep
   job auto-revokes on expiry. Eligible assignments require **activation** (justification
   + optional approval) to become active for a bounded window. AG-4/AG-5.

4. **Entra group sync** — *Entra: group-based assignment + dynamic groups.* An access
   package or resource role may target an **Entra security group**; membership changes in
   Entra flow through to Loom grants (add→grant, remove→revoke) on a reconcile cadence.
   Group-derived assignments are surfaced distinctly from direct ones. AG-8/AG-9.

5. **Configurable approver chains + separation-of-duties** — *Entra: multi-stage approval
   + incompatible access packages; Foundry: policy-based approval.* The fixed F16
   `TIER_SEQUENCE` becomes a **per-package/per-resource policy**: ordered stages, each
   with named approvers (user/group/role/owner), escalation timeout + reminders, and
   **SoD rules** that block a request whose grant would combine incompatible entitlements.
   AG-3/AG-10.

6. **Unified who-has-access report** — *Entra: access reviews + audit; Foundry: access
   graph.* A first-class read model answering both **"what does principal X have?"** and
   **"who has access to resource Y, via what (direct / package / group), granted when, by
   whom, expiring when?"** — with export. Backed by an **entitlement ledger** (below), not
   by scraping `audit-log`. AG-11/AG-12.

7. **Request-on-item from any 403** — *Entra: "request access" deep links; Foundry: request
   from the object.* Any surface that returns a 403 / honest access-gate renders an inline
   **Request access** control that opens the right request flow pre-scoped to that
   resource + the package(s) that would grant it. AG-13.

8. **Bulk ops & leaver/joiner/mover lifecycle** — *Entra: lifecycle workflows.* Bulk
   approve/deny in inboxes and reviews; on-leaver **revoke-all** for a principal; grant
   on-behalf-of. AG-14.

---

## (c) Azure-native backend mapping

**New / reused Cosmos containers** (created via `cosmos-client` `createIfNotExists`, per
`no-vaporware` §"New Cosmos container"):

| Container | PK | Holds |
|---|---|---|
| `access-packages` *(new)* | `/tenantId` | Package definitions: resources[], role-per-resource, request policy, approval-policy id, lifetime/expiry defaults, SoD tags, visibility |
| `access-assignments` *(new — the entitlement ledger)* | `/principalId` | One row per effective grant: principal, resource, scopeType/scopeRef, role, source (`direct`/`package:<id>`/`group:<id>`), `grantedAt`, `grantedBy`, `expiresAt?`, `roleAssignmentId`, state (`eligible`/`active`/`expired`/`revoked`) |
| `approval-policies` *(new)* | `/tenantId` | Ordered stages, approver bindings, escalation timeouts, SoD incompatibility sets |
| `access-reviews` *(new)* | `/tenantId` | Review campaigns: scope, reviewers, cadence, decisions[], status, auto-revoke rule |
| `access-request-workflow` *(reuse)* | `/tenantId` | Extended: `approvalPolicyId`, `packageId?`, `expiresAt?`, `stageIndex` replacing the hard-coded tier |
| `access-requests` *(reuse)* | `/dataProductId` | F15 unchanged; assignments now also written to the ledger on completion |
| `workspace-roles` / `signin-access-requests` *(reuse)* | — | Unchanged; assignments mirrored into the ledger for the unified report |

**Enforcement:** reuse **`enforceAccessGrant` / `revokeAccessGrant`** (`lib/azure/access-policy-client.ts`, `lib/azure/rbac-client.ts`) unchanged — every new path funnels grants/revokes through it, and every success writes an `access-assignments` ledger row. No new grant primitive.

**Microsoft Graph (Entra) — new app permissions on the Console UAMI** (honest infra gate,
Fix-it wizard names each; provisioned in bicep + granted by the post-deploy bootstrap):

| Feature | Graph scope(s) | Notes |
|---|---|---|
| Group sync / group-targeted packages | `Group.Read.All`, `GroupMember.Read.All`, `User.Read.All` | Read membership; reconcile → grant/revoke via `enforceAccessGrant` |
| Optional real-Entra access-package mirror (opt-in) | `EntitlementManagement.ReadWrite.All` | Only if the operator opts to mirror to native Entra EM; Loom-native is the default |
| Approver/principal resolution | `Directory.Read.All` | Resolve approver groups/roles to members |

Absent these grants, the feature runs **Loom-native** (Cosmos-backed packages/assignments)
and only the *group-sync* and *native-Entra-mirror* paths show an honest gate — everything
else is day-one-ON. This honors `no-fabric-dependency` (Entra/Graph is Azure) and
`no-vaporware` (the gate names the exact grant + links the bicep module).

**Scheduler (expiry + review sweeps):** a new **timer-triggered Azure Function**
`azure-functions/access-governance-sweeper` (Linux consumption Y1, in-VNet, Console-UAMI
auth) running on a cron: (1) revoke assignments past `expiresAt` via `revokeAccessGrant` +
mark ledger `expired`; (2) open/close scheduled `access-reviews`; (3) reconcile Entra
group membership deltas. Bicep: add the Function + its role assignments to
`platform/fiab/bicep/modules/**`; wire env into `admin-plane/main.bicep`; register on the
Admin gate page. (Pattern per the existing read-warmer / self-heal timer jobs.)

**Admin surface:** extend `app/admin/access-requests/` into an **Access Governance** admin
area (packages, policies, reviews, the who-has-access report), each a Fluent v9 + Loom-token
wizard/table per `loom-no-freeform-config` + `web3-ui` + `ux-baseline`.

---

## (d) Wave plan (day-one-ON; each wave ships with real backend + E2E receipt)

**W1 — Entitlement ledger + unified who-has-access (foundation).**
- [ ] AG-11 `access-assignments` ledger container + write-through: every existing grant
      path (F15 PATCH, F16 decision final tier, workspace role add, self-serve) writes a
      ledger row on success; every revoke marks it `revoked`. Backfill job for existing grants.
- [ ] AG-12 Who-has-access report: `/admin/access-governance/report` + `/api/access-governance/report`
      answering per-principal AND per-resource, with source attribution + export. Real
      Cosmos reads. (No feature flag — ON.)
- [ ] AG-15 `my-access` + item **Access** panels read the ledger (consistent truth
      everywhere; supersedes the audit-log projection fixed in `fix/access-requests-status`).

**W2 — Access packages + configurable approval policy + SoD.**
- [ ] AG-1 `access-packages` container + package builder wizard (pick resources → role each
      → request policy → lifetime). Publish to catalog/marketplace as requestable.
- [ ] AG-2 Request-a-package flow → opens an `access-request-workflow` doc carrying
      `packageId` + `approvalPolicyId`; fan-out grants on completion.
- [ ] AG-3 `approval-policies` container + policy builder (ordered stages, approver
      bindings, escalation). F16 decision route reads `stageIndex`/policy instead of the
      hard-coded `TIER_SEQUENCE` (kept as the default policy for back-compat).
- [ ] AG-10 SoD incompatibility sets enforced at request time (block + explain).

**W3 — Time-bound / JIT / PIM + expiry sweeper.**
- [ ] AG-4 `expiresAt` on assignments + package default lifetime; request UI offers a
      duration picker.
- [ ] AG-5 Eligible-vs-active: eligible assignments require **activation** (justification
      + optional approval) for a bounded window; ledger state machine.
- [ ] AG-16 `access-governance-sweeper` Function: expiry auto-revoke + notifications;
      bicep + gate-registry entry + Admin gate page.

**W4 — Access reviews + Entra group sync + request-on-item + bulk/leaver.**
- [ ] AG-6 `access-reviews` container + campaign builder (scope, reviewers, cadence).
- [ ] AG-7 Reviewer inbox with **bulk** attest/revoke + delegation + auto-revoke on
      no-response (sweeper closes campaigns).
- [ ] AG-8 Group-targeted packages/roles (Graph read).
- [ ] AG-9 Group reconcile in the sweeper (membership delta → grant/revoke).
- [ ] AG-13 Request-on-item: shared `RequestAccessInline` on every 403 / access-gate,
      pre-scoped to the resource + qualifying package(s).
- [ ] AG-14 Bulk approve/deny in inboxes; leaver **revoke-all**; request-on-behalf-of.

Each wave: real-data E2E receipt (endpoint hit + response + screenshot dark/light +
bicep diff), gate-registry + Admin-gate entries for any honest gate, parity doc row
update, `ux-standards §7` checklist green.

---

## (e) Explicit non-goals

- **Not replacing Entra ID as the IdP.** Loom does not mint identities or mutate tenant
  group membership as a default (the sign-in queue deliberately returns an onboarding
  instruction). The optional `EntitlementManagement.ReadWrite.All` mirror is opt-in only.
- **Not a new grant primitive.** All enforcement stays on `enforceAccessGrant` /
  `revokeAccessGrant`; this PRP adds lifecycle + ledger + policy *around* it.
- **Not conditional-access / sign-in risk / MFA policy** — that is Entra Conditional
  Access, out of scope.
- **Not cross-tenant B2B entitlement** in W1–W4 (single-tenant assignments first).
- **No raw-JSON policy editing** — every policy/package/review is a wizard or picker
  (`loom-no-freeform-config`).
- **No day-one gates** except the honest Graph-permission gate for group-sync / native-
  Entra-mirror, each with an inline Fix-it wizard and a gate-registry entry.

---

## Verification per merge (binding)
Real-data E2E receipt in the PR (endpoint + response first 300 chars + dark/light
screenshot or Playwright trace + bicep diff), gate-registry + Admin-gate-page entries for
any honest gate, and a `docs/fiab/parity/access-governance.md` row set showing zero ❌.
A wave is done only when every box is real-backend E2E'd with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET (Azure-native path).
