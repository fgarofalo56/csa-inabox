# Copilot quality triage — why 9 of 10 surfaces are below floor

**Issue:** [#2585](https://github.com/fgarofalo56/csa-inabox/issues/2585) ·
**Status:** diagnosis complete; **P0/P1/P1b/P3 remediated — see
[copilot-retrieval-remediation.md](copilot-retrieval-remediation.md)**; P2 + P4
still open ·
**Author:** triage pass, 2026-07-28 ·
**Subject run:** [30373810035](https://github.com/fgarofalo56/csa-inabox/actions/runs/30373810035)
(10 sets / 146 rows, judge `gpt-5.6-sol`, corpus manifest `f3484db9`)

> **Verdict.** Retrieval is **genuinely weak** — this is not a harness
> id-format bug. A textbook BM25 baseline over the *identical* corpus, the
> *identical* chunker and the *identical* evaluator scoring lifts overall
> doc-level hit-rate from **0.185 → 0.568** at the same top-5 window, and takes
> `lakehouse` from **0.000 → 0.333**. The golden sets are answerable; the ranker
> is not finding the answers.
>
> The floors are **also** unvalidated — they were seeded before any run data
> existed and have never been ratcheted from measurement — but that is a
> *secondary* finding. **Do not lower the floors.** Two surfaces
> (`kql-database`, `lakehouse`) do not clear 0.5 even under BM25@5, so the
> floors need to be *earned* by fixing retrieval, then honestly re-baselined
> from measured runs — not decorated down to meet today's numbers.

Everything below is labelled **MEASURED** (I ran it, it is reproducible from
this repo with no Azure access) or **INFERRED** (reasoning from code I read,
not executed).

Reproduce every number in this document with:

```bash
node --max-old-space-size=6144 scripts/csa-loom/diagnose-retrieval.mjs
node --max-old-space-size=6144 scripts/csa-loom/diagnose-retrieval.mjs --explain lakehouse
```

---

## 1. The four triage questions, answered

### Q1. Does the corpus contain lakehouse content, under the filter the lakehouse surface queries?

**Yes to the content. And there is no filter at all.**

**MEASURED** — every `expectedChunks` document in all 146 golden rows (20
distinct docs) exists on disk and lies inside a root the indexer walks. Zero
rows reference a missing or unindexed doc. `scripts/csa-loom/lint-eval-sets.mjs`
already asserts this in CI (and additionally that every `#anchor` resolves to a
real heading slug) — its run-30373810035 line reads
`lint-eval-sets: OK — 10 sets, 146 rows, 20 corpus docs referenced`.

**MEASURED (code read)** — *there is no surface→filter mapping anywhere.* The
evaluator sends `surface` on every probe call
(`run-evals.ts:135`), and `/api/internal/copilot/eval-probe` accepts it —
but the route never uses it for retrieval. It calls the global
`searchDocs(question, top)` and merely echoes `surface` back in the response:

```ts
// apps/fiab-console/app/api/internal/copilot/eval-probe/route.ts:96
const { hits, backend } = await searchDocs(question, top);   // no surface, no kind
...
surface: body?.surface || null,                              // echoed, never applied
```

So each surface's questions compete against the **whole corpus**: **49,568
chunks across 2,587 markdown documents**, with a **top-5** window
(`top = Number(body?.top) || 5`; the evaluator never sends `top`). The task is
"rank one specific document into the global top 5 of 2,587" with no topical
narrowing whatsoever.

> The phrase "the filter the lakehouse surface queries" describes a mechanism
> that does not exist. That is itself a finding: `surface` is wired end-to-end
> and is a no-op.

### Q2. How is `retrievalHitRate` computed — could 0.000 be a matching bug?

**It is computed correctly. The 0.000 is real.**

**MEASURED (code read)** — the chain is coherent, and the id normalisation that
looked like the obvious suspect actually works:

| step | code | shape |
|---|---|---|
| probe builds the id | `route.ts:113` | `` `${h.path}#${slugified-heading}` `` → `docs/fiab/parity/lakehouse.md#backend-per-control` |
| client flattens | `azure-clients.ts:88` | `chunks.map(c => String(c?.id ?? c))` → `string[]` |
| scorer normalises | `evaluator-core.ts:218` | `chunkPath()` strips `#anchor`, trims, lowercases, `\`→`/` |
| scorer matches | `evaluator-core.ts:230` | exact equality on the doc path; hit = ≥1 expected doc present |

Golden sets store `docs/fiab/parity/lakehouse.md#backend-per-control`; the
retriever returns `docs/…` -rooted paths in **both** deployment layouts (in the
image `repoRoot` is `./copilot-corpus`, whose staged tree is `copilot-corpus/docs/…`,
so `path.relative` yields `docs/…` — `loom-docs-index.ts:432-447` +
`stage-copilot-corpus.sh`). **The two sides agree.**

**MEASURED (executed)** — the decisive proof that matching is not broken: using
this *same* `scoreRetrieval` implementation, the BM25 control registers **83/146
hits**. A broken comparator cannot score 83 hits. And the *same* comparator
scores `lakehouse` at exactly 0.000 under a faithful port of the production
ranker — reproducing the live 0.000 offline.

> **Hypothesis "harness id/format mismatch" is FALSIFIED.**

### Q3. Why is grounding high (3.4–4.7) while hit-rate is low?

**Same document set, different question.** Not two different sets.

**MEASURED (code read)** — the judge's evidence and the hit-rate's evidence come
from the *same* probe response: `probeConsole` returns
`excerpts: chunks.map(c => c.preview)` from the very chunks whose ids are scored
(`azure-clients.ts:88-95`), and `run-evals.ts:152` feeds those excerpts to
`buildJudgeMessages`. So grounding is not measured against a different corpus.

The shape is explained by what each metric asks:

* **hit-rate** asks *"was the exact gold document retrieved?"* — binary, strict.
* **grounding** asks *"is the answer supported by whatever was retrieved?"* — and
  the retriever is returning **topically adjacent, genuinely relevant neighbours**.

**MEASURED (executed)** — the top-5 for `lakehouse-001`
("How do I use a lakehouse without a Fabric capacity?") is:

```
0.583  docs/fiab/parity-gap/lakehouse.md        [Lakehouse editor — Fabric parity gap report]
0.583  docs/fiab/parity-gap/lakehouse.md        [Phase 1 — Fabric reference]
0.583  docs/fiab/parity/lakehouse-preview.md    [lakehouse-preview — parity with Fabric Lakehouse table preview]
0.583  docs/fiab/design/lakehouse-shortcuts.md  [Lakehouse "Shortcuts" — Azure-native, NO Fabric dependency]
0.583  docs/fiab/design/lakehouse-shortcuts.md  [2. Azure-native mapping — how Loom virtualizes each capability]
gold doc docs/fiab/parity/lakehouse.md ranked 28 of 18,915 chunks scoring > 0
```

Every one of those is a real lakehouse document. An answer built from them is
legitimately well-grounded — hence grounding 3.933 — while the gold document
never appears, hence hit-rate 0.000. **Most of the gap is near-miss, not
fabrication.**

**But the issue's product concern is real and I can evidence it.** For
`lakehouse-007` ("How does the lakehouse Share button grant access?") the top-5
contained **no lakehouse document at all**:

```
0.500  PRPs/active/loom-next-level/ws-identity-cloudmatrix.md  [I3 — Shadow audit …]
0.500  PRPs/active/loom-next-level/ws-identity-cloudmatrix.md  [I3 — Shadow audit …]
0.375  docs/fiab/operator-interactive-setup.md                 [How to verify … after the grants]
0.375  docs/fiab/sharing-endorsement-preview-as.md             [Share — grant people access]
0.375  docs/fiab/topology-migration.md                         [ADX shared-cluster principal …]
gold doc docs/fiab/parity/lakehouse.md ranked 398 of 24,006 chunks scoring > 0
```

An in-flight identity PRP and a topology-migration doc are the evidence base for
a question about a lakehouse UI control. That is the "confident answer from the
wrong source" failure `refuse-not-guess` (N9) is meant to catch, and it is
happening.

**MEASURED (code read) — a second, independent harness defect on this axis.**
The judge grades grounding against a **300-character truncation** of each chunk,
while the answer was generated from **1,500 characters** of the same chunk:

```ts
route.ts:45   `[${i+1}] …\n${e.content.slice(0, 1500)}`   // what the MODEL saw
route.ts:117  preview: h.content.slice(0, 300),           // what the JUDGE sees
```

The judge is therefore asked "is this claim supported?" while holding 20% of the
evidence the model actually used. **INFERRED:** this biases grounding *downward*
and adds noise; it does not explain the high scores, but it does mean grounding
is not currently a trustworthy number in either direction.

### Q4. Were the floors ever met?

**No. They have never been measured against anything.** This is stated in the
repo, by the authors, in two places.

**MEASURED** — `content/evals/eval-floors.json` `_meta.note`:

> "**PROVISIONAL SEED (2026-07-22): these floors were set BEFORE any eval-run
> data existed** (E2 landed the same day; the first live runs happen post-roll)."

and the commit that introduced them, `a9e18b33` (2026-07-22, PR #2426):

> "per-surface floors for the 10 E1 surfaces …, seeded CONSERVATIVE +
> provisional (**no run data exists yet** — E2's first live runs happen post-roll)"

**MEASURED** — `_meta.lastRatchet` is `null`, and every one of the 10 surfaces
still carries `"provisional": true`. The raise-only ratchet
(`scripts/csa-loom/ratchet-eval-floors.mjs`) has never run. Every floor is the
same seeded triple: `0.5 / 3 / 0.4`, uniform across all 10 surfaces — no
per-surface calibration was ever attempted.

So: run 30373810035 is not a regression against a known-good baseline. **It is
the baseline** — the first measurement this system has ever produced.

---

## 2. What is actually wrong with retrieval

### 2.1 The ranker is boolean term-presence with no IDF

`searchDocs` has two backends (`loom-docs-index.ts:374`). The Cosmos fallback
ranks with `rankSubstring` (`loom-docs-index.ts:331`):

```ts
const terms = q.split(/\s+/).filter((t) => t.length > 2);   // "how", "use", "with" all kept
for (const term of terms) {
  if (text.includes(term)) score += 1;                      // presence, not frequency
  if (heading?.toLowerCase().includes(term)) score += 1;    // heading counted twice
}
return score / (terms.length * 2);                          // max 1.0
```

**MEASURED** — consequences, from the `--explain lakehouse` trace:

* **No IDF.** "lakehouse" and "how" contribute equally. In a corpus about a
  lakehouse platform, the discriminating term carries almost no weight.
* **No term frequency, no length normalisation.** A chunk mentioning a term once
  ranks identically to one about that term.
* **Enormous candidate sets and pervasive ties.** Between **14,229 and 26,862
  chunks score > 0** for a single lakehouse question; the top score is typically
  0.500–0.583 with **1–16 chunks tied at it**. Ties are broken by store order —
  i.e. arbitrarily. `eventstream` averages **16 chunks tied at the top score**,
  and scores 0.083.
* **Substring, not token, matching.** `text.includes('report')` matches
  "reported", "reporting".

The AI Search backend is better but not by design: `searchSearch`
(`loom-docs-index.ts:236`) issues `queryType: 'simple'`, `searchMode: 'any'`
(OR semantics) with **no semantic ranker, no vector field, no scoring profile** —
the index schema (`loom-docs-index.ts:140-149`) declares only `Edm.String`
fields. It is plain BM25 with no title/path weighting.

**INFERRED** — the live run's overall hit-rate (0.322, 47/146) sits above my
offline Cosmos-port (0.185) and below the BM25 control (0.568), which is
consistent with AI Search having served it. **I could not confirm which backend
answered**: `backend` is captured per-question into Cosmos
(`run-evals.ts:173`) but the CI receipt (`eval-run.json`) carries only the five
rollup fields, and Cosmos is not reachable from a dev workstation. See §4.4.

### 2.2 The top-5 window is partly wasted on duplicate documents

**MEASURED** — retrieval returns 5 *chunks*, but hits are scored per *document*,
and multiple chunks routinely come from the same file (visible twice in both
traces above). Distinct documents per top-5 window average **4.2–4.75**, so the
effective recall window is under 5 documents out of 2,587. No per-document
diversification exists.

### 2.3 Corpus hygiene is a real but small lever

The corpus deliberately includes `PRPs/active/**` (in-flight plans, AUDIT
receipts, competitive research) alongside published product docs, plus
`docs/fiab/audit/**`, `docs/fiab/prp/**` and `docs/fiab/parity-gap/**`. These are
the documents that surfaced as wrong-source evidence in the `lakehouse-007`
trace.

**MEASURED** — dropping all 261 of those documents (2,587 → 2,326) is worth only
**+0.027** (substring) / **+0.035** (BM25). It is worth doing for answer
*correctness* — it removes stale planning docs from user-facing citations — but
it is **not** the fix for hit-rate.

### 2.4 The lever matrix

**MEASURED**, `scripts/csa-loom/diagnose-retrieval.mjs`, doc-level hit-rate@5
under the evaluator's own `scoreRetrieval`:

| surface | live run | substring/full | substring/product | **BM25/full** | **BM25/product** | floor |
|---|---|---|---|---|---|---|
| cost | 0.667 | 0.167 | 0.250 | 0.750 | **0.833** | 0.5 |
| data-agent | 0.467 | 0.133 | 0.267 | 0.733 | **0.867** | 0.5 |
| deploy-planner | 0.467 | 0.333 | 0.333 | 0.600 | **0.667** | 0.5 |
| eventstream | 0.167 | 0.083 | 0.083 | 0.667 | **0.667** | 0.5 |
| health | 0.133 | 0.133 | 0.133 | 0.400 | **0.467** | 0.5 |
| help | 0.600 | 0.250 | 0.300 | 0.550 | **0.550** | 0.5 |
| kql-database | 0.267 | 0.133 | 0.133 | 0.200 | **0.200** | 0.5 |
| lakehouse | **0.000** | **0.000** | **0.000** | 0.333 | **0.333** | 0.5 |
| rbac | 0.167 | 0.333 | 0.333 | 0.667 | **0.667** | 0.5 |
| report | 0.200 | 0.267 | 0.267 | 0.867 | **0.867** | 0.5 |
| **OVERALL** | **0.322** | **0.185** | 0.212 | 0.568 | **0.603** | — |

At top-10 (the route already permits `top` up to 10), BM25/full reaches
**0.685** overall and `lakehouse` **0.533**.

Read the columns, not the absolute values:

* **ranker is the dominant lever** — +0.383 overall at fixed corpus (≈3×);
* **corpus hygiene is a minor lever** — +0.027 / +0.035;
* **7 of 10 surfaces clear the 0.5 floor under a plain BM25 control**, so the
  floors are broadly reachable;
* **3 surfaces do not** — `health` (0.467), `lakehouse` (0.333),
  `kql-database` (0.200). These need per-surface work, §3.3.

### 2.5 Why `lakehouse` and `kql-database` resist even BM25

**MEASURED** — their gold documents sit in unusually crowded name-spaces. The
`lakehouse` set pins **17 of its 18 expected-doc references** on the single file
`docs/fiab/parity/lakehouse.md`, which competes with 12 sibling
`docs/fiab/parity/lakehouse-*.md` files (`-preview`, `-schemas`, `-permissions`,
`-shortcuts-internal/-external/-sharepoint`, `-table-history`,
`-iceberg-endpoint`, `-load-to-table`, `-file-upload-download`, `-shortcut`,
`-preview-ai`) plus `parity-gap/lakehouse.md`, `lakehouse-parity-spec.md`,
`design/lakehouse-shortcuts.md` and two tutorials — **28 files with "lakehouse"
in the filename**. `kql-database` faces 8 same-prefix files and 22 `kql*` files.

`health` fails differently: 12 of its 15 rows expect `docs/fiab/parity/monitor.md`,
a file whose name shares no token with the word "health" — so a
filename/heading boost cannot help it.

**INFERRED** — crowding is a *contributing* factor, not a law: `report` also has
21 same-name files yet scores 0.867 under BM25. What distinguishes lakehouse is
that its siblings are *near-duplicates in content*, not merely in name.

---

## 3. Prioritised remediation plan

Ordered by measured value per unit of risk. **P0 and P1 are the fix; P4 is the
only floor change permitted, and only after P0–P2 land.**

### P0 — Replace the ranking function (biggest measured win)

**Evidence:** +0.383 overall hit-rate at fixed corpus and fixed K
(§2.4). **Owner surface:** `loom-docs-index.ts`.

1. **Cosmos fallback (`rankSubstring`)** — replace boolean presence with real
   BM25: token (not substring) matching, IDF, term frequency, length
   normalisation, stopword removal. The implementation in
   `scripts/csa-loom/diagnose-retrieval.mjs` (`buildBm25`) is a working reference
   that already scores against the golden sets.
2. **AI Search backend** — add a **scoring profile** weighting `path` and
   `heading` above `content`, and switch `searchMode` from `'any'` to
   `'all'`-with-fallback or add `queryType: 'semantic'`. Both are index-schema /
   query-shape changes, not new infrastructure.
3. **Filename/heading boost — tune it per surface, do not assume it helps.**
   **MEASURED** (BM25@5 with boost 2.0 vs boost 0): overall it is worth only
   **+0.020**, and it is *not* uniformly positive:

   | helped | hurt | unchanged |
   |---|---|---|
   | `help` +0.150, `report` +0.134, `data-agent` +0.066 | `kql-database` **−0.133**, `health` **−0.067** | cost, deploy-planner, eventstream, lakehouse, rbac |

   It hurts exactly the surfaces whose gold document does *not* carry the
   question's vocabulary in its filename — `health` questions point at
   `parity/monitor.md`, and `kql-database` questions are outranked by its 7
   same-prefix siblings once filenames are weighted. Treat the boost as a tuned
   parameter validated against the golden sets, not as a free win.

**Risk:** this changes what the production Copilot retrieves. It must land with
an offline hit-rate delta *and* a live re-run of `copilot-quality-evals`, per
G1 — a `tsc`+vitest green is not evidence here.

### P1 — Diversify the top-K by document, and widen it

**Evidence:** §2.2 — the 5-slot window currently yields 4.2–4.75 distinct docs;
BM25@10 adds +0.117 overall and +0.200 on `lakehouse` (§2.4).

* Cap chunks-per-document in the returned set (e.g. max 2), backfilling from the
  next document. Cheap, purely post-ranking, no index change.
* Raise the eval probe's `top` from the default 5 toward 8–10. **Note the
  coupling:** this also changes how much context the answer prompt carries, so
  it is a product change, not a metric knob — measure answer quality alongside.

### P2 — Corpus hygiene (do it for correctness, not for the score)

**Evidence:** §2.3 — worth +0.027/+0.035 on hit-rate, but it is what removes
in-flight PRPs and audit sweeps from user-facing citations (the `lakehouse-007`
failure).

* Exclude `PRPs/active/**`, `docs/fiab/audit/**`, `docs/fiab/prp/**`,
  `docs/fiab/parity-gap/**` from the retrieval corpus, **or** give them a
  down-weighting `kind` and rank published product docs above them.
* This partially reverses a deliberate earlier decision (the module header
  documents adding `PRPs/active/**` to stop the Copilot answering from stale
  *completed* PRPs). The right resolution is **down-weight, not delete**, so
  in-flight receipts remain reachable when nothing better exists.

### P3 — Fix the two harness defects found during triage

Neither changes retrieval; both change how honestly we can read the numbers.

1. **Judge evidence truncation** (§Q3) — the judge sees `slice(0, 300)` while the
   model answered from `slice(0, 1500)`. Align them (or state the cap
   deliberately and document it). Until then `groundingAvg` is noisy in both
   directions.
2. **`surface` is a no-op** (§Q1) — the parameter is sent, accepted, echoed, and
   never applied. Either implement per-surface retrieval scoping (which would
   change the task from "top-5 of 2,587" to "top-5 of a topical slice" and
   should substantially lift hit-rate), or delete the parameter so it stops
   implying a filter exists. **Decide deliberately — this is a product design
   question, not a bug fix.**

### P4 — Re-baseline the floors, honestly, and only last

**Do not touch `eval-floors.json` until P0–P2 have landed and a real run exists.**

The floors are decoration today (§Q4), but the answer is not to lower them to
meet a broken ranker — that recreates exactly the "green having measured
nothing" failure this thread exists to fix. The sequence is:

1. Land P0–P2; re-run `copilot-quality-evals` for real.
2. Collect **≥3 runs** per surface (the ratchet already requires a 3-run streak).
3. Run `node scripts/csa-loom/ratchet-eval-floors.mjs --write` to set floors
   **from measurement**, per-surface, and clear `provisional: true`.
4. If a surface genuinely cannot reach 0.5 after P0–P2, its floor may be set
   *below* 0.5 — but only in a dedicated commit that (a) names the surface,
   (b) cites the measured ceiling, and (c) links the follow-up issue for the
   remaining gap. `_meta.unblock` already mandates this.

The gate is correctly **not** in `required_status_checks`, so it can stay red
and visible throughout without wedging the merge queue. Leave it that way until
P4 completes.

---

## 4. Limits of this diagnosis — what I did NOT measure

Stated explicitly so nobody over-reads the numbers.

1. **I did not replay the live run.** `scripts/csa-loom/diagnose-retrieval.mjs`
   is a faithful *port* of `chunkMarkdown` + `rankSubstring` + `searchCosmos` +
   `scoreRetrieval`, not those functions themselves (they are module-private
   TypeScript). It models the Cosmos-fallback path. The relative deltas between
   cells are the load-bearing result; the absolute values are a model.
2. **I do not know which backend served run 30373810035.** `backend` is written
   per question to Cosmos but is absent from the CI receipt, and Cosmos is not
   reachable from a workstation. The live 0.322 sitting between my Cosmos-port
   0.185 and the BM25 control 0.568 is *consistent with* AI Search — that is an
   inference, not a measurement.
3. **My tree is not the run's tree.** The run staged corpus commit `f3484db9`
   (2,586 files); I measured at branch base `57d4b7fc` and enumerate 2,587
   markdown docs. A ±1 document drift between commits does not affect any
   conclusion.
4. **I did not measure answer quality, only retrieval.** No judge call was made
   (deliberately — zero token spend). Every grounding statement in §Q3 is a code
   reading plus the aggregate numbers in the receipt, not a re-judged run.
5. **BM25 here is a diagnostic control, not a proposed implementation.** It
   demonstrates headroom exists. A production ranker still needs the AI Search
   path solved (§P0.2), which my offline harness cannot exercise.
6. **No fix is included in this pass.** The instruction was to diagnose before
   tuning, and the defects found are ranking-quality changes that require a
   measured, staged rollout with a live re-run — not a one-line patch. A
   diagnosis is not a fix, and #2585 stays open.

---

## Appendix — evidence index

| claim | evidence |
|---|---|
| all 20 expected docs exist + are indexed | `scripts/csa-loom/lint-eval-sets.mjs` (CI, run log) + local enumeration |
| corpus size 49,568 chunks / 2,587 docs | `scripts/csa-loom/diagnose-retrieval.mjs` header line |
| `lakehouse` 0.000 reproduces offline | `diagnose-retrieval.mjs`, `substring/full` column |
| gold doc ranks 28th–398th | `diagnose-retrieval.mjs --explain lakehouse` |
| 14,229–26,862 chunks score > 0 per question | `--explain lakehouse`, "of N chunks scoring > 0" |
| BM25 lifts 0.185 → 0.568 | `diagnose-retrieval.mjs`, `BM25/full` column |
| corpus hygiene worth +0.027/+0.035 | `diagnose-retrieval.mjs`, `*/product` columns |
| `surface` is never applied | `app/api/internal/copilot/eval-probe/route.ts:96,112` |
| judge sees 300 chars, model saw 1,500 | same file, `:45` vs `:117` |
| floors seeded with no data | `content/evals/eval-floors.json` `_meta.note`; commit `a9e18b33` |
| floors never ratcheted | `_meta.lastRatchet: null`; all 10 `provisional: true` |
