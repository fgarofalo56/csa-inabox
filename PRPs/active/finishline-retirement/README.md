# FINISHLINE — retirement record

**Program:** `FINISHLINE` · **ledger:** `.harness/state.json` (56 tasks,
19 operator questions) · **retired:** 2026-09-17 · **tracking:** `Refs #4495`.

The operator's instruction was **reconcile, then archive — nothing lost
silently.** This directory is the reconciliation. The ledger itself is preserved
verbatim at `.harness/archive/2026-08-08/`.

| Where things went | |
|---|---|
| The 56-task ledger + program config, byte-for-byte | `.harness/archive/2026-08-08/` |
| The program spec and its audit | `PRPs/archive/2026-08-22-omnibus-consolidation/finishline/` |
| The 19 unanswered operator decisions | [`OPERATOR-QUESTIONS.md`](OPERATOR-QUESTIONS.md) |
| Per-task dispositions | this file, § *The 18 unmapped tasks* |
| Newly filed work | #4549, #4550 |
| The harness of record from here | `tools/drain/` |

---

## Correction to #4495's premise

#4495 states that FINISHLINE's spec *"is deleted"*. It is not. It was
**archived**, deliberately, on 2026-08-22 by #3881
(*"chore(prp): consolidate 22 PRP units and all 261 open issues into one
fan-out program"*). Both files `.harness/config.json` names in its `read_first`
list are on disk today:

```
PRPs/archive/2026-08-22-omnibus-consolidation/finishline/PRP.md
PRPs/archive/2026-08-22-omnibus-consolidation/finishline/AUDIT-2026-08-06.md
```

`PRPs/active/omnibus-2026-08-22/PRP.md:202` records the consolidation verdict
for this program: *"`finishline` (2) | register, pre-08-18 authority |
**superseded by this file**"*.

So the real defect behind #4495 is narrower and more ordinary than a deletion:
**the PRP was consolidated and the `.harness/` ledger that pointed at it was
not**. `/harness:harness-next` then resolved a `read_first` path that had moved
and could select nothing. That is what this retirement settles.

It also bounds what the consolidation did *not* do. The omnibus table treated
FINISHLINE as *"a register"* and carried it wholesale; it never reconciled the
56 tasks individually. That reconciliation is below, and it is the part that
would have been lost.

---

## Measured shape of the ledger

Re-derived from `.harness/state.json` at head, not taken on trust:

| | count |
|---|---|
| tasks | **56** |
| — by status | 24 `review` · 17 `todo` · 7 `in_progress` · 4 `operator` · 2 `done` · 2 `doing` |
| tasks that reference at least one issue number | **38**, covering **87 distinct issues** |
| — of those 87, already closed | **77** |
| — still open, and all already in the drain ledger | **10** |
| tasks referencing **no** issue number | **18** — the candidate hidden backlog |
| operator-queue entries, unanswered since 2026-08-06 | **19** |

`last_updated` inside the file reads `2026-08-06T00:00:00Z`; the last commit to
change its contents is `6b3c15698d7`, **2026-08-08**. The archive directory is
named for the later of the two, since that is when the ledger actually stopped
moving.

The 38 issue-referencing tasks needed no separate disposition: they are tracked
where tracking belongs, 89% of the referenced issues are already closed, and the
10 open ones are in the drain ledger. Archiving those loses nothing. The 18
below are the ones that only existed here.

---

## The 18 unmapped tasks — disposition

Each was treated as a **hypothesis from 2026-08-10**, not a fact, and
re-measured at head on 2026-09-17.

**Result: 11 DONE · 3 SUPERSEDED · 2 LIVE-UNFILED (now filed) · 2 SPLIT.**

`G3` and `C16` are the two that produced the filings — each is partly done, and
counted live because a measured gap survives. `C10` and `D17` are SPLIT for a
different reason: their remaining halves are recorded at the site rather than
filed, for reasons given in their sections below. `D17` also shares `C16`'s t169
gap, so #4550 covers a concern named by two tasks. Task titles bundle two or
three asks apiece; the counts are of **tasks**, not of asks.

### A note on the 38 "has an issue ref" tasks — the exclusion rule is not free

Those 38 were excluded from per-task disposition on the rule *"referenced, so
tracked elsewhere"*. That rule is sound for most of them and **unsound for
`C11`**, which is dispositioned below precisely because carrying an issue number
is not the same as being covered.

No systematic audit of the other 37 against the same failure mode was performed.
That is a stated limit of this reconciliation, not a claim that the other 37 are
fine.

### `C11` — an issue reference that covers one of nine items

`C11` reads: *"Deferred programs — schedule, don't lose"*, and then names nine
things. Its only issue reference is **#1483**, which covers the third of them.
Under the exclusion rule above, `C11` would have been waved through on that one
number. It should not have been, and the t169 finding (#4550) came out of
looking anyway.

| C11 entry | where it lands |
|---|---|
| `bridge-services` (4 services, zero code) | omnibus **L8 / L7 triage** (`omnibus-2026-08-22/PRP.md:207`) |
| `geo-graph-ml` GEO-2/3/4 (Esri operator-gated) | omnibus **L8** (`:190`); the license decision is **OP-7** |
| `domain-mesh` #1483 verification program (~16 items, code shipped, verify owed) | omnibus **L8** (`:196`); **#1483 is OPEN** — but it is the *feature*, and what C11 flags is the **owed verification**, which I could not establish is carried anywhere |
| EH Phases 2-4 (`enterprise-hardening`) | omnibus **L8** (`:197`) |
| **t169 RG/CAF** | **filed as #4550** |
| `SVC-3/4/6/7/9/10` | **CANNOT-VERIFY** |
| `W4/W12/W14/W15/W16/W17/W22` | **CANNOT-VERIFY** |
| `T97` SHIR | **CANNOT-VERIFY** |
| `T100/T101` reports | **CANNOT-VERIFY** |

**Why CANNOT-VERIFY and not "missing".** Those four identifier-sets resolve only
to audit tables inside `docs/fiab/prp/` — `PRP-AUDIT-2026-07-09.md:131,134` for
`SVC-*`, `AUDIT-2026-06-10-deep.md:128,131,132` for `T97`/`T100`/`T101`. That
directory is gitignored (`.gitignore:389`) operator-internal material, the rows
are line items rather than PRP units, and the omnibus consolidation table carries
**whole PRP units**. So I cannot show they were carried, and I cannot show they
were dropped. Saying which is which would be asserting what I did not establish.

An independent review counted **five** CANNOT-VERIFY where this table has four.
The discrepancy is `domain-mesh`: its *program* demonstrably reaches L8, while
the *owed verification* C11 actually names does not demonstrably go anywhere. I
could not settle that, so it is flagged in the row rather than silently counted
either way.


| id | status then | disposition | evidence at head |
|---|---|---|---|
| `C25` | doing | **DONE** | `deploy-fiab-commercial.yml` now passes `loomTenantAdminGroupId` (`:1125`) and `loomTenantAdminOid` (`:1139`), and **fails closed** at `:1158` rather than shipping an empty admin gate. The task's own evidence was "grep = 0 hits" for all three names in that file. |
| `C18` | in_progress | **DONE** | All three floating MCR refs pinned — `dab-runtime.bicep:43` digest, `presidio-sidecar.bicep:75,126` → `2.2.358` via ACR, `container-instances.bicep:23` digest-only. Registry `platform/fiab/images/mcr-images.json`, guard `scripts/ci/check-mcr-image-pins.mjs`. |
| `C24` | in_progress | **DONE** | Tracked and merged as **#3088**. `full-app-deploy-commercial.yml:964-996` verifies the admin-user disable by reading it back, and `scripts/csa-loom/acr-firewall-lease.sh` re-locks with `acr_lease_verify_locked` + bounded retries + a sweeper janitor. A no-op re-lock now turns the job red. |
| `G3` | in_progress | **SPLIT — 1 done, 3 filed as #4549** | `deploy-gov.yml` recovered (`success` 2026-08-16). `gov-provision-graph-grants` (1 run ever, failed), `gov-provision-dbx-sql` (4/5 failed) and `gov-provision-dbx-sql-invnet` (9/10 failed) are all still `active`, last-red, and absent from both `workflow-lane-states-allowlist.json` and `check-deploy-staleness.mjs`. |
| `D5` | review | **DONE** | `catalog.bicep:149,304` set `publicNetworkAccess: 'Disabled'` with the policy rationale at `:114`; `scripts/csa-loom/preflight-policy-restrictions.mjs` exists; the promised V5 doc rows are in `docs/fiab/deployment/brownfield.md` and `failure-recovery.md`. |
| `C10` | todo | **SPLIT — 2 done, 1 PARTIAL** | Two of three sub-items are fully built. PP solution import/export — `app/api/powerplatform/solutions/route.ts` drives `ExportSolutionAsync` / `DownloadSolutionExportData` / `StageSolution` / `ImportSolutionAsync` / `GetSolutionImportStatus`. Mirroring wizard — `mirrored-database-editor.tsx:309,744` persists `connectionId` and surfaces "Key Vault connection bound". **Scale-by-SKU is PARTIAL, not done** — see below. |
| `C12` | todo | **DONE (buildable half)** | The `ux-fidelity` checklist gate exists as `docs/fiab/ux-standards.md` §7 *"Capabilities checklist (the review gate)"*, §7.0 universal + §7.1–7.5 per surface kind. `ux-fabric-a` W5/W6 was already triaged as *"superseded in practice by the ux-baseline die-hard rule"* in the archived loom-apex audit. The remainder (GOV-3, model-strategy §7, TPM raises) is **OP-5**. |
| `C15` | todo | **SUPERSEDED** → #3513, #3544, #4359 | The FRESH0 half is **done**: `loom-guardrails.yml:682` is now *"prp-freshness (PRP ground-truth drift BLOCKS — FRESH0 / C15)"*, merged as #3131. The G2 half was **re-measured and the audit number corrected** by `check-honest-gate-coverage.mjs`: the registry is 131/131 `fixit:`, 1:1 — "~160 vs 131" was a regex artifact. The real breach is on the surfaces, now a merge-blocking ratchet. |
| `C16` | todo | **SPLIT — 2 done, 1 filed as #4550** | AG-13 has a real importer (`app/apps/view/[id]/page.tsx:106`); AG-14 has a real caller (`lib/editors/access-request-inbox.tsx:338`). *Scope note, not a defect: `RequestAccessInline` is mounted on `loom-app` only — whether it belongs on more resource types is a new question.* The t169 function-RG split is still not built → #4550. |
| `C17` | todo | **DONE** | `platform/fiab/bicep/modules/admin-plane/access-governance-sweeper-job.bicep` exists and is wired into `admin-plane/main.bicep:235` as **default-ON** three scheduled Container App Jobs. `lib/access/sweep-auth.ts` replaced the never-set `LOOM_SWEEPER_TOKEN` with a managed-identity path (legacy token still honoured if explicitly set). |
| `C20` | todo | **DONE** | `scripts/ci/check-editor-read-failure-honesty.mjs` — a merge-blocker headed *"FINISHLINE C19/C20"* — plus the shared `lib/components/ui/query-error-bar.tsx` and C20 markers across 10+ editors. The guard **discloses its own scope limit** (34 `useQuery` surfaces vs 506 `useState`+`useEffect`), with `check-empty-claim-read-evidence.mjs` as the sibling for the rest. |
| `C21` | todo | **SUPERSEDED** → #3513, #3544, #4359 | The ai-red-team half is **done**: `ai-red-team-editor.tsx:82-110` renders a non-dismissible `ScopeDisclosure` that degrades to `warning` whenever a run is too narrow to support a safety claim, explicitly labelled C21. The G2-coverage half folds into `C15`. |
| `C4` | todo | **DONE, residual already tracked** | Typed client-route map merged as **#3152** (*"B-R15-17, FINISHLINE C4"*); WS-4.4 object sync merged as #2313; B-R10 slice 1 as #2565. `docs/fiab/decomposition-plan.md:185` records the split. Residual is **#2581, OPEN** and already in the drain ledger. |
| `C5` | todo | **DONE** | LU-7 — `app/api/governance/policy-code/engine-rules/route.ts` plus `lib/governance/policy-code/compilers/trino.ts` and its tests. LU-11 — `app/api/catalog/unity/foreign-catalogs/route.ts` + `app/catalog/unity/page.tsx:1258`. LU-12 — `app/api/databricks/unity-catalog/metric-views/route.ts`, with the Azure-native semantic layer as the **default** backend per `no-fabric-dependency.md`. |
| `C6` | todo | **DONE** | The task itself said "RE-INVENTORY first", and that re-inventory exists: `docs/fiab/help-inventory-2026-08-08.md` — **33 of 33 already done**, 142/142 item guides registered with zero dead links and zero orphans, 29/29 apps covered. D6 visual captures remain operator-gated (**OP-8**). |
| `D11` | todo | **DONE** | The dispatch the task asked for happened. `csa-loom-post-deploy-bootstrap.yml` was stale at 2026-07-19; it has since run `success` on **2026-08-08** and **2026-08-12**. Recurrence is watched — the workflow is registered in `scripts/ci/check-deploy-staleness.mjs:132`. |
| `D17` | todo | **DONE (docs half), with a measured drift** | R8 greenfield + brownfield walkthroughs exist as separate complete pages: `docs/fiab/deployment/greenfield.md`, `brownfield.md`, `failure-recovery.md`, `resource-groups.md`. **Wizard/doc agreement was re-measured, not assumed** — see below. The t169 half went to #4550; the clean-sub acceptance runs are **OP-3**. |
| `F1` | todo | **SUPERSEDED** → #3110 | #3110 is titled *"**F1 federation residue**: amnesiac Iceberg catalog, 30s cold-start 504s, Trino file-ACL, zero credential vending, sign-in app reused as catalog audience"* — it carries this task's name. Companion open issues: #3339, #3746, #3747. |

### `C10` scale-by-SKU — why PARTIAL and not DONE

The sub-ask is *"scale-by-SKU verify **EVERY** resource (task-020)"*. Universality
is the ask, not a decoration on it, so a label of DONE over partial coverage is
wrong even with the gap disclosed underneath — **the label is what the drain
consumes.**

Measured 2026-09-17. `lib/azure/__tests__/scaling-clients.test.ts` exercises
**8 distinct clients**:

```
aisearch-client · aks-arm-client · apim-client · container-apps-arm-client
databricks-client · fabric-client · kusto-arm-client · synapse-dev-client
```

The scale surfaces are **17**: 15 routes under `app/api/admin/scaling/`, plus two
item-level scale routes (`items/azure-sql-database/[id]/scale`,
`items/synapse-spark-pool/[id]/scale`). Between them they reach **13** distinct
clients. **5 are uncited by the test:**

| uncited client | reached from |
|---|---|
| `cosmos-client` | `admin/scaling/cosmos/route.ts:12` — `updateContainerThroughput` |
| `foundry-client` | `admin/scaling/foundry-compute/route.ts:13` — `updateAmlComputeScale` |
| `purview-client` | `admin/scaling/compute/purview-managed-vnet`, `compute/register-purview-shir` |
| `vmss-client` | `admin/scaling/compute/register-purview-shir/route.ts:44` |
| `monitor-client` | `admin/scaling/utilization/route.ts:40` (read path) |

Coverage is also partial *within* covered clients: `synapse-dev-client` is
exercised for `updateDedicatedPoolSku` but not `scaleSparkPool`, which is what
the item-level Spark-pool scale route calls
(`items/synapse-spark-pool/[id]/scale/route.ts:12`). So "8 of 17 surfaces" is
the fair headline and "8 of 13 clients" the sharper one.

**Not filed as a new issue, deliberately.** This is test coverage over shipped,
working routes — a thinness in the verification, not a broken capability, and no
defect was observed in the uncovered five. Filing it would put a
coverage-expansion task into the drain ahead of measured defects. It is recorded
here, at the site, with the exact uncited list so whoever picks up scaling work
next has the gap in hand rather than having to re-derive it.

### `D17` wizard/doc agreement — measured, and the doc is stale

`deploy-integrity.md` R8 requires that the wizard and the docs agree, and calls
drift a defect. That is testable, so it was tested rather than assumed.
`brownfield.md` publishes its own two re-measurement probes; both were re-run at
head on 2026-09-17.

**Probe 1 holds.** The doc says the wizard's Deploy button is gated on
`planBlockers`. At head, `lib/panes/setup-wizard.tsx:1715` is verbatim
`nextDisabled={!!planner.plan && planBlockers(planner.plan).length > 0}`.

**Probe 2 is FALSIFIED.** The doc's BLOCKING DEFECT section asserts that
`evaluateFitness()` and `applyFitness()` have *"zero production callers — grep
returns only their own definitions and tests"*, therefore *"the blocker can never
clear"*, therefore *"Use the CLI for brownfield today."* Re-running the doc's own
grep at head returns production callers:

- `lib/deploy/fitness-probe.ts:2` — self-described as *"the PRODUCTION PRODUCER
  for `evaluateFitness()`"*, calling it at `:442,460,470,488,522`
- `app/api/setup/validate-adoption/route.ts` — the validation step the doc says
  *"the product does not have"*
- `lib/panes/setup-adoption-planner.ts:251` — attaches the verdict via
  `applyFitness`

So the docs and the product disagree, in the direction that makes the docs
**more pessimistic** than the code: a published page tells operators a UI path is
unusable on the strength of a premise that no longer holds.

**Bounded honestly:** what was measured is that the producer now exists. It was
**not** measured that the wizard can deploy an adopt plan end-to-end — that needs
a `ux-baseline.md` G1 browser walk, which this change did not do. So this is not
a claim that brownfield-via-wizard works.

**Not filed.** #3342 is OPEN and is exactly this subject — *"The brownfield
wizard cannot deploy: every adopt blocks on a fitness verdict with **no
production producer**"*. Its stated premise is the one falsified above. Whoever
owns #3342 should re-measure and either re-title it or record what still blocks;
opening a second issue beside it would split the finding.

### The two filings landed after the drain ledger was built

Recorded so this account is complete rather than flattering.
`tools/drain/state.json` was built at **16:26:24Z**; #4549 and #4550 were filed
at **16:40Z / 16:41Z**. So for a window, **the only two survivors of this entire
reconciliation were invisible to the drain that was about to start** — the exact
loss this retirement exists to prevent, reproduced by the retirement itself.

The ledger is coordinator-owned; this change did not and must not write it. The
coordinator reconciled the two issues into it separately. The ordering lesson is
the durable part: **file first, then build the ledger** — a reconciliation that
finishes after its consumer has snapshotted has not been delivered.

### Filed, and why


Two items and only two survived re-measurement as real work with no GitHub row.
Nothing else was filed — per the operator's instruction, filing work that is
already done costs the drain a cycle to rediscover, which is worse than the loss
it was meant to prevent.

- **#4549** — three `gov-provision` lanes are `active` and last-red, one of them
  never green in its single run ever, and no staleness or lane-state guard
  watches any of them. The `deploy-integrity.md` R3 / `cloud-parity.md`
  never-exercised shape.
- **#4550** — the CAF function-RG split (t169) is still not built, and
  `docs/fiab/deployment/resource-groups.md:202` tracks it by the string
  "FINISHLINE `C11`". That pointer was already wrong — C11's issue reference is
  #1483, which is about the domain designer — and this retirement would have
  made it name nothing at all.

### What could not be determined

Stated rather than guessed:

- `gov-provision-dbx-sql` run `30129075527` concluded `failure`, but the jobs
  API returns an empty job list for it, so the failing step is **unknown**.
  Recorded as unknown in #4549.
- `C10`'s title claims scale-by-SKU should *"verify EVERY resource"*. The client
  suite and its tests exist and cover eight backends; **universality across
  every resource was not independently verified.**
- Whether `RequestAccessInline` should mount on resource types beyond
  `loom-app` is a scope question this reconciliation did not settle. The filed
  defect — zero importers — is genuinely gone.

---

## Pointers left for an owner outside this change's file scope

This change owns `.harness/**` and `PRPs/active/finishline-retirement/**` only.
Three pointers elsewhere are now stale or thin, and are recorded here rather
than silently left:

- `docs/fiab/prp/data-factory.md:378` — *"State carried in
  `.harness/state.json`; one task = one PR."* That path is now
  `.harness/archive/2026-08-08/state.json`. A June-era doc, one line.
- `PRPs/active/drain-2026-08-31/OWED.md` §2 carries *"open operator
  questions"*. The 19 in [`OPERATOR-QUESTIONS.md`](OPERATOR-QUESTIONS.md) belong
  in that ledger's field of view; they are not there today.
- `PRPs/active/REGISTER.md` contains **zero** mentions of `finishline` or
  `harness`, so a reader working from the register would not learn this program
  existed.

None of these is load-bearing for the retirement itself — the dispositions and
the operator queue are preserved regardless — but each is the same
pointer-drift class as #4550.

---

## Why the harness is retired rather than repaired

`tools/drain/` is the harness of record (tracked, on `main` since #4488).
FINISHLINE's program authority was superseded on 2026-08-22, and 77 of the 87
issues its tasks referenced are already closed. Repairing the `read_first` paths
would restore a selector over a ledger whose forward-looking content is now
either already settled, in the drain ledger, in this file, or newly filed as
#4549 / #4550.

Nothing is deleted. `.harness/state.json` and `.harness/config.json` are moved
into `.harness/archive/2026-08-08/` unmodified — the same dated-directory
convention the June program used at `.harness/archive/2026-06-05/`.
`.harness/session-notes.md` is deliberately **not touched**: it is modified in
the primary checkout's working tree, and moving a file out from under an
uncommitted edit is exactly the silent loss this retirement is supposed to
prevent.
