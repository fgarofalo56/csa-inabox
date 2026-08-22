# PRP — Access Governance: entitlement-management breadth for CSA Loom

**Status:** BUILT / SHIPPED (W1–W4 landed on `main`; header corrected 2026-07-27 from a
stale "DRAFT" by the loom-apex A7 truth reconcile). Author: access-audit agent.
**Verification (2026-07-24 all-PRPs audit, `PRPs/active/loom-apex/research/prps-audit.md:148-155`)** —
every wave's code exists on `main` and was re-confirmed on disk 2026-07-27:
- **Ledger + report (W1):** `apps/fiab-console/lib/access/{assignment-ledger,access-report}.ts` +
  `app/api/access-governance/{assignments,backfill,report}/`.
- **Packages + approval policy (W2):** `lib/access/approval-policy.ts` (+ test), Cosmos containers
  `access-assignments` / `access-packages` (`lib/azure/cosmos-client.ts:1048-1049,1656-1657`).
- **Expiry / JIT sweeper (W3):** `lib/access/expiry.ts` + `azure-functions/access-governance-sweeper/`
  (timer Function: `function_app.py`, `deploy/`) + `app/api/access-governance/sweep/`.
- **Reviews + group sync + leaver + inline request (W4):** `lib/access/{access-reviews,close-campaign,revoke-assignment,group-sync,leaver}.ts`
  (+ `lib/access/__tests__/`), `app/admin/access-reviews/page.tsx`,
  `app/api/access-governance/{reviews,group-sync,revoke-all}/`,
  `lib/components/access/request-access-inline.tsx`.
Residuals (NOT blocking this status): the N19c **signed-evidence record** on campaign close
(scheduled as loom-apex **B-N19c′**, `PRPs/active/loom-apex/PRP.md:93`), the
`docs/fiab/parity/access-governance.md` zero-❌ confirmation, and the Graph-permission gate verify
(prps-audit.md:154-155).
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

> **2026-07-27 note (A7 truth reconcile):** W1–W4 below SHIPPED on `main` — see the
> Status verification block at the top for the per-wave code evidence
> (`PRPs/active/loom-apex/research/prps-audit.md:148-155`). The checkboxes were never
> ticked when the work landed; they are kept as the original spec. Open residuals are
> only the three named in the Status block (B-N19c′ signed evidence, parity-doc
> confirmation, Graph-permission gate verify).

> **2026-08-06 checkbox hygiene (measured, not asserted).** Every box below was
> re-verified against the tree — grep for the named container/route/component AND
> its call site, because "the module exists" is not evidence in this repo. Boxes
> are now ticked ONLY where the flow is real end-to-end; PARTIAL and NOT-BUILT
> rows carry what is missing and where it was searched for. **Three findings are
> CODE defects, not doc drift, and are called out under "Measured residuals"
> below** — do not tick them.

**W1 — Entitlement ledger + unified who-has-access (foundation).**
- [x] AG-11 `access-assignments` ledger container + write-through: every existing grant
      path (F15 PATCH, F16 decision final tier, workspace role add, self-serve) writes a
      ledger row on success; every revoke marks it `revoked`. Backfill job for existing grants.
      — **SHIPPED.** Container `lib/azure/cosmos-client.ts:1061` (`/principalId`). All four
      writers real: `app/api/workspaces/[id]/role-assignments/route.ts:36,128`,
      `app/api/data-products/[id]/access-requests/route.ts:32,212` (F15 PATCH),
      `app/api/access-requests/[id]/decision/route.ts:38,131,177` (F16 final tier),
      `lib/marketplace/subscribe.ts:20,58`. Revoke marks it:
      `app/api/workspaces/[id]/role-assignments/[principalId]/route.ts:17,43`,
      `lib/access/revoke-assignment.ts:17,50`. Backfill:
      `app/api/access-governance/backfill/route.ts` (idempotent, all three sources).
