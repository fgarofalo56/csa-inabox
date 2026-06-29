# Appendix — Multi-Domain ACL Engine (PRP Phase 4)

**Enterprise hardening of CSA Loom for 100–60,000-user regulated multi-domain enterprises.**
Domain owner: enterprise-architect. Scope: a single, coherent authorization
engine — principal × resource × action → allow/deny with inheritance + explicit
grants/denies — built ON the existing Loom domain model, with REAL data-plane
enforcement points, dual-cloud (Commercial + Azure Government), sized for 60k users.

> Cross-cutting rules honored: `no-fabric-dependency` (Azure-native default,
> Fabric/Power BI strictly opt-in), `no-vaporware` (real backend per control),
> `web3-ui` (Fluent v9 + Loom tokens), `loom-no-freeform-config` (wizard /
> matrix / people-picker, never JSON), `everything-on-day-one` (cost-governed,
> not gated). Every refactor is incremental + reversible behind a feature flag.

---

## 0. Executive summary — readiness = PARTIAL

Loom already ships **most of the enforcement primitives** but lacks the **single
Policy Decision Point (PDP)** that composes them and the **continuous reconciler
/ per-workspace identity** that make the model native and sovereign.

What exists today (verified in code):

| Capability | File(s) | State |
|---|---|---|
| Multi-domain model + Entra-group tiers | `lib/azure/domain-registry.ts`, `domain-groups.ts`, `domain-hierarchy.ts`, `lib/auth/domain-role.ts` | strong |
| Workspace-role effective resolver (nested groups) | `lib/azure/workspace-roles-client.ts` (`resolveEffectiveRole`) | strong |
| OneLake security roles → real ADLS POSIX ACL (OLS folder/table) | `lib/azure/onelake-security-client.ts`, `onelake-security-rules.ts`, pane `lib/panes/onelake-security-tab.tsx` | strong (OLS only) |
| Access-policy grant → ADLS RBAC / Synapse SQL role / ADX role | `lib/azure/access-policy-client.ts`, `rbac-client.ts` | strong |
| Sensitivity-label → RBAC enforcement + export/label-change gates | `lib/azure/label-protection.ts`, `mip-graph-client.ts`, bicep `label-rbac-grants.bicep` | partial (event-driven, no reconciler) |
| Item-share dialog (people-picker + permission matrix → Cosmos + ACL + RBAC) | `lib/dialogs/share-item-dialog.tsx`, `lib/editors/components/share-dialog.tsx`, `app/items/[type]/[id]/permissions/page.tsx`, `lib/components/ui/identity-picker.tsx` | strong |
| Cosmos containers for ACL state | `lib/azure/cosmos-client.ts` (`_shares`, `_wsPermissions`, `_featurePermissions`, `_onelakeSecurityRoles`, `_auditLog`, `_labelPropagation`) | strong |
| Bicep RBAC modules | `platform/fiab/bicep/modules/admin-plane/*-rbac.bicep`, `landing-zone/synapse-storage-rbac.bicep` | strong |

What is **missing or weak** (the Phase-4 build):

1. **No coherent PDP.** There is no `authorize(principal, resource, action)`
   evaluator. Routes query each silo (domain-role, workspace-role, onelake
   roles, access-policy, label-protection) ad-hoc; there is no composed,
   inheritance-aware decision with explicit grant/deny precedence and no single
   testable model. **P0 — the spine of the whole engine.**
2. **OneLake roles have OLS but no RLS/CLS in the role.** `onelake-security-client`
   sets folder/table ACLs only; RLS lives separately (SQL `SESSION_CONTEXT('loom_user')`,
   Report Wave 3, ADX RLS) and is not unified into the role + reconciled to the
   source engines. **P0.**
3. **Protection policies are not a reconciler.** `label-protection` enforces
   on-demand; there is no continuous loop that watches label assignments and
   converges ADLS RBAC / Synapse DENY / ADX RLS to match, no drift detection,
   no sovereign no-Purview pure-RBAC mode surfaced as a policy object. **P0.**
