# loom-apex — ADVERSARIAL REVIEW (2026-08-06)

**Phase E, deliverable 2.** This artifact was **absent** until this commit; its
absence was itself an open exit-criterion (FINISHLINE `AUDIT-2026-08-06` row C1).

**Method.** For each material claim the apex program makes about what shipped, I
attempted to **refute it by measurement**. The default verdict is **REFUTED**;
a claim only earns SURVIVES if a measurement I ran today positively supports it.
"No contrary evidence" is *not* a pass — that is the `unknown_as_negative_class`
and `gates_that_measure_nothing` failure mode this repo has been bitten by
repeatedly.

**A review that confirms everything is a failed review.** Below, 5 claims
survive, 6 are refuted, 2 survive only in part, and 1 is unverifiable.

Companion: [`PHASE-E-REGRADE.md`](PHASE-E-REGRADE.md) (the 142-type ledger).

Repo state: `57ab6a66`. Live Commercial estate: `7e9289cc` / v0.88.0.

---

## Verdict table

| # | Claim under test | Verdict | Decided by |
|---|---|---|---|
| R1 | A1 deploy-skew / ChunkLoadError recovery shipped | **SURVIVES** | live measurement |
| R2 | A2 route error/loading boundaries shipped | **SURVIVES (qualified)** | source count |
| R3 | A3 silent-failure surfaces fixed | **PARTIAL** — 1 of 5 verified | source + test |
| R4 | A5 canvas resize completed | **UNVERIFIABLE today** | needs browser |
| R5 | A6 zero involuntary gates achieved | **REFUTED** | operator + AUDIT |
| R6 | A7 ledger-truth reconcile done | **SURVIVES** | source |
| R7 | Phase B (drain) complete | **REFUTED** | AUDIT C2 |
| R8 | Phase C (Loom Unity) delivered | **REFUTED — security-material** | AUDIT G1/D2 |
| R9 | Phase D (Help Center) complete | **REFUTED** | coverage gate |
| R10 | Phase E artifacts exist | **REFUTED (until this commit)** | file absence |
| R11 | The catalog is a set of A/A+ surfaces | **REFUTED** | ledger arithmetic |
| R12 | G1 receipts are an operable completion gate | **REFUTED (currently)** | run history |
| R13 | Phase E ran in its defined sequence | **REFUTED** | program's own PRP |
| R14 | The competitive grading rests on verified claims | **REFUTED by self-admission** | PARITY-MATRIX text |
| R15 | *(self-audit)* My own measurements were sound | **REFUTED — 3 hollow measurements caught** | self-review |

---

## R1 — "A1 shipped: Next `deploymentId` + ChunkLoadError recovery" → SURVIVES

**Attempted refutation:** if `deploymentId` were not wired, live asset URLs would
carry no build discriminator and post-roll clients would still 404 dead chunks.

**Measurement:** every `/_next/static/**` URL in the live `/catalog` document
carries `?dpl=7e9289cc0a51`, matching the live build SHA
(`7e9289cc0a5106b8a860d716c50acb8d921af2fb` from `/build-marker.txt`).

**Verdict: SURVIVES.** The `deploymentId` half is live and provably tied to the
deployed SHA. **Not proven:** that the ChunkLoadError boundary actually
hard-reloads once and is loop-guarded — that is a runtime behaviour requiring a
roll plus an in-flight client. Recorded as OWED, not as passing.

## R2 — "A2 shipped: error/loading boundaries across the route tree" → SURVIVES (qualified)

**Attempted refutation:** the research claimed `0 error.tsx / 0 loading.tsx /
0 global-error.tsx` across 132 routes. If A2 only added a handful, most routes
would still fall to the raw Next error page.

**Measurement:** 41 × `error.tsx`, 40 × `loading.tsx`, 1 × `global-error.tsx`
against 136 `page.tsx`. Critically, **`app/error.tsx` and `app/global-error.tsx`
both exist at the root** — in Next's App Router a root `error.tsx` catches every
descendant segment, so 41 well-placed boundaries do cover the tree by
inheritance.

