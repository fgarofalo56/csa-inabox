# FINISHLINE operator queue — 19 questions, re-measured 2026-09-17

> **Some of these have since been answered. The answers are in `DECISIONS.md`,
> beside this file.** Decided there: **OP-3**, **OP-7**, **OP-8**, **OP-9 item
> 2**, **OP-14**, and **OP-19(b)**. **OP-15** dissolved on measurement — its
> premise was false and its row must not be acted on. Still carrying something
> live: **OP-5**, **OP-9 items 1/3/5/7**, **OP-11**, **OP-13**, **OP-19(a)**.
>
> Read `DECISIONS.md` § "Provenance" before relying on any of it: none of those
> decisions has an artifact a reader can follow, because on this repository an
> operator statement and an agent statement are indistinguishable by author.
>
> The question text below is left as it was asked. A decision is only legible
> beside the question it answers.

The FINISHLINE harness (`.harness/`) carried an `operator_queue` of **19
decisions**. None has been answered since **2026-08-06**. The harness is being
retired (`Refs #4495`); this page exists so the queue is answerable in one pass
instead of dying with the ledger.

**Nothing here is answered for you.** Every row is an operator decision. What
the re-measurement *does* do is say whether the question still stands, because
six weeks of merges have settled several of them — and a settled question that
still looks open wastes a pass.

Verdicts used below:

| verdict | meaning |
|---|---|
| **OBSOLETE** | the thing the question was about has happened, or its premise is gone. No decision needed. Evidence given per row. |
| **NARROWED** | part of the question answered itself; a smaller decision remains. |
| **LIVE** | still stands as asked — as first measured, not a claim about today. See the note at the top of this page. |

Counts: **5 OBSOLETE · 4 NARROWED · 10 LIVE.**

Two of the ten LIVE rows — **OP-13** and **OP-14** — carry a part that has since
been discharged. They are filed under LIVE because a real decision survives in
each, but the discharged part is marked at the row so it is not re-litigated.
The counts are of *questions*, not of sub-asks; several rows bundle two or three.

Source of the original text: `.harness/archive/2026-08-08/state.json`,
`operator_queue[]`. The archived program spec is at
`PRPs/archive/2026-08-22-omnibus-consolidation/finishline/` (`PRP.md` +
`AUDIT-2026-08-06.md`).

---

## OBSOLETE — no decision needed

### OP-1 · task `G1` · gov-uc-purview-wire

**Asked.** The workflow was dispatched 2026-08-06T16:12Z and still running
(3.5–4.5h). "No action needed unless it fails — then either a new attended
window (`skip_purview=true` narrows; JWKS egress risk) or an interim
IP-restrict on Gov `loom-unity`."

**Blocked.** Nothing, conditionally.

**Why obsolete.** It did not fail in the end.
`gh run list --workflow gov-uc-purview-wire.yml` shows three failures on
2026-08-11 followed by **`success` 2026-08-11T17:15Z**. The contingency never
had to be chosen. Related issue states: #2643 is no longer open; #2974 and
#3002 both merged.

### OP-10 · task `C8` · #2622 residual

**Asked.** Operator file access to add `try/finally` inside
`shortcut-credentials.ts` and drop `KNOWN_UNAUDITED`.

**Blocked.** #2622.

**Why obsolete.** #2622 — *"LU-3 follow-up: audit the un-audited Unity Catalog
exits (shortcut-credentials, SQL DDL, account-plane)"* — is **CLOSED**.

### OP-12 · task `C11` · #2671 thrift / Rust CI lane

**Asked.** The thrift fix needs a lockstep arrow/parquet/datafusion/deltalake
major migration in `loom-directlake` with a real `cargo` build; no cargo on the
dev host, no CI compiles that crate. Decide: **add a Rust CI lane, or park**.

**Blocked.** #2671.

**Why obsolete.** **Both branches of the decision have been settled**, and by
opposite means.