- [x] AG-12 Who-has-access report: `/admin/access-governance/report` + `/api/access-governance/report`
      answering per-principal AND per-resource, with source attribution + export. Real
      Cosmos reads. (No feature flag — ON.)
      — **SHIPPED, at a different route than spec'd.** `app/api/access-governance/report/route.ts:22-29`
      merges the ledger + workspace roles + `getGroupTransitiveMembers`; modes at `:5-9`;
      CSV export `lib/access/access-report.ts:119`. UI `lib/components/admin/access-report-panel.tsx`
      mounted by `access-governance-tabs.tsx:37,145`. **Path drift:** the surface is
      `/admin/access-governance?tab=report` after an IA consolidation, with
      `app/admin/access-report/page.tsx` as a redirect stub — the spec'd
      `/admin/access-governance/report` page does not exist.
- [ ] AG-15 `my-access` + item **Access** panels read the ledger (consistent truth
      everywhere; supersedes the audit-log projection fixed in `fix/access-requests-status`).
      — **NOT BUILT.** `app/api/data-products/my-access-requests/route.ts:27-30` still reads
      `accessRequestWorkflowContainer` + `accessRequestsContainer` directly, with no ledger
      import; `lib/components/marketplace/my-access.tsx` calls only
      `/api/marketplace/subscriptions` + `/api/data-products/my-access-requests`;
      `lib/panes/manage-access-pane.tsx:163` and `lib/panes/workspace-access.tsx:21-23`
      read `/api/workspaces/{id}/role-assignments` only. Searched `accessAssignmentsContainer`,
      `assignment-ledger`, `/api/access-governance/report` across `lib/panes`,
      `lib/components/marketplace`, `app/api/data-products` — the admin report panel is the
      only ledger consumer. **The ledger is the single source of truth for admins and not
      for users, which is the exact inconsistency this item exists to remove.**

**W2 — Access packages + configurable approval policy + SoD.**
- [ ] AG-1 `access-packages` container + package builder wizard (pick resources → role each
      → request policy → lifetime). Publish to catalog/marketplace as requestable.
      — **PARTIAL.** Built: container `cosmos-client.ts:1062`; CRUD `app/api/access-packages/route.ts`
      + `[id]/route.ts`; full no-freeform wizard (resources → role → policy → lifetime → SoD)
      `lib/components/admin/access-packages-panel.tsx:218-290`, mounted at
      `access-governance-tabs.tsx:38,178`. **Missing: the publish-to-catalog/marketplace half** —
      searched `requestable` and `accessPackagesContainer` across `app/api/catalog/**`,
      `app/api/marketplace/**`, `lib/components/marketplace/**`: zero hits. Packages are an
      admin-only surface.
- [ ] AG-2 Request-a-package flow → opens an `access-request-workflow` doc carrying
      `packageId` + `approvalPolicyId`; fan-out grants on completion.
      — **PARTIAL — backend complete, no user-reachable surface.**
      `app/api/access-packages/[id]/request/route.ts:88-135` resolves the policy and writes one
      `AccessRequestDoc` per grant with `packageId`/`packageName`/`approvalPolicyId`/`approvalPlan`
      (fan-out `:94-133`). Its **only** client is `lib/components/access/request-access-inline.tsx:79`,
      which has zero importers (AG-13) — so today no non-admin can request a package.
- [ ] AG-3 `approval-policies` container + policy builder (ordered stages, approver
      bindings, escalation). F16 decision route reads `stageIndex`/policy instead of the
      hard-coded `TIER_SEQUENCE` (kept as the default policy for back-compat).
      — **PARTIAL.** Built: container `cosmos-client.ts:1063`; `app/api/approval-policies/route.ts`
      + `[id]/route.ts`; builder `access-packages-panel.tsx:318 PolicyDialog` (stages + approver
      bindings `:363-367`); the decision route does read the plan —
      `app/api/access-requests/[id]/decision/route.ts:39,117` `nextStage(...)` over
      `effectiveStages(doc.approvalPlan)`. **Missing:** (a) **escalation timeout + reminders** —
      grep `escalat|reminder|timeout` in `lib/types/approval-policy.ts`, `lib/access/approval-policy.ts`
      and the policies route returns nothing, though both this checkbox and §line 93 name it;
      (b) **direct catalog requests never get a plan** — `app/api/catalog/request-access/route.ts`
      has no `resolveApprovalPlan`/`approvalPlan`, so a `default`- or `resource-type`-scoped
      policy is silently ignored outside the package path.