4. **No per-workspace identity.** The data plane uses ONE shared Console UAMI
   (`uamiArmCredential`, ~233 files). There is no per-workspace user-assigned MI
   + storage **resource-instance rule** (the Azure-native 1:1 of Fabric
   "workspace identity" + "trusted workspace access"). Per-user isolation rests
   on app-layer + SQL session RLS only. **P1 (defense-in-depth + sovereign).**
5. **Managed private-endpoint self-service** is referenced (`lib/panes/networking.tsx`,
   `lib/components/pipeline/factory-resources-tree.tsx`) but there is no
   per-workspace MPE create→approve self-service flow. **P1.**
6. **Endorsement (Promote/Certify)** exists only as content-bundle metadata
   strings — not a real item field + governance gate + catalog surfacing. **P2.**
7. **Audit is fragmented.** `_auditLog` + `monitor-client` exist but there is no
   unified "who-accessed-what" view joining data-plane access (Storage/Synapse/
   ADX diagnostic logs) to the PDP decision. **P1.**
8. **No edge authorize middleware** (`middleware.ts` absent) — no defense-in-depth
   gate before route handlers. **P2.**

---

## 1. Architecture in words — the PDP/PEP model

### 1.1 The decision model

A **single evaluatable function** is introduced as the spine:

```
authorize(principal: Principal, resource: ResourceRef, action: Action): Decision
```

- **Principal** = `{ oid, upn, groups: string[], tenantId }` — sourced from the
  existing encrypted session (`lib/auth/session.ts`), whose `claims.groups`
  carries the Entra group OIDs at sign-in (already the cache for tier checks in
  `domain-role.ts`). Graph transitive fallback (`userIsTransitiveGroupMember`)
  only when the claim overflows (>200 groups).
- **ResourceRef** = a typed path down the hierarchy:
  `domain → workspace → item → table → column → row-predicate`. Each level
  carries its id + parent ref so the evaluator can walk up for inheritance.
- **Action** = `read | write | admin | share | (build|execute for compute items)`.
- **Decision** = `{ effect: 'allow'|'deny', reason, source, obligations[] }`
  where `obligations` carry RLS predicates / CLS column masks / export blocks
  the PEP must apply (so the PDP returns *constrained allow*, matching OneLake's
  effective-role semantics: `(OLS ∩ CLS ∩ RLS)` per role, `UNION` across roles).

### 1.2 Composition + precedence (inheritance)

The evaluator composes the existing silos in a fixed order, mirroring OneLake's
documented model (least-restrictive UNION across roles; INTERSECTION within a
role) **plus** an explicit-deny override layer that Fabric lacks but regulated
tenants demand:

1. **Tenant admin** (`isTenantAdmin`) → `allow admin` short-circuit (audited).
2. **Explicit deny** (Cosmos `_aclGrants`, `effect:'deny'`) → hard `deny`, wins
   over everything below. This is the regulated-enterprise requirement; ADLS/
   Synapse cannot create Azure *deny assignments* (apps may not), so deny is
   enforced by (a) the PDP, (b) **omission** of a positive grant, and (c) RLS/
   CLS obligations narrowing the row/column set — defense in depth.
3. **Domain tier** (`resolveDomainTier`) → domain-admin = `allow admin` within
   the domain subtree; domain-contributor = `allow write` to create/assign
   workspaces.
4. **Workspace role** (`resolveEffectiveRole`) → Admin/Member/Contributor/Viewer
   mapped to read/write/admin; inherited by every item in the workspace unless
   item-level overrides exist.
5. **Item share grants** (`_shares`) → additive per-item permissions
   (Read/Edit/Reshare/ReadData/…).
6. **OneLake security role** (`_onelakeSecurityRoles`) → folder/table OLS +
   (NEW) RLS/CLS obligations.