The premise died: #2671 is **CLOSED** and was re-titled *"security: 1 HIGH
Dependabot alert — nanoid <3.3.17 (**thrift premise is dead**)"*, so there is no
thrift migration to build a lane for.

And the alternative the question offered — *"add a Rust CI lane"* — **was built
anyway**. `.github/workflows/loom-directlake-ci.yml` exists and is green:
`cargo build --locked` across both feature sets plus `cargo test`, with the
toolchain installed in-lane (`:74-80`); last runs `success` 2026-09-13 and
2026-09-14. Its own header records the gap it filled — *"`grep -rl "cargo "
.github/workflows` returned ZERO files"* — which is the condition OP-12
described. So "no CI compiles that crate" is no longer true either.

Nothing to decide on either horn.

### OP-17 · task `C18` · pin three MCR `:latest` refs

**Asked.** Pin the three floating MCR refs on deploy paths —
`dab-runtime.bicep:36`, `presidio-sidecar.bicep`,
`deploy-planner/container-instances.bicep:19`?

**Blocked.** `C18`.

**Why obsolete.** The decision was taken and executed. All three are pinned at
head, and a guard now watches the class:

| ref | at head |
|---|---|
| `dab-runtime.bicep:43` | `data-api-builder:2.0.9@sha256:ad5ac179…` — digest-pinned |
| `presidio-sidecar.bicep:75,126` | `${acrLoginServer}/presidio/analyzer:2.2.358` / `anonymizer:2.2.358` — versioned, boundary-local |
| `deploy-planner/container-instances.bicep:23` | `aci-helloworld@sha256:456a1150…` — digest-only |

Registry of record `platform/fiab/images/mcr-images.json`; enforcement
`scripts/ci/check-mcr-image-pins.mjs`. A repo-wide
`grep -rnE "mcr\.microsoft\.com/[^'\"]*:latest" --include=*.bicep` returns two
hits and neither is a deploy path: an `examples/ai-agents` sample, and a prose
comment in `presidio-sidecar.bicep:10` describing the old state.

### OP-18 · task `E3` · #2970 should be re-titled

**Asked.** #2970's stated hypothesis (AI Search searchMode/queryType/window) is
measurably not the cause; the real cause was window-local BM25 IDF collapse in
`rankChunks`. Left as-is the title sends the next investigation down the same
wrong path. **Re-title, or record the correction.**

**Blocked.** Nothing; it is a correctness-of-the-record ask.

**Why obsolete.** Exactly what was asked has been done. #2970 is now titled
*"Copilot retrieval: window-local BM25 collapses IDF (NOT AI Search stage-1
recall — hypothesis falsified)"* and is CLOSED.

---

## NARROWED — a smaller decision remains

### OP-2 · task `D12` · #2958 attended re-apply window

**Asked.** Decide MSAL inline-vs-KV-ref, then dispatch an attended re-apply of
data-plane grants for the 3 changed identities; accept the `loom-mcp` `/data`
blip during it.

**Blocked.** #2958.

**What changed.** #2958 is still **OPEN** but has been re-scoped by its own
title: *"admin-plane redeploy is **NOT unsafe any more** — it runs green on
schedule; all that remains is an `/admin/readiness` receipt for DuckLake +
RisingWave."*

**Remaining decision.** The attended window and the inline-vs-KV-ref choice are
no longer what #2958 is about. What survives is whether you want the
`/admin/readiness` receipt gathered under an attended window or left to the
schedule. **Recommend reading #2958's current body before answering — the
question in the harness is six weeks stale.**

### OP-4 · task `D16` · #2640 svc-postgres cost ruling

**Asked.** `svc-postgres` default-ON vs policy-accepted opt-in — a cost ruling.
Plus: "s3-gateway returns to default-ON automatically once D14 (ACR mirror)
lands; no ruling needed there."

**What changed.** The s3-gateway half resolved itself exactly as predicted:
`platform/fiab/bicep/modules/admin-plane/main.bicep:1452` reads
`var s3GatewayEnabled = true`. #2640 is MERGED
(*"deploy svc-ducklake-catalog + svc-loom-duckdb by default (s3-gateway split
out in round 4)"*).

**Remaining decision.** `svc-postgres` only, and it is **still opt-in**:
`main.bicep:4554` — *"the svc-postgres gate reads opt-in, and the vector store
falls back"*; the gate is registered at
`apps/fiab-console/lib/gates/registry/azure-services.ts:591`. Under
`auto-bind-by-default.md` a cost-material opt-in is allowed **only** when the
operator has explicitly chosen it and the reason is recorded in the gate
registry. Right now it is opt-in *without* that recorded ruling. So the ask is:
**default-ON, or opt-in with the cost reason written into the registry entry.**

### OP-16 · task `D13` · three decisions

**Asked.** (1) Retire `csa-loom-spark-probe2.yml` (byte-identical duplicate of
the livy probe, kept dispatchable)? (2) #3025 — accumulated unexpired Entra
credentials on the MSAL app (07-19 / 07-23 / 08-03, all `--append`) need a
deliberate keep-or-clean decision. (3) #3034 item 5 — the zero-jobs
symptom-level check was not built; parse-level hard-fail covers the known cause.
Want the symptom-level watcher as its own item?

**What changed.** Parts (2) and (3) are **obsolete**: #3025 is CLOSED
(*"Two MSAL rotation traps…"*) and #3034 is CLOSED (*"Three workflows are
invalid YAML and have NEVER executed…"*).

**Remaining decision.** Part (1), and it has grown. Both
`.github/workflows/csa-loom-spark-probe2.yml` **and**
`.github/workflows/csa-loom-spark-probe3.yml` exist at head. The question is now
**how many Spark probe lanes should there be, and which retire** — not whether
to retire one.

### OP-6 · task `G5` · #2330 Gov grants + quota + consent

**Asked.** #2330 Gov SP UAA grant on the Gov admin RG (highest-leverage single
grant); Gov PG quota increase; tenant consent / PATs for the remaining Gov
services.

**What changed.** #2330 is **MERGED** — but it is a *docs* PR
(*"docs(gov): 77/92 execution update + deploy-SP role-grant constraint"*), so
the merge recorded the constraint rather than performing the grant. The live
tracker is **#2698, OPEN**: *"Gov gates: 105/125 — zero critical/recommended
blocked; the 20 optional are bucketed and mostly NOT agent-closable."* Gate
coverage moved 77/92 → 105/125 in the interim.

**Remaining decision.** The grant, the quota and the consents are still
operator-only actions. Answer them against **#2698's current bucketing**, not
against the 2026-08-06 framing. Note `loom_optional_severity_is_the_defect`:
"optional" in that bucket list is not a licence to skip.

---

## LIVE — still stands as asked

### OP-3 · task `D17` · clean-sub acceptance runs

Commercial **and** Gov, from a fresh subscription, via the three-step
from-scratch path in `no-vaporware.md`. Needs an operator-provided clean
subscription and an attended window.

**Blocked.** `deploy-integrity.md` R4 — greenfield proves nothing about
brownfield and vice versa, and neither cloud's receipt substitutes for the
other's. The R8 docs half of `D17` is **done**
(`docs/fiab/deployment/greenfield.md`, `brownfield.md`,
`failure-recovery.md`, `resource-groups.md`); this is the part that only an
operator can unblock.

### OP-5 · task `C12` · GOV-3 / model-strategy §7 / TPM raises

Three product decisions. The buildable half of `C12` is done — the
`ux-fidelity` checklist gate exists as
`docs/fiab/ux-standards.md` §7 *"Capabilities checklist (the review gate)"*
(§7.0 universal plus §7.1–7.5 per surface kind). These three are what remain.

### OP-7 · task `C11` · Esri license

Gates `geo-graph-ml` GEO-2/3/4. The program is archived at
`PRPs/archive/2026-08-22-omnibus-consolidation/geo-graph-ml/PRP.md`, where GEO-2
is sequenced **last** and explicitly BYO-license. Unrelated note so it is not
mistaken for an answer: `lib/editors/report/map-visual.tsx:28` records a
*separate* decision that ArcGIS/Esri stay out of the report map visual as
third-party. That does not settle the GeoAnalytics license question.

### OP-8 · task `C6` · help-program D6 visual captures

Screenshots and recordings, operator-produced per the privacy workflow. The
written half of `C6` is **done and re-measured** —
`docs/fiab/help-inventory-2026-08-08.md` found **33 of 33** baseline items
already complete (142/142 item guides, 29/29 app tutorials). Visual captures are
the outstanding piece and are operator-gated by design.

### OP-9 · task `C1` · loom-apex operator items 1–7

Verbatim from the archived `loom-apex/PRP.md:180-186`:

1. Entra CA exclusion for `svc-loom-synthetic@limitlessdata.ai` → V1 login probe online.
2. I6/I7 enforce flip after I9 sign-off + clean-shadow window (~08-05). **That window has passed.** It needs a fresh decision, not a silent roll-forward — and it is now six weeks staler than when that warning was written.
3. S2 FIC flip on the prod app reg.
4. Visual-tutorial capture runs + privacy review — the same work as OP-8. Quantified then as 0/159 published (items 0/142, features 0/17).
5. RisingWave image-tag confirm + Trino Helm install (opt-ins).
6. Esri license for GEO-2 — the same decision as OP-7.
7. The 10 operator actions in the archived `loom-apex/research/gates-zero.md`.

Items 4 and 6 are duplicates of OP-8 and OP-7; answer them once.

### OP-11 · task `D18` · #2678 audience registration

The Trino app registration's `api://` audience is not a registered App ID URI
(`identifierUris` empty) — the exact value is in #2678. Pick:
registration, an alternative audience, or the managed-identity path — options
a/b/c are in the reopen comment. **#2678 is OPEN** at head
(*"svc-loom-trino: default-ON Federated SQL engine + a working Entra posture"*),
so this stands exactly as asked.

