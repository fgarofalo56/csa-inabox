# loom-next-level — Section I (Per-Workspace Managed Identity) + Section X (Cloud Matrix)

> Draft workstream for the master PRP (rev 2 — post-adversarial-review). Two sections:
> **I** — per-workspace managed identity, phased shadow → enforce (**I1–I9**;
> I9 = the rev-2 threat-model/AppSec gate before enforcement).
> **X** — cross-cutting per-cloud engineering matrix every other workstream references.
>
> **Rev-2 renumbering (consistency 1a):** the X-section items are now
> contiguous — **X1** (cloud-endpoints adoption ratchet, unchanged), **X2**
> (availability-gate convention — formerly "X.3"), **X3** (per-cloud CI
> validation lanes — formerly "X.5", previously uncounted in the master).
> The service-availability matrix (**X-MATRIX**, formerly "X.2") and the IL5
> checklist (**X-IL5**, formerly "X.4") are un-numbered REFERENCE blocks, not
> buildable items.
>
> Conventions (shared with the master PRP): PR-sized items with IDs (`I1…` identity,
> `X1…` cross-cutting). Each item states goal, exact files/paths, backend/infra
> (bicep per `no-vaporware.md` §"Bicep sync requirement" **+ the rev-2 R0 rule:
> `admin-plane/main.bicep` is at the 256-param ARM cap — new params ride config
> objects, never new top-level `param`s**), env vars (registered in
> `ENV_CHECKS` + the gate registry with a Fix-it per UX rule G2, **updating
> `lib/gates/__tests__/registry.test.ts` parity in the same PR; new EnvSpecs
> carry the X2 `availability` field; env-adding PRs serialize on
> `env-checks.ts`/`registry.ts`/the parity test**), acceptance criteria
> including a real-data E2E receipt (per `loom_browser_e2e_before_done`), and a
> per-cloud column: **Commercial** (live — centralus sub `e093f4fd`), **Gov GCC-High**
> (live), **IL5/air-gap** (design-constraint documentation only, no live sub).

---

## 0. Current-state grounding (READ FIRST — do not rebuild what exists)

This is the single most important part of Section I. **A large fraction of the
phase-A scaffolding already exists in the repo as dormant, additive code.** The
PRP's job is to *activate, instrument, and enforce* it — not to design it from
scratch. Verified against the live tree:

### 0.1 The shared Console UAMI credential (today's default path)

- **`apps/fiab-console/lib/azure/aca-managed-identity.ts`** — the custom
  `AcaManagedIdentityCredential` (a `TokenCredential`) that hits the raw ACA
  managed-identity metadata endpoint (`2019-08-01` + `X-IDENTITY-HEADER`) because
  `@azure/identity`'s MSAL `ManagedIdentityCredential` cannot parse the ACA
  `expires_on` (Unix-seconds) response shape. It reads the UAMI client id from
  `LOOM_UAMI_CLIENT_ID` / `AZURE_CLIENT_ID`. Also exports `loomServerCredential`
  (a `ChainedTokenCredential`: Aca → SDK-MI → `DefaultAzureCredential`).
- **`apps/fiab-console/lib/azure/arm-credential.ts`** — `uamiArmCredential()`
  returns the canonical ACA-first UAMI chain. **~217 clients** under
  `lib/azure/*` build a module-level `const credential = new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({clientId}), new DefaultAzureCredential())`
  (adls-client.ts is the reference pattern) or call `uamiArmCredential()`. The
  credential is resolved **once at module load** from process env — there is no
  per-request / per-workspace context threaded through today. That is the central
  fact I5 has to change.

### 0.2 Per-workspace identity scaffolding — ALREADY PRESENT, dormant

- **`apps/fiab-console/lib/azure/workspace-identity-client.ts`** — Phase-1 §2.4,
  explicitly labelled "DORMANT, ADDITIVE". Exports:
  - `workspaceUamiName(workspaceId)` → `uami-ws-<workspaceId>`
  - `workspaceIdentityConfigGate()` → `{missing}` naming `LOOM_WS_IDENTITY_SUB` /
    `LOOM_WS_IDENTITY_RG` (never blocks the default path)
  - `getWorkspaceUami` / `createWorkspaceUami` / `deleteWorkspaceUami` (ARM CRUD
    on `Microsoft.ManagedIdentity/userAssignedIdentities`, api `2024-11-30`)
  - `getWorkspaceCredential(workspaceId)` → returns a per-workspace
    `ManagedIdentityCredential({clientId})` **only when that UAMI exists in ARM
    and its clientId is known**; otherwise silently returns the shared
    `uamiArmCredential()`. Any ARM failure falls back to the shared UAMI.
  - Test: `lib/azure/__tests__/workspace-identity-client.test.ts`.
- **`platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep`** — creates
  `uami-ws-<workspaceId>`, grants **Storage Blob Data Contributor**
  (`ba92f5b4-2d11-453d-a403-e96b0029c9fe`) scoped to ONE lake container, and
  optionally (`addNetworkRule`) admits it through the lake storage firewall via
  `networkAcls.resourceAccessRules`. **Documents two hard caps in-line:** ≤200
  `resourceAccessRules` per storage account → per-DOMAIN shared lakes (200 ws ×
  ~300 domains ≈ 60k), and `skipRoleGrants` on re-deploy to avoid
  `RoleAssignmentExists`.
- Related: `platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep`,
  and `app/api/admin/workspaces/[id]/networking/trusted-resources/route.ts`
  (trusted-resource wiring surface).

> **Implication for the PRP:** Section I is *not* greenfield. I1 wires the
> existing bicep module into the workspace-create provisioner + delete-cascade;
> I5 generalises the existing `getWorkspaceCredential` into a credential *factory*
> that every client can consume; I3/I4 add shadow instrumentation around a call
> path that already has a working per-workspace credential resolver. The design
> below is deliberately incremental on top of these files.

### 0.3 The PDP shadow infrastructure (the store I3/I4 reuse)

- **`apps/fiab-console/lib/auth/pdp/enforce.ts`** — `pdpCheck()` +
  `pdpEnforceMode()` (`off | shadow | enforce`, **default shadow**). Shadow mode
  does a real `authorize()` and writes ONE row to the existing `_auditLog`
  Cosmos container via `auditLogContainer()`; it NEVER blocks and swallows all
  errors. Row shape (`writeShadowAudit`): `{ kind:'pdp.shadow', itemId, tenantId,
  who, at, ts, oid, action, route, effect, reason, source, obligations,
  divergence, details }`. `divergence = legacyAllowed !== (effect==='allow')`
  when the caller passes `opts.legacyAllowed`.
- **`app/api/admin/pdp/shadow-report/route.ts`** — tenant-admin-only GET that
  queries `c.kind = 'pdp.shadow'` (TOP-N, `denyOnly` / `divergentOnly` filters),
  tallies `bySource/byRoute/byAction`, returns `{summary, rows}`. The UI for this
  just landed. **I3 writes a sibling `kind:'identity.shadow'` row into the SAME
  container; I4 extends this exact report + its UI with an identity-divergence
  view.** Do not stand up a new container or a new admin route shell.

### 0.4 The workspace model + create/delete lifecycle

- **`apps/fiab-console/lib/types/workspace.ts`** — the `Workspace` Cosmos doc.
  Partition key `tenantId` actually holds the owner `oid` (documented, immutable);
  `tid` / `ownerOid` are the honest fields. Already carries lifecycle side-effect
  status blocks: `backingRgProvision`, `capacityAssignment`, `domainRegistration`,
  `cmkBinding`. **I1/I6 add a parallel `workspaceIdentity` status block here.**
- **`apps/fiab-console/lib/azure/workspace-bindings.ts`** — `applyWorkspaceBindings()`
  runs post-create side-effects best-effort (capacity assign, Purview register,
  marketplace publish, optional backing-RG ARM PUT via the Console UAMI). **This
  is the exact hook point for I1's identity provisioning** — add an
  `applyWorkspaceIdentity()` side-effect alongside `tryProvisionBackingRg()`.