7. **Protection policy** (NEW `_protectionPolicies`, label-driven) → can only
   *restrict*: a labeled item with an associated protection policy blocks
   everyone not in the allow-list (exactly Fabric's "retain permission or be
   blocked" model — grounded in Learn `protection-policies-overview`).

The result is a **constrained allow or deny** with obligations. The PDP is pure,
cache-friendly, and unit-testable in isolation (no Azure SDK on the hot path —
the same discipline already used in `onelake-security-rules.ts`).

### 1.3 Enforcement points (PEPs)

The PDP **decides**; PEPs **enforce** at two layers (never one alone):

- **App-layer PEP (defense-in-depth):** every BFF route + a new edge
  `middleware.ts` calls `authorize(...)` and returns `403 {ok:false,error}` or
  applies obligations to the query. Fast, but not the sole boundary.
- **Native data-plane PEP (the real boundary):** the existing reconcilers push
  the decision into Azure so it holds even outside Loom:
  - ADLS Gen2 POSIX ACL (`onelake-security-client.applyRoleAcls`),
  - Storage RBAC role assignment (`access-policy-client` / `adls-client.grantContainerRole`),
  - Synapse **dedicated SQL** DB-role + **SECURITY POLICY** for RLS / column GRANT-DENY for CLS,
  - Synapse **serverless** RLS via `SESSION_CONTEXT('loom_user')` (already used; `onelake-security-tab.tsx`),
  - ADX **Row Level Security** policy + restricted view / database role.

This is the `no-vaporware` posture: the PDP is the brain, but the row a user
sees is decided by a real ADLS ACL / SQL security policy / ADX RLS — verifiable
by reading it back (`verifyRoleAcls` already does this for ACLs).

---

## 2. File-level build spec

### 2.1 P0 — the PDP spine

**Create `lib/auth/pdp/resource-ref.ts`** — pure types: `Principal`,
`ResourceRef` (discriminated union by level), `Action`, `Decision`, `Obligation`
(RLS predicate, CLS column set, export-block). No Azure imports (vitest-safe,
same pattern as `onelake-security-rules.ts`).

**Create `lib/auth/pdp/evaluate.ts`** — the pure composition function
`evaluate(principal, resourceRef, action, context): Decision`, where `context`
is the *already-fetched* policy bundle (grants, roles, label, protection policy).
Pure → fully unit-testable. Encodes the precedence in §1.2 and the
`(OLS ∩ CLS ∩ RLS)` UNION-of-roles algebra (grounded in Learn
`data-access-control-model#evaluating-multiple-onelake-security-roles`).

**Create `lib/auth/pdp/context-loader.ts`** — the impure side: given
`(principal, resourceRef)`, fetch the minimal policy bundle from the existing
silos (`domain-role`, `workspace-roles-client`, `_shares`, `_onelakeSecurityRoles`,
`_protectionPolicies`, `_aclGrants`) in **one batched read per level**, memoized
per-request. Caches: an in-process LRU keyed by `(oid, resourceId, action)` with
a 60 s TTL + explicit bust on any grant write (so a revoke is felt within a
request, fully within a minute globally). At 60k users this keeps Cosmos RU flat
(see §5).

**Create `lib/auth/pdp/authorize.ts`** — the public surface:
`authorize(principal, resourceRef, action)` = `evaluate(...context-loader...)`.
Exports `requireAuthorize(...)` (throws `403` JSON) for routes.

**Create `lib/auth/pdp/__tests__/evaluate.test.ts`** — truth-table tests:
tenant-admin short-circuit, explicit-deny override, workspace inheritance,
item-share additivity, OLS+RLS+CLS intersection, multi-role UNION,
protection-policy block. This is the acceptance artifact for the engine.

**Edit (incremental, flag-gated)** the highest-value routes to call
`requireAuthorize` first: `app/api/items/[type]/[id]/permissions/route.ts`,
the data-plane query routes under `app/api/items/**`, and the OneLake-security
+ access-policy routes. Behind `LOOM_PDP_ENFORCE` (default `shadow`): in
`shadow` mode the PDP runs and **logs** divergence from today's ad-hoc checks to
`_auditLog` without blocking; flip to `enforce` per-domain once shadow shows
zero false-denies. This is the migration-safe rollout.

**Create `middleware.ts`** (edge, P2 follow-on) — coarse pre-filter
(authenticated + domain membership) using only the session cookie claims; never
the sole boundary, just early-out for obviously-unauthorized requests. `matcher`
excludes static assets + public routes.

### 2.2 P0 — RLS/CLS in the OneLake security role + reconciler

**Edit `lib/azure/onelake-security-rules.ts`** — extend the role shape:
`rls?: { table: string; predicate: string }[]` and
`cls?: { table: string; allowedColumns: string[] }[]`. Add pure validators
`isValidRlsPredicate` (whitelist SQL `WHERE` subset per Learn
`row-level-security#syntax-rules`) and `isValidColumnList`. Keep zero Azure
imports.

**Create `lib/azure/onelake-rls-reconciler.ts`** — materializes role RLS/CLS to
the **source engines** (the native PEP):
- Synapse serverless/dedicated: `CREATE SECURITY POLICY` + inline table-valued
  function for RLS (uses `synapse-sql-client`); CLS via `GRANT SELECT(col)` /
  `DENY SELECT(col)` (Learn `column-level-security`, `sql-data-discovery`).
- ADX: `.alter table T policy row_level_security` + restricted columns via
  update policy / materialized restricted view (uses `kusto-client`).
- For Delta-on-ADLS read paths with no SQL engine: RLS is enforced by the PDP
  obligation only (honest gate surfaced — ADLS POSIX has no row concept).
Returns change counters like `applyRoleAcls` does.

**Edit `lib/panes/onelake-security-tab.tsx`** — add the **Row security** and
**Column security** sub-dialogs to each role (mirrors Fabric's `...` → Row/Column
security menu, grounded in Learn screenshots). WYSIWYG predicate builder +
column checkbox grid — **not** a JSON box (`loom-no-freeform-config`). One role
may hold RLS *or* CLS combos per Learn's single-role rule; the UI enforces that.

**Create `app/api/items/[type]/[id]/onelake-security/[role]/rls/route.ts`** and
`.../cls/route.ts` — POST persists to `_onelakeSecurityRoles` + calls the
reconciler; GET returns current + last-reconcile receipt.

### 2.3 P0 — Protection-policy reconciler (sovereign)

**Create `lib/azure/protection-policy-client.ts`** — a first-class policy object
(`_protectionPolicies` Cosmos container, partition key `/domainId`):
`{ id, label, allowPrincipals[], retainFullControl: bool, scope, mode }` where
`mode ∈ { 'purview' (opt-in), 'sovereign-rbac' (default) }`. Mirrors Fabric's
protection policy (label → retain-or-block; Learn `protection-policies-overview`),
**but the default `sovereign-rbac` mode needs NO Purview/Fabric dependency** —
it is pure ADLS RBAC + Synapse DENY-by-omission + ADX RLS, satisfying the
sovereign requirement (`no-fabric-dependency`).

**Create `lib/azure/protection-policy-reconciler.ts`** — the continuous loop:
1. Enumerate items carrying the policy's label (reuse `_labelPropagation` +
   `mip-graph-client` for the label graph; in sovereign mode, the Loom-applied
   label stored on the item doc — no Graph call needed).