### OP-13 · task `D4` · attended D4–D6 proving deploy

Dispatch `deploy-fiab-commercial.yml` attended with `run_mode=full`
`region=centralus` `keep_resources=true` `allow_existing_hub=true`, after #3058
merges.

**#3058 is MERGED**, so the stated precondition is met. The run has not
happened, and there is a new obstacle the question predates: the six most recent
`deploy-fiab-commercial.yml` runs — 2026-09-12 through **2026-09-17**, all
`schedule` — are **all `failure`**, already tracked as **#4448**. An attended
dispatch into a red lane is unlikely to produce the receipt.

The watch-list in the original ask is still worth carrying verbatim into
whenever the window opens:

- Expect discovery to print ADOPT of `vpngw-loom-centralus` + `link-apim-console`; zero leaves of the four fixed classes; DuckLake either provisions or visibly per-leaf-retries as capacity (~300s).
- Watch that `apim-gateway-dns-a` no-ops with `recordAuthored=false` and the live 10.0.4.4 survives; catalog green with managed-RG storage PNA=Disabled.
- **#3056 hazard:** the admin-plane deploy's bicep `guid` for `loom-internal-token` will overwrite the rotated 64-char secret and re-break the evaluator / reconciler / cost-monitor consumers. *(#3056 is now CLOSED — re-check whether this hazard survived the fix before relying on the warning either way.)*
- Reviewer additions: (a) the 10.0.4.4 APIM A record may be permanently manual — PremiumV2 never reports `privateIPAddresses`, so "the next reconcile authors it" may never fire; (b) capacity retries × ~40–60 min/attempt will hit the 120 m wall-clock before max-attempts 4 — expect "wall-clock budget exhausted" if centralus stays short; (c) a red DISCOVERY step (exit 3) is an RBAC read gap on the deploy identity, **not** a regression of these fixes.

