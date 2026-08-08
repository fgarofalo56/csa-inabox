# Commercial ↔ Gov capability matrix

**Measured 2026-08-08 (FINISHLINE lane G2/G3/G4).** Every row is either a
MEASURED fact (a run receipt, a file read, a reproduced compile) or is labelled
INFERRED. Per `.claude/rules/cloud-parity.md`, a capability that works in
Commercial and not in a sovereign boundary is **INCOMPLETE, not
"Commercial-first"** — so the "missing" column below is a defect list, not a
roadmap.

> **Why this document is load-bearing.** Databricks Unity Catalog does not
> exist in Azure Government. Loom Unity + Iceberg/Trino federation is therefore
> not a parity checkbox in Gov — it *is* the catalog and federation product for
> sovereign customers. The boundary with the greatest need currently has the
> least product, and this matrix is how that gap stops being invisible.

## Boundaries, and what they actually are

| Boundary | Cloud the lane authenticates to | Region | Param file |
| --- | --- | --- | --- |
| Commercial | `AzureCloud` | `eastus2` / `centralus` (live) | `commercial-full.bicepparam` |
| **GCC** | **`AzureCloud`** — Azure public + GCC M365 identity | `eastus` | `gcc.bicepparam` |
| GCC-High | `AzureUSGovernment` | `usgovvirginia` | `gcc-high.bicepparam` |
| IL5 / DoD | `AzureUSGovernment` | `usgovvirginia` | `il5.bicepparam` |

**GCC is not a Gov-cloud boundary.** It runs on commercial Azure with GCC
tenancy (`deploy-fiab-gcc.yml` sets `AZURE_CLOUD: AzureCloud`). This matters
operationally: a Gov-cloud image producer cannot serve GCC, and vice versa.
Conflating the two is how #3078 stayed open.

## Deploy-lane status (MEASURED 2026-08-08)

