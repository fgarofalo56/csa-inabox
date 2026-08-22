# ESTATE PAUSE / RESUME — a Fabric-SKU-style switch for the whole Loom estate

**Status:** DRAFT — execution-ready. Created 2026-08-22. Operator-directed, **priority #1**.
**Mandate:** Azure spend on the Loom estates rose sharply while they are used only for
test and validation. The operator wants a **one-click pause/resume modelled on pausing a
Microsoft Fabric SKU**, and a standing order that **MAC (Commercial) and MAG (Government)
stay PAUSED unless actively validating.**

---

## 1. The money — what we are actually attacking

Derived Commercial cost, **~$9,400–9,900/month** across **604 resources** in two
subscriptions (admin-plane + DLZ).

> **Every dollar in this document is DERIVED** — measured SKU × measured retail rate ×
> 730h. The Cost Management API returned HTTP 429 on all 11 attempts over ~35 minutes, so
> **no figure here is a billed amount.** Re-derive from an invoice before quoting these
> externally. Log Analytics ingestion and storage capacity are **unmeasured** and excluded.

| # | Resource | SKU | $/mo | Native pause | Tier |
|---:|---|---|---:|---|---|
| 1 | APIM | PremiumV2 ×1 | **2,800** | ❌ none at any tier | **ACCEPTED — stays up** |
| 2 | Analysis Services | S1 | 1,482 | ✅ Suspend | PAUSE |
| 3 | Synapse dedicated pool | DW100c | 1,102 | ✅ pause | PAUSE |
| 4 | Azure Firewall | Standard | 913 | ⚠️ Deallocate (PowerShell only) | **HIBERNATE** |
| 5 | ACA D8 workload profile | `minimumCount:1` | 523 | ✅ set 0 | **quick win — separate PR** |
| 6 | ACA Consumption min-replicas | 19 apps | 388 | ✅ min-replicas 0 | PAUSE |
| 7 | Front Door | Premium | ~330 | ❌ delete only | HIBERNATE |
| 8 | Analysis Services | B1 | 314 | ✅ Suspend | PAUSE |
| 9 | Redis | Premium P1 ×2 replicas | 405–607 | ❌ none | HIBERNATE |
| 10 | Purview | Standard 1 CU | 300 | ❌ floor is 1 CU | ACCEPTED |
| 11 | AI Search | Standard S1 | 245 | ❌ cannot pause | **ACCEPTED** (see §4) |
| 12 | Bastion | Standard | 212 | ❌ delete only | HIBERNATE |
| 13 | Private Endpoints ×27 | — | 197 | 🚫 **never touch** | EXCLUDED |
| 14 | VPN Gateway | VpnGw1AZ | 153 | ❌ delete only | HIBERNATE |
| 15 | VM `vm-loom-pbigw` | D2s_v5 Windows | 146 | ✅ **deallocate** | PAUSE |
| 16 | Mongo vCore | M25 | ~140 | ❌ none | ACCEPTED |
| 17 | PostgreSQL Flexible ×5 | 4×B1ms + B2s | 112 | ✅ stop ⚠️ 7-day | PAUSE |
| 18 | ADX | Dev E2a_v4 | 104 | ✅ stop | PAUSE ⚠️ §3 |

**Already $0 at idle — no action, do not "optimise" these:** 251 Stream Analytics jobs
(**zero Running**; ASA bills only when started), SHIR VMSS (capacity 0 — the idle-stop
workflow works), 5 App Service Plans (all Y1 Consumption), 2 SQL DBs (`GP_S_Gen5`
serverless, self-pausing), 2 Cosmos accounts (serverless), 3 AI Services (S0
pay-per-token, no PTUs), Batch (quota 0).

### Expected outcome
With APIM accepted, **PAUSE + HIBERNATE reaches roughly 52% of the bill.** That ceiling is
a deliberate operator decision (§2), not a limitation of the implementation.

---

## 2. Operator decisions — binding