2. Compute the target grant set = `allowPrincipals` (+ label issuer, who is
   never blocked — Learn note).
3. Diff against live grants (`listContainerRoleAssignments`, Synapse SQL db-role
   members, ADX `showDatabasePrincipals`) and converge — `enforceAccessGrant`
   for missing; `revokeAccessGrant` (ADLS) / `revokeStructuredGrant` (SQL) /
   `dropDatabasePrincipal` (ADX) for non-allowed — *positive grants only* (apps
   cannot create Azure deny assignments; enforcement = grant-allowlist +
   remove-others + RLS). Each backend gates honestly when unset.
4. Write a drift/convergence receipt to `_auditLog`.

**Deploy as an ACA Job** (KEDA cron, scale-to-zero) — see §3. Also exposed as an
on-demand "Reconcile now" button. Drift surfaced in Governance → Policies.

**Edit `lib/azure/label-protection.ts`** — keep the on-demand export/label-change
gates; have them consult the protection-policy object so behavior is consistent
with the reconciler. No breaking change.

### 2.4 P1 — Per-workspace identity + resource-instance rule

The Azure-native 1:1 of Fabric "workspace identity" + "trusted workspace access"
(Learn `workspace-identity`, `security-trusted-workspace-access`):

**Create `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep`** —
parameterized module that provisions a **user-assigned MI per workspace**
(`uami-ws-<workspaceId>`), grants it `Storage Blob Data Contributor` scoped to
the workspace's lake container, and adds a **resource-instance rule** /
trusted-service exception on the storage account
(`networkAcls.resourceAccessRules`). Because resource-instance rules for Fabric
must be ARM-deployed (Learn restriction), Loom mirrors that with ARM/bicep — the
real native pattern. Cap: ≤200 rules/account (Learn limit) → at 60k users this
forces **per-domain shared lakes** (see §5 cost-gov), not per-workspace accounts.