**Verdict: SURVIVES, qualified.** Two honest gaps: (a) there is **no root
`loading.tsx`**, so segments without one show no designed loading state;
(b) whether these boundaries *preserve the shell chrome* (A2's actual promise)
is a visual assertion I could not test. The count refutes the "0 boundaries"
baseline; it does not prove the UX promise.

## R3 — "A3 shipped: silent-failure surfaces now fail honestly" → PARTIAL

**Attempted refutation:** A3 named five surfaces that rendered errors as healthy.
I checked the flagship one — `/admin/incident-console`, which showed
"all monitored tables are healthy" on transport failure.

**Measurement:** `lib/panes/incident-console.tsx:113-127` now carries an explicit
`MessageBar intent="error"` reading *"This is a transport failure, not a healthy
state"*, with a comment naming "the 2026-07-15 G1 0-count class". A dedicated
regression test exists: `lib/panes/__tests__/incident-console-error.test.tsx`.

**Verdict: PARTIAL.** One of five verified, and verified well (fix + named
regression test). The other four (`/browse`, `/workload-hub`, `/apps` empty-array
catches; `/admin/rum` + `s3-gateway-editor` `isError`; `AskAffordance.tsx`
un-tried await) were **not** individually confirmed. Claiming A3 complete on one
sample would be the generalisation error this review exists to catch.

## R4 — "A5 shipped: canvas resize completed (height AND width)" → UNVERIFIABLE TODAY

**Attempted refutation:** A5's root cause was a grip that *clips unreachable*
(`top-tabs.tsx` `overflow:hidden` + a clamp to 80vh of the **window**, not the
panel), stranding a height persisted on a tall monitor when reopened on a short
/ RDP window.

**Measurement:** `lib/components/pipeline/top-tabs.tsx:19` still sets
`overflow: 'hidden'`, but line 33 now gives the body `overflow: 'auto'` with a
comment stating the previous structure was the bug. 50 files reference
`sizingKey`, so `SplitPane` adoption is broad.

**Verdict: UNVERIFIABLE TODAY — and this is the honest answer.** The defect was
*"the grip is unreachable at a short viewport with a large persisted height."*
That is a geometry outcome. No amount of source reading settles it; it needs a
browser at a short viewport with poisoned persisted state. Source says the fix
was attempted; nothing available to me says it worked. **Not graded as passing.**

## R5 — "A6 achieved: zero involuntary gates on both estates" → REFUTED

**Attempted refutation:** A6's stated acceptance is *"gate-registry page shows
zero involuntary reds on both estates."*

**Measurement / evidence:**
- The **operator reported on 2026-08-05 that "all the gates" were still present**
  — the incident recorded verbatim in `.claude/rules/deploy-integrity.md`.
- FINISHLINE `AUDIT-2026-08-06` **D15**: day-one scoring "lies BOTH ways" —
  `optIn` is not carried into `EDITABLE_ENV` (policy opt-ins score unconfigured
  forever) *and* `derived`-but-unset counts as configured, with readiness
  mapping `blocked + canAutoResolve → ready` **without consulting a probe**.
- **D16**: `s3-gateway` is opt-in in violation of default-ON.
- Gate registry today: ~160 `GATE_META` entries carrying 131 `fixit:`
  declarations (regex-counted; approximate — nested objects may inflate both).
  So Fix-it coverage is high but **not universal**, and G2 demands it be universal.

**Verdict: REFUTED.** Worse than "incomplete": D15 means the *scoring surface
that would certify A6* is itself unreliable in both directions. A green
gate-page today would not be trustworthy evidence. **This is the single most
important refutation in this document** — it says the instrument is broken, not
merely the result.

## R6 — "A7 done: ledger/PRP truth reconciled" → SURVIVES

**Attempted refutation:** A7 promised to correct three specific stale claims.

**Measurement:**
- `PARITY-MATRIX.md:167` now grades LLM fine-tuning **A− (was F)**, explicitly
  re-graded 2026-07-27 with file-level evidence.
- `PRPs/active/access-governance/PRP.md:4` records its previously-stale "DRAFT"
  as flipped by the A7 reconcile.

**Verdict: SURVIVES.** And it survives *well* — the PARITY-MATRIX row even
volunteers that its browser-E2E receipt is still pending (see R14). That is the
correct disclosure behaviour.

## R7 — "Phase B (drain) complete" → REFUTED

`AUDIT-2026-08-06` row **C2** lists still-open Phase-B work: `B-N14b` NL
governance copilot, `B-N14c` contract-validating copilots, `B-N14e`
agent-designer publish, `B-N19c′` signed evidence on access-review close,
`B-N19d` scheduled insight digests, and the embedding-pipeline **item type**
(the pgvector client exists; the item type does not). Row **C4** adds `B-FP′`,
`B-U12`, `B-R10-17`. Row **C3** adds `B-FN` (11 Functions → ACA jobs).

**Verdict: REFUTED.** Phase B waves 1 and 2 genuinely landed (commits
`449b97a8`, `bd4336a4`), but the phase is not drained.

## R8 — "Phase C (Loom Unity) delivered" → REFUTED, and security-material

This is the most consequential refutation.

- **LU-2 — the AuthN/Z hardening that closes the anonymous-in-VNet catalog —
  merged on 2026-07-2x (`0c011be8`, PR #2553).**
- **AUDIT row G1, measured 2026-08-05: Gov `loom-unity` auth is STILL DISABLED
  LIVE — anonymous read + mutate + SAS, since the 07-15 image.** The code fix
  exists (#2974/#3002); the `gov-uc-purview-wire.yml` dispatch that would make
  it real has never been run.
- **AUDIT row D2: `loom-unity` has NO producer in any Commercial deploy path** —
  and the workflow comment claiming admin-plane wiring is **false** (zero module
  invocations exist).
- **AUDIT row C5:** LU-7 (Trino OPA), LU-11 (foreign catalogs), LU-12
  (metric-views) remain open.

**Verdict: REFUTED.** This is a textbook `deploy-integrity.md` R2 violation:
a merged security fix reported as delivered while the exposure it closes is
**still open on the live Gov estate**, and the Commercial component has no
producer at all. Merged ≠ deployed ≠ done.

## R9 — "Phase D (Help Center) complete" → REFUTED

**Measurement:** `node scripts/csa-loom/check-tutorial-coverage.mjs` reports
**`total: 0/159 published`** (items 0/142, features 0/17; apps not audited).

**Verdict: REFUTED** for D6. In fairness, D6 was always flagged
OPERATOR-GATED, and D1–D4 substantially landed (`479d3126`, `c35b343d`,
`61a46c22`; 144 `editor-*.md` docs on disk; 142/142 slugs registered in
`EDITOR_DOC_SLUGS`). But the phase's own acceptance names tutorial coverage, and
that metric is **zero** — not low, zero.

## R10 — "Phase E artifacts exist" → REFUTED (until this commit)

`ADVERSARIAL-REVIEW.md` did not exist. Neither did any apex `DONE.md` ledger
(the directory held only `PRP.md`, `KICKOFF.md`, `research/`). Writing this file
fixes *artifact existence only* — it does not manufacture the click-walk that
Phase E deliverable 1 actually requires.

## R11 — "The catalog is a set of A/A+ surfaces" → REFUTED

**Refutation by arithmetic, before anyone opens a browser:**

- `ui-parity.md`: a surface is **A-grade only when its parity doc shows zero ❌**.
  **14 item types have no parity doc at all** → cannot be A.
- `no-vaporware.md`: **A = B + tested**. **29 item types have no editor unit
  test** → cannot be A.
- Union: **33 of 142 item types (23%) are disqualified from A on documentary
  grounds alone**, of which **10 are missing both** (`ai-red-team`,
  `analysis-board`, `data-contract`, `data-quality`, `digital-twin`,
  `ducklake-catalog`, `feature-table`, `fusion-sheet`, `notepad`,
  `synthetic-data`).
- And per `ux-baseline.md` G1, **0 of 142 have a click-walk receipt**, so the
  remaining 109 are UNKNOWN rather than A.

**Verdict: REFUTED.** The defensible statement is: *142/142 item types have a
registered rich editor and a registered Learn guide* — which is a real and
substantial achievement — *and 0/142 are currently gradeable as A.*

## R12 — "G1 receipts are an operable completion gate" → REFUTED (currently)

**Measurement:** `loom-ui-verify` last succeeded **2026-08-04T01:02:35Z**
(run `30867496747`). Last 60 runs: 39 success / 19 failure / 2 cancelled. All
three runs today failed, with `Failed to resolve action download info. Error:
Service Unavailable` (GitHub Actions degradation, not a Loom defect); the newest
hung 79 minutes before cancellation.

**Verdict: REFUTED as currently operable.** The mechanism is real and has a
genuine green history — but for ~2.5 days the program's *only* completion gate
has been unavailable. Any task closed as "done" in that window on a G1 basis was
closed without its stated evidence.

## R13 — "Phase E ran in sequence" → REFUTED by the program's own PRP

`PRP.md:159` defines Phase E as *"LAST, after everything above"*, and its
deliverable 1 as *"every surface A/A+"*. R5, R7, R8, R9 each show an earlier
phase still open. Phase E was therefore executed **out of order**, and its
headline deliverable was **unachievable by construction** in this pass.

Recording this so no future reader mistakes "Phase E artifacts landed" for
"Phase E's acceptance was met."

## R14 — "The competitive grading rests on verified claims" → REFUTED by self-admission

`PARITY-MATRIX.md:167` states, of its own re-graded row: *"Browser-E2E receipt
per the G1 bar still pending like other post-matrix rows."*

**Verdict: REFUTED, by the document's own text.** The competitive grades are
source-grounded, not exercise-grounded. That is disclosed honestly, and the
grades may well be right — but they are not receipts.

---

## R15 — turned on myself: my own first measurements were hollow

An adversarial review that does not audit its own instruments is theatre. Three
of my measurements failed before they passed, and all three failed in the exact
patterns this repo's memory already names:

1. **`provisioner: 1/142`** — a regex that matched nothing real. Had I shipped
   it, the ledger would have implied 141 broken item types. Fixed by parsing the
   actual `PROVISIONERS` dispatch map, with an `assert len > 20` tripwire so the
   parse cannot silently return garbage again.
2. **`api: 130/142` is a PROXY, not proof** — it measures a dedicated
   `/api/items/<slug>/` directory, *not* whether a backend exists. Spot-checking
   two "missing" rows refuted my own column: `sql-lab` → `/api/duckdb/query`,
   `/api/sql/trino`; `s3-gateway` → `/api/s3-gateway/info`. Both have real
   backends. The column is relabelled, not deleted.
3. **My FRESH0 mutation proof read the wrong exit code.** I piped `node … | tail`
   and captured `$?` — which is `tail`'s status, always 0 — and briefly concluded
   that `--strict` could not fail. Re-run with the exit captured from `node`
   directly: mutant → **exit 1**, restored → **exit 0**. The guard is sound; my
   first proof was `gates_that_measure_nothing` in miniature.

**Kept in the record deliberately.** The lesson generalises: *any* proof that
routes a command's result through a pipe before reading `$?` is measuring the
last stage of the pipe. That is the same class of defect as the `2>/dev/null`
that produced a false "the tag does not exist" in `deploy-integrity.md` R7.

---

Apex `PRP.md:162-169` requires a red-team grading of each capability area
against **Microsoft Fabric, Databricks (Unity/Genie/Mosaic), Palantir
Foundry/AIP, Snowflake (Cortex)**, plus dbt Cloud / Dataiku / Alteryx / Sigma,
across ~13 capability areas, with per-area win/loss verdicts.

**I am not writing that section today, and that is a deliberate call.**

A competitive grading that cannot exercise the product under test is opinion
wearing the costume of measurement. With 0/142 surfaces click-walked, any
"Loom beats Databricks at X" I wrote here would be unfalsifiable — and would
become a citable claim in future PRPs, exactly the doc-rot pattern the
`docs_source_of_truth` rule and this repo's stale-plan history warn against.

`PARITY-MATRIX.md` already carries a source-grounded competitive assessment
(composite **B+ / A−**), and it *already discloses* its missing G1 receipts.
Duplicating it here with more confidence and less evidence would make the
evidence base worse, not better.

**OWED, with the precondition stated:** the competitive panel becomes writable
once (a) `loom-ui-verify` is green again and (b) a click-walk pass has produced
real grades for at least the T1 cohort (73 types). Until then the honest
competitive position is `PARITY-MATRIX.md` **plus** its own pending-receipt
caveat.

---

## What this review recommends (ordered, and none of it is cosmetic)

1. **Fix the instrument before trusting any gate reading.** AUDIT **D15** —
   `optIn` not carried into `EDITABLE_ENV`; `derived`-but-unset counted as
   configured; readiness `blocked + canAutoResolve → ready` with no probe. Until
   D15 lands, `/admin/gates` and `/admin/env-config` are not evidence (R5).
2. **Close the Gov `loom-unity` exposure (G1) and give Commercial a producer
   (D2).** A merged security fix that never deployed is the most dangerous
   state in the ledger (R8).
3. **Re-run the C1 click-walk the moment Actions recovers.** The re-grade ledger
   is built to be re-run; only the Live-grade column needs filling.
4. **Write the 14 missing parity docs** — no estate required, unblocks 14 rows
   from a hard A-disqualification today (R11).
5. **Add editor unit tests for the 29 untested types**, prioritising the 10
   missing both doc and test.
6. **Treat "0/159 visual tutorials" as a scheduled operator commitment**, not a
   background metric (R9).
7. **Never again let Phase E's acceptance be reported on artifact existence.**
   The artifacts now exist; the acceptance does not (R13).
