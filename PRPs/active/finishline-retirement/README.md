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
| Per-task dispositions — 18 unmapped + 6 reached by no issue | this file |
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
| tasks carrying at least one `#` reference | **38**, spanning **87 distinct numbers** |
| — resolved **by type**: Issues | **47** — 37 closed, **10 open** (all 10 already in the drain ledger) |
| — resolved **by type**: Pull Requests | **40** |
| tasks carrying **no** `#` reference | **18** — the candidate hidden backlog |
| tasks whose references are **all PRs**, so no Issue reaches them | **10** |
| operator-queue entries, unanswered since 2026-08-06 | **19** |

`last_updated` inside the file reads `2026-08-06T00:00:00Z`; the last commit to
change its contents is `6b3c15698d7`, **2026-08-08**. The archive directory is
named for the later of the two, since that is when the ledger actually stopped
moving.

### `#N` is not a synonym for "issue" — 40 of the 87 are pull requests

An earlier revision of this page said the 38 tasks covered *"87 distinct issues,
77 already closed"*, and concluded they were *"tracked where tracking belongs"*.
**That sentence was wrong, and it was the sentence that bought all 38 tasks a
pass.**

Issues and pull requests share one numbering space, and `gh issue view` resolves
a PR number without complaint — so it cannot be the discriminator. A GraphQL
`issueOrPullRequest` pass over all 87 (`temp/resolve_types.py`; **zero
unresolved**, and the script refuses to score if any lookup fails) returns:

```
BY TYPE: Issues=47 (open=10 closed=37) | PullRequests=40
OPEN issues: 1483 2581 2583 2626 2642 2678 2698 2874 2958 3060
```

A merged PR is a receipt that something shipped. It is **not** a tracker: it
carries no residue, it will not be re-opened, and no backlog pass walks it. So
for a task whose only references are PRs, "tracked elsewhere" is simply false.

**Ten tasks are in that position** — `C1` `C13` `C14` `C3` `C7` `D16` `D3` `D4`
`E2` `P2-DOCS`. Four are reached by the operator queue anyway (`D4`→OP-13,
`C3`→OP-19, `C1`→OP-9, `D16`→OP-4). **The remaining six were reached by
nothing**, and are dispositioned below on the same terms as the 18.

The other 32 issue-referencing tasks are left as tracked-elsewhere, with the
limit stated in its own section below.

---

## The 18 unmapped tasks — disposition

Each was treated as a **hypothesis from 2026-08-10**, not a fact, and
re-measured at head on 2026-09-17.

**Result: 11 DONE · 3 SUPERSEDED · 2 SPLIT→FILED · 2 SPLIT→RECORDED.**

Four labels, used consistently in the table below and nowhere loosely:

| label | meaning |
|---|---|
| **DONE** | every ask in the task is discharged; the site that does it is named |
| **SUPERSEDED** | an open issue already carries the remainder; that issue is named |
| **SPLIT→FILED** | partly done, and the live remainder is now a GitHub issue |
| **SPLIT→RECORDED** | partly done, and the remainder is recorded at the site with the reason it was not filed |