1. **Two tiers, mirroring Fabric.**
   - **PAUSE** — native stop/suspend only. Data-safe, reversible, no deletes.
   - **HIBERNATE** — additionally deletes resources with no pause API and redeploys them
     from bicep on resume. Maximum savings; resume becomes a partial deploy.
2. **APIM is ACCEPTED, not deleted.** $2,800/mo stays. Deleting it would change the VIP
   (breaking downstream IP allowlists) and lock the name for 48h — an unacceptable trap
   for an estate that pauses and resumes often. Revisit as its own decision.
3. **PAUSED is a continuously-enforced INVARIANT, not a one-shot action** (§5).
4. **Idle auto-pause with a timer is in scope** — the Fabric behaviour. The real failure
   mode is forgetting to press pause on a Friday.
5. **Sequencing:** pause **Gov first**; pause **Commercial only after OMNIBUS Wave 0
   validates**, because Commercial auto-rolls on every merge and this program's rules
   require live in-browser G1 receipts a paused estate cannot serve.

---

## 3. THE DEFINING RISK — a stopped resource is not guaranteed startable

**Measured live, 2026-08-22, not hypothetical.** The GCC-High ADX cluster had
`enableAutoStop: true` (`adx-cluster.bicep:124`), stopped itself when idle, and then
**could not be restarted**:

```
ERROR: (InsufficientResourcesForSubscription) [BadRequest] Currently there are no
available resources to start the cluster with current SKU. Please choose different SKU
```

**Azure does not reserve your capacity while a resource is stopped.** This is the single
most important way raw Azure differs from a Fabric SKU pause, where Microsoft holds the
capacity for you. A pause you cannot reverse is not a pause; it is an outage.

### Binding requirements that follow

- **R-CAP-1.** Resume-capacity is a **precondition to be checked, never an assumption.**
  Before pausing a capacity-constrained resource (ADX, AKS, VM/VMSS, anything SKU-bound in
  a sovereign region), record the SKU **and a declared fallback SKU**.
- **R-CAP-2.** On resume failure with a capacity error, **automatically attempt the
  declared fallback SKU** and surface loudly what changed. Never silently leave it down.
- **R-CAP-3.** The UI must state, per resource, **the resume risk** before pausing —
  region-scarce SKUs are flagged. HIBERNATE requires explicit acknowledgement.
- **R-CAP-4.** Never report an unknown as a success. If resume cannot be confirmed, the
  estate state is `RESUME_FAILED`, not `RUNNING`.

---

## 3b. SCOPE SAFETY — the subscriptions are NOT Loom-only

**Measured 2026-08-22 via Resource Graph.** Of 23 pausable resources (Analysis Services,
Synapse pools, ADX, Redis, PostgreSQL Flexible, VMs) in the reachable subscriptions:

- **11** are in Loom resource groups (`rg-csa-loom-admin-centralus`, `rg-csa-loom-dlz-default-centralus`)
- **12** are in **10 unrelated resource groups**: `rg-limitlessdata-blog`, `sentinel-dev-rg`,
  `atlasdiag-rg`, `rg-atlas-renderix-dev-eastus2`, `rg-forzelite-dev-eastus2`,
  `rg-ghrunner-nasa-poc`, `rg-sandbox-demo-east2`, `rg-simplechat-dev`, `artemis-poc-rg`,
  `rg-dlz-aiml-stack-dev`

**A subscription-scoped pause would take down the operator's blog, a Sentinel dev estate,
two Atlas estates, a NASA PoC runner and a SAP HANA sandbox.** This is the single easiest
way for this feature to cause a serious incident.

### R-SCOPE-1 — never scope by subscription
The pause set is an **explicit inventory**, never "everything in the subscription".

### R-SCOPE-2 — never scope by resource-group NAME pattern either
Matching `rg` against `/loom/i` is wrong in **both** directions:
- it would **miss `rg-dlz-aiml-stack-dev`**, which contains `func-csa-inabox-copilot-fg` —
  a genuine Loom component with no "loom" in its RG name;
- and a future non-Loom RG containing the substring would be swept in. A real example
  now exists in the W1 fixtures: `rg-loomis-analytics-prod` matches `/loom/i` and is not
  ours — the filter would tear it down.

