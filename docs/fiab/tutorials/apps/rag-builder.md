# RAG Builder — from install to a grounded, cited answer

Install `app-rag-builder`, get a **live hybrid Azure AI Search index** with ten
seeded documents, a **grounded prompt flow** that refuses to answer outside the
corpus, and a **7-metric evaluation suite** whose scores come only from a real
AI Foundry run. **~25 minutes** (plus provisioning time).

!!! abstract "What you end up with"
    Four workspace items: `RAG Corpus — CSA Loom Knowledge Base` (AI Search index),
    `RAG Basic — grounded Q&A over the corpus` (prompt flow), `RAG Quality — 7-metric
    suite` (evaluation), and `RAG Builder Walkthrough` (notebook). The index is
    *really* created — the install does a live `PUT /indexes/<name>` and pushes the
    sample documents.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_AI_SEARCH_SERVICE` set on the Console | The index provisioner targets `https://<service>.search.windows.net` | The AI Search item installs with an honest remediation gate naming the variable |
| Console UAMI has **Search Service Contributor** + **Search Index Data Contributor** | Create the index, then push documents | The provisioner surfaces the verbatim `403` and the role to grant |
| `LOOM_FOUNDRY_PROJECT` set (optional for step 1) | The prompt-flow provisioner creates the flow in an AI Foundry project | The prompt-flow item shows a gate; the AI Search half still works |
| `LOOM_FOUNDRY_EVAL_DATASET` + `LOOM_FOUNDRY_EVAL_DEPLOYMENT` (optional) | Submit a real evaluation run | The evaluation item renders metric definitions with **no fabricated scores** |

!!! tip "The AI Search half is independent"
    You do not need AI Foundry to get value from step 1. The index provisions, seeds,
    and is queryable on its own. Foundry only gates the flow + evaluation.

## 1. Install the app

1. Left nav → **Apps** → search for **RAG Builder** → open the card.
   (The detail route is `/apps/app-rag-builder`.)