`G3` and `C16` are the two SPLIT→FILED (#4549, #4550). `C10` and `D17` are
SPLIT→RECORDED. `D17` also shares `C16`'s t169 gap, so #4550 covers a concern
named by two tasks. Task titles bundle two or three asks apiece; **the counts are
of tasks, not of asks.**

Nothing mechanical consumes these labels — `tools/drain/` reads GitHub issues
and its own `state.json`, and its only `PRPs/active` path is
`build_inventory.py:14` — so a mislabel here misleads a human without dropping a
row from the automated pass. That is why the filings matter more than the table,
and why every live remainder above is either an issue or explicitly explained.

### A note on the 38 "has a `#` ref" tasks — the exclusion rule is not free

Those 38 were excluded from per-task disposition on the rule *"referenced, so
tracked elsewhere"*. Two separate failures of that rule are now recorded:

1. **A reference may be a PR**, which tracks nothing — 10 tasks, six of them
   reached by nothing at all (dispositioned immediately below).
2. **A reference may cover one ask out of many** — `C11` carries #1483, which
   covers one of the nine things it names (dispositioned further below).

A second independent review sampled six of the remaining tasks, weighted to
`review`/`in_progress`, and found **3 of 6 carry a reference that does not cover
the ask**. One of those, `G2`, carried a live residue — now added to **#4549**
(see § *The Gov lanes*). Their other rows, recorded so they are not re-derived:
`C22`'s #2977 is no longer open and the task text itself says *"Same class as
#2977"*,
so the reference was never the tracker (shipped via #3122, no residue); `C8`'s
#2622 is closed with partial coverage and no residue; `C1`'s residue is covered
by open **#3527** — *"V&V Sprint: Item & App Catalog coverage matrix (142 items
+ 29 apps)"* — which the ledger never names.

**No exhaustive audit of all 38 was performed.** Between the ten PR-only tasks,
`C11`, and a six-task sample, roughly two-thirds of the 38 have been looked at.
The rest rely on the exclusion rule, and that rule is now known to fail in two
distinct ways. Stated as a limit, not a clean bill.

### The six tasks reached by nothing

`C13` `C14` `C7` `E2` `D3` `P2-DOCS` — all `status: review`, all with only merged
PRs behind them. Same treatment as the 18: the title is a hypothesis from
2026-08-10, re-measured at head 2026-09-17.

| id | disposition | evidence at head |
|---|---|---|
| `C13` | **DONE — including the residue it flagged** | loom-ui-verify repaired via merged #3076. Its own evidence flagged a product defect as *"Still unfixed"*: `/copilot` rendering **neither** the Ready badge **nor** the honest AOAI gate. That is now discharged — `app/copilot/page.tsx:370` renders the `Ready` hero chip, `:17` documents the honest AOAI-gate MessageBar, and `e2e/aoai-target-resolution.spec.ts:307` asserts **one or the other** must appear. The Playwright project still exists (`playwright.config.ts:375`). |
| `E2` | **DONE** | Merged #3069. The root cause was a chunker emitting `title › innermost-heading` with no product label, so `classifyExcerptProvenance` returned `unlabelled` for whole gold documents; fixed with full `title›H2›H3` ancestry, corpus-wide unlabelled 1711→1249. No residue named in the task. |
| `D3` | **DONE, one residue CANNOT-VERIFY** | Merged #3052 — the three degraded apps' pull UAMIs had zero role assignments; grants created, `dependsOn` added. **Residue:** its evidence records a stray out-of-band Container App `loom-wrangler-h2` that `LOOM_WRANGLER_ENDPOINT` pointed at, to be deleted only *after* a deploy re-points the endpoint. `grep -rn "loom-wrangler-h2"` across the repo returns **zero hits** — no tracker anywhere. Whether the stray still exists is an **estate-state** question, and this change has no estate access, so it is not asserted either way. Probe for someone who does: `az containerapp list -g rg-csa-loom-admin-centralus --query "[?contains(name,'wrangler')].name"`. |
| `C7` | **DONE, G1 receipt owed** | Merged #3064 (route body-parse + `provisionBackingRg` threaded + wizard mounted) and #3065 (register corrections). Mutation-proved: reverting the route reds 4 of 6 contract tests. **Residue:** the reviewer recorded *"NO live-browser G1 receipt — tsc+vitest only, insufficient per ux-baseline G1"*, blocked at the time by `C13`. `C13` is now fixed, so the receipt is obtainable. Same class as open #2581, #4408, #4470 — none of which names this surface. Recorded, not filed: G1 receipts are a standing repo-wide debt with three open trackers already, and a fourth adds a row without adding information. |
| `C14` | **SPLIT→RECORDED** — parity half SUPERSEDED, test half recorded | Merged #3071. **Parity docs** (14 docs, 172 MISSING rows) → superseded by open **#3726** (15 admin pages with zero parity doc), **#3725** (4 confirmed-stale docs), **#3722** (ai-red-team "Not A-grade" — untracked), **#3720** (slate-app self-grades D). **Editor tests:** the task named 20 remaining; `lib/editors/__tests__/` now holds **195** files against the 13 spec files it measured, and 6 of the 20 named have a matching test file (`activation-sync`, `cosmos-account`, `data-marketplace`, `digital-twin`, `loom-app`, `mapping-dataflow`). Filename matching is weak and the other 14 are **not** thereby shown absent. Not filed, same reasoning as `C10`: coverage expansion over shipped routes, no observed defect. |
| `P2-DOCS` | **DONE, residues route to existing places** | Merged #3070 (18 files, docs only). It found and fixed real drift — 4 foundry-parity ❌ that were actually shipped, a PARITY-MATRIX whose staleness had migrated to 4 sibling docs, an `EXISTING_*` table wrong in **all 7 rows**, and a `brownfield.md` that contradicted itself on dlz-attach. **Residues, both already owned:** 11 of 12 grades left `_TBD_` deliberately rather than fabricated, naming `C1` as the producer → that is open **#3527**; and the clean-sub acceptance procedure written under an explicit *"Status: NOT RUN"* banner → that is **OP-3**. |

**Nothing filed from these six.** Two residues are genuinely discharged (`C13`,
`E2`), two route to issues that already exist (`C14` parity → #3720/#3722/#3725/#3726,
`P2-DOCS` → #3527 + OP-3), one is a standing repo-wide debt class with three open
trackers (`C7`), and one cannot be observed from here (`D3`). Filing any of them
would add a row without adding information — the same test this reconciliation
applied to the 18.

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
| `G3` | in_progress | **SPLIT→FILED** (#4549) — 1 lane recovered, 3 filed | `deploy-gov.yml` recovered (`success` 2026-08-16). `gov-provision-graph-grants` (1 run ever, failed), `gov-provision-dbx-sql` (4/5 failed) and `gov-provision-dbx-sql-invnet` (9/10 failed) are all still `active`, last-red, and absent from both `workflow-lane-states-allowlist.json` and `check-deploy-staleness.mjs`. |
| `D5` | review | **DONE** | `catalog.bicep:149,304` set `publicNetworkAccess: 'Disabled'` with the policy rationale at `:114`; `scripts/csa-loom/preflight-policy-restrictions.mjs` exists; the promised V5 doc rows are in `docs/fiab/deployment/brownfield.md` and `failure-recovery.md`. |
| `C10` | todo | **SPLIT→RECORDED** — 2 done, 1 partial | Two of three sub-items are fully built. PP solution import/export — `app/api/powerplatform/solutions/route.ts` drives `ExportSolutionAsync` / `DownloadSolutionExportData` / `StageSolution` / `ImportSolutionAsync` / `GetSolutionImportStatus`. Mirroring wizard — `mirrored-database-editor.tsx:309,744` persists `connectionId` and surfaces "Key Vault connection bound". **Scale-by-SKU is PARTIAL, not done** — see below. |
| `C12` | todo | **DONE (buildable half)** | The `ux-fidelity` checklist gate exists as `docs/fiab/ux-standards.md` §7 *"Capabilities checklist (the review gate)"*, §7.0 universal + §7.1–7.5 per surface kind. `ux-fabric-a` W5/W6 was already triaged as *"superseded in practice by the ux-baseline die-hard rule"* in the archived loom-apex audit. The remainder (GOV-3, model-strategy §7, TPM raises) is **OP-5**. |
| `C15` | todo | **SUPERSEDED** → #3513, #3544, #4359 | The FRESH0 half is **done**: `loom-guardrails.yml:682` is now *"prp-freshness (PRP ground-truth drift BLOCKS — FRESH0 / C15)"*, merged as #3131. The G2 half was **re-measured and the audit number corrected** by `check-honest-gate-coverage.mjs`: the registry is 131/131 `fixit:`, 1:1 — "~160 vs 131" was a regex artifact. The real breach is on the surfaces, now a merge-blocking ratchet. |
| `C16` | todo | **SPLIT→FILED** (#4550) — 2 done, 1 filed | AG-13 has a real importer (`app/apps/view/[id]/page.tsx:106`); AG-14 has a real caller (`lib/editors/access-request-inbox.tsx:338`). *Scope note, not a defect: `RequestAccessInline` is mounted on `loom-app` only — whether it belongs on more resource types is a new question.* The t169 function-RG split is still not built → #4550. |
| `C17` | todo | **DONE** | `platform/fiab/bicep/modules/admin-plane/access-governance-sweeper-job.bicep` exists and is wired into `admin-plane/main.bicep:235` as **default-ON** three scheduled Container App Jobs. `lib/access/sweep-auth.ts` replaced the never-set `LOOM_SWEEPER_TOKEN` with a managed-identity path (legacy token still honoured if explicitly set). |
| `C20` | todo | **DONE** | `scripts/ci/check-editor-read-failure-honesty.mjs` — a merge-blocker headed *"FINISHLINE C19/C20"* — plus the shared `lib/components/ui/query-error-bar.tsx` and C20 markers across 10+ editors. The guard **discloses its own scope limit** (34 `useQuery` surfaces vs 506 `useState`+`useEffect`), with `check-empty-claim-read-evidence.mjs` as the sibling for the rest. |
| `C21` | todo | **SUPERSEDED** → #3513, #3544, #4359 | The ai-red-team half is **done**: `ai-red-team-editor.tsx:82-110` renders a non-dismissible `ScopeDisclosure` that degrades to `warning` whenever a run is too narrow to support a safety claim, explicitly labelled C21. The G2-coverage half folds into `C15`. |
| `C4` | todo | **DONE, residual already tracked** | Typed client-route map merged as **#3152** (*"B-R15-17, FINISHLINE C4"*); WS-4.4 object sync merged as #2313; B-R10 slice 1 as #2565. `docs/fiab/decomposition-plan.md:185` records the split. Residual is **#2581, OPEN** and already in the drain ledger. |
| `C5` | todo | **DONE** | LU-7 — `app/api/governance/policy-code/engine-rules/route.ts` plus `lib/governance/policy-code/compilers/trino.ts` and its tests. LU-11 — `app/api/catalog/unity/foreign-catalogs/route.ts` + `app/catalog/unity/page.tsx:1258`. LU-12 — `app/api/databricks/unity-catalog/metric-views/route.ts`, with the Azure-native semantic layer as the **default** backend per `no-fabric-dependency.md`. |
| `C6` | todo | **DONE** | The task itself said "RE-INVENTORY first", and that re-inventory exists: `docs/fiab/help-inventory-2026-08-08.md` — **33 of 33 already done**, 142/142 item guides registered with zero dead links and zero orphans, 29/29 apps covered. D6 visual captures remain operator-gated (**OP-8**). |
| `D11` | todo | **DONE** | The dispatch the task asked for happened. `csa-loom-post-deploy-bootstrap.yml` was stale at 2026-07-19; it has since run `success` on **2026-08-08** and **2026-08-12**. Recurrence is watched — the workflow is registered in `scripts/ci/check-deploy-staleness.mjs:132`. |
| `D17` | todo | **DONE (docs half), with a measured drift** | R8 greenfield + brownfield walkthroughs exist as separate complete pages: `docs/fiab/deployment/greenfield.md`, `brownfield.md`, `failure-recovery.md`, `resource-groups.md`. **Wizard/doc agreement was re-measured, not assumed** — see below. The t169 half went to #4550; the clean-sub acceptance runs are **OP-3**. |
| `F1` | todo | **SUPERSEDED** → #3110 | #3110 is titled *"**F1 federation residue**: amnesiac Iceberg catalog, 30s cold-start 504s, Trino file-ACL, zero credential vending, sign-in app reused as catalog audience"* — it carries this task's name. Companion open issues: #3339, #3746, #3747. |

### `C10` scale-by-SKU — why SPLIT→RECORDED and not DONE

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

### The Gov lanes — a fourth, found in a task the exclusion rule had passed

`G3` (no `#` ref) produced #4549. A second review then found the **same defect
in `G2`**, which the exclusion rule had waved through because it carries #1603,
#3012 and #3060 — none of which covers the lane.

Three of `G2`'s four "never run" Gov lanes have since gone green unaided.
`gov-provision-streaming-migrate.yml` has not, measured 2026-09-17:

- **active**, **1 run in its entire history, `failure`** (2026-08-08T04:23:30Z)
- run `31239331967`, job *"Build + provision loom-migrate + loom-risingwave
  (Gov)"*, failed at step **"What-if both deployments"** — so it never reached
  an apply
- absent from `workflow-lane-states-allowlist.json` and from
  `check-deploy-staleness.mjs`

`check-deploy-staleness.mjs:589-592` **names this gap itself**: *"That
`gov-provision-streaming-migrate.yml` is itself unwatched is a real and separate
gap; it is named here rather than papered over from this entry."* The reasoning
around it is sound — listing a callee under a caller's entry would cry wolf —
but the gap is still open and nothing else picked it up. `cloud-parity.md`'s own
violation grep iterates exactly `G2`'s four workflow names, this one included.

**Added to #4549 rather than filed beside it** (comment
`#issuecomment-5718907867`; title updated three → four). Same defect class, same
two-branch remedy — green it, or declare it in the allowlist with a `reviewBy` —
and splitting it across two issues would split the fix.

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
These are recorded rather than silently left. The first is not cosmetic.

**1 · `app/api/setup/deploy/route.ts:447` — a live non-enforcement resting on an
expired reason.** This is worse than the stale prose in `brownfield.md`. The
comment does not merely restate the false *"no production path evaluates
fitness"* premise; it **uses** it to justify `fitness-not-evaluated` and
`scan-coverage-missing` being absent from the `ENFORCED` set at `:452`. The
producer has since landed (`lib/deploy/fitness-probe.ts`), so the justification
has expired while the non-enforcement it justified is still in effect. Belongs
with #3342.

**2 · `apps/fiab-console/app/api/setup/__tests__/deploy-fitness-gate.test.ts:189`
— a ratchet whose trigger has fired.** Correcting my own earlier framing: this
test **does** have kill power — returning 400 instead of 503 reds it — so it is
**not** an un-killable assertion and does not fall under `assertion-design.md`
§5. Its defect is narrower and real: its own comment says *"When the evaluator
lands, this test is the one to flip"*, **the evaluator has landed**, and its
tracking reference is closed. A ratchet that nobody flipped.

**3 · `docs/fiab/deployment/brownfield.md`** — the BLOCKING DEFECT section whose
probe 2 is falsified, per the `D17` section above.

**Discoverability**, the cheapest items on the list:

- `gh issue view 4495` had **comments=0**, and the drain ledger's single row for
  it points at a title asserting a premise this work falsifies, with no link to
  this directory. **Addressed from here**: a comment now on #4495
  (`#issuecomment-5718914935`) carries the correction, the by-type counts, and
  the paths. That is what an autonomous pass actually walks.
- `PRPs/active/REGISTER.md` has **0 hits** for `finishline` or `harness`
  (control: 1 for `omnibus`, so the grep works) and routes readers to
  `drain-2026-08-31/OWED.md` §2 — where these 19 questions are not. Both files
  are outside this change's ownership.
- `docs/fiab/prp/data-factory.md:378` — *"State carried in
  `.harness/state.json`; one task = one PR."* That path is now
  `.harness/archive/2026-08-08/state.json`. A June-era doc, one line.

**Nit, recorded and deliberately NOT patched:**
`.claude/commands/harness/harness-next.md:38` reads `.harness/state.json` and
falls back to *"No state file (run /harness-init first)"*; `:44` opens the same
path directly. After this archive both resolve to nothing, so the next agent to
run `/harness:harness-next` will be told to **re-initialise a retired program**.
The fix belongs upstream in `claude-tools` — per this repo's `CLAUDE.md`,
`.claude/commands/` is synced from there and a local edit is overwritten on the
next resync. `.harness/README.md` carries a warning for anyone who lands there
by that route.

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