**Create `lib/azure/workspace-identity-client.ts`** — CRUD over per-workspace
UAMIs (ARM) + a `getWorkspaceCredential(workspaceId)` that returns a per-workspace
`ManagedIdentityCredential` (falls back to the shared `uamiArmCredential` when
the flag is off). This is the **migration-safe** path off the single shared UAMI:
flag `LOOM_PER_WORKSPACE_IDENTITY` (default off) selects per-workspace creds for
new workspaces only; existing workspaces keep the shared UAMI until backfilled.

**Edit `lib/panes/networking.tsx`** — add a "Workspace identity" card (create
UAMI, show its principalId, the granted roles, and the resource-instance-rule
status with an honest gate when the operator hasn't run the ARM grant).

> Honest gate (tenant-admin action): provisioning a per-workspace UAMI + storage
> resource-instance rule requires `Microsoft.Authorization/roleAssignments/write`
> + `Microsoft.Storage/storageAccounts/write` on the DLZ sub. Surface a Fluent
> `MessageBar intent="warning"` naming the bicep module + the `az deployment`
> command when the Console UAMI lacks it (it is Reader-only on some DLZ subs per
> the known cross-sub gotcha).

### 2.5 P1 — Managed private-endpoint self-service

**Create `platform/fiab/bicep/modules/landing-zone/managed-private-endpoint.bicep`**
— per-workspace managed PE to the workspace lake / SQL / ADX, auto-approved when
Loom owns the target, pending-approval surfaced when it doesn't.

**Create `lib/azure/managed-pe-client.ts`** — list/create/approve MPEs (ARM on
the managed VNet, reusing the ADF managed-VNet pattern already shipped) +
status polling.

**Edit `lib/panes/networking.tsx`** — "Managed private endpoints" self-service
card: pick target → create → show approval state. Honest gate when approval is a
tenant-admin action on a foreign subscription.

### 2.6 P1 — Unified access audit ("who-accessed-what")

**Create `lib/azure/access-audit-client.ts`** — queries Log Analytics
(`monitor-client`) for `StorageBlobLogs`, `SynapseGatewayApiRequests` /
`SQLSecurityAuditEvents`, and ADX `.show queries` joined by principal +
resource, and merges with the PDP decision log in `_auditLog`. Returns a
"who-accessed-what-when, allowed/denied, by which policy" table.

**Create `app/admin/access-audit/page.tsx`** + `app/api/admin/access-audit/route.ts`
— Governance surface: filter by principal/domain/workspace/item/time; export CSV
(export itself runs through `label-protection.checkExport`).

### 2.7 P2 — Endorsement (Promote / Certify)

**Edit `lib/types/workspace.ts`** — add `endorsement?: { status:'none'|'promoted'|'certified'; certifiedBy?; certifiedAt?; reviewerGroupId? }`.

**Create `app/api/items/[type]/[id]/endorse/route.ts`** — POST sets endorsement;
**Certify** is gated on membership of the domain's `certifierGroupId` (resolved
via `domain-role`) — mirrors Fabric's "only authorized certifiers may certify".

**Edit** the item header in `lib/editors/phase3-editors.tsx` host + catalog tiles
to show a Promote/Certify badge (web3 styling) and the certify dialog.

---

## 3. Deploy / bicep / ACA-job steps

1. **Cosmos containers** — add `_protectionPolicies` (PK `/domainId`),
   `_aclGrants` (PK `/resourceId`, holds explicit allow/deny) via
   `cosmos-client` `createIfNotExists` (no bicep needed; matches existing
   pattern). Autoscale 1000→ per §5.
2. **Reconciler ACA Job** — add a `Microsoft.App/jobs` resource (KEDA cron,
   `replicaTimeout`, scale-to-zero) running the protection-policy +
   onelake-rls reconcilers, in `platform/fiab/bicep/modules/admin-plane/`.
   Same image as the console; entrypoint `node reconcile.mjs`. Env: the policy
   container + the target lake/SQL/ADX endpoints.