- [x] AG-10 SoD incompatibility sets enforced at request time (block + explain).
      — **SHIPPED.** `lib/access/approval-policy.ts:96 effectiveConflicts` (bidirectional) +
      `:105 evaluateSod`; enforced at `app/api/access-packages/[id]/request/route.ts:78-84`
      (`block` → refusal carrying a `detail:` explanation; `warn` surfaces at `:131`).
      Authoring: `sodConflictsWith`/`sodMode` in `access-packages-panel.tsx:233`, persisted
      `app/api/access-packages/route.ts:37-55`.

**W3 — Time-bound / JIT / PIM + expiry sweeper.**
- [ ] AG-4 `expiresAt` on assignments + package default lifetime; request UI offers a
      duration picker.
      — **PARTIAL.** Built: `lib/types/access-assignment.ts` `expiresAt`; `lib/access/expiry.ts:12
      computeExpiry` applied at grant (`decision/route.ts:174`); package default
      `lib/types/access-package.ts:39` + admin field `access-packages-panel.tsx:277`, snapshotted
      onto the request at `access-packages/[id]/request/route.ts:117`. **Missing: the requester-side
      duration picker** — grep `defaultLifetimeDays|grantLifetimeDays|duration` across all `.tsx`
      finds only the admin builder and a read-only badge in the unmounted
      `request-access-inline.tsx:121`. Lifetime is admin-fixed per package, never chosen at
      request time.
- [ ] AG-5 Eligible-vs-active: eligible assignments require **activation** (justification
      + optional approval) for a bounded window; ledger state machine.
      — **PARTIAL.** Built: states `lib/types/access-assignment.ts:37`
      (`active/eligible/expired/revoked/paused`); `lib/access/assignment-ledger.ts:82 activateAssignment`,
      `:103 expireAssignment`; `eligible` issued at final approval (`decision/route.ts:127-147`);
      activation performs the **real** grant with a bounded `expiresAt` (default 8h) at
      `app/api/access-governance/assignments/[id]/activate/route.ts:23,46-60`; Activate button
      `access-report-panel.tsx:133`. **Missing: justification + optional approval** — the activate
      route ignores its body (`_req` at `:25`), so activation is unjustified and unapprovable.
- [ ] AG-16 `access-governance-sweeper` Function: expiry auto-revoke + notifications;
      bicep + gate-registry entry + Admin gate page.
      — **PARTIAL, and the deploy half is a `no-vaporware.md` §Bicep-sync violation — see
      "Measured residuals" below.** Built: `azure-functions/access-governance-sweeper/function_app.py:75,95,105`
      (three timers) driving `app/api/access-governance/sweep/route.ts`, which does a real revoke
      at `:65-75`. **Missing:** notifications (no notifications container in the sweep route);
      **platform bicep wiring** (`grep -rn "LOOM_SWEEPER_TOKEN|access-governance-sweeper" platform/ scripts/ .github/`
      → **zero hits**; the only bicep is the standalone
      `azure-functions/access-governance-sweeper/deploy/main.bicep`); and a **gate-registry entry**
      (`grep sweeper apps/fiab-console/lib/gates/registry/*.ts` → nothing), so it cannot appear on
      `/admin/gates`.

**W4 — Access reviews + Entra group sync + request-on-item + bulk/leaver.**
- [x] AG-6 `access-reviews` container + campaign builder (scope, reviewers, cadence).
      — **SHIPPED.** Container `cosmos-client.ts:1068`; `app/api/access-governance/reviews/route.ts`
      snapshots in-scope ledger grants into review items; builder
      `lib/components/admin/access-reviews-panel.tsx:189-292` — scope kinds
      all/package/resource/principal/group (`:247-271`), `IdentityPicker` reviewers (`:274`),
      cadence (`:292`); mounted `access-governance-tabs.tsx:39,212`.
- [x] AG-7 Reviewer inbox with **bulk** attest/revoke + delegation + auto-revoke on
      no-response (sweeper closes campaigns).
      — **SHIPPED.** Bulk: `reviews/[id]/decision/route.ts:5-7` (`itemIds[]` / `all:true`) + UI
      `access-reviews-panel.tsx:332-338,393`. Delegation: `reviews/[id]/route.ts` PATCH
      `action:'delegate'` + UI `:365`. Auto-revoke on close: `lib/access/close-campaign.ts:37-60`
      (real `revokeAssignment` per undecided item), called by `reviews/[id]/route.ts` and
      `reviews/sweep/route.ts`; timer `function_app.py:95`.