2. Read the **Bundled items (4)** section — it lists exactly what will be created.
3. Click **Install into workspace**.
4. In the dialog:
   - **Workspace** *(required)* — pick your target workspace.
   - **Install location** — workspace root, or an existing folder. **…or create a
     new folder** creates it and installs everything inside (e.g. `RAG`).
   - **Deploy artifacts to live Azure services** — leave **On (recommended)**.
     Off keeps the install Cosmos-only (templates, no backend resources).
   - **Compute** — **Shared** (use the tenant's existing AI Search / Foundry).
     *Dedicated* expects an admin to have pre-provisioned an isolated set.
5. Click **Install**.

The route returns `202 { jobId }` immediately and the install runs asynchronously.
The dialog polls `/api/apps/install-jobs/<jobId>` every 5 seconds and shows a
progress bar (item creation 0→35%, provisioning 35→95%). **You can close the
dialog** — the poll survives in the jobs store and a toast names the app when it
finishes.

## 2. What gets provisioned

| Item | Provisioner | Real backend call | Honest gate |
| --- | --- | --- | --- |
| `RAG Corpus — CSA Loom Knowledge Base` (`ai-search-index`) | `aiSearchProvisioner` | `PUT /indexes/rag-corpus---csa-loom-knowledge-base` then `POST /docs/index` with the 10 seed documents | *"AI Search service not configured. Set `LOOM_AI_SEARCH_SERVICE` to the service name (without `.search.windows.net`)."* |
| `RAG Basic — grounded Q&A over the corpus` (`prompt-flow`) | `promptFlowProvisioner` | Creates the flow in the AI Foundry project via the AML data plane | *"No AI Foundry project configured… Set `LOOM_FOUNDRY_PROJECT`."* |
| `RAG Quality — 7-metric suite` (`evaluation`) | `evaluationProvisioner` | Submits a real AI Foundry evaluation run | Names whichever of `LOOM_FOUNDRY_PROJECT` / `LOOM_FOUNDRY_EVAL_DATASET` / `LOOM_FOUNDRY_EVAL_DEPLOYMENT` is unset |
| `RAG Builder Walkthrough` (`notebook`) | `notebookProvisioner` | Synapse (`LOOM_SYNAPSE_WORKSPACE`) or Databricks (`LOOM_DATABRICKS_HOSTNAME`) artifact | Names the missing workspace variable |

The provisioning report renders **inside the install dialog**, one row per item, with
`created` / `exists` / `skipped` / `remediation` / `failed`, the resolved resource id,
and a per-row **Retry** on any gate. Re-running the install is idempotent — items that
already exist by name are skipped.

### Index shape (what the schema actually is)

Hybrid retrieval — BM25 **and** HNSW vectors in one index:

- `id` (key), `tenantId` (filterable — the flow's search node applies
  `tenantId eq '<tid>'`), `title` (searchable), `content` (searchable),
  `source_url`, `chunk_index`, `document_id`, `created_at` (sortable),
  `tags` (`Collection(Edm.String)`).
- `embedding` — `Collection(Edm.Single)`, **1536 dimensions**, bound to the
  `default-profile` vector profile the provisioner synthesizes from
  `vectorConfig { dimensions: 1536, algorithm: 'hnsw' }`.
- Two scoring profiles: **title-boost** (title matches weighted 3×) and
  **recency-boost** (linear decay over `created_at`, 90-day horizon).

## 3. Seeded data

**10 SAMPLE documents** about CSA Loom architecture, FedRAMP, and Fabric are pushed
at install time. They are explicitly labelled sample content — replace them with your
own corpus before drawing conclusions from retrieval quality. The `tenantId` on the
seeds is `tenant-demo`.

Nothing else is fabricated: the evaluation ships **metric definitions and targets
only**, with no baseline numbers, until a live Foundry run completes.

## 4. First meaningful task — ask the corpus a question

### 4a. Prove the index answers (no Foundry needed)

1. Open **`RAG Corpus — CSA Loom Knowledge Base`** from the workspace tree.
2. The editor has four tabs: **Schema**, **Search**, **Statistics**, **Indexers**.
3. **Schema** should list the ten fields above, including `embedding` with its vector
   profile — this is read back from the live service, not from the bundle.
4. Switch to **Search**. Enter `tenant-aware admin plane`, choose query type
   **simple** (or **full (Lucene)**), and optionally select the **title-boost**
   scoring profile. Run it.
5. You should get seeded chunks back with their `document_id` and `source_url`.

### 4b. Run the grounded flow (needs `LOOM_FOUNDRY_PROJECT`)

1. Open **`RAG Basic — grounded Q&A over the corpus`**.
2. Pick your **project** in the project picker at the top.
3. The flow DAG is five nodes: `input → rephrase → search → synthesize → output`.
4. Save the flow (runs execute the *persisted* `flow.dag.yaml`), then run it. The
   editor POSTs `{ project, inputs }` to `/api/items/prompt-flow/<id>/run` and renders
   the response under **Run output**.
5. Ask something the corpus covers, then ask something it does not. The system prompt
   is a hard-grounding contract: every claim must carry an inline `[doc:<document_id>]`
   citation, and an unsupported question must return exactly
   *"I don't have grounding for that. Try rephrasing or expanding the question."*
   **A confident answer with no citation is a regression, not a feature.**

### 4c. Score it (needs the three eval variables)

Open **`RAG Quality — 7-metric suite`**, pick the project, and read the results the
editor loads from `GET /api/items/evaluation/<id>?project=…&results=1`. The seven
metrics and their targets: `groundedness` ≥ 0.90, `retrieval_recall` (@5) ≥ 0.85,
`retrieval_precision` (@5) ≥ 0.60, `answer_relevance`, `citation_coverage` ≥ 0.95,
`latency_p95` ≤ 4000 ms, `hallucination_rate` ≤ 10%.

If the variables are unset, the editor shows the definitions and an honest
"run the suite to populate scores" state. That is by design — no hard-coded numbers.

### 4d. Bring your own corpus (the notebook)

Open **`RAG Builder Walkthrough`**, attach a compute in the ribbon's compute picker
(Synapse Spark pool or Azure ML), and **Run all**. Its cells:

1. Load the sample corpus.
2. Chunk at 1000 tokens with 100-token overlap (recursive splitter, paragraph-preferred).
3. Embed with `text-embedding-3-small` (1536-dim) via Azure OpenAI.
4. Push chunks to the index this app created — the notebook resolves the index name
   from `LOOM_RAG_INDEX_NAME`, defaulting to
   `rag-corpus---csa-loom-knowledge-base`.
5. Ask a grounded question through the real prompt-flow run route.
6. Read evaluation results through the real evaluation route.

Cells that need Foundry configuration print the **missing environment variable** rather
than fabricating output. Point step 1 at your own documents to make the index yours.

## 5. Verify it worked

- **Install dialog**: the AI Search row reads `created` with
  `endpoint: https://<service>.search.windows.net/indexes/rag-corpus---csa-loom-knowledge-base`.
- **Editor → Statistics tab**: a non-zero document count (the ten seeds).
- **Editor → Search tab**: a real result set, not an empty grid.
- **Flow**: an answer with at least one `[doc:…]` citation, plus a clean refusal on an
  out-of-corpus question.

If any of those four are missing, the app is not working yet — go to Troubleshooting.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| AI Search row = `remediation`, "service not configured" | `LOOM_AI_SEARCH_SERVICE` unset | Set it to the **service name only** (no `.search.windows.net`), restart the Console revision, then **Retry** the row |
| AI Search row shows a verbatim `403` | UAMI lacks the Search roles | Grant **Search Service Contributor** (create index) and **Search Index Data Contributor** (push docs) on the search service |
| Schema tab renders but Search returns nothing | Documents were not pushed | Check the install dialog's step log for the `docs/index` call; re-run the install (idempotent) |
| Prompt-flow gate on `LOOM_FOUNDRY_PROJECT` | No AI Foundry project bound | Set it to a `Microsoft.MachineLearningServices` **kind=Project** workspace name under the hub |
| Evaluation shows definitions but no scores | One of the three eval variables is unset | Set `LOOM_FOUNDRY_PROJECT`, `LOOM_FOUNDRY_EVAL_DATASET`, `LOOM_FOUNDRY_EVAL_DEPLOYMENT`, then re-run |
| Notebook cell 1 fails on `AZURE_OPENAI_ENDPOINT` | Notebook is running outside the Console identity | Grant your local identity **Search Index Data Contributor** + **Cognitive Services OpenAI User**, or run on Console-attached compute |

## Cleanup

Delete the four items from the workspace tree (right-click → Delete), or delete the
workspace. **The AI Search index is a real service-side object** — deleting the Loom
item does not remove it from the search service; drop it there if you want the storage
back.

## What's next

- [Tutorial 05 — Data Agent over a Lakehouse](../05-data-agent.md) — the conversational
  surface that can use this index as a source.
- [Sovereign AI Agents use case](../../use-cases/sovereign-ai-agents.md) — the
  air-gapped variant of this pattern.
- [FedRAMP Compliance Tracker](fedramp-tracker.md) — pairs with this app when the
  corpus is your control evidence.