3. **RBAC** — extend `synapse-storage-rbac.bicep` (Storage Blob Data Owner for
   the reconciler MI, gated by `loomProtectionPolicyEnabled`) and add
   `workspace-identity.bicep` + `managed-private-endpoint.bicep`.
4. **Env vars** (add to `apps[].env` in `admin-plane/main.bicep`):
   `LOOM_PDP_ENFORCE` (shadow|enforce), `LOOM_PER_WORKSPACE_IDENTITY`,
   `LOOM_PROTECTION_POLICY_MODE` (sovereign-rbac|purview),
   `LOOM_RECONCILER_INTERVAL`.
5. **Acceptance deploy** — `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` must stand up the containers + ACA job;
   Gov variant `-p params/gov-full.bicepparam`.

---

## 4. Commercial vs Azure Government

| Concern | Commercial / GCC | GCC-High / IL4-5 / DoD |
|---|---|---|
| Entra authority | `login.microsoftonline.com` | `login.microsoftonline.us` (set via `cloud-endpoints.ts` already) |
| Graph (group/label resolution) | `graph.microsoft.com` | `graph.microsoft.us` / `dod-graph.microsoft.us` (`LOOM_MIP_GRAPH_BASE`) |
| ARM (RBAC, resource-instance rule) | `management.azure.com` | `management.usgovcloudapi.net` |
| Storage DFS | `*.dfs.core.windows.net` | `*.dfs.core.usgovcloudapi.net` |
| Protection policy | `purview` mode available (opt-in) **or** sovereign | **sovereign-rbac only** — Purview protection policies + label rights filter may 404/400 in GCC-High; the pure-RBAC reconciler has no Purview/Fabric dependency, so it is the default and fully functional |
| Per-workspace identity | UAMI + resource-instance rule | identical; IL5 → private-only (no public network), CMK on storage, MPE mandatory |
| Audit logs | Log Analytics | Log Analytics (Gov); ensure diagnostic settings deployed in DLZ |
| OSS substitute (label rights when Graph degrades) | n/a | item-stored label + Loom policy object replaces the Graph `usageRightsInfo` call; export-by-format block still holds |

All host selection flows through the existing `cloud-endpoints.ts` +
`LOOM_MIP_GRAPH_BASE` — no new per-cloud branching invented; the new clients
import the same helpers.

---

## 5. Scale to 60,000 users — throughput, partitioning, cost

- **PDP read path:** without caching, a per-request authorize = ~4 Cosmos point
  reads × peak RPS. With the 60 s LRU + per-level batching, steady-state Cosmos
  RU stays flat regardless of user count (cache hit ratio >95% for hot
  domains/workspaces). Containers on **autoscale** (Learn: scales 0.1×Tmax→Tmax,
  dynamic per-partition) so day-one-on stays affordable.
- **Partitioning:** `_aclGrants` PK `/resourceId`, `_protectionPolicies`
  `/domainId`, `_shares` keep ≤20 GB logical partitions and avoid hot keys
  (Learn `partitioning#choose-a-partition-key`). Pre-provision RU for large
  tenants per Learn `scaling-provisioned-throughput-best-practices`
  (physical-partition math) before bulk grant import.
- **Resource-instance-rule cap = 200/account** (Learn). At 60k users you cannot
  have one storage account per workspace. **Design:** one lake account per
  **domain** (≤200 workspaces/domain rules), per-workspace isolation via
  container + UAMI + ACL, not per-account. This is the cost-governed shape.
- **Reconciler:** runs per-domain in parallel ACA-job replicas, scale-to-zero
  between intervals — cost ≈ minutes of vCPU/day, not a standing service.
- **Cost-gov layer (day-one-on but safe):** an `enable-per-domain` toggle on
  protection-policy / per-workspace-identity / RLS-reconcile, defaulting ON but
  letting a domain admin disable for a low-sensitivity domain; capacity SKUs
  (F2–F512, already modeled) + chargeback tags attribute reconciler + Cosmos RU
  per domain.

---

## 6. Code vs tenant-admin action (runbooks)