### R-SCOPE-2b — resource-group scoping is ALSO insufficient: RGs are MIXED
Measured during W1 (PR #3897): **`rg-dlz-aiml-stack-dev` contains both Loom-owned and
non-Loom resources.** So the unit of ownership is the **resource**, not the group. Any
design that resolves "is this ours?" at RG granularity — however the RG is selected — will
either spare Loom resources or sweep in someone else's, in the same group.

This kills the intuitive fallback ("just enumerate the Loom RGs") as decisively as it
kills name matching. Ownership must be resolved **per resource**.

### R-SCOPE-3 — the scope is a tag or a declared manifest, verified before every action
Resolve the pause set from an explicit ownership tag applied by bicep (preferred) or a
manifest emitted by the deploy, and **re-verify membership immediately before acting on
each resource**. Anything not positively identified as Loom-owned is left alone —
fail-safe means "leave it running", per the SHIR idle-stop contract.

### R-SCOPE-4 — dry-run first, always
Pause and Hibernate must both support a preview that lists exactly what would be acted on,
with its owner tag, and that preview is what the UI shows before the confirm.

## 3c. Resource Graph is STALE for power state — do not read it

**Measured 2026-08-22.** The activity log recorded
`Microsoft.Synapse/workspaces/sqlPools/pause/action` → **Succeeded at 20:22:14**. Resource
Graph continued to report that pool as `Online` well afterwards.

**Power state MUST be read from authoritative ARM, never from Resource Graph.** Resource
Graph is fine for *discovery* (what exists) and wrong for *state* (what is running). Using
it for state is the same recency-vs-serving error as #3676 and #3798, and it would cause
the reconciler to fight itself — re-pausing something already paused, or reporting a
paused estate as running.

## 4. Resume latency — this shapes the UX more than anything else

| Resource | Resume time (Microsoft Learn) |
|---|---|
| **AI Search** scale | **several hours, UNCANCELLABLE** |
| **APIM** rebuild | 30–40 min, VIP changes, 48h name lock |
| **AKS** start | + **mandatory 15–30 min cooldown** before restart |
| **ADX** start | ~10 min + **unbounded** hot-cache rehydration |
| **Bastion** rebuild | ~10 min |
| **Azure Firewall** allocate | "a few minutes" to "10 min or longer" |
| **Synapse pool** resume | "several minutes" — and the API reports `ONLINE` **2–3 min before it can serve** |
| **PostgreSQL** start | +5–8 min if maintenance applies |

**A one-click resume of this estate is a ~15-minute operation at best.** Consequences:

- **The UI needs a progress model and a readiness gate, not a spinner.** Per-resource
  states, an ETA, and an explicit "ready to use" signal.
- **Synapse's 2–3 minute lie window is a correctness trap.** `ONLINE` ≠ servable. The
  readiness gate must probe, not trust the status field. This is the same
  recency-vs-serving error as #3676 and #3798 — do not repeat it here.
- **AI Search is ACCEPTED (not hibernated)** despite having no pause: a scale operation
  takes hours and cannot be cancelled, and deleting it re-bills every embedding on
  rebuild, which can exceed weeks of idle SU cost.

**Note the model does not publish a number either.** Microsoft's Fabric pause/resume page
documents the click path and says content *"becomes available once the capacity is
resumed"* with **no duration anywhere**. Fabric pause also carries a **settlement charge**
and **does not pause OneLake storage** — so "just like Fabric" already implies a partial
pause with an unstated resume time. We should be more honest than the model.

---

## 5. PAUSED as an invariant — why one-shot fails

Four independent mechanisms un-pause this estate on their own:

1. **PostgreSQL Flexible Server auto-restarts after 7 days.** Learn states this three ways.
2. **Event Hubs auto-inflate never scales down** — *"doesn't automatically scale down."*
   Every test spike permanently raises the floor unless resume resets `--capacity`.
3. **The Commercial estate rolls itself on every merge to `main`** (build → `workflow_run`
   → roll), which will resume Container Apps that were just paused.
4. **Any ARM PUT resumes App Gateway / Firewall** — a bicep re-apply or a tagging policy
   silently un-pauses them.

### The reconciler

A scheduled **in-VNet ACA job**, copying the existing pattern in
`modules/admin-plane/cost-anomaly-monitor-job.bicep` (`Microsoft.App/jobs`, Schedule
trigger) — **not** a Function, and with **no GitHub dependency**, so it works identically
in a sovereign boundary.

It re-asserts the desired state every N minutes and must:

- **Arbitrate with deploys, not fight them.** A deploy or roll in flight **wins**; the
  reconciler backs off and re-asserts afterwards. A reconciler that fights the deploy
  path recreates #3676 (an estate silently reverting) with the polarity flipped.
- **Fail safe, never fail closed-down.** Copy the contract from
  `.github/workflows/csa-loom-shir-idle-stop.yml`: every query error leaves the resource
  **UP**. *Never scale down on uncertainty.* Note that workflow's own header records its
  `*/15` schedule under-delivering (median 49 min measured) — do not assume cron fidelity.
- **Be idempotent and observable** — every action dual-audited (§7).

### Idle auto-pause
Same job. Idle = no console sign-in and no BFF API traffic for N hours (default 4,
configurable). **Must exclude its own health traffic and the `*/15` platform jobs**
(`loom-synthetic-monitor`, `loom-asset-reconciler`, `loom-access-sweep`,
`loom-lineage-extractor`) from the idleness signal, or the estate never reads as idle.

---

## 6. Resume fidelity — snapshot first, bicep as fallback

**Decision: capture a snapshot at pause time and restore from it; fall back to bicep only
for resources the snapshot does not cover.**

Restoring purely from bicep is simpler but would silently re-impose the exact waste we are
removing — the D8 `minimumCount: 1`, 19 always-on min-replicas, and a Synapse pool that
starts Online. Restoring purely from a snapshot is faithful but strands resources that
vanished while paused.

- Snapshot lives in Cosmos, following the `AppInstallJob` pattern (`cosmos-client.ts:628`).
- Record per resource: type, id, pre-pause power state, SKU/capacity, replica counts,
  **and the declared fallback SKU** (R-CAP-1).
- On resume, **diff snapshot vs live** and report anything that changed underneath —
  do not silently accept drift.
- **The snapshot is not a backup.** HIBERNATE deletes are still deletes.

---

## 7. Where it lives — integration points

**Host UI:** `apps/fiab-console/app/admin/scaling/page.tsx`. It already mutates every
backing service's compute state via real ARM, already sits in the "Capacity & cost" nav
group, and has the primitives (`ServiceCard`, `ScalePicker`, `CostPreview`).

> **This is partly a vaporware fix, not a greenfield build.**
> `apps/fiab-console/app/admin/capacity/page.tsx:441` **already promises this feature in
> prose** — *"most engines can pause… so idle compute stops billing while data persists"* —
> and links to `/admin/scaling`, which has **no pause verb**. Under `no-vaporware.md` that
> is a live violation today.

**Estate state badge** on `/admin/readiness` — per `deploy-integrity.md` R3 that is where
estate truth belongs, and it is the only page rendering both clouds.

**BFF:** `route.ts` with named verb exports. Envelope is `{ok:true, ...fields}` — fields
**spread, not nested under `data`** (`lib/api/respond.ts`). Authorization MUST use the
wrapper, not an inline check:

```ts
export const POST = withTenantAdmin(async (req, { session }) => { … });
```

from `lib/api/route-toolkit.ts`. That file documents why: `enforceCapability` returns
`NextResponse | null`, so the authorization *is* the caller's `if (gate) return gate;` —
and on 2026-08-07 deleting that one line left **three** route guards still green.

**Destructive-action protection:** there is **no per-route CSRF token** in this repo; the
established guard is a **typed/echoed confirmation** in the body. Follow
`admin/scaling/adx/route.ts` (`confirm: '<clusterName>'`) and `admin/updates/apply/route.ts`
(`confirmTag` → 409 on drift). **HIBERNATE must require a typed confirmation.**

**Actuation, Commercial:** direct ARM via the console UAMI (`lib/azure/arm-client.ts`,
`uamiArmCredential()`). **Every primitive already exists** — `synapse-dev-client.ts:1262/1275`,
`kusto-arm-client.ts:278/287`, `loom-apps-client.ts:619/630`, `container-apps-arm-client.ts`,
`stream-analytics-client.ts:250/263`, `aml-client.ts:313/344`. Compose them; do not rewrite.

**Actuation, Gov:** `workflow_dispatch` + allow-listed run poll. Copy
`lib/updates/pipeline-dispatch.ts` and poll via `app/api/setup/workflow-run-status/route.ts`.
**MANDATORY: extend `lib/setup/deploy-workflows.ts` (`ALLOWED_DEPLOY_WORKFLOWS`,
`resolveAllowedWorkflow()`) rather than passing a workflow-name string.** That allow-list
exists because of CodeQL alert #368, where a caller-supplied
`?workflow=../../../../user/repos` walked out of the workflows path carrying
`LOOM_GITHUB_ACTIONS_TOKEN`.

**Closest existing precedent to copy wholesale:** `/admin/updates` →
`POST /api/admin/updates/apply`. One admin button, real multi-resource ARM mutation,
`withDlzAccess` on both GET and POST, a `confirmTag` drift guard returning 409, dual audit,
and a pipeline-dispatch fallback returning **202 with a `monitorUrl`**. That is the shape.

**Audit:** both layers — `auditLogContainer()` (Cosmos) and `emitAuditEvent()`
(`lib/admin/audit-stream.ts`).

---

## 8. Cloud parity — and the hard Gov constraint

`cloud-parity.md` is die-hard: Commercial-only is INCOMPLETE, not "Commercial-first".

**The constraint: Azure Government has no general egress to `api.github.com`, so a
Gov-hosted console cannot dispatch its own workflow.** Resolution:

- **Interactive pause/resume for Gov is dispatched from the Commercial console** (which
  can reach `api.github.com`) via the allow-listed `workflow_dispatch` path. This is a new
  trust edge — Commercial mutating Gov — and must be authorized and audited as such.
- **The invariant reconciler runs in-boundary** as its own ACA job, with no GitHub
  dependency, so PAUSED holds in Gov even with no connectivity to Commercial.

Boundary discriminator is `lib/azure/cloud-boundary.ts` — `detectLoomCloud()` reads
`LOOM_CLOUD` → `AZURE_CLOUD` → `LOOM_CLOUD_BOUNDARY`. **Note `IL5` folds to `GCC-High`
deliberately; only `LOOM_CLOUD_BOUNDARY` distinguishes them.** Gov workflows authenticate
with an **SP client secret**, not OIDC (the `id-token: write` present is for cosign).

**Measured reality check on "parity":** GCC-High exists and is rolled daily, but its
full-deploy lane has failed its last 3 runs. **IL5 has never been deployed — `total_count: 0`,
not once.** GCC's workflow is disabled at GitHub level. So parity for IL5 currently means
parity with nothing; do not block Commercial delivery on an estate that does not exist, and
say so plainly rather than implying coverage.

---

## 9. Explicitly EXCLUDED — pausing these costs more than it saves

1. **Private Endpoints ×27 ($197/mo).** Deleting destroys the private DNS A records,
   changes the private IP, and forces re-approval. **Two PEs sharing a zone: deleting one
   removes the A record and it is NOT restored for the survivor.** Highest
   reconstruct-risk-per-dollar in the estate.
2. **Standard Public IPs ×4 and NAT Gateway.** Billed whether associated or not —
   detaching saves nothing and breaks things.
3. **Azure Firewall — HIBERNATE only, and only if the control rewrites UDRs.** Deallocate
   **may change the private IP**, blackholing every route that points at it, and
   **Allocate fails outright if private-IP DNAT rules exist.** Verify both before enabling.
4. **Log Analytics daily cap as a routine lever.** Over-cap data is dropped *and still
   billed*, and you go blind until a per-workspace reset hour **you cannot configure**.
   Retention below 31 days saves nothing.
5. **Cosmos provisioned RU/s.** The autoscale floor **ratchets permanently**
   (`highest_ever/10`); it already self-parks at 10%. Leave it.

---

## 10. Build order

| # | Work item | Why first |
|---|---|---|
| **0** | **Quick wins — D8 `minimumCount: 0`; get `synapse-auto-pause` actually deployed** | ~$1,625/mo, no new surface, no architecture decisions. **Already in flight as its own PR.** |
| 1 | Estate state model + Cosmos snapshot doc + `PAUSED`/`RESUMING`/`RESUME_FAILED` states | Everything else depends on it |
| 2 | `pauseEstate` / `resumeEstate` orchestrator composing the existing `/admin/scaling` primitives | The actuators exist; this is composition |
| 3 | Capacity precondition + fallback-SKU handling (R-CAP-1..4) | The ADX proof says this is not optional |
| 4 | UI on `/admin/scaling` + progress/readiness model + badge on `/admin/readiness` | Closes the `/admin/capacity` vaporware promise |
| 5 | Reconciler ACA job (invariant + idle auto-pause) with deploy arbitration | Holds the savings |
| 6 | Gov path — allow-listed dispatch from Commercial + in-boundary reconciler | Cloud parity |
| 7 | HIBERNATE tier (Firewall/Front Door/Redis/Bastion/VPN GW delete + redeploy) | Highest risk, do last, typed confirmation |

---

## 10b. Work items — declared file ownership and gates

Parallel safety in this repo is a **FILE** property, not a topic property. Two agents that
can touch the same file cannot run concurrently (CLAUDE.md §8). Every work item below
declares what it owns; anything not listed is out of bounds and must be routed.

| ID | Work item | OWNS (exclusive) | Gates | Depends on |
|---|---|---|---|---|
| **W1** | Estate state model + Cosmos snapshot | `apps/fiab-console/lib/estate/pause-state.ts` *(new)*, `lib/estate/pause-inventory.ts` *(new)*, `lib/estate/__tests__/**` | `pnpm vitest run lib/estate` · schema round-trip test | — |
| **W2** | Pause/Resume orchestrator | `apps/fiab-console/lib/estate/pause-orchestrator.ts` *(new)* | `pnpm vitest run lib/estate` · a dry-run test proving the action list matches the tagged inventory exactly | W1 |
| **W3** | Capacity precondition + fallback SKU | `apps/fiab-console/lib/estate/capacity-preflight.ts` *(new)* | unit test where the capacity probe FAILS → must yield `RESUME_FAILED`, never `RUNNING` | W1 |
| **W4** | BFF routes | `apps/fiab-console/app/api/admin/estate/pause/route.ts`, `…/resume/route.ts`, `…/state/route.ts` *(all new)* | `pnpm vitest run` route suites · `scripts/ci/check-route-toolkit.mjs` **PER-KEY mode** · authz mutation: delete the `if (gate) return gate;` line and prove a test goes RED | W2, W3 |
| **W5** | UI + progress/readiness model | `apps/fiab-console/app/admin/scaling/page.tsx`, `app/admin/capacity/page.tsx`, `app/admin/readiness/**` | `pnpm next build` · **G1 in-browser click-walk** (tsc+vitest are explicitly NOT evidence) | W4 |
| **W6** | Reconciler ACA job (invariant + idle auto-pause) | `platform/fiab/bicep/modules/admin-plane/estate-pause-reconciler-job.bicep` *(new)*, `apps/loom-estate-reconciler/**` *(new)*, **+ a declared edit window on `modules/admin-plane/main.bicep`** | `make validate-bicep` · compiled-template sync · a test proving a deploy-in-flight makes the reconciler BACK OFF | W2 |
| **W7** | Gov path — allow-listed dispatch | `apps/fiab-console/lib/setup/deploy-workflows.ts`, `.github/workflows/estate-pause-gov.yml` *(new)* | `actionlint` · a test proving a workflow name NOT in the allowlist is REFUSED (CodeQL #368 regression) | W2 |
| **W8** | HIBERNATE tier | extends W2/W3 only — **no new file ownership** | typed-confirmation test · delete/redeploy round-trip in a scratch RG | W2, W3, W5 |

### Lanes

```
W1 ──┬── W2 ──┬── W4 ── W5 ── W8
     └── W3 ──┘   └── W6   (bicep — see conflict below)
                  └── W7   (workflows + allowlist)
```

W1 is the only true blocker. W2 and W3 can run concurrently after it. W4/W6/W7 are
mutually disjoint and parallelise. **Max useful concurrency is 3**, matching the
review-capacity ceiling in CLAUDE.md §9.

### ⚠️ Known conflicts with the in-flight OMNIBUS program — MUST be sequenced

1. **W6 vs OMNIBUS L0 Batch C.** Both edit `platform/fiab/bicep/modules/admin-plane/main.bicep`.
   L0 Batch C (nine bicep env-wiring issues) has not started. **Do not run W6 and Batch C
   concurrently** — whichever starts second takes a declared ownership transfer via the
   OMNIBUS master's §6 procedure.
2. **W6 vs the cost quick-wins PR.** That PR edits `modules/landing-zone/main.bicep` and
   `modules/compute/container-platform.bicep` — disjoint from W6's file, but both may
   force a rebuild of the compiled `apps/fiab-console/deploy-templates/main.json`. Only
   one may hold that file at a time. **Let the quick-wins PR land first.**
3. **W4/W5 vs OMNIBUS L5 (Console Admin & UX).** L5 is Wave 1 and owns admin surfaces
   broadly. It has not started. When it does, `app/admin/scaling/**` and
   `app/api/admin/estate/**` are **already claimed by this PRP** and must be excluded from
   L5's inventory.
4. **W4 vs OMNIBUS L1 Batch 2.** L1 Batch 2 currently owns `app/api/admin/workspaces/route.ts`.
   W4's routes are new files under `app/api/admin/estate/` — disjoint, but do not let W4
   refactor any shared helper under `lib/api/` while L1 is in flight.

### Rigor

**FULL mutation-proof** for W3, W4, W6, W7 and W8 — these decide whether resources stop,
whether an unauthorized caller can stop them, and whether a paused estate can be brought
back. **Normal rigor** (gates + one independent pass) for W1, W2 and W5.

Every guard this PRP introduces must be shown RED on a deliberately broken subject.
A guard that stays green when its subject is mutated is the defect, not the fix.

## 11. Definition of done

- One click pauses and one click resumes, in **both** boundaries, with a **G1 in-browser
  receipt** for each (`tsc` + `vitest` are explicitly not evidence).
- A **derived** before/after cost delta is reported, and labelled derived.
- The estate survives 7+ days paused **without drifting back to running** — proving the
  reconciler beats the Postgres auto-restart and the merge-triggered roll.
- Resume reaches a **verified servable state**, not merely a status field reading `ONLINE`
  (the Synapse 2–3 min lie window).
- A capacity-failure resume produces `RESUME_FAILED` and a fallback attempt — **never a
  false green**.
- `/admin/capacity`'s existing prose promise is no longer a `no-vaporware.md` violation.

## 12. Open items

- **Who paused the Synapse pool at 20:21 UTC on 2026-08-22?** A user-initiated ARM call
  during the research pass; the identity was deliberately not printed. Confirm it was the
  operator and not an unknown automation.
- Cost Management 429 — re-derive the top-10 from an actual invoice before quoting.
- **Log Analytics ingestion is unmeasured** (`api.loganalytics.io` does not resolve from
  the workstation) and could plausibly be a top-5 line item at PerGB2018 with a 50 GB/day
  cap and 90-day retention.
- Confirm whether any GCC estate exists at all — `gov-discover.yml` is read-only and runs
  in-boundary.
