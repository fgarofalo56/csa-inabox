# Golden Q/A eval sets (`content/evals/`)

Version-controlled, hand-authored eval sets for the in-product Copilot
surfaces — item **E1** of `PRPs/active/loom-next-level/PRP.md` (Workstream E,
Copilot Eval Harness). One JSONL file per Copilot **pane/surface**
(`lib/copilot/skill-registry-core.ts` panes; `help` = the `default`
Learning-Hub docs Copilot). The E2 `copilot-evaluator` Function executes these
rows against the REAL retrieval + AOAI path and writes scored results to
Cosmos; the E3 gate compares runs against `eval-floors.json`.

## File layout

| File | Rows | Surface |
|---|---|---|
| `help.jsonl` | 20 | `default` pane — Learning-Hub docs Copilot (`searchDocs` RAG) |
| `deploy-planner.jsonl` | 15 | Deploy planner Copilot |
| `lakehouse.jsonl` | 15 | Lakehouse editor Copilot |
| `kql-database.jsonl` | 15 | KQL database editor Copilot |
| `data-agent.jsonl` | 15 | Data agent Copilot |
| `cost.jsonl` | 12 | Cost / chargeback Copilot (ties to WS-C) |
| `health.jsonl` | 15 | Health + Monitor Copilot |
| `report.jsonl` | 15 | Report + semantic-model Copilot |
| `rbac.jsonl` | 12 | RBAC / access-governance Copilot |
| `eventstream.jsonl` | 12 | Eventstream editor Copilot |

`_schema.json` is the JSON-Schema every row must validate against.
`scripts/csa-loom/lint-eval-sets.mjs` (`pnpm --filter fiab-console lint:evals`)
enforces it in CI.

## Row shape

```json
{"id":"lakehouse-001",
 "question":"How do I use a lakehouse without a Fabric capacity?",
 "expectedChunks":["docs/fiab/parity/lakehouse.md#backend-per-control"],
 "expectedAnswer":"Loom's lakehouse is Azure-native by default: ADLS Gen2 + Delta...",
 "mustMention":["ADLS","Delta"],
 "mustNotMention":["requires a Fabric capacity"],
 "tier":"mini","taskClass":"lightweight"}
```

- **`id`** — `<surface>-<NNN>`, unique per file, prefix = the JSONL basename.
- **`question`** — what a real user asks the Copilot on that surface.
- **`expectedChunks`** — repo-root-relative corpus doc paths (staged by
  `scripts/csa-loom/stage-copilot-corpus.sh`), optionally `#<heading-anchor>`.
  These are what the retriever SHOULD surface; the evaluator scores hit-rate +
  MRR against them. **Every path must exist** in the docs tree (and in the
  staged `.corpus-manifest.json` when present) and **every anchor must match a
  real heading** — the lint fails on dangling paths/anchors. Dump a doc's valid
  anchors with:
  `node scripts/csa-loom/lint-eval-sets.mjs --anchors docs/fiab/parity/lakehouse.md`
- **`expectedAnswer`** — the grounded reference answer, written FROM the cited
  docs (read them; do not answer from memory). Fed to the LLM judge as gold.
- **`mustMention`** — case-insensitive substrings the answer must contain.
  A cheap deterministic grounding check run BEFORE the LLM judge.
- **`mustNotMention`** — substrings whose presence auto-fails the row with **no
  judge spend**. See below — this is where product rules become assertions.
- **`tier` / `taskClass`** — the expected tier-router labels
  (`ModelTier = mini|standard|strong`, `TaskClass =
  lightweight|general|reasoning` from `lib/foundry/model-tier-router.ts`).
  These feed the E6 tier-accuracy set.

## How `mustNotMention` encodes the product rules as assertions

Two die-hard rules become machine-checked answer guards:

1. **`no-fabric-dependency.md`** — Loom is Azure-native BY DEFAULT; Fabric /
   Power BI is strictly opt-in. A Copilot answer that tells a user they *need*
   a Fabric capacity, a bound Fabric workspace, or a Power BI workspace for a
   default-path feature is a **product-rule violation, not a style issue**.
   Rows therefore carry guards like:
   - `"mustNotMention":["requires a Fabric capacity"]`
   - `"mustNotMention":["you must bind a Fabric workspace"]`
   - `"mustNotMention":["requires a Power BI workspace"]`
   A hit auto-fails the row deterministically — the LLM judge is never even
   consulted (no token spend on a known-wrong answer).

2. **`no-vaporware.md`** — answers must describe honest behavior: real
   backends, or an honest MessageBar gate naming the exact env var / role.
   Guards like `"mustNotMention":["fabricated"]` /
   `["deploys automatically"]` / `["instantly"]` catch answers that promise
   behavior the product intentionally does NOT have (fake numbers, magic
   deploys, instant env-var flips).

Keep guard phrases **short and unambiguous** (a substring match): prefer
`"requires a Fabric capacity"` over `"Fabric"` — the latter would also fail
honest answers that correctly say "Fabric is opt-in". Never put the same
phrase in both `mustMention` and `mustNotMention` (lint rejects it).

