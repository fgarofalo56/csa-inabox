# Copilot retrieval remediation — P0/P1/P2/P3 measured results

**Issue:** [#2585](https://github.com/fgarofalo56/csa-inabox/issues/2585) ·
**Diagnosis:** [`copilot-quality-triage.md`](copilot-quality-triage.md) ·
**Status:** P0, P1, P1b, P2, P3 implemented and measured offline; the AI Search
retrieval path is now wired through the same ranker (#2929, §9 — deploy-gated);
P4 (floor re-baseline) NOT started ·
**Floors:** `content/evals/eval-floors.json` is **unchanged** — re-baselining is
P4 and happens last, from ≥3 real runs through the existing raise-only ratchet.

Everything below is labelled **MEASURED** (reproducible from this repo with no
Azure access and zero judge-token spend) or **INFERRED** (reasoning from code,
not executed).

Reproduce every number here with:

```bash
node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs
node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs --top 8
node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs --top 8 --source-weights 0.9:0.75:0.7
node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs --explain health
```

`scripts/csa-loom/measure-retrieval.mjs` **imports the shipping ranker**
(`apps/fiab-console/lib/azure/docs-ranker.ts`) through Node's native
type-stripping, so the "after" column is the code that runs in the console — not
a second implementation that could agree with itself while both disagree with
production. (The triage script it sits beside,
`scripts/csa-loom/diagnose-retrieval.mjs`, measured a *port*, because at the
time the ranker was module-private.)

---

## 1. Headline — before vs after

**MEASURED**, doc-level hit-rate under the evaluator's own `scoreRetrieval`,
146 golden rows / 10 surfaces, corpus 49,593 chunks / 2,588 documents.

"Before" is production as it shipped: substring/term-presence ranking in a
top-5 window. "After" is production as this change ships it: BM25 +
per-document diversification + surface boost, in the new top-8 window.

| surface | before (substring@5) | **after (shipped@8)** | Δ | floor |
|---|---|---|---|---|
| cost | 0.167 | **1.000** | +0.833 | 0.5 |
| data-agent | 0.133 | **0.867** | +0.734 | 0.5 |
| deploy-planner | 0.333 | **0.800** | +0.467 | 0.5 |
| eventstream | 0.083 | **0.833** | +0.750 | 0.5 |
| health | 0.133 | **0.467** | +0.334 | 0.5 ⚠️ |
| help | 0.250 | **0.600** | +0.350 | 0.5 |
| kql-database | 0.133 | **0.733** | +0.600 | 0.5 |
| lakehouse | **0.000** | **0.667** | +0.667 | 0.5 |
| rbac | 0.333 | **0.917** | +0.584 | 0.5 |
| report | 0.267 | **0.867** | +0.600 | 0.5 |
| **OVERALL** | **0.185** | **0.760** | **+0.575** | — |

**Zero surfaces regress.** Nine of ten clear the seeded 0.5 floor offline;
`health` (0.467) does not — see §5.

> These are OFFLINE numbers over the Cosmos-fallback ranking path. They are not
> a prediction of the next live `copilot-quality-evals` run. Do not treat them
> as a reason to touch the floors.

---

## 2. Lever by lever, at a fixed window

**MEASURED** at top-5 (left) and top-8 (right). Each column adds one lever to
the one before it, except `title2` and `sfc-filter`, which are alternatives that
were measured and **rejected** (§4).

| surface | substring@5 | bm25@5 | +div@5 | +sfc@5 | | substring@8 | bm25@8 | +div@8 | +sfc@8 |
|---|---|---|---|---|---|---|---|---|---|
| cost | 0.167 | 0.750 | 0.750 | 1.000 | | 0.250 | 0.917 | 0.917 | 1.000 |
| data-agent | 0.133 | 0.667 | 0.667 | 0.867 | | 0.267 | 0.800 | 0.800 | 0.867 |
| deploy-planner | 0.333 | 0.600 | 0.600 | 0.800 | | 0.333 | 0.667 | 0.667 | 0.800 |
| eventstream | 0.083 | 0.667 | 0.667 | 0.833 | | 0.083 | 0.750 | 0.750 | 0.833 |
| health | 0.133 | 0.467 | 0.467 | 0.467 | | 0.133 | 0.467 | 0.467 | 0.467 |
| help | 0.250 | 0.400 | 0.400 | 0.400 | | 0.300 | 0.600 | 0.600 | 0.600 |
| kql-database | 0.133 | 0.333 | 0.333 | 0.733 | | 0.200 | 0.467 | 0.467 | 0.733 |
| lakehouse | 0.000 | 0.333 | 0.333 | 0.600 | | 0.000 | 0.333 | 0.333 | 0.667 |
| rbac | 0.333 | 0.667 | 0.667 | 0.833 | | 0.333 | 0.750 | 0.750 | 0.917 |
| report | 0.267 | 0.733 | 0.733 | 0.800 | | 0.333 | 0.733 | 0.733 | 0.867 |
| **OVERALL** | **0.185** | **0.548** | **0.548** | **0.712** | | **0.226** | **0.637** | **0.637** | **0.760** |
| *distinct docs* | 4.45 | 4.51 | 4.60 | 4.47 | | 7.05 | 6.92 | 7.17 | 6.95 |

Read that honestly:

* **The ranker is the dominant lever** — +0.363 at top-5, +0.411 at top-8, at a
  fixed corpus and window. This is P0 and it is the whole reason the change
  exists.
* **The surface boost is the second lever** — +0.164 at top-5, +0.123 at top-8,
  with **no surface worse off**. It is what finally moves `kql-database`
  (0.333 → 0.733) and `lakehouse` (0.333 → 0.667), the two surfaces the triage
  flagged as resisting plain BM25.
* **Diversification does NOT move hit-rate at the shipped window.** 0.548 →
  0.548 at top-5, 0.637 → 0.637 at top-8. Its measured effect is +0.15 (top-5) /
  +0.25 (top-8) *distinct documents* per window, and +0.021 hit-rate at top-10
  (0.671 → 0.692). It ships because evidence diversity is the actual product
  complaint in #2585 — not because it lifts the metric, which it does not.
* **Widening 5 → 8 is worth +0.048** at the shipped ranker (0.712 → 0.760) with
  zero regressions. Top-10 would give a further +0.021 (0.781); it was not taken
  because the token cost of a 10-chunk grounded prompt was not measured against
  any answer-quality benefit.

---

## 3. What shipped

| lever | where | flag | default |
|---|---|---|---|
| BM25 ranking (tokens, IDF, TF saturation, length normalisation, stopwords) | `lib/azure/docs-ranker.ts` → `searchCosmos` | `copilot-bm25-retrieval` | **ON** |
| Per-document diversification (max 2 chunks/doc, over-fetch ×4, backfill) | `searchDocs` | `copilot-bm25-retrieval` | **ON** |
| Surface topical boost (×1.35 on-topic) | `searchDocs` + eval probe + Copilot tool | `copilot-surface-scoped-retrieval` | **ON** |
| Retrieval window 5 → 8 | `DEFAULT_DOC_RETRIEVAL_TOP` | `copilot-retrieval-window-8` | **ON** |

All three default **ON** per `loom_default_on_opt_out`, and all three fail
**open** to the new path if the flag store is unreachable — the new path is the
measured-better one, so a flag-subsystem outage must not silently restore the
worse ranker. OFF on `copilot-bm25-retrieval` restores the pre-#2585 scorer
**byte-identically** (the old function is preserved verbatim in `docs-ranker.ts`
as the revert target, not re-derived).

### Surface scoping is a boost, never a filter

`surfaceTopicTerms()` derives topic terms **mechanically from the surface slug**
(`kql-database` → `kql`, `database`). That is deliberate: a hand-curated
surface→topic map would be written by someone who has already seen which
documents the golden sets expect, which fits the metric rather than improving
retrieval. The mechanical mapping is why `health` → `health` gains nothing (its
gold document is `parity/monitor.md`) and why `help` → `help` is a no-op — both
are correct outcomes, and both are visible in the table above.

In production the surface is the open item's type (`pageContext.itemType`), so
this is a real product change, not an eval-only one.

### Backend asymmetry, stated plainly

On the Cosmos/BM25 path the surface boost is folded into **scoring**, so it can
promote a document from anywhere in the corpus. On the Azure AI Search path the
ranking happens inside the service, so the boost can only **re-sort the
over-fetched window**. The offline harness exercises the Cosmos path only —
**the AI Search variant is a weaker approximation that has not been measured.**

---

## 4. What was measured and deliberately NOT shipped

### Filename / heading boost — rejected

**MEASURED** (BM25 + diversification, boost 2.0 vs 0):

| | top-5 | top-8 |
|---|---|---|
| overall | 0.548 → 0.575 (+0.027) | 0.637 → 0.664 (+0.027) |
| `kql-database` | 0.333 → **0.200** (−0.133) | 0.467 → **0.400** (−0.067) |
| `health` | 0.467 → **0.400** (−0.067) | — |
| `eventstream` | — | 0.750 → **0.667** (−0.083) |
| `cost` | — | 0.917 → **0.833** (−0.084) |
| `help` | 0.400 → 0.550 (+0.150) | 0.600 → 0.550 (−0.050) |
| `report` | 0.733 → 0.867 (+0.134) | 0.733 → 1.000 (+0.267) |

It buys +0.027 overall and costs up to −0.133 on a single surface, and its sign
flips between windows (`help` +0.150 at top-5, −0.050 at top-8). That is a tuned
parameter, not a ranking improvement. `Bm25RankOptions.titleBoost` exists and
**defaults to 0**; a unit test asserts it stays off.

### Hard surface filter — rejected

**MEASURED** — restrict the window to documents whose path carries a surface
term, backfilling when too few match:

| | top-5 | top-8 | top-10 |
|---|---|---|---|
| soft boost (shipped) | **0.712** | 0.760 | 0.781 |
| hard filter | 0.692 | 0.767 | 0.788 |
| `rbac`, boost vs filter | 0.833 / **0.667** | 0.917 / **0.750** | 0.917 / **0.750** |

The filter's aggregate edge at top-8/10 is ≤0.007 — **one golden row out of
146**, i.e. noise. Its `rbac` regression is −0.167 at every window, which is not.
A filter also makes a document *unreachable* rather than merely lower-ranked,
which is the wrong failure mode for cross-cutting questions. The plan said
"apply the surface filter"; the measurement says apply it as a prior, not a
gate, so that is what shipped.

### Top-10 window — not taken

+0.021 over top-8, at the cost of two more ≤1500-character excerpts in every
grounded prompt. Answer quality was not measured (zero judge spend by design),
so there is no evidence the extra context is worth the tokens. The route still
honours an explicit `top` up to 10.

### AI Search scoring profile — not attempted

Triage §P0.2 proposed a scoring profile weighting `path` and `heading` above
`content`. That is precisely the filename/heading boost measured above, which is
**not** a free win — and the offline harness cannot exercise the AI Search
backend at all, so shipping it would be an unmeasured change to a path the
measurement cannot see. Left for a follow-up that can measure it live.

---

## 5. `health` is still below floor

> **Resolved in P2 — see §8.2.** The diagnosis below was correct: it was a
> content problem. `parity/monitor.md` was found to be materially stale (it
> claimed alert authoring was unwired when it ships, and documented 6 of the
> surface's 13 tabs). Correcting it took `health` to **0.667** on this same
> ranker and **0.800** with P2's source weighting. The paragraph below is kept
> as the original diagnosis.

**MEASURED** — `health` moves 0.133 → 0.467 and stops there. 12 of its 15 rows
expect `docs/fiab/parity/monitor.md`, a document whose name shares no token with
the word "health", so neither the surface boost nor a filename boost can reach
it; only the body text can. This is a **corpus/content** problem (P2 territory),
not a ranking one, and it is the honest reason one surface will still sit under
0.5 on the next run.

That is not a reason to lower its floor. It is a reason to fix the content or
the golden set, tracked under #2585.

---

## 6. Harness defects fixed (P3)

1. **Judge evidence ≠ generation evidence.** The judge graded grounding on
   `slice(0, 300)` while the model answered from `slice(0, 1500)` of the same
   chunk (`eval-probe/route.ts:45` vs `:117`), so any claim drawn from
   characters 301–1500 looked ungrounded. Both call sites now read one exported
   constant, `EVIDENCE_CHARS = 1500`, and a route test asserts the preview is
   the exact slice the prompt contains. **`groundingAvg` is not comparable
   across this change** — runs before it were graded on 20% of the evidence.
2. **`surface` was a no-op.** Accepted, echoed, never applied. Now applied as
   the topical boost above, and asserted by a test that an echo-only
   implementation fails.
3. **The receipt never said which backend answered.** `backend` was written on
   every per-question Cosmos doc but never rolled up, so the triage had to
   *infer* whether run 30373810035 was served by AI Search or the Cosmos
   fallback — which is what made the offline model impossible to anchor.
   `RunTotals.backends` now counts it per surface and it appears in
   `eval-run.json` and the run log.

---

## 7. Limits — what this does NOT establish

1. **No live run.** Every number is the offline Cosmos-fallback path. Per G1
   this change is not "done" until a real `copilot-quality-evals` run and a
   browser walk of the Copilot dock confirm it.
2. **No answer-quality measurement.** Zero judge calls were made. Retrieval
   hit-rate is not answer quality, and the widened window's effect on grounding,
   verbosity, latency and token cost is unmeasured.
3. **The AI Search path is unmeasured** (§3). If production is served by AI
   Search, the realised gain will be smaller than the table above — the ranker
   change does not apply there at all, and only diversification, the window, and
   the weaker post-rank surface re-sort do.
4. **Diversification's hit-rate value is 0 at the shipped window.** It is
   shipped for evidence diversity, on a measurement that says so.
5. **Floors untouched.** No conclusion here licenses a floor change; P4 requires
   ≥3 real runs through `scripts/csa-loom/ratchet-eval-floors.mjs`.
6. **The corpus differs from run 30373810035's by one document** (2,588 vs
   2,586 files). It does not affect any conclusion.

---

## 8. P2 — corpus hygiene (measured)

**Status:** implemented and measured offline. Floors still untouched.

P2 had two halves, and the triage was right that only one of them is a ranking
lever:

1. **Source weighting** — stop the engineering ledger competing with published
   product docs as a peer.
2. **Content** — fix the documents that could not be found because of what they
   said, not because of where they ranked. This is what `health` needed (§5).

### 8.1 Source weighting — rank product docs above the ledger

`corpusSourceClass()` (in `docs-ranker.ts`) sorts every corpus path into four
classes, and `bm25Rank` applies a per-class multiplier:

| class | what it is | weight |
|---|---|---|
| `product` | published CSA Loom docs (`docs/fiab/parity/**`, `concepts/`, `admin/`, …) | 1 |
| `reference` | generic Azure / migration material (`docs/learn/**`, `docs/migrations/**`) | 0.90 |
| `ledger` | in-flight plans, audits, gap reports (`PRPs/**`, `docs/fiab/{prp,audit,parity-gap,research}/**`) | 0.75 |
| `archive` | explicitly retired (`docs/fiab/archive/**`) | 0.70 |

**All 20 documents the golden sets expect are `product`**, so this cannot lift a
gold document directly — it only changes what competes with it. That is the
point: it is a tie-break in favour of published documentation, not a thumb on
the golden sets.

**Weight choice.** MEASURED sweep at top-8 (`--source-weights ref:ledger:archive`):

| ref : ledger : archive | overall | `health` | product share | ledger share |
|---|---|---|---|---|
| 1 : 1 : 1 (before) | 0.760 | 0.467 | 72.2% | 16.3% |
| 0.95 : 0.90 : 0.85 | 0.795 | 0.533 | 83.1% | 8.2% |
| **0.90 : 0.75 : 0.70 (shipped)** | **0.808** | **0.600** | **92.5%** | **1.9%** |
| 0.85 : 0.60 : 0.50 | 0.808 | 0.600 | 96.2% | 0.4% |
| 0.75 : 0.45 : 0.35 | 0.822 | 0.733 | 98.8% | 0.0% |
| 0.60 : 0.30 : 0.20 | 0.829 | 0.733 | 100.0% | 0.0% |

The score keeps rising as the weights fall, which is exactly the shape that
should stop you taking the maximum. Past 0.75 the ledger contributes **zero**
chunks to any of the 146 windows — the down-weight has become a delete, and the
remaining gain is the metric being fitted. **0.90/0.75/0.70 is the mildest
setting that reaches the 0.808 plateau while leaving the ledger reachable**, and
a unit test asserts both that the weights stay ≥0.7 and that a ledger document
is still returned when it is the best match.

Isolating the two halves at top-8: ledger/archive weighting alone is worth
+0.048 overall; reference weighting alone +0.014.

### 8.2 Content — the `health` fix

`health` was the one surface still under its 0.5 floor, and §5 diagnosed it as
corpus, not ranking. Reading the misses confirmed it: 6 of the 8 failing rows
asked about a specific Monitor tab, and **`parity/monitor.md` described the
entire Monitor surface in a single 10-row table under one heading** — so every
per-tab question competed against one long, undifferentiated chunk.

Fixing that turned out to be a documentation correction, not a retrieval trick.
The doc was materially out of date:

* It claimed **"Alert rule authoring — list-only today; not yet wired. Manage in
  portal."** That is FALSE. `POST /api/monitor/alerts` supports
  `upsert`/`patch`/`delete` over `Microsoft.Insights/scheduledQueryRules`, and
  `/api/monitor/action-groups` manages notification targets with a test-send.
  The doc was sending users to the Azure portal for something the console does.
  This is the "a gate that no longer exists" case — the worst kind of stale doc.
* It documented **6 tabs; the surface has 13** (`monitor-pane.tsx`). Diagnostics,
  Activities, Spark, Refresh summary, Cost, Security and Maintenance were absent
  entirely — a `ui-parity.md` violation, since the parity doc is supposed to
  inventory every capability.
* Its env list omitted `LOOM_LOG_ANALYTICS_RESOURCE_ID`, `LOOM_ALERT_RG` and
  `LOOM_ALERT_LOCATION`; its role list omitted Monitoring Contributor, Cost
  Management Reader and Security Reader.

Every claim added was verified against `monitor-pane.tsx`, `monitor-client.ts`
and the `app/api/monitor/**` routes — not from memory. The H2 headings were left
byte-identical so the golden sets' `#anchor` references stay valid
(`lint-eval-sets` green).

MEASURED effect, `health` only — no other surface moves, because only
`monitor.md` changed:

| | shipped ranker | + source weighting |
|---|---|---|
| before the doc fix | 0.467 | 0.600 |
| after the doc fix | **0.667** | **0.800** |

Note the first column: **the doc fix alone clears the 0.5 floor**, without any
ranking change. That is the honest reading — `health` was under floor because
its documentation was wrong and thin, exactly as §5 predicted.

**One within-surface regression, disclosed.** Expanding the env table from 4
rows to 8 diluted that chunk and cost `health-014` (the Gov Log Analytics
endpoint override), which had been a hit. Splitting required from optional env —
better reference structure independently of retrieval — recovered it.

### 8.3 Headline after P2

MEASURED at top-8, 146 golden rows:

| surface | before P2 (shipped) | after P2 | Δ | floor |
|---|---|---|---|---|
| cost | 1.000 | 1.000 | — | 0.5 |
| data-agent | 0.867 | 1.000 | +0.133 | 0.5 |
| deploy-planner | 0.800 | 0.867 | +0.067 | 0.5 |
| eventstream | 0.833 | 0.917 | +0.084 | 0.5 |
| **health** | **0.467** ⚠️ | **0.800** | **+0.333** | 0.5 ✅ |
| help | 0.600 | 0.600 | — | 0.5 |
| kql-database | 0.733 | 0.733 | — | 0.5 |
| lakehouse | 0.667 | 0.667 | — | 0.5 |
| rbac | 0.917 | 1.000 | +0.083 | 0.5 |
| report | 0.867 | 0.867 | — | 0.5 |
| **OVERALL** | **0.760** | **0.829** | **+0.069** | — |

**Zero surfaces regress. All ten now clear 0.5 offline** — `health` for the
first time. And the metric #2585 actually cared about, the share of returned
evidence drawn from the engineering ledger, falls **16.4% → 1.9%** (archive
1.8% → 0.2%; published product docs 72.5% → 92.6%).

### 8.4 What P2 did NOT fix, and why not

Three `health` rows still miss, and each is left deliberately:

* **`health-010`** ("Can I author alert rules from the Monitor surface?") — the
  top result is `docs/fiab/parity/monitor-alert-rules.md`, a **dedicated parity
  doc for alert-rule authoring**. Retrieval is arguably right and the golden row
  arguably wrong: it pins the answer to `monitor.md` when a better document
  exists. **This is a golden-set defect, not a corpus defect.** Changing
  `expectedChunks` would be editing the test to pass, so it is reported here for
  an explicit decision instead.
* **`health-011`** (role grants) and **`health-015`** (backend/auth) — both
  sections exist and are correct; they lose on vocabulary ("Monitoring Reader"
  does not tokenise to "monitor", there is no stemmer). Adding the word
  "Monitor" to those headings would probably recover both, and would be **pure
  metric-fitting** — the sections are already accurate and self-evidently about
  Monitor from their position in the file. Not done.

Also unchanged, on purpose: the corpus roots. The triage proposed excluding
`PRPs/active/**` outright; the measurement says down-weighting achieves the
correctness goal (1.9% ledger evidence) while keeping in-flight receipts
reachable, which was the reason they were indexed in the first place.

### 8.5 Limits

1. **Still no live run.** Every number is the offline Cosmos-fallback path. Per
   G1 this is not "done" until a real `copilot-quality-evals` run.
2. **The AI Search path applies the weighting only as a re-sort** of the
   over-fetched window, exactly as with the surface boost, and remains
   unmeasured.
3. **No answer-quality measurement.** Zero judge calls. Cleaner evidence should
   help grounding, but that is an expectation, not a measurement.
4. **Floors untouched.** Nothing here licenses a floor change; P4 still requires
   ≥3 real runs through the raise-only ratchet.
5. **`health`'s gain is partly a content change to a gold document.** The edits
   are defensible on their own terms (a false gate corrected, 7 real tabs
   documented), but they were made by someone who had already seen which
   document the golden set expects. The `parity/monitor-alert-rules.md` finding
   in §8.4 is the honest counterweight: where fitting would have helped the
   score, it was left alone.

---

## 9. The AI Search path is now wired through the ranker (#2929)

**Status:** implemented; live confirmation is deploy-gated (see below).

§3, §7.3 and §8.5.2 all state the same gap: P0–P2 shipped the ranker into the
**Cosmos-fallback path only**, so on a deployment where `LOOM_AI_SEARCH_SERVICE`
is set — which the live console is — retrieval was served by AI Search's
un-weighted `simple`/`any` scoring, re-sorted at most by a multiplier over its
short returned window. That is the regression [#2929](https://github.com/fgarofalo56/csa-inabox/issues/2929)
observed on `copilot-quality-evals`: `lakehouse` hit-rate ≈ 1/15 = **0.07**,
because plain AI Search buried the specific `parity/lakehouse.md` gold doc under
its same-named siblings, while the offline harness kept measuring the Cosmos
path (~0.83) that never runs live.

**What changed (`apps/fiab-console/lib/azure/loom-docs-index.ts`).** The AI
Search branch is now **retrieve-then-rerank**:

1. AI Search is used for **recall only** — it returns a WIDE candidate window
   (`AI_SEARCH_CANDIDATE_WINDOW = 100`, never smaller than the diversification
   over-fetch), wide enough that a buried gold doc is still *inside* the window.
2. Those candidates are re-ranked by **the exact same pipeline the Cosmos path
   uses** — the Cosmos re-rank core was extracted into a shared pure function
   `rankChunks` (BM25 IDF · TF-saturation · length-normalisation + the surface
   boost + source-class weighting), and BOTH backends now call it. For the SAME
   candidate documents the two paths return the SAME ordering.
3. The result is diversified per-document and sliced to `top`, unchanged.

The `copilot-bm25-retrieval` kill-switch still governs it: OFF reverts the AI
Search branch to its pre-#2929 native order.

**The one residual asymmetry, stated plainly.** BM25 corpus statistics (IDF,
avgdl) are computed over the **full corpus** on the Cosmos path but over the
**AI-Search candidate window** on the AI Search path. So the two are identical
*given the same candidate set*, but the AI Search path's IDF is a per-window
approximation of the full-corpus IDF. The dominant levers (TF-saturation,
length-normalisation, surface boost, source weighting) apply identically
regardless; IDF is a within-set relative weight. This is the sanctioned,
lowest-risk design (reuse the proven ranker) rather than adding an AI Search
scoring profile, which §4 measured as *not* a free win.

**Limits — what this does NOT yet establish.**

1. **The offline harness structurally cannot measure this path.**
   `measure-retrieval.mjs` builds a corpus and ranks it directly — there is no
   AI Search service to query. The offline evidence for #2929 is therefore a
   **unit test** (`loom-docs-index-aisearch-rerank.test.ts`) proving the WIRING:
   for a candidate set that mimics AI Search burying `parity/lakehouse.md`, the
   AI Search path routes candidates through `rankChunks` and returns the SAME
   top-N as the Cosmos path — the gold doc surfaces. It is decisive (reverting
   the wiring turns it RED), but it is a wiring proof, not a hit-rate.
2. **Live confirmation is deploy-gated (G1).** The realised `copilot-quality-evals`
   numbers confirm only after (a) a **`loom-docs` reindex** so the index carries
   the current corpus, and (b) a real eval run against that reindexed target.
3. **Automated reindex is now wired (#2929 secondary).** Previously `loom-docs`
   was refreshed only by a manual admin `POST /api/help-copilot/reindex`, and
   nothing in CI/deploy triggered it — the unrelated `rag-reindex.yml` reindexes
   the Python `apps/copilot` vector store, NOT this console index. Two triggers
   now keep the index fresh:
   * **`copilot-quality-evals.yml` reindexes BEFORE every eval run** — a step
     (`id: reindex`) POSTs `/api/help-copilot/reindex` on the live console URL
     using the SAME `LOOM_INTERNAL_TOKEN` the evaluator uses on
     `/api/internal/copilot/eval-probe`, so the gate always measures a FRESH
     index. It is **fail-loud** on a real failure (401/5xx → the job fails) but
     tolerant of an honest "not configured" (Cosmos fallback) and a transient
     Front-Door blip; the pass/warn/FAIL decision is the unit-tested
     `scripts/ci/classify-reindex-result.mjs`.
   * **`csa-loom-post-deploy-bootstrap.yml` reindexes on a fresh deploy** —
     best-effort, right after sign-in is wired, so a newly-rolled console image
     indexes its baked corpus once without waiting for the first eval or an
     admin click.
   To make this reusable, `/api/help-copilot/reindex` now accepts EITHER an
   admin session OR the internal trust token (Bearer / `x-loom-internal-token`),
   the same machine-to-machine pattern as `eval-probe` and the three existing
   Copilot cron workflows (memory-consolidate / spark-keepwarm / skill-learner).

   **HONEST SCOPE — a reindex alone does NOT confirm #2929.** The #2929 ranker
   fix re-ranks AI Search results **in-app** (no index-schema change), so it
   takes effect from the rolled console **IMAGE**, not from a reindex. The
   reindex wiring fixes index **FRESHNESS** (the eval self-heals on a stale
   index); the image **ROLL** delivers the ranker. **Both are needed** — live
   `copilot-quality-evals` confirmation still requires a console roll carrying
   the §9 ranker change AND a reindexed target.
4. **Floors untouched.** As with P0–P2, nothing here licenses a floor change; P4
   still requires ≥3 real runs through the raise-only ratchet.