- Workspace delete-cascade (#2020) already exists — I1's deletion path
  (`deleteWorkspaceUami`) hangs off the same cascade.

### 0.5 The gate registry + ENV_CHECKS (where I-env-vars + X3 plug in)

- **`apps/fiab-console/lib/admin/env-checks.ts`** — `ENV_CHECKS: EnvSpec[]` is the
  declarative source of truth (`id, category, title, severity, required?, anyOf?,
  remediation, docs?, provisionedBy?, role?, derived?, optionalDefault?`). **No
  structured cloud-availability field exists** — GCC gaps are free-text prose in
  `remediation`/`autoResolveNote` + `legacyCodes` (e.g. `AAS_NOT_IN_GOV`). This is
  exactly the gap X3 closes.
- **`apps/fiab-console/lib/gates/registry.ts`** — `GATES: GateDef[]` derived from
  `ENV_CHECKS` via `GATE_META`. `GateDef` carries `fixit: {kind: 'env-picker' |
  'resource-picker' | 'role-grant' | 'wizard'}` (+ `GateOptionsLoader` for
  ARM-backed pickers). A `registry.test.ts` asserts full ENV_CHECKS coverage.
  There is a second surface `lib/admin/gate-registry.ts` (impure probe layer).

### 0.6 The cloud-config module (X1) — ALREADY EXISTS and is mature

- **`apps/fiab-console/lib/azure/cloud-endpoints.ts`** (~1339 lines) is the single
  source of truth for every sovereign suffix + AAD scope. `detectLoomCloud()`
  returns `Commercial | GCC | GCC-High | DoD` from `LOOM_CLOUD` (falling back to
  `AZURE_CLOUD`); `isGovCloud()`, `armBase()/armScope()`, Graph 3-way split, KV /
  Service Bus / ADLS-DFS / ADX / AI-Search / Batch / Cosmos / Gremlin / AML /
  Log-Analytics / Monitor-ingestion / Blob / Files / AOAI / AAS / Power-BI helpers,
  and honest gates `assertFabricFamilyAvailable()` + `graphDlpPolicyApiAvailable()`.
  Tests: `__tests__/cloud-endpoints.test.ts`, `__tests__/cloud-matrix.test.ts`.
- **Therefore X1 is NOT "build a cloud-config module" — it is an *adoption
  ratchet*** that drives the last hard-coded literals into these helpers and adds
  the missing structured availability layer (X2). See Section X.

---

# SECTION I — Per-workspace managed identity (shadow → enforce)

## Rationale + threat model (one paragraph the PRP references)

Today every data-plane call from the console runs as the **single shared Console
UAMI**, which holds broad grants (Storage Blob Data Contributor across the lake,
Synapse SQL admin, ADX admin, Cosmos data plane, constrained RBAC-Administrator
for app-resource delegation). A compromised BFF route, an SSRF, or a cross-tenant
authz bug therefore has the blast radius of *every* workspace's data. **Per-workspace
managed identity** shrinks that blast radius: each workspace optionally runs as its
own `uami-ws-<id>` scoped to only that workspace's lake container / database /
partition. Because flipping ~217 clients to a new identity is high-risk, we phase
it: **Phase A (shadow)** provisions the identities and their scoped grants but keeps
running as the shared UAMI, while *recording* — per call — whether the workspace
UAMI *would* have had access (a real ARM/data-plane permission check), surfacing
divergence in the existing shadow report. Only after an operator vets zero
unexpected divergence for a workspace do they flip **Phase B (enforce)** for that
workspace, at which point its calls actually mint the workspace UAMI token. The
control is `LOOM_WORKSPACE_IDENTITY_MODE = off | shadow | enforce` (global default
`off`), with a per-workspace enforce override (I6). Default-off honors
`loom_default_on_opt_out` only in the sense that the *observability* default is
cheap and non-blocking; identity **enforcement** is a security posture change an
operator opts into, exactly like `LOOM_PDP_ENFORCE`.

---

## PHASE A — Shadow (provision + instrument, zero behavior change)

### I1 — Identity provisioning on workspace create (+ deletion cascade)

**Goal.** When a workspace is created, provision its `uami-ws-<id>` and record the
outcome on the workspace doc — behind a flag, best-effort, never blocking create.
On workspace delete, cascade-delete the UAMI and its role assignments.

**Files / paths.**
- `apps/fiab-console/lib/azure/workspace-bindings.ts` — add
  `applyWorkspaceIdentity(ws)` alongside `tryProvisionBackingRg`; call it from
  `applyWorkspaceBindings()` when `workspaceIdentityProvisioningEnabled()` (reads
  `LOOM_WORKSPACE_IDENTITY_MODE !== 'off'` **and** `!workspaceIdentityConfigGate()`).
- `apps/fiab-console/lib/azure/workspace-identity-client.ts` — reuse existing
  `createWorkspaceUami` / `deleteWorkspaceUami`; add `ensureWorkspaceGrants(ws, uami)`
  that PUTs the scoped role assignments of I2 via ARM (idempotent, `guid()` names).
- `apps/fiab-console/lib/types/workspace.ts` — add `workspaceIdentity?:
  { status:'provisioned'|'queued'|'failed'|'skipped'; uamiName?; uamiClientId?;
  principalId?; grants?: GrantStatus[]; mode?: 'shadow'|'enforce'; at?; error? }`.
- Workspace delete route / cascade (the #2020 delete-cascade path — locate via
  `app/api/workspaces/[id]/route.ts` DELETE + its cascade helper) — call
  `deleteWorkspaceUami(ws.id)` and remove role assignments (best-effort; a failed
  UAMI delete must not block workspace delete, but MUST be recorded).
- Existing bicep `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep`
  is the **provisioning-by-topology** path (bulk / IaC). The runtime ARM path in
  `createWorkspaceUami` is the **provisioning-on-create** path. Both name the UAMI
  identically (`uami-ws-<id>`) so they converge.

**Backend / infra (bicep-sync).**
- No NEW bicep resource is required for the runtime path (the Console UAMI already
  holds Managed Identity Contributor-equivalent + constrained RBAC-Administrator —
  verify it can PUT `userAssignedIdentities` in the WS-identity RG; if not, add a
  **Managed Identity Contributor** (`e40ec5ca-96e0-45a2-b4ff-59039f2c2b59`) grant
  for the Console UAMI scoped to `LOOM_WS_IDENTITY_RG` as a new
  `modules/admin-plane/ws-identity-rbac.bicep`, following the
  `monitoring-reader-rbac.bicep` shape: `guid(scope, consolePrincipalId,
  'mi-contributor')`, `principalType:'ServicePrincipal'`, guarded by
  `if(!empty(consolePrincipalId) && !skipRoleGrants)`).
- Wire `ws-identity-rbac` into `main.bicep` next to the existing `*-rbac` modules,
  passing `consolePrincipalId: hub.consolePrincipalId` and the WS-identity RG —
  **via the R0 config-object pattern (`main.bicep` is at the 256-param cap; the
  workspace-identity settings ride `workspaceIdentityConfig`, no new top-level
  params).**
- **ARM-write-throttle note (rev 2, SRE F16 addendum):** provision-on-create does
  MULTIPLE ARM writes per workspace (UAMI PUT + role-assignment PUT + optional
  firewall rule). Besides the UAMI-specific creation throttle (2 req/s per sub,
  0.25 req/s per resource — I8), the **general ARM write bucket (~200 writes per
  subscription per service principal, refill ~10/s, token-bucket — Learn:
  request-limits-and-throttling)** applies: bulk topology deploys hit BOTH.
  I1's provisioning queue/backoff must cite and respect both limits.

**Env vars (ENV_CHECKS + gate).**
- `LOOM_WORKSPACE_IDENTITY_MODE` (`off|shadow|enforce`, default `off`) —
  ENV_CHECKS `id:'svc-workspace-identity'`, `optionalDefault:true` (never
  required), category `security`, remediation naming the two sub/RG vars.
- Reuse existing `LOOM_WS_IDENTITY_SUB` (or `LOOM_SUBSCRIPTION_ID`) and
  `LOOM_WS_IDENTITY_RG` (or `LOOM_DLZ_RG`) via `workspaceIdentityConfigGate()`.
- Gate registry entry `svc-workspace-identity` with `fixit:{kind:'wizard'}` — the
  Fix-it launches an "Enable per-workspace identity" wizard (I6 UI) that sets the
  mode + sub/RG. `canAutoResolve:true` (optionalDefault). Register on the Admin →
  Gates page.

**Acceptance criteria + E2E receipt.**
1. With `LOOM_WORKSPACE_IDENTITY_MODE=off` (default), create a workspace → NO
   `uami-ws-*` created, `workspaceIdentity.status:'skipped'`, behavior identical to
   today (regression guard).
2. With mode `shadow` + sub/RG set: `POST /api/workspaces` (minted-session harness)
   → ARM shows `uami-ws-<newId>` exists (`az identity show`), workspace doc
   `workspaceIdentity.status:'provisioned'` with a real `principalId`. **Receipt:**
   the create response body (first 300 chars) + `az identity show` JSON.
3. `DELETE /api/workspaces/<id>` → `az identity show` 404 and role assignments
   gone (`az role assignment list --assignee <principalId>` empty). **Receipt:**
   both CLI outputs.
4. Vitest: `workspace-identity-client.test.ts` extended for `ensureWorkspaceGrants`
   idempotency (second call = no-op, no `RoleAssignmentExists` throw).

**Per-cloud.**
- **Commercial (live):** provision against the centralus DLZ per-domain lake; run
  the create/delete E2E on sub `e093f4fd`.
- **Gov GCC-High (live):** `Microsoft.ManagedIdentity` + role assignments are GA
  in Azure Government; ARM host resolves via `armBase()` (`management.usgovcloudapi.net`).
  Run the same create/delete via the `gov-*` ACA-job harness (no public egress).
  `uami-ws-*` naming ≤ 128 chars OK; note the 24-char UAMI-name limit applies only
  to VM/VMSS assignment (not our case) — verified against Learn.
- **IL5 / air-gap (design-only):** identical ARM shapes; the WS-identity RG and the
  per-domain lake must live inside the air-gapped sub; no public ARM egress (the
  ACA-job / in-VNet execution model already used by gov workflows applies). No
  cross-cloud identity federation.

---

### I2 — Scoped role-grant model (per backend, initially UNUSED)

**Goal.** Enumerate the minimal per-backend grants a workspace UAMI needs and grant
them, scoped as tightly as each backend allows. In Phase A these grants exist but
are **unused** (calls still run as the shared UAMI) — they are the safety net that
makes I3's "would it have had access?" check answerable *from real RBAC*, and the
thing I6/enforce switches onto.

**Grant matrix (per workspace UAMI, least-privilege scope).** Grounded in the
existing clients that name each backend + the `no-fabric-dependency.md` canonical
Azure backends:

| Backend (client) | Built-in role (GUID) | Tightest scope Azure allows | Notes |
|---|---|---|---|
| ADLS Gen2 lake (`adls-client`) | Storage Blob Data Contributor `ba92f5b4-2d11-453d-a403-e96b0029c9fe` | **container** (`.../blobServices/default/containers/<ws>`) | Already in workspace-identity.bicep. One container per workspace, or ABAC path-prefix condition on a shared container (see I8). |
| Synapse dedicated/serverless SQL (`synapse-sql-client`) | — (data-plane, not ARM RBAC) | **database / schema** | Grant is a T-SQL `CREATE USER [uami-ws-x] FROM EXTERNAL PROVIDER; ALTER ROLE db_datareader/db_datawriter ADD MEMBER` — not a role assignment. Runbook + SQL script, executed by the Console UAMI (Synapse SQL admin). Counts against NO RBAC cap. |
| ADX / Eventhouse (`kusto-client`, `kusto-arm-client`) | — (Kusto database RBAC) | **database** | `.add database <db> viewers/users ('aadapp=<clientId>;<tenant>')` via the Kusto mgmt endpoint. Not an ARM role assignment. |
| Cosmos data plane (`cosmos-data-client`) | Cosmos DB Built-in Data Contributor (data-plane role, `00000000-0000-0000-0000-000000000002`) | **account** (Cosmos data-plane RBAC has no container scope) or partition-key logical scope via SQL role def | `az cosmosdb sql role assignment create`. Partition-level isolation is logical (enforced in query), not RBAC. |
| Event Hubs eventstream (`eventhubs-client`) | Azure Event Hubs Data Receiver/Sender (`a638d3c7-…` / `2b629674-…`) | **entity (event hub)** | Per-workspace hub or consumer group. |
| Azure Monitor scheduled-query alerts (activator) (`monitor-client`) | Monitoring Contributor `749f88d5-…` | **RG / alert-rule** | Only when the workspace owns activator rules. |
| Key Vault (per-workspace secrets) (`kv-secrets-client`) | Key Vault Secrets User `4633458b-…` | **vault / secret** | Only if a workspace gets its own KV scope. |

**Files / paths.**
- `apps/fiab-console/lib/azure/workspace-grants.ts` (NEW) — declarative
  `WORKSPACE_GRANTS: WorkspaceGrantSpec[]` (backend, roleGuid|dataPlaneScript,
  scopeBuilder(ws), armType) + `ensureWorkspaceGrants(ws, uami)` (ARM RBAC PUTs) +
  `evaluateWorkspaceGrant(ws, uami, backend)` (used by I3). Mirror the bicep
  `guid()`-name idempotency.
- `platform/fiab/bicep/modules/landing-zone/workspace-identity.bicep` — extend to
  optionally emit the Synapse/ADX/Cosmos grants for the IaC bulk path (guarded,
  `skipRoleGrants` aware). Data-plane grants (Synapse/ADX) stay as
  deploymentScript or runbook, not ARM RBAC.

**Backend / infra.** No new resource types; only role/permission grants. Document
each in `docs/fiab/runbooks/workspace-identity-grants.md`.

**Env vars / gate.** None new beyond I1 (grants are derived from the backend env
vars already registered, e.g. `LOOM_BRONZE_URL`, Synapse/ADX/Cosmos vars).

**Acceptance + E2E receipt.** For each backend present in the deployment: after I1
provision, `az role assignment list --assignee <ws-principalId> --all` shows
exactly the expected scoped grants (Receipt: the JSON). Synapse: `SELECT` against
`sys.database_principals` shows the external user (Receipt: query output). ADX:
`.show database <db> principals` shows the app principal. **Idempotency E2E:**
re-run provision → zero new assignments, zero errors.

**Per-cloud.**
- **Commercial / GCC-High (live):** all listed backends exist in both (ADLS,
  Synapse, ADX, Cosmos, Event Hubs, Monitor, KV are GA through GCC-High). Role
  GUIDs are cloud-invariant (built-in). Run the grant-list E2E in each.
- **IL5 (design-only):** same GUIDs; ensure the grant executor runs in-VNet /
  in-sub (no ARM egress). Cosmos data-plane RBAC + Synapse external-provider users
  are IL5-available.

---

### I3 — Shadow audit: "would the workspace UAMI have had access?"

**Goal.** On every data-plane call that carries a workspace context, in addition to
running as the shared UAMI (unchanged), evaluate whether the **workspace UAMI would
have been authorized** and record divergence into the existing `_auditLog` store as
`kind:'identity.shadow'`. Never blocks, never throws (mirrors `pdpCheck` shadow).

**How the "would have had access" check is computed** (must be *real*, per
`no-vaporware.md`):
- **Preferred (cheap, correct):** ARM **permission check** — not a live token mint.
  For ARM-RBAC backends, resolve whether `uami-ws-<id>.principalId` has an effective
  role assignment covering the target scope + dataAction. Use
  `getWorkspaceUami()` + `evaluateWorkspaceGrant()` (I2), which reads the role
  assignments we created — so the check is "did I2 grant this?" verified against
  live ARM (`role assignment list` at scope), cached per (workspaceId, backend).
- **Data-plane backends (Synapse/ADX/Cosmos):** the "would" answer is "does the
  external user / principal exist with the needed role" — resolved from the same
  provisioning receipts (I2) + a periodic real probe, not per call (too costly).
- The recorded `divergence = true` when the **shared UAMI succeeded but the
  workspace UAMI would have been denied** (the migration-blocking case) — the exact
  analog of PDP `legacyAllowed !== effect`.

**Files / paths.**
- `apps/fiab-console/lib/azure/workspace-identity-shadow.ts` (NEW) —
  `recordIdentityShadow({workspaceId, backend, scope, action, sharedAllowed:true,
  wsWouldAllow})` → writes ONE `_auditLog` row via `auditLogContainer()`. Row
  shape parallels `pdp.shadow`: `{ kind:'identity.shadow', itemId:workspaceId,
  tenantId, who, at, ts, workspaceId, backend, scope, action, wsIdentity:uamiName,
  wsWouldAllow, divergence, reason, details }`. Swallow all errors.
- Instrument the credential factory (I5): when `LOOM_WORKSPACE_IDENTITY_MODE=shadow`,
  after the shared-UAMI call path resolves the credential for a workspace context,
  fire `recordIdentityShadow(...)` (async, non-blocking). Concentrating the hook in
  the factory (not 217 call sites) is why I5 must land first/with I3.
- Sampling / cost guard: `LOOM_WS_IDENTITY_SHADOW_SAMPLE` (0..1, default 1.0) to
  cap `_auditLog` write volume on hot paths.
- **Retention + classification (rev 2, SRE F8 — REQUIRED):** an
  `identity.shadow` row is a **map of where least-privilege isn't yet satisfied**
  — access-decision recon data. (a) Set a **TTL on `identity.shadow` rows (90d,
  aligned to the audit-retention convention)** — and apply the same TTL decision
  to the sibling `pdp.shadow` rows in the same PR; (b) classify the shadow data
  as **"access-control sensitive — tenant-admin read only"** in the code comment
  + runbook; (c) add a test asserting the report route (I4) rejects
  non-tenant-admin sessions.

**Backend / infra.** Reuses the `_auditLog` Cosmos container — no new container
(per the PDP precedent). **Capacity note (rev 2, SRE F10):** quantify the RU
delta — at sampling 1.0 and X workspace-context calls/s, shadow writes ≈
(calls/s × ~5 RU) on the SAME account that also absorbs E2 eval writes + C3
rules + V1 run summaries; state the combined headroom + the sampling value
chosen for each estate in the PR (the `LOOM_WS_IDENTITY_SHADOW_SAMPLE` lever is
the mitigation and must ship quantified, not default-blind).

**Env vars / gate.** `LOOM_WS_IDENTITY_SHADOW_SAMPLE` (optionalDefault `1.0`).
No new gate (folds under `svc-workspace-identity`).

**Acceptance + E2E receipt.** With mode `shadow`: exercise a real data-plane call
that carries a workspace (e.g. `GET /api/items/lakehouse/<id>/tables` in a
workspace with a provisioned UAMI but a DELIBERATELY missing grant) → response
succeeds (shared UAMI, unchanged) AND `GET /api/admin/pdp/shadow-report?...`
(extended, I4) shows an `identity.shadow` row with `divergence:true`. **Receipt:**
the API response + the shadow row JSON. Negative case: a workspace whose grants are
complete → `divergence:false`. Vitest: `workspace-identity-shadow.test.ts` asserts
row shape + never-throws on a Cosmos error.

**Per-cloud.** Store + query are cloud-invariant (Cosmos via `cosmosSuffix()`).
Run the divergence E2E in Commercial + GCC-High. IL5: same, in-sub Cosmos.

---

### I4 — Shadow-report UI: identity-divergence view

**Goal.** Extend the existing PDP shadow report (route + UI) with an identity tab so
an operator can vet per-workspace identity divergence before enforcing — the exact
migration tool the PDP report is for authz.

**Files / paths.**
- `app/api/admin/pdp/shadow-report/route.ts` — either extend to also query
  `kind:'identity.shadow'` (add `?kind=identity` param) OR add a sibling
  `app/api/admin/identity/shadow-report/route.ts` reusing the same tenant-admin
  guard + tally helpers. **Recommendation:** sibling route, shared helper module,
  so the two report shapes stay independent but the admin surface is one page.
- Admin UI (rev 2 — named explicitly per consistency 6b): the PDP shadow surface
  is **`lib/components/admin/pdp-shadow-report-card.tsx`, rendered as a TAB on
  `/admin/permissions`** (added by PR #2386 — not a standalone page). Add the
  "Identity" segmented tab there.
  Columns: workspace, backend, scope, action, wouldAllow, divergence, when. Filters
  `divergentOnly`, `byWorkspace`, `byBackend`. Per `web3-ui.md` + `ux-standards.md`:
  Fluent v9 + Loom tokens, `EmptyState` when zero rows, skeletons, type-badged
  columns, no raw table butting borders.
- A per-workspace **readiness rollup**: "Workspace X — N calls observed, 0
  divergences over 14 days → ready to enforce" surfaced as the CTA that launches I6.

**Backend / infra.** None new.

**Env vars / gate.** None.

**Acceptance + E2E receipt.** Browser E2E (G1, minted admin session): open Admin →
Shadow Report → Identity tab; with seeded `identity.shadow` rows, the table renders
with real counts, `divergentOnly` filter works, the readiness rollup shows the
right verdict. **Receipt:** screenshot (dark + light) + the network response body.
Narrow-width pass (badge wrap) + empty-state pass on a fresh tenant.

**Per-cloud.** UI is cloud-invariant. Verify the report renders in GCC-High
(the gov console) via the `gov-bff-verify` minted-cookie harness.

---

### I5 — Per-workspace credential factory (the interface change)

**Goal.** Replace the ~217 module-level `const credential = …` singletons with a
**workspace-context-aware credential resolver** so a client can mint the right
identity per request, behind `LOOM_WORKSPACE_IDENTITY_MODE`. This is the load-bearing
refactor; everything else rides on it.

**Design.**
- `apps/fiab-console/lib/azure/workspace-credential-factory.ts` (NEW) — the public
  interface:
  ```ts
  export interface CredentialContext { workspaceId?: string; }
  export async function credentialFor(ctx?: CredentialContext): Promise<TokenCredential>;
  ```
  Behavior by `workspaceIdentityMode()`:
  - `off` → always `uamiArmCredential()` (today's exact behavior; zero cost, no ARM
    lookup).
  - `shadow` → `uamiArmCredential()` (call runs as shared UAMI) **and** fires
    `recordIdentityShadow(...)` (I3) when `ctx.workspaceId` is present. Returns the
    shared credential — behavior unchanged.
  - `enforce` → `getWorkspaceCredential(ctx.workspaceId)` when the workspace's
    per-workspace enforce flag is on (I6) AND its UAMI exists; else shared UAMI
    (fail-safe, logged). Reuses the existing `getWorkspaceCredential`.
  - Per-workspace credential caching (LRU keyed by workspaceId, short TTL) so
    enforce mode doesn't ARM-lookup every request. **Cache-key guard (rev 2,
    SRE F14 — the one guard the confused-deputy review demanded): the LRU MUST
    key strictly on `workspaceId` and MUST NEVER fall back to a *different*
    workspace's cached credential on a collision/miss — add a unit test proving
    a miss mints/looks-up fresh rather than returning a neighbor's entry.**
    (F14 verdict, recorded: shadow mode does a cached ARM permission check, not
    a second token mint — no doubled token traffic and no delegation confusion;
    the LRU key is the only guard needed.)
- **Adoption ratchet (not a big-bang):** add a `check-workspace-credential-adoption.mjs`
  CI script (mirroring the existing `scripts/ci/check-*-sync.mjs` pattern) that
  counts direct `new ChainedTokenCredential(new AcaManagedIdentityCredential()…)`
  constructions in `lib/azure/*` and **ratchets the number down** — new code must
  use `credentialFor()`; the floor decreases as clients migrate (same mechanic as
  the vitest coverage-floor ratchet in commit `14a16d8e`). Clients that never carry
  a workspace context (pure admin/ARM-plane: cost, defender, monitor-cluster) may
  stay on `uamiArmCredential()` and are allow-listed.
- **Threading the workspace context:** BFF item routes already resolve
  `workspaceId` (item docs carry it). The factory reads it from the route; where a
  client is called without one, `ctx` is undefined → shared UAMI (safe). The
  migration is per-client, driven by the ratchet, prioritising the lake/Synapse/ADX
  clients (the ones with a real per-workspace scope).

**Files / paths.** New factory + CI script above;
`lib/azure/workspace-identity-client.ts` (`getWorkspaceCredential` — reused, may add
LRU); high-value clients migrated first: `adls-client.ts`, `synapse-sql-client.ts`,
`kusto-client.ts`, `cosmos-data-client.ts`.

**Backend / infra.** None (pure app-layer).

**Env vars / gate.** `LOOM_WORKSPACE_IDENTITY_MODE` (I1). No new gate.

**Acceptance + E2E receipt.**
1. Unit: `credentialFor({})` in `off` mode `=== uamiArmCredential()` shape (no ARM
   call) — proves zero-regression default.
2. `shadow` mode with a workspaceId fires exactly one shadow write, returns shared
   cred (spy assertion).
3. `enforce` mode with a provisioned UAMI + per-ws flag returns a
   `ManagedIdentityCredential` whose clientId === the ws UAMI (I2 grants let it
   actually read) — **real-data E2E:** in a workspace flipped to enforce, `GET
   /api/items/lakehouse/<id>/tables` returns real table rows minted by the ws UAMI
   (Receipt: response body + the ADLS request in `read_network_requests` showing the
   ws principal via a server-log correlation id).
4. CI ratchet script passes and the count is strictly below the previous floor.

**Per-cloud.** Factory is cloud-invariant (it composes `@azure/identity` +
`getWorkspaceCredential`, both cloud-agnostic). Enforce-mode real-data E2E must run
in Commercial AND GCC-High (the ACA MI endpoint + `ManagedIdentityCredential({clientId})`
both work in gov ACA). IL5: same code path, in-VNet.

---

## PHASE B — Enforce (opt-in per workspace, with migration safety)

### I6 — Per-workspace enforcement flag + admin UI + gate

**Goal.** Let an operator flip a *single* workspace from shadow to enforce (mint the
workspace UAMI for real), independently of the global mode, with a one-click Fix-it
wizard. Global `LOOM_WORKSPACE_IDENTITY_MODE=enforce` is the "all workspaces" switch;
the per-workspace flag is the safe, incremental path. **Rev-2 precondition: I6
does not flip for ANY workspace until the I9 threat-model/AppSec review is
signed off (in addition to the ≥2-weeks-clean-shadow gate).** **Round-3 Q4,
CONFIRMED: I6 stays opt-in** — the deliberate carve-out from
`loom_default_on_opt_out` is correct here (a blast-radius security-posture
change needs operator intent + the ATO review, like PDP-enforce).

**Files / paths.**
- `apps/fiab-console/lib/types/workspace.ts` — `workspaceIdentity.enforce?: boolean`
  + `enforceAt?`, `enforceBy?`.
- `app/api/admin/workspaces/[id]/identity/route.ts` (NEW) — GET (status + readiness
  rollup from I4), POST `{enforce:true|false}` (tenant-admin only; on enable,
  preflight I7 grant-check; persist flag). Structured `{ok,data,error}`.
  **Audit requirement (rev 2, SRE F7 — ATO):** the POST is a security-posture
  change — every toggle writes an `_auditLog` row via `auditLogContainer()`:
  `{ kind:'identity.enforce', who, oid, action:'enable'|'disable', workspaceId,
  prior, next, ts }`. Reviewer rejects the PR without the audit row in the G1
  receipt.
- Admin workspace settings surface — an "Identity" panel: current mode, provisioned
  UAMI + grants (with per-grant green/red), the 14-day divergence rollup, and the
  **Enable enforcement** button (disabled with an inline reason until grant-check +
  zero-divergence pass). Per `ux-standards.md` G2: this IS the Fix-it wizard for the
  `svc-workspace-identity` gate.
- `lib/gates/registry.ts` — `svc-workspace-identity` `fixit.kind:'wizard'` points
  here; Admin gate page lists it.

**Backend / infra.** None new (flag on the Cosmos doc).

**Env vars / gate.** Per-workspace flag is data, not env. Global env `…_MODE` (I1).

**Acceptance + E2E receipt.** Browser E2E: on a workspace with complete grants + 0
divergences, click Enable enforcement → flag persists, subsequent lakehouse read is
served by the ws UAMI (Receipt: screenshot of the panel post-enable + the real table
data). Negative: a workspace with an incomplete grant shows the Enable button
disabled with the exact missing grant named (honest gate, no red on first open).

**Per-cloud.** Commercial + GCC-High live. IL5 design-only (same shapes).

---

### I7 — Migration runbook + grant-check preflight + rollback

**Goal.** A repeatable, reversible procedure to move a workspace (or a whole
deployment) shadow → enforce, with a preflight that refuses to flip a workspace whose
grants are incomplete, and an instant rollback.

**Deliverables.**
- `docs/fiab/runbooks/workspace-identity-migration.md` — the runbook: (1) set global
  `…_MODE=shadow`, (2) let shadow run N days, (3) review I4 report per workspace,
  (4) run grant-check preflight, (5) flip per-workspace enforce (I6), (6)
  smoke-test, (7) rollback = set `enforce:false` (instant; next request falls back
  to shared UAMI via the factory fail-safe).
- `apps/fiab-console/lib/azure/workspace-identity-preflight.ts` (NEW) —
  `preflightWorkspaceEnforce(ws)` → `{ ready:boolean, missingGrants:[], divergences:N,
  observedCalls:N }`. Real ARM + data-plane probes (no mocks). Called by I6's POST
  and exposed as `GET /api/admin/workspaces/[id]/identity` readiness.
- Bulk tool: `scripts/csa-loom/workspace-identity-enforce.mjs` — enumerate
  workspaces, print readiness, `--apply` to flip the ready ones (idempotent).

**Rollback guarantee.** Because the factory's `enforce` branch fail-safes to the
shared UAMI when the flag is off or the UAMI/ grant is missing, `enforce:false`
restores prior behavior on the very next request — no redeploy, no token cache to
bust beyond the LRU TTL (document the TTL as the max rollback latency).

**Acceptance + E2E receipt.** E2E: flip a ready workspace, break a grant (revoke the
container role in ARM), observe the next read **fails closed** in enforce mode (the
ws UAMI genuinely lacks access — this is the point), then `enforce:false` → read
succeeds again via shared UAMI within the TTL. **Receipt:** the two API responses +
the `az role assignment delete` command + timestamps proving rollback latency.

**Per-cloud.** Runbook has a per-cloud appendix: Commercial (portal/CLI), GCC-High
(gov CLI endpoints + ACA-job execution), IL5 (in-VNet only, no public ARM).

---

### I8 — Limits, scale, cost + blast-radius analysis (honest)

**Goal.** Document the real ceilings so an operator sizes deployments correctly and
the PRP doesn't over-promise. All figures grounded in Microsoft Learn (cited).

**The binding constraint — RBAC role assignments per subscription = 4,000 (fixed,
cannot be increased).** (Learn: *Troubleshoot Azure RBAC limits* / *azure-subscription-service-limits#azure-rbac-limits*.)
- A per-workspace UAMI with ARM-RBAC grants costs **1 role assignment per ARM-RBAC
  backend**. With ADLS-container as the only ARM-RBAC grant (Synapse/ADX/Cosmos are
  data-plane, *not* ARM role assignments — this is why I2 deliberately uses
  data-plane grants where possible), that's **~1 assignment / workspace** → ~4,000
  workspaces per subscription before the cap, minus existing platform assignments.
  If a workspace also takes Event Hubs + Monitor + KV ARM grants (3 more), the
  effective ceiling drops to ~800–1,000 workspaces/sub.
- **Mitigations (documented, choose per scale target):**
  1. **Prefer data-plane grants** (Synapse external users, ADX db principals,
     Cosmos data-plane role assignments — the last do NOT count against the 4,000
     ARM cap) over ARM RBAC wherever the backend supports it. *(This is the design
     choice already reflected in I2.)*
  2. **ABAC path-prefix conditions on a shared container role** instead of one role
     assignment per container — Learn's canonical "scale to thousands of principals"
     pattern (*conditions-custom-security-attributes-example*: 256k logical grants
     collapsed via ABAC). One shared Storage Blob Data role assignment per lake +
     an ABAC condition keyed on a custom security attribute / path prefix per
     workspace UAMI → removes the per-workspace ARM assignment entirely.
  3. **Group-based assignment** — assign roles to an Entra group, add workspace
     UAMIs to the group (assignment count independent of member count).
  4. **Additional subscriptions / per-domain sharding** — the workspace-identity.bicep
     already documents per-DOMAIN lakes for the 200-`resourceAccessRules`/account
     firewall cap; the same sharding relieves the 4,000-RBAC cap.
- **Storage firewall:** ≤ **200 `resourceAccessRules` per storage account** (already
  documented in the bicep) → per-domain shared lakes (200 ws × ~300 domains ≈ 60k
  workspaces). Trusted-workspace-access rules are the second scaling axis.
- **UAMI REST throttling** (Learn: *workload-identity-federation-considerations#throttling-limits*):
  create/update **2 req/s per subscription, 0.25 req/s per resource**; 429 on
  breach. → I1 provisioning must be **queued/backoff** for bulk topology deploys,
  not a tight loop. There is no hard cap on the *count* of UAMIs per subscription,
  only this creation throttle.
- **ARM write throttle (rev 2 addition, SRE F16 — Learn:
  *request-limits-and-throttling*):** the general per-subscription-per-SP ARM
  **write** bucket is ≈ **200 requests, refilling ~10/s** (token-bucket).
  Provision-on-create does multiple ARM writes per workspace (UAMI PUT +
  role-assignment PUT + optional firewall rule), so bulk topology deploys hit
  ARM write throttling **in addition to** the MI-specific throttle above. I1's
  queue/backoff must cite BOTH limits; the sizing table includes a
  "workspaces provisionable per hour" row derived from them.
- **Federated identity credentials** as an alternative to more UAMIs: a single UAMI
  can carry multiple FICs, but FICs solve external-workload trust, not per-workspace
  Azure-scope isolation — **not a fit here**; note and dismiss.
- **Cost:** UAMIs are free; role assignments are free; the marginal cost is (a)
  `_auditLog` Cosmos RUs for I3 shadow writes (mitigate with
  `LOOM_WS_IDENTITY_SHADOW_SAMPLE`) and (b) ARM permission-check calls in enforce
  mode (mitigate with the LRU cache in I5). Quantify: at 1.0 sampling and X calls/s,
  RU/s ≈ (writes/s × ~5 RU). Provide a sizing table.
- **Blast-radius delta (the security payoff):** shared UAMI = one identity with
  lake-wide + Synapse-admin + ADX-admin + constrained-RBAC-admin scope (compromise =
  all workspaces). Per-workspace enforce = compromise of a workspace-scoped BFF path
  reaches only that workspace's container + database. Quantify as "N workspaces →
  1/N data blast radius per compromised workspace context."

**Deliverable.** `docs/fiab/workspace-identity-scale.md` with the ceilings table, the
mitigation decision tree (which lever at 100 / 1k / 10k / 60k workspaces), and the
cost/RU sizing table. No code; this is the honest-limits artifact the PRP cites.

**Per-cloud.** Caps are cloud-invariant (4,000 RBAC / 200 rules / MI throttle apply
in Gov identically). Note only that Gov subscriptions are often more numerous/smaller
(per-agency), which *helps* the per-subscription cap.

---

### I9 — Threat model + AppSec review gate (precondition to I6) *(NEW, rev 2 — SRE F12)*

**Goal.** Section I carries a solid one-paragraph threat model, but the *new*
attack surfaces this PRP adds have no abuse-case artifact, and nothing gated a
security review before I6 flips a live workspace onto enforcement. I9 closes
that: a short, written **STRIDE threat model** covering the program's new
endpoints + credentials, and an **AppSec review sign-off that is a hard
precondition to I6** (alongside the existing "≥2 weeks clean shadow" gate).

**Scope of the threat model (minimum):**
- The L2 OpenLineage ingest (per-pool credential, workspace scoping, caps —
  verify the F2 redesign held in implementation).
- The new Functions (E2 evaluator, C3 anomaly monitor, L3 extractor, S1 secret
  monitor): identity posture (no storage keys — F6), role scopes, HTTP-trigger
  exposure.
- The V1 synthetic-login automation credential (CA exception, rotation,
  unexpected-use alerting — verify F13 held).
- The identity shadow store (`identity.shadow` recon sensitivity, TTL,
  tenant-admin-only read — verify F8 held).
- The I5/I6 enforce path (fail-safe fallback, LRU key guard, audit rows).

**Deliverables.** `docs/fiab/security/loom-next-level-threat-model.md` (STRIDE
table per surface, abuse cases, mitigations mapped to the shipped controls) + a
recorded review sign-off (reviewer, date, findings, disposition) referenced from
the I7 runbook. Any HIGH finding blocks I6 until dispositioned.
**Round-3 note (Q6 — partial I9 pulled forward):** the **L2 ingest** and **E2
Function** rows of this threat model are written + signed **in their own PRs
at Phase 0–1** ("ships with its threat-model row signed" acceptance lines on
L2 and E2), because those internet-adjacent surfaces land Phases 0–2 while I9
is Phase 3. I9 incorporates those pre-signed rows (verifying they held in
implementation) rather than authoring them retroactively; the FULL review
remains the pre-I6 gate.

**Acceptance.** Doc merged; sign-off recorded; I6's admin panel shows
"Security review: signed-off <date>" as part of the enforce-readiness rollup
(the Enable button stays disabled without it).

**Per-cloud.** One artifact covers both estates (call out Gov-specific deltas —
`.us` endpoints, gov SP scopes); IL5 posture is covered by the X-IL5 checklist
answers each item already carries.

---

# SECTION X — Cross-cutting cloud matrix (whole-PRP reference)

> **Rev-2 numbering:** buildable items are **X1, X2, X3**. The grounding note,
> the availability matrix (X-MATRIX), and the IL5 checklist (X-IL5) are
> reference blocks.

## X grounding — endpoint/suffix handling, current state

**There is already a central cloud-config module:**
`apps/fiab-console/lib/azure/cloud-endpoints.ts` (see §0.6). It is mature and
well-tested (`cloud-endpoints.test.ts`, `cloud-matrix.test.ts`). Detection:
`detectLoomCloud()` → `Commercial | GCC | GCC-High | DoD` from `LOOM_CLOUD`
(fallback `AZURE_CLOUD`); `isGovCloud()` for the binary; per-service getters for
every suffix/scope. It also owns the honest Fabric-family + DLP gates.

**Therefore X1 is an adoption ratchet, not a build.** The remaining risk is
*straggler literals* — clients that still hard-code `management.azure.com` /
`*.windows.net` / a Commercial scope instead of importing a helper.

---

### X1 — Cloud-config adoption ratchet (drive out straggler literals)

**Goal.** Guarantee every sovereign-variant literal flows through
`cloud-endpoints.ts`, and keep it that way with a CI ratchet — so a new client
can't silently break Gov by hard-coding a Commercial host.

**Files / paths.**
- `scripts/ci/check-cloud-endpoint-literals.mjs` (NEW) — grep `lib/azure/**` +
  `app/api/**` for the forbidden literal set (`management.azure.com`,
  `vault.azure.net`, `servicebus.windows.net`, `dfs.core.windows.net`,
  `kusto.windows.net`, `search.windows.net`, `documents.azure.com`,
  `database.windows.net`, `api.loganalytics.io`, `cognitiveservices.azure.com`,
  `graph.microsoft.com`, `openai.azure.com`, `analysis.windows.net`,
  `blob.core.windows.net`, `.batch.azure.com` audience, etc.) OUTSIDE
  `cloud-endpoints.ts` itself and its tests. Maintain an allow-list of intentional
  occurrences (comments, the `@deprecated SEARCH_AAD_SCOPE`). **Ratchet the count
  down** (same mechanic as I5 / the vitest-floor commit `14a16d8e`); floor starts at
  today's count and only decreases.
- Wire into the existing `scripts/ci/check-*-sync.mjs` gate lane.

**Backend / infra.** None.

**Env vars / gate.** None (pure CI).

**Acceptance + E2E receipt.** CI job runs green; deliberately adding
`https://management.azure.com` in a non-allow-listed client fails the job (Receipt:
the failing + passing CI logs). A Gov smoke (`gov-bff-verify`) confirms no
Commercial host is reached on a default gov path.

**Per-cloud.** The ratchet protects all clouds at once. No per-cloud variance.

---

## X-MATRIX — Service availability matrix (REFERENCE block — not a numbered item; formerly "X.2")

Legend: ✅ available · ⚠️ available with limits/variance · ❌ not available →
**Loom fallback** column names the honest gate or Azure/OSS substitute. GCC-High =
FedRAMP High / `AzureUSGovernment`. IL5 = DoD IL5 (`AzureUSGovernment`, air-gapped
posture). Citations are Microsoft Learn unless noted; where a fact is already
encoded in `cloud-endpoints.ts` that is noted as the in-repo source of truth.

| Service (PRP use) | Commercial | GCC-High | IL5 | Loom fallback / handling |
|---|---|---|---|---|
| **Managed identity + RBAC** (Section I) | ✅ | ✅ (GA in Gov) | ✅ | Core; cloud-invariant GUIDs. |
| **ADLS Gen2 / Synapse / ADX / Cosmos / Event Hubs / Key Vault** (I2 backends) | ✅ | ✅ | ✅ | Suffixes via `cloud-endpoints.ts`. All GA through IL5. |
| **Playwright on ACA** (UAT / E2E harness) | ✅ | ✅ | ✅ (in-VNet) | ACA (Container Apps) is GA in Azure Gov; gov E2E already runs as **ACA Container App Jobs** in-VNet (`gov-provision-dbx-sql-invnet.yml`), not public Playwright. IL5: in-VNet job only, no public endpoint. |
| **Azure Monitor alerts / action groups** (activator, cost alerts) | ✅ | ✅ | ✅ | Azure Monitor "enables the same features in both Azure and Azure Government" (Learn: *compare-azure-government#management-and-governance*). Monitor scheduled-query alerts = the activator Azure-native backend. |
| **Cost Management + Query/Forecast API** (cost/chargeback WS) | ✅ | ✅ (GA FedRAMP High→IL5) | ✅ | Cost Management GA through IL5 (Learn: *documentation-government-product-roadmap*). Forecast is the Query/Forecast REST API (Learn: *cost-management-automation-scenarios*). **Not available:** Cost Management for CSPs, and the Cost Management **Power BI template app** (Learn: *analyze-cost-data…-power-bi-template-app* — "not supported in Azure Government"). Fallback: use the REST Forecast/Query API + Loom-native rendering, never the PBI template app. |
| **Azure Budgets** (cost WS) | ✅ | ✅ | ✅ | Part of Cost Management; GA in Gov. |
| **AOAI models** (copilot / model router) | ✅ (full catalog) | ⚠️ reduced catalog + region lag | ⚠️/❌ per-model | AOAI IS in Gov (`openai.azure.us`, `cognitiveservices.azure.us` via `cogScope()`/`getOpenAiSuffix()`) but the **model/version catalog lags Commercial**. Fallback: the tier-router already selects available models; add an availability probe (X3) so an unavailable model renders an honest gate naming the Gov-available substitute. Verify exact model list per deployment at implementation. |
| **Azure Maps** (network/topology maps) | ✅ | ⚠️ FedRAMP High/IL4/IL5 in compliance scope | ⚠️ | Compliance scope lists Azure Maps ✅ through IL5, but Loom ships an **OSS MapLibre tile server** substitute in Gov (`gov-provision-maps.yml`) to avoid the account/region variance. Fallback = MapLibre (already built). |
| **Azure Analysis Services (AAS)** (semantic-model DirectQuery) | ✅ | ❌ | ❌ | `cloud-endpoints.ts` `aasScope(serverUri)` **throws** in Gov. Fallback = **Loom-native semantic layer** (`LOOM_SEMANTIC_BACKEND=loom-native`, the default) — no Fabric/PBI/AAS needed. |
| **Purview (classic Data Map)** (governance) | ✅ | ✅ | ✅ | Classic Data Map GA in Gov; note the Gov empty-privatelink-DNS-zone gotcha (memory `csa_loom_gov_purview_dns_empty_zone`). Unified-catalog data products are Commercial-only → classic-only path in Gov (already handled in `purview-client.ts`). |
| **Azure Managed Grafana** (dashboards) | ✅ | ✅ (FedRAMP High GA) | ❌ (IL4/IL5 not in scope) | Compliance scope: Grafana ✅ FedRAMP High + DoD IL2, **blank IL4/IL5** (Learn: *azure-services-in-fedramp-auditscope*). **Enterprise plugins & Essential tier NOT supported in Gov** (Learn: *managed-grafana/known-limitations#feature-availability-in-sovereign-clouds*). Fallback IL5: OSS Grafana self-hosted in-cluster, or Loom-native dashboards over ADX (`kql-dashboard-model`). |
| **Application Insights / RUM** (telemetry) | ✅ | ✅ | ✅ | App Insights + Log Analytics part of Azure Monitor, GA through IL5/IL6 (Learn: *azure-services-in-fedramp-auditscope*). Endpoint suffix differs → connection-string endpoint-suffix (Learn: *compare-azure-government*). **Browser RUM/CDN script** must be self-hosted in IL5 (no public CDN — see X-IL5; RUM1 in WS-O builds it). |
| **Cosmos continuous backup / PITR** (BCDR) | ✅ | ✅ | ✅ | Continuous backup + point-in-time restore GA in Azure Gov. **Round-3 Learn wrinkle: `Continuous30Days` is the GA default; `Continuous7Days` is documented "in preview" — and the repo currently runs 7-day. DR0/DR1: prefer `Continuous30Days` (GA) for the drill window; confirm the 7-day tier's Gov-region support or move to 30-day.** |
| **Microsoft Fabric / Power BI** (opt-in only) | ✅ (opt-in) | ❌ Fabric / ⚠️ PBI (`api.powerbigov.us`) | ❌ | `assertFabricFamilyAvailable()` throws with the Azure-native equivalent. Never on a default path (`no-fabric-dependency.md`). |
| **Microsoft Graph DLP policy API** (governance) | ✅ | ❌ (`/beta/security/dataLossPreventionPolicies`) | ❌ | `graphDlpPolicyApiAvailable()` = false in Gov. Fallback: Purview compliance portal + Security & Compliance PowerShell; DLP **alerts** + restrict-access RBAC still work. |
| **Azure Digital Twins** (graph/twin surfaces) | ✅ | ❌ (not in GCC-High) | ❌ | Encoded as `legacyCode` prose today (`svc-digital-twins`); fallback = Loom AGE/graph over Postgres/ADX. X2 structures this. |
| **Databricks SQL** (warehouse) | ✅ | ⚠️ region-limited | ⚠️ | Not in all Gov regions (`svc-databricks-sql` note). Fallback = Synapse dedicated SQL. |

> **Action:** every ❌/⚠️ row that is currently only free-text prose in ENV_CHECKS
> must become a structured `availability` field (X2) so the honest gate is
> automatic, not hand-maintained per surface.

---

### X2 — Availability-gate convention (structured cloud availability → auto honest-gate) *(formerly "X.3"; rev 2: lands in Phase 0, BEFORE every other env-adding item, so all later EnvSpecs adopt `availability` on first write)*

**Goal.** Turn the matrix above into data. Add a structured per-service availability
descriptor keyed to cloud detection, so any feature whose backend is unavailable in
the active cloud renders an honest gate **automatically** — no per-surface `if
(isGovCloud())` sprinkling, no stale prose.

**Files / paths.**
- `apps/fiab-console/lib/admin/env-checks.ts` — extend `EnvSpec` with an optional
  `availability?: { commercial: Avail; gccHigh: Avail; il5: Avail; fallbackNote?: string }`
  where `type Avail = 'ga' | 'limited' | 'unavailable'`. Backfill the ~10 services
  in the X-MATRIX that today carry only prose/legacyCodes (`AAS_NOT_IN_GOV`, Grafana IL5,
  ADT, Databricks-SQL, DLP-policy, Fabric/PBI, Cost-CSP, AOAI-model-lag).
- `apps/fiab-console/lib/gates/registry.ts` — add `availabilityFor(id)` +
  `isAvailableInActiveCloud(id)` using `detectLoomCloud()`; `gateStatus(id)` returns
  a new `state:'cloud-unavailable'` (distinct from `missing`) carrying the
  `fallbackNote`. `GateDef` gains `availability` passthrough.
  **`'limited'` rendering (round 3, guess-risk clarification — verbatim):**
  `'limited'` renders the surface **normally** PLUS a **non-blocking info
  note** sourced from `fallbackNote` (e.g. AOAI-model-lag,
  Databricks-SQL-region-limited); **only `'unavailable'` produces the
  `cloud-unavailable` gate.** Two agents must not treat `'limited'` as a gate.
- `apps/fiab-console/lib/components/shared/honest-gate.tsx` — when a gate is
  `cloud-unavailable`, render the honest MessageBar **naming the Azure-native/OSS
  fallback** (from `fallbackNote`) with NO Fix-it that would try to provision an
  impossible resource — instead a "Use the Loom-native equivalent" CTA. This keeps
  G2 (no bare remediation bar) satisfied while being honest that the gate is
  cloud-structural, not a config miss.
- The cross-item Copilot gate-discovery + the Admin gate-registry page automatically
  pick these up (they already read the registry).

**Backend / infra.** None (declarative + UI).

**Env vars / gate.** None new; this *classifies* existing gates.

**Acceptance + E2E receipt.** With `LOOM_CLOUD=gcc-high`, open a surface backed by
AAS / Grafana(IL5) / ADT → the honest gate renders automatically naming the
fallback, with no broken Fix-it. Same surface in `LOOM_CLOUD=commercial` renders
normally. **Receipt:** two screenshots (gov + commercial) + the `gateStatus` JSON
showing `state:'cloud-unavailable'`. Vitest: `cloud-matrix.test.ts` extended to
assert `availabilityFor()` matches the X-MATRIX table for each service in each cloud.

**Per-cloud.** This item *is* the per-cloud mechanism; validated by toggling
`LOOM_CLOUD` in tests + a live gov render.

---

## X-IL5 — IL5 / air-gap design-constraint checklist (REFERENCE block — formerly "X.4"; every PRP item answers these)

Every item in the master PRP (Section I included) must answer this checklist in its
"IL5 (design-only)" column. It is the acceptance gate for the air-gap posture; no
live IL5 sub exists, so these are documentation-verified, not E2E'd.

1. **No public endpoints.** Every backend the item calls is reachable via Private
   Endpoint only; no call resolves to a public host. (Cross-check against X1's
   literal ratchet + the `pe-subresource-groups.ts` PE map.)
2. **Private DNS.** Each PE has its `privatelink.*.usgovcloudapi.net` zone; beware
   the **empty-zone-shadows-public** gotcha (memory `csa_loom_gov_purview_dns_empty_zone`)
   — an empty privatelink zone silently breaks resolution. Item states which zones
   it needs.
3. **Offline artifact / corpus delivery.** Any content the item ships (copilot
   corpus, docs index, templates, container images) is delivered **inside the image
   / ACR** (memory `csa_loom_inproduct_copilot_corpus_fix` — corpus-not-in-image is
   a known failure), never fetched from a public URL at runtime.
4. **No external CDN / telemetry.** No public CDN scripts, fonts, RUM beacons, or
   third-party telemetry. Browser RUM must be self-hosted; the CSP must not require a
   public origin (memory `csa_loom_csp_nonce_frontdoor_breaks` — keep it working
   without external hosts). App Insights ingestion uses the Gov endpoint suffix.
5. **Cert / CA handling.** Item states any custom CA trust it needs (private CA for
   in-VNet TLS); no dependency on a public CA-only endpoint. Synapse/SQL JDBC uses
   the sovereign `hostNameInCertificate` (`synapseSqlJdbcHostCert()` already handles
   this).
6. **Deployment without GitHub.** Every GitHub-workflow step the item relies on has a
   **script/azd parity** so it can run from an air-gapped runner: the `gov-*.yml`
   workflows already use `Azure/login@v2` + `az` with Gov endpoints and **ACA
   Container App Jobs** for in-VNet execution — the item names the equivalent
   `scripts/csa-loom/*.mjs` or `az` sequence. (No GitHub-hosted runner reaches an
   air-gapped sub.)
7. **No cross-cloud identity federation.** Item's identities (incl. Section I's
   per-workspace UAMIs) live entirely within the sovereign tenant; no FIC/trust to a
   Commercial IdP.

---

### X3 — Per-cloud CI validation lanes (how new features plug into gov validation) *(formerly "X.5" — a real, load-bearing buildable item the rev-1 master neither counted nor phased; it is the gov E2E receipt for I1–I3)*

**Goal.** Every new feature (including Section I) gets validated in Gov, not just
Commercial, via the existing gov workflow fleet — specify the plug-in points so a
PR author knows exactly which lane exercises their surface.

**Current gov CI fleet (21 `gov-*.yml`), grouped:**
- **Deploy / roll:** `deploy-gov.yml` (full infra), `gov-console-roll.yml` (image
  build + roll), `gov-apply-env.yml` (set env on the live `loom-console`).
- **Verify (read-only, minted-cookie):** `gov-gates.yml` (`GET /api/admin/gates` →
  score + blocked list), `gov-bff-verify.yml` (governance BFF probes),
  `gov-selfaudit.yml` (full self-audit), `gov-discover.yml` (resource discovery).
- **Deep functional (real backend):** `gov-exercise.yml` (mints admin session,
  two-phase real-backend probes: SQL/ADX/ADLS/Cosmos/AOAI/ADF then Spark),
  `gov-purview-verify.yml`.
- **Incremental provisioners:** `gov-provision-{aisearch,dbt,dbx-sql,dbx-sql-invnet,
  graph-grants,maps,mongo,posture,wrangler}.yml`, `gov-dataverse.yml`,
  `gov-uc-purview-wire.yml`, `gov-waf-cookie-exclusion.yml`.
- **Auth pattern (uniform):** `Azure/login@v2` with inline creds JSON + Gov
  endpoints (`login.microsoftonline.us`, `management.usgovcloudapi.net`),
  `environment: AzureUSGovernment`, then `az cloud set --name AzureUSGovernment`.
  Session mint = pull `session-secret` + env off the container app, AES-mint the
  `loom_session` cookie in Node. In-VNet execution = **ACA Container App Job** on the
  console's CAE + UAMI (not a GitHub runner).

**X3 deliverable.**
- `docs/fiab/runbooks/gov-ci-plugin-guide.md` — a table: "new surface kind → which
  gov lane validates it". E.g. a new **gate/env var** → `gov-gates.yml` asserts it
  appears + resolves; a new **BFF route** → add a probe to `gov-bff-verify.yml`; a
  new **real backend** (Section I identity provisioning) → add a step to
  `gov-exercise.yml` (mint session, `POST /api/workspaces` with
  `LOOM_WORKSPACE_IDENTITY_MODE=shadow`, assert `uami-ws-*` via `az identity show`);
  an **in-VNet-only** provisioner → clone the `gov-provision-*-invnet.yml`
  ACA-job pattern.
- **Section I specifically:** add `gov-workspace-identity.yml` (NEW) modeled on
  `gov-exercise.yml`: mint admin session → create workspace in shadow mode → assert
  UAMI + grants via `az` → hit the identity shadow-report route → delete workspace →
  assert cascade. This is the gov E2E receipt for I1/I2/I3.

**Acceptance + E2E receipt.** The new `gov-workspace-identity.yml` runs green against
the live gov console (Receipt: the workflow run log showing `az identity show` 200
then 404 across create/delete). `gov-gates.yml` shows `svc-workspace-identity`
present + auto-resolved.

**Per-cloud.** This item is the per-cloud validation mechanism itself; Commercial
parity is the existing `loom-ui-verify.yml` / `loom-roll-and-validate.yml` lanes.

---

## Cross-references (for the master PRP editor)

- Section I depends on: `workspace-identity-client.ts`, `workspace-identity.bicep`
  (both exist, dormant), `pdp/enforce.ts` + `shadow-report/route.ts` (shadow-store
  precedent), `workspace-bindings.ts` (create hook), delete-cascade #2020.
- Section X depends on: `cloud-endpoints.ts` (X1 base, exists), `env-checks.ts` +
  `gates/registry.ts` (X2), the `gov-*.yml` fleet (X3).
- Rules honored: `no-fabric-dependency.md` (Azure-native defaults; Fabric/PBI/AAS
  gated), `no-vaporware.md` (real ARM/data-plane, E2E receipts), `loom_browser_e2e_before_done`
  (G1 receipts), `ux-standards.md` G2 (Fix-it wizards / gate registry) + G3, `loom_default_on_opt_out`
  (identity enforcement is the deliberate opt-in security exception, like PDP enforce).
- Rev-2 sequencing (from the master spine): **I1 → I2 → I5 → I3 → I4** (I5
  before I3 — the shadow hook lives in the credential factory, not 217 call
  sites); **I9 before I6**; I8 + X3 sit in the Phase-2/3 opportunistic bucket;
  X2 lands in Phase 0 before every other env-adding item.
- Open verification-at-implementation flags: exact AOAI model catalog per Gov region;
  Cosmos PITR tier (7 vs 30 day) per Gov region; Azure Maps account availability vs
  the MapLibre substitute decision; whether the Console UAMI already holds Managed
  Identity Contributor in `LOOM_WS_IDENTITY_RG` (else add `ws-identity-rbac.bicep`).