## Point `expectedChunks` at the section that states LOOM's answer

A `docs/fiab/parity/*.md` describes **two products**: a feature-inventory
section saying what Fabric or the Azure portal does, and a `Loom coverage`
section saying what CSA Loom actually ships. `lib/copilot/docs-grounding` rule 1
tells the model to answer a Loom question from the Loom side. **The golden set
has to agree with that**, or it is asking for one thing and grading another.

Measured failure (2026-08-06, run `31064239486`): 15 of `data-agent.jsonl`'s 18
rows pointed `expectedChunks` at a **Fabric inventory** anchor while their
`mustMention` token (`Cosmos`, `cURL`, `LLM-as-judge`, `SELECT`) exists only in
the Loom coverage table. The surface retrieved its gold document on 90% of
questions and still scored `passRate` **0.100** with `productFidelityAvg`
**1.889/5** — the eval had asked for the other product's inventory and the
`productFidelity` rubric (#2979) correctly hard-failed answers that used it.

So, when authoring:

- Cite the **`Loom coverage` / `Backend per control`** anchor for "what does Loom
  do" questions. Cite an inventory anchor only when the question is explicitly
  about the other product.
- If the Loom-side section does not actually state the fact your `mustMention`
  demands, that is a **corpus gap**: fix the doc, don't re-point the row at the
  inventory.
- Retrieval is scored at DOCUMENT level (`evaluator-core.chunkPath` strips the
  anchor), so a wrong anchor will NOT show up as a hit-rate miss. It shows up
  much later, as an unexplained `productFidelity` collapse.

### Case study — `rbac` (E5, 2026-08-07): facts trapped in table cells

`rbac` sat on the `passRate` floor for weeks, oscillating 0.33 / 0.38 / 0.42
against a floor of 0.40 — one question deciding the whole gate. Measured
per-question against the LIVE probe, both scoring channels were failing for the
**same** reason, and neither was a floor problem:

- **Retrieval missed** (`rbac-004/005/007/009`) because the answer-bearing fact
  existed only inside a dense parity/glossary **table cell**, which carries none
  of the question's vocabulary. `rbac-007` ("what happens to undecided items
  when a review expires") retrieved eight chunks all headed *"What actually
  happens"* from unrelated `docs/fiab/parity-gap/*` docs — a heading collision
  beat the real answer, whose gold chunk ranked **1397th**.
- **Grounding missed** (`rbac-001/010/012`) because retrieval DID return the
  right document, but the wrong *section* of it — the H1 preamble instead of
  `## Model` — so the model never saw the roles table and never wrote
  `Reader`/`Contributor`.

The fix was entirely on the corpus side, and it is the pattern to copy:

1. **State the fact in prose, not only in a table cell.** Tables are for
   scanning; the retriever and the judge both need a sentence.
2. **Give each answer its own question-shaped `###` heading.** `chunkMarkdown`
   breaks sections on H1–H3 and `heading` is a searchable AI Search field, so a
   heading that restates the question is both a tighter chunk and a ranking
   signal. Retrieval also admits at most
   `DEFAULT_MAX_CHUNKS_PER_DOC` (2) chunks per document — so which chunk wins
   matters more than how many the document has.
3. **Verify the fact in the code before writing it.** Every sentence added here
   was checked against `lib/auth/feature-gate.ts`,
   `lib/access/access-reviews.ts`, and the `principals` / `group-sync` routes.

Offline (`scripts/csa-loom/diagnose-retrieval.mjs --top 8`) that moved `rbac`
hit-rate@8 from **0.750 → 0.917** (BM25) and **0.333 → 0.917** (substring
ranker), with every other surface byte-identical — no metric-fitting, and no
floor was touched. Gold-chunk ranks: `rbac-007` 1397→1, `rbac-009` 2716→1,
`rbac-012` 2172→1, `rbac-010` 586→1, `rbac-005` 85→3, `rbac-001` 18→1.

**Never lower a floor to clear this.** `eval-floors.json` is ratchet-up-only;
a surface under its floor is a surface to fix (#2585).

## Authoring workflow

1. Pick real questions from the surface's traffic/risk (install, gates,
   Fabric-independence, backend wiring, RBAC, per-cloud behavior).
2. Find the doc(s) that answer it under `docs/fiab/**` — these are the corpus.
   Read them. Cite section anchors where the answer lives.
3. Write `expectedAnswer` from those docs, reflecting the ACTUAL product.
   Azure-native default, honest gates, exact env-var names.
4. Add `mustMention` for the load-bearing terms and `mustNotMention` for the
   rule guards above.
5. Run `pnpm --filter fiab-console lint:evals` — fix every error.
6. Sets ship into the image via `stage-copilot-corpus.sh` →
   `copilot-corpus/evals/` (no external fetch at runtime; IL5-safe).

## Per-cloud

The sets are static content, identical in Commercial / GCC-High / IL5 — they
ship in the image alongside the corpus. Rows that touch per-cloud behavior
(Gov endpoints, IL5 catalogs) assert the documented per-cloud facts.