### OP-14 · task `E1` · #3056 needs an owner + judge cap

Two parts, and they diverge.

- **#3056 is CLOSED** (*"internal-token rotation strands stale copies… broke eval-probe/reindex 2026-08-06"*), so "needs an owner" no longer stands **as an ownership question**. See the OP-13 hazard note above.
- **Still live:** the Copilot-evaluator judge cap. It was raised to 5000/day — worst case ~20–25 M gpt-4.1 tokens/day if fully consumed, realistic burn far lower. Override via `functionAppsConfig.copilotEvalJudgeDailyCap`. **Do you want a different ceiling?** That is a cost decision nobody has made.

### OP-15 · task `D2` · Tag Contributor on the ACR

**This question dissolved on measurement. Do not act on it — see
`DECISIONS.md` § "OP-15".** Both halves of the premise below are false: the
deploy identity already holds Owner at the tenant-root management group, so it
does not lack `Microsoft.Resources/tags/write`; and the lease tags are erased by
every subscription-scope apply regardless, so the grant would not make leases
race-free. Issue 4563 tracks the real problem. The question text is kept below
because the answer is only legible beside what was asked.

The deploy identity lacks `Microsoft.Resources/tags/write` on the Commercial ACR
(name in `.harness/archive/2026-08-08/config.json`, `estate.commercial.acr`), so
#2603 firewall leases run in legacy-fallback
(unleased) mode. Granting Tag Contributor on the registry makes leases
race-free.