| Lane | Boundary | State | Finding |
| --- | --- | --- | --- |
| `deploy-fiab-commercial` | Commercial | active | — |
| `deploy-fiab-gcc` | GCC | **`disabled_manually`** | Was SUCCESS daily to 08-03 — while deploying **zero Container Apps** (#3078). Now disabled, so it produces no signal at all. |
| `deploy-fiab-gcch` | GCC-High | **`disabled_manually`** | **12 consecutive scheduled failures**, 07-23 → 08-03, all on the topology guard. Then disabled rather than fixed. |
| `deploy-fiab-il5` | IL5 | active | **NEVER RUN.** |
| `deploy-gov` (legacy `deploy/bicep/gov/`) | Gov | active | Ran twice ever (07-21), both failed at step 1. Template had **never compiled** — 7 hard bicep errors. Fixed this session. |

**The most important row is `disabled_manually`.** Disabling a red deploy lane
does not fix it; it removes the signal. `deploy-integrity.md` records the
incident this rule exists to prevent in exactly these terms: *"The failure was
not the broken deploy. It was that the breakage was invisible."* Two of the
three Gov/GCC deploy lanes are currently invisible by configuration.

The `deploy-fiab-gcch` guard defect itself **was** fixed on 2026-08-07 (#3079
added the scheduled-reconcile branch, matching what Commercial has had since
audit-t157). That fix is **merged, not deployed** — it has never executed,
because the workflow was disabled before it landed.

## Gov provisioning / verification lanes (MEASURED 2026-08-08)

| Lane | Before this session | After |
| --- | --- | --- |
| `gov-build-images` | **never run** | ✅ **SUCCESS** — first-ever run ([31239350207](https://github.com/fgarofalo56/csa-inabox/actions/runs/31239350207), `loom-unity`). Build → deploy-tag verify → Trivy CRITICAL → cosign sign+verify → ACR re-lock, all green. The `loom-console` branch (S3 agent pool + Copilot-corpus staging — the one genuinely different code path) proven separately on a **non-deploy-referenced tag** so no live pull was re-armed: [31239653478](https://github.com/fgarofalo56/csa-inabox/actions/runs/31239653478) ✅. |
| `gov-workspace-identity` | **never run** | ✅ **SUCCESS** — first-ever run ([31239339295](https://github.com/fgarofalo56/csa-inabox/actions/runs/31239339295)). Only defect was that nobody had dispatched it. |
| `gov-provision-dataplane-images` | claimed never-run | ✅ Already SUCCESS 2026-08-07 — **that premise was stale.** |
| `gov-provision-streaming-migrate` | **never run** | ❌ Failed on first dispatch ([31239331967](https://github.com/fgarofalo56/csa-inabox/actions/runs/31239331967)) with a bare `exit code 3`. Root cause found and fixed; **not yet re-dispatched**. |
| `gov-provision-dbx-sql-invnet` | 8 failures, never green | ⚠️ **Failure class CHANGED — the RBAC blocker is cleared.** See below. |
| `gov-provision-trino` | **never run** | Still never run — Gov Iceberg/Trino federation is unexercised. |
| `gov-uc-purview-wire` | — | failure 2026-08-06. |
| `gov-gates` | — | success 2026-07-30. |

### `gov-provision-dbx-sql-invnet` — the blocker moved, and that matters

Its 8 historical failures (all 2026-07-21) were
`AuthorizationFailed … Microsoft.Authorization/roleAssignments/write` on the ACR
scope. Re-measured today with `apply=true`
([31240115395](https://github.com/fgarofalo56/csa-inabox/actions/runs/31240115395)):

- role assignment **succeeded** (only a benign Graph-API lookup warning)
- `loom-dbx-init` image **built** on the Gov ACR
- the in-VNet Container App job **created, started, and ran**

So the RBAC Administrator grant **cleared the original blocker**. This is why
the brief's instruction to re-measure rather than trust an old blocker matters —
reporting "still blocked on RBAC" would have been false.

The run still failed, but on something entirely different: the Gov Databricks
workspace returned `TEMPORARILY_UNAVAILABLE` from
`/api/2.0/sql/warehouses` on **all 8 list attempts and all 8 create attempts**
over ~6 minutes, then failed closed with `NO_WAREHOUSE_ID`.

Note the workflow behaved *correctly* here — it retried with backoff, failed
closed, and reported the API's own text (deploy-integrity **R6**). The remaining
question is a backing-service one, not a code one: 16 consecutive
`TEMPORARILY_UNAVAILABLE` responses over six minutes is not a transient, and
suggests **Databricks SQL warehouses may not be serviceable on this Gov
workspace**. If that is confirmed, it is a `cloud-parity.md` §3 case — the cloud
genuinely lacks the dependency, so Loom must supply the Azure-native/OSS
equivalent rather than treat it as a Gov-only gap. **Unresolved; needs an
operator decision.**


## Capability parity

| Capability | Commercial | GCC | GCC-High | IL5 | Gap |
| --- | --- | --- | --- | --- | --- |
| Container Apps deployed | ✅ `deployAppsEnabled = true` | ❌ **never set → defaults `false`** | ✅ `true` | ✅ `true` | **#3078** — GCC deploys zero Container Apps. Verified by reading `gcc.bicepparam`: the line is present but commented out pending a GCC image lane. |
| Image producer | ✅ `full-app-deploy-commercial` | ❌ **none** | ✅ `gov-build-images` (proven today) | ✅ `gov-build-images` | GCC needs a *commercial-cloud* producer pointed at the GCC ACR in `eastus`. The Gov lane cannot serve it. |
| Loom Unity / Iceberg / Trino | ✅ | ❌ inactive (gated on `deployAppsEnabled`) | ⚠️ deployable, **unproven** (`gov-provision-trino` never run) | ⚠️ same | The sovereign catalog story is the least-exercised part of the product. |
| Purview | ✅ `purviewEnabled = true` | ✅ `true` | ⚠️ `false` — reuses tenant Enterprise Purview | ⚠️ `false` — Atlas on AKS instead | Intentional per-boundary substitution, not a defect. |
| Workspace-scoped managed identity | ✅ | — | ✅ **proven today** | INFERRED (same code path) | — |
| bicep-drift coverage | ✅ evaluating | n/a | ❌ **zero coverage** — what-if has aborted before comparing anything since 07-27 | n/a | **#2874**, fixed this session. |

## Operator-gated blockers

These cannot be resolved by any workflow and need an operator with directory or
subscription rights.

1. **Re-enable `deploy-fiab-gcch` and `deploy-fiab-gcc`** (repo Actions admin).
   Both are `disabled_manually`. The gcch guard defect is already fixed
   (#3079), so the scheduled reconcile should now pass — but that is INFERRED
   from reading the guard, and cannot be proven while the lane is disabled.
   Re-enabling resumes a daily deploy ring into sovereign estates, which is a
   cost and blast-radius decision, so it is deliberately left to the operator
   rather than flipped by an agent.

2. **`#2330` — Gov SP UAA grant on the Gov admin RG.** Named here for
   completeness; not re-measured this session.

3. **Synthetic-journeys Conditional Access exclusion** for
   `svc-loom-synthetic@limitlessdata.ai` (tenant admin). Documented in
   `gov-build-images`' own summary: building the `loom-uat` image does not make
   the Journeys tab populate until a tenant admin scopes the CA exclusion.
   Nothing in this repo can automate it.

## What changed in Gov's favour (re-measure before trusting old blockers)

The Gov deploy SP was granted **RBAC Administrator** this session. Two
historical blockers are therefore suspect and were re-measured rather than
believed:

- `gov-build-images` — previously assumed blocked; **succeeded on its first-ever
  run today**, including the ACR firewall lease and role-dependent steps, for
  both the simple app path and the console path.
- `gov-provision-dbx-sql-invnet` — its 07-21 failure was
  `AuthorizationFailed … roleAssignments/write` on the ACR scope. **Re-measured
  today: that step now succeeds.** The lane fails later and for an unrelated
  reason (see above).

The general lesson, recorded so the next session does not repeat it: **"this
has always been blocked in Gov" is a claim with a timestamp.** Re-measure it.
Two of the four premises this lane was handed were already stale.

## Method

- Every Gov fact came from a GitHub Actions run. **No local `az` was ever run
  against Gov** — there is no local Gov context and attempting one wastes time.
- Bicep compile failures were reproduced locally with the pinned bicep 0.45.15.
- Workflow enabled/disabled state came from
  `gh api repos/{owner}/{repo}/actions/workflows`, which is the only place that
  distinguishes "passing", "failing", and "not running at all".