- [x] AG-8 Group-targeted packages/roles (Graph read).
      — **SHIPPED**, behind the honest gate this PRP sanctions.
      `lib/types/access-package.ts:53 groupTargets`; live Graph read
      `app/api/access-governance/group-sync/route.ts:25 getGroupTransitiveMembers`; gate
      `:40 groupSyncEnabled()` registered as `graph-group-sync` in
      `lib/admin/env-checks/enrichment.ts:21` and `lib/gates/registry/enrichment.ts:15-25`
      (carries a Fix-it + surfaces, so G2-compliant).
- [x] AG-9 Group reconcile in the sweeper (membership delta → grant/revoke).
      — **SHIPPED.** Pure delta `lib/access/group-sync.ts:38 diffGroupMembership`, driven for real
      at `group-sync/route.ts:26-29,125` (`enforceAccessGrant` + `recordAssignment` on join,
      `revokeAssignment` on leave); scheduled `function_app.py:105 group_sync_timer`; manual
      trigger `access-reviews-panel.tsx:488`.
- [ ] AG-13 Request-on-item: shared `RequestAccessInline` on every 403 / access-gate,
      pre-scoped to the resource + qualifying package(s).
      — **NOT BUILT — the component exists with ZERO importers.**
      `lib/components/access/request-access-inline.tsx:42,64,79` is real, but
      `grep -rn "RequestAccessInline" apps/` matches only that file, and no import of
      `request-access-inline` exists anywhere in `apps/fiab-console`. No 403 surface, access gate,
      or item pane renders it. **This is the "correct module, zero production caller" pattern —
      see "Measured residuals".**
- [ ] AG-14 Bulk approve/deny in inboxes; leaver **revoke-all**; request-on-behalf-of.
      — **PARTIAL.** Leaver revoke-all **SHIPPED**: `app/api/access-governance/revoke-all/route.ts:19-20`
      (`selectRevocable` + real `revokeAssignment`) + UI `access-reviews-panel.tsx:501-504`; bulk in
      the **review** inbox is shipped under AG-7. **Missing:** bulk approve/deny in the **F16 request**
      inbox — the route exists (`app/api/access-requests/bulk-decision/route.ts:23`) but
      `grep -rn "bulk-decision" apps/fiab-console --include=*.tsx` returns nothing and neither
      `lib/editors/access-request-inbox.tsx` nor `lib/components/admin/access-requests-panel.tsx`
      has any bulk selection. Request-on-behalf-of is backend-only
      (`access-packages/[id]/request/route.ts:42-50` reads `body.onBehalfOf` + `isTenantAdmin`);
      no UI passes it.

### Measured residuals — CODE defects found by the 2026-08-06 hygiene pass

These are **not** documentation drift. The spec is right and the code is wrong;
they are recorded here so they are not lost, and they should be tracked as issues
rather than resolved by editing this file.

1. **`RequestAccessInline` has zero importers** (AG-13). A real, tested component
   that nothing in the product reaches — the guard-adoption gap this repo has hit
   before. It also strands AG-2: the package-request backend is complete but has
   no user-reachable client.
2. **`/api/access-requests/bulk-decision` has zero UI callers** (AG-14). Same
   shape: a working route with no surface.
3. **The sweeper is not in the platform deploy** (AG-16). `LOOM_SWEEPER_TOKEN` is
   set nowhere under `platform/`, `scripts/` or `.github/`, and no orchestrator
   references `azure-functions/access-governance-sweeper`. On a from-scratch
   deploy the Function does not exist; hand-deployed, the Console rejects it
   because `sweep/route.ts:33` compares against an unset env. Expiry auto-revoke
   is therefore **admin-button-only in practice** — a `no-vaporware.md` §Bicep-sync
   violation and a `deploy-integrity.md` R3 drift. Note this Function is already
   queued for the Functions→ACA-jobs migration (`.harness/state.json`,
   `docs/fiab/functions-to-aca-jobs.md:140`, FINISHLINE `C3`), which is the natural
   place to fix the wiring.

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