#2603 itself is CLOSED, but the grant is an estate action a merge cannot
perform, so closing the issue did not perform it. Context that raises the
stakes rather than lowering them: **#4285 is OPEN** — *"ACR firewall lease: ~13
Commercial claimants on one per-registry mutex, none serialized, with a 25-min
wait budget below the builder's 36-min median hold."* Unleased fallback under
that much contention is the #3676 shape. That contention is real and is not
dissolved; what dissolved is the idea that a role grant addresses it.

### OP-19 · task `C3` · Function Apps — two asks

**(a) Cheap mitigation, needn't wait for the removal PR.** Disable the two
enabled function definitions on `func-secexp` (timer `0 0 6 * * *`) and
`func-cpeval` (`0 0 7 * * *`). They are identical to their live ACA job crons
(`loom-secret-expiry-monitor 0 6 * * *`, `loom-copilot-evaluator 0 7 * * *`), so
if those hosts ever recover the work runs **twice**.

**(b) Approve teardown?** Seven Function Apps remain provisioned and billing
while executing nothing — `FunctionExecutionCount` sum = 0 over 13 days; 5 are
superseded by live ACA replacements. Removal was deliberately deferred so it
pairs with proof in a reviewable commit.

**Still live at head.** The C3 migration is real and partly landed —
`report-subscriptions-job.bicep` is an in-VNet scheduled Container App Job
running as the Console UAMI, and `main.bicep:8650` still carries the measurement
that `func-secexp`/`func-cpeval` *"DO hold enabled timers."* Function Apps are
still declared in bicep (`builtin-mcp.bicep`, `label-propagation-function.bicep`,
`monitor-ops-agent.bicep`, `scc-labels-function.bicep`), and
`full-app-deploy-commercial.yml:1259` still looks up `func-cpeval-*` at deploy
time. Nothing has disabled the duplicate timers.

---

## What to do with this page

Answer in place — an issue comment on #4495, or edits to this file, either is
fine. When a row is settled, record the decision where the code can see it
(`PRPs/.../DECISIONS.md` for a declined item, the gate-registry entry for a
cost-material opt-in, a workflow allowlist entry for a parked lane) rather than
only here. A decision that lives only in a retirement doc is the same class of
loss this page was written to prevent.