| Action | Who | Runbook / gate |
|---|---|---|
| Ship PDP, reconcilers, RLS/CLS, sharing, audit UI | **Code** (Loom) | this appendix |
| Grant Console/reconciler UAMI `Storage Blob Data Owner` on DLZ lake | **Tenant-admin** | `synapse-storage-rbac.bicep` (gated); honest gate in UI when absent |
| Deploy storage **resource-instance rule** (per-workspace UAMI trusted access) | **Tenant-admin** | `workspace-identity.bicep` via `az deployment group create`; ARM-only per Learn |
| Approve managed PE on a foreign subscription | **Tenant-admin** | `managed-private-endpoint.bicep` + portal approval; pending-state surfaced |
| Create Purview protection policy (opt-in mode only) | **Tenant-admin** | Purview portal; Loom's default sovereign mode needs none |
| Grant Console UAMI `Microsoft.Authorization/roleAssignments/write` on DLZ sub | **Tenant-admin** | required for live grant/revoke; known Reader-only cross-sub gotcha → honest gate |
| Exclude workspace identities from Conditional Access for workload identities | **Tenant-admin** | Learn restriction; runbook note for trusted-access |

Every tenant-admin action has an **honest in-product gate** (Fluent
`MessageBar intent="warning"` naming the exact role/bicep/command) per
`no-vaporware` — the UI still fully renders.

---

## 7. Migration plan (incremental + reversible)

1. **Phase A (shadow):** ship PDP + `LOOM_PDP_ENFORCE=shadow`. Routes log
   PDP-vs-legacy divergence to `_auditLog`; zero behavior change. Reversible by
   flag.
2. **Phase B (enforce per-domain):** flip enforce for one low-risk domain;
   monitor false-denies; expand. Per-domain flag = blast-radius control.
3. **Phase C (RLS/CLS + protection reconciler):** enable per-domain; reconciler
   in shadow (report drift) → converge.
4. **Phase D (per-workspace identity):** `LOOM_PER_WORKSPACE_IDENTITY` for NEW
   workspaces only; backfill existing in batches; shared UAMI remains the
   fallback throughout (never a big-bang off the 233-file shared credential).
5. **Phase E:** managed-PE self-service, endorsement, edge middleware.

Each phase is independently shippable, flag-gated, and revertible.

---

## 8. Acceptance criteria

- `evaluate.test.ts` truth table passes (tenant-admin, explicit-deny override,
  workspace inheritance, share additivity, OLS∩CLS∩RLS, multi-role UNION,
  protection-policy block).
- Live receipt: a user in a OneLake role with RLS sees only permitted rows in
  **Synapse serverless query AND ADX** (real query, not the UI) with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — proving the no-Fabric default.
- A protection-policy label assignment converges real ADLS RBAC within one
  reconciler interval; revoking it removes the grant (verified by
  `listContainerRoleAssignments`).
- Share dialog grant writes Cosmos `_shares` + ADLS ACL + Storage RBAC and the
  grantee can read; revoke reverses all three.
- Per-workspace UAMI reads the lake through the resource-instance rule with the
  shared Console UAMI's blob-data role removed (proving native per-workspace
  isolation).
- Access-audit page shows the allow/deny + governing policy for each access.
- Commercial AND Gov param files both deploy the containers + ACA job; sovereign
  protection mode works in GCC-High with Graph rights-filter unavailable.

---

## 9. Sources (Microsoft Learn)

- OneLake security: get-started, data-access-control-model (effective-role
  UNION/INTERSECTION), table-folder-security, row-level-security,
  column-level-security, best-practices.
- Protection policies in Fabric: protection-policies-overview,
  protection-policies-create, protected-sensitivity-labels,
  information-protection#access-control, sensitivity-label-change-enforcement.
- Workspace identity + trusted access: workspace-identity,
  workspace-identity-authenticate, security-trusted-workspace-access,
  onelake-manage-inbound-access-trusted-resources (resource-instance rules,
  200-rule cap, ARM-only).
- Cosmos scale: partitioning, provision-throughput-autoscale,
  scaling-provisioned-throughput-best-practices, data-partitioning-strategies.
- Security baselines: governance-security-baselines-fabric / -purview, MCSB DP-1.
