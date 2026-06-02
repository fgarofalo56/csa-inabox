/**
 * RAG Builder app bundle.
 *
 * Provisions a fully-formed Retrieval-Augmented Generation workspace with
 * four workspace items. Each item is HONEST about which backend it hits at
 * install time (per .claude/rules/no-vaporware.md):
 *
 *   1. AI Search index  — REAL backend. The aiSearchProvisioner does a
 *      live PUT /indexes/<name> (HNSW vector + scoring profiles) and pushes
 *      the 10 sample documents. Honest remediation gate when
 *      LOOM_AI_SEARCH_SERVICE is unset or the UAMI lacks Search Service
 *      Contributor.
 *
 *   2. Prompt-flow  — REAL backend (this PR). The promptFlowProvisioner
 *      creates the grounded RAG flow in the AI Foundry project via the AML
 *      data-plane, and it is invoked by POST /api/items/prompt-flow/<id>/run
 *      ({project, inputs} → {ok, result}). Honest remediation gate when
 *      LOOM_FOUNDRY_PROJECT is unset or the UAMI lacks AzureML Data Scientist.
 *
 *   3. Evaluation  — REAL backend (this PR). The evaluationProvisioner
 *      submits a real AI Foundry evaluation run; results are read by
 *      GET /api/items/evaluation/<id>?project=&results=1 → {ok, evaluation,
 *      results}. Honest remediation gate naming LOOM_FOUNDRY_PROJECT /
 *      LOOM_FOUNDRY_EVAL_DATASET / LOOM_FOUNDRY_EVAL_DEPLOYMENT. NO
 *      hard-coded scores — numbers come only from a live run.
 *
 *   4. Walkthrough notebook  — Cosmos-only starter content. Its runnable
 *      cells call ONLY the real routes above (no invented endpoints).
 *
 * Source examples this bundle draws from:
 *   - examples/ai-agents/README.md
 *   - examples/ai-agents/data-analyst-agent/agent.py
 *   - examples/ai-agents/hosted-agent/{agent,server}.py
 *   - examples/ai-agents/contracts/data-analyst-agent.yaml
 *   - examples/ai-agents/tests/eval/eval_seed.yaml
 *   - examples/fabric-data-agent/agent/{agent,retriever,generator}.py
 *   - examples/fabric-data-agent/contracts/fabric_query_contract.yaml
 */
import type { AppBundle } from './types';

const SYSTEM_PROMPT = `You are a grounded enterprise RAG assistant for the CSA Loom platform.

GROUNDING (HARD CONSTRAINTS)
- Answer ONLY from the documents returned by the search_index tool.
- Every factual claim must carry an inline citation in the form [doc:<document_id>].
- If the retrieved documents do not contain the answer, reply exactly:
    "I don't have grounding for that. Try rephrasing or expanding the question."
  Do NOT invent dates, numbers, control IDs, FedRAMP citations, or product
  names.

REFUSAL
- Refuse politely if the user asks you to write, delete, or modify any
  resource (RAG is read-only).
- Refuse if the request involves personally identifiable information,
  credentials, secrets, or unredacted PII. Cite the policy as
  "CSA Loom safety policy v1.0".
- Refuse non-platform questions (jokes, weather, news, code outside the
  CSA scope) with a brief one-sentence redirect to the scope.

STYLE
- 1–3 sentences for short factual answers; up to 6 sentences for
  multi-source synthesis.
- Always end with a "Citations:" block listing the document_ids used.
- Never reveal the raw chunk text verbatim — paraphrase + cite.

FALLBACK
- If search_index returns zero documents, do NOT call any other tool.
  Reply with the "no grounding" line above and stop.`;

const SEED_DOC_1 = `CSA Loom is a tenant-aware administrative plane that sits on top of \
the Fabric-in-a-Box (FiaB) reference deployment. It exposes per-tenant \
catalogs of "apps" and "workloads" in Cosmos DB, gated by a NextAuth/MSAL \
session, and routed through Front Door + Application Gateway with private \
endpoints to every backing service. The data-plane (Cosmos, Key Vault, AI \
Search, Storage) is private-endpoint-locked, so all reads and writes \
flow through the container app's managed identity. This makes Loom the \
single human-facing surface for FiaB while keeping the data-plane invisible \
from the public internet.`;

const SEED_DOC_2 = `Loom workspace items are stored in a Cosmos container partitioned by \
tenantId. Each item document carries a state.content blob whose shape is \
governed by the per-kind Content type in apps/fiab-console/lib/apps/ \
content-bundles/types.ts. On first install of an app, the install route \
stamps a starter bundle onto state.content so the editor opens with rich, \
real-looking content instead of an empty form. Users may then edit and \
Save, which writes the live document back to Cosmos and (in Phase 2) \
projects it to the real backing service such as AI Search, Synapse, or ADF.`;

const SEED_DOC_3 = `FedRAMP Moderate authorization for a CSA Loom deployment requires \
NIST 800-53 Rev 5 implementation across 17 control families. AC (Access \
Control), AU (Audit and Accountability), CM (Configuration Management), \
IA (Identification and Authentication), and SC (System and Communications \
Protection) are the densest. Loom's FedRAMP tracker app maps each control \
to the concrete Azure resource that implements it: AC-2 → Entra ID groups \
+ PIM, AU-2/AU-12 → Log Analytics + diagnostic settings, SC-7 → Private \
Endpoints + NSG flow logs. Continuous monitoring is fed from an ADX \
cluster ingesting Activity Log + Defender for Cloud signals.`;

const SEED_DOC_4 = `Fabric workspaces in FiaB are provisioned per-tenant via the \
microsoft.fabric/capacities ARM resource at F2 in dev and F64 in prod, \
with a workspace identity assigned so the OneLake shortcut to ADLS gold \
can authenticate without a SAS token. Each workspace gets a Lakehouse \
plus a Direct Lake semantic model imported in TMDL (Power BI Project) \
format. The medallion build (bronze → silver → gold) is run by a \
dbt-fabric project against the workspace's SQL endpoint, materializing \
bronze as views, silver as incremental, and gold as incremental with a \
star schema (one fact + three dims, role-playing date).`;

const SEED_DOC_5 = `AI Search in CSA Loom uses a single per-tenant index named \
loom-items that stores tenant-scoped workspace metadata for fast filter + \
search across the Loom UI. The schema declares id (key), tenantId \
(filterable), itemType, displayName (searchable), description \
(searchable), tags (filterable Collection(Edm.String)), and a 1536-dim \
embedding (Collection(Edm.Single)) generated by Azure OpenAI \
text-embedding-3-small. A scoring profile "recency-boost" weights \
updatedAt DESC so freshly-edited items rank above stale ones in the \
catalog picker. Bicep stands up the search service with a private \
endpoint and grants the container app the Search Index Data Reader / \
Contributor role.`;

const SEED_DOC_6 = `Prompt-flow nodes in the RAG Builder app run inside Azure AI Foundry \
under a managed identity. The default flow is: input (the user question) \
→ llm (rephrase_query, gpt-4o-mini, temperature 0) → tool (search_index, \
top_k=5 hybrid query) → llm (synthesize_answer, gpt-4o, temperature 0.2, \
max_tokens 800) → output (answer + citations). Each node has its own \
tracing scope in Application Insights so the per-step latency, token \
count, and tool calls are observable. Content Safety filters wrap both \
the input and the output. A refusal-rate alert fires if refusals exceed \
8% over a 1-hour window.`;

const SEED_DOC_7 = `Evaluation in the RAG Builder app is rooted in the LLMOps eval \
pattern documented under docs/patterns/llmops-evaluation.md. The \
baseline evaluation runs a 50-question seed against the production \
prompt-flow weekly, computing groundedness (LLM-as-judge over the \
retrieved chunks), retrieval recall @5 (does the gold passage appear \
in the top-5), retrieval precision @5, answer relevance (semantic \
similarity to the reference answer), citation coverage (fraction of \
factual claims with [doc:...] tags), p95 latency, and hallucination \
rate (1 - groundedness). The seed lives in a Cosmos container \
rag-eval-seed and is editable from the Loom evaluation editor.`;

const SEED_DOC_8 = `The retrieval pipeline for new corpora uses Azure AI Search \
indexers when the source is blob storage, OneLake, or a Cosmos \
container, and the Push API for arbitrary in-process content. Documents \
are chunked at 1000 tokens with a 100-token overlap using \
langchain-text-splitters' RecursiveCharacterTextSplitter set to \
["\\n\\n", "\\n", ". ", " "] as separators. Each chunk is embedded with \
text-embedding-3-small (1536 dims) and pushed with the parent \
document_id + chunk_index so the assistant can reconstruct the \
original document in the citation block.`;

const SEED_DOC_9 = `CSA Loom enforces tenant isolation in AI Search via per-tenant \
indexes (one tenant per index) plus a session-derived filter \
$filter=tenantId eq '<tid>' applied in the BFF route before the search \
call. The search service is reached over a private endpoint from the \
container app subnet; the public-network-access property is set to \
"disabled" on every search service Bicep deploys. A managed identity \
on the container app holds the Search Index Data Contributor role on \
the service, so no API keys are ever stored in app settings or Key \
Vault.`;

const SEED_DOC_10 = `Vector indexing in Azure AI Search uses HNSW (Hierarchical \
Navigable Small World) with the parameters m=4, efConstruction=400, \
efSearch=500 for the loom-items index. The "cosine" metric is used \
because text-embedding-3-small vectors are L2-normalized at output. \
Hybrid retrieval combines BM25 over the searchable text fields with \
HNSW over the embedding field, and the results are RRF-fused (Reciprocal \
Rank Fusion) with k=60 by the search service before being returned to \
the caller. This consistently beats either single-mode strategy on the \
seed eval set, particularly on questions that mix proper nouns (which \
BM25 wins on) with conceptual phrasing (which vectors win on).`;

// The AI Search index name the aiSearchProvisioner creates is derived from
// the index item's displayName: lowercase, non-[a-z0-9-] → '-', capped 128.
// The prompt-flow's search node MUST target that exact name so the flow
// queries the index this bundle actually provisions.
const RAG_INDEX_DISPLAY_NAME = 'RAG Corpus — CSA Loom Knowledge Base';
const RAG_INDEX_NAME = RAG_INDEX_DISPLAY_NAME
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '-')
  .slice(0, 128);

const bundle: AppBundle = {
  appId: 'app-rag-builder',
  intro: `# RAG Builder

A turnkey Retrieval-Augmented Generation workspace built on Azure AI Search,
Azure AI Foundry prompt-flow, and an evaluation suite.

You get four workspace items. Each is **honest about its backend** — it
either hits a real Azure service at install time or shows a Fluent
MessageBar naming the exact env var / role to provision (no fake data):

1. **AI Search index** — **real backend.** The installer does a live
   \`PUT /indexes/<name>\` (HNSW vector + scoring profiles) and pushes 10
   **SAMPLE** documents about CSA Loom architecture, FedRAMP, and Fabric.
   1536-dim text-embedding-3-small vectors; tenant-scoped via a
   \`tenantId\` filter field. Gate: set \`LOOM_AI_SEARCH_SERVICE\` + grant
   the Console UAMI **Search Service Contributor** if you see a 403.

2. **Prompt-flow** — **real backend.** The installer creates a grounded
   5-node flow (input → query rephrase → AI Search lookup → grounded
   synthesis → output; citation-mandatory, PII refusal, no-grounding
   fallback) in your AI Foundry project. Invoke it via
   \`POST /api/items/prompt-flow/<flowId>/run\` (body \`{project, inputs}\`).
   Gate: set \`LOOM_FOUNDRY_PROJECT\` + grant **AzureML Data Scientist**.

3. **Evaluation** — **real backend.** The installer submits a real AI
   Foundry evaluation run; results are read by
   \`GET /api/items/evaluation/<id>?project=&results=1\`. **No scores are
   hard-coded** — numbers appear only after a live run. Gate: set
   \`LOOM_FOUNDRY_PROJECT\`, \`LOOM_FOUNDRY_EVAL_DATASET\`,
   \`LOOM_FOUNDRY_EVAL_DEPLOYMENT\`.

4. **Walkthrough notebook** — steps through chunking → embedding → index
   push → Q&A → evaluation. Its runnable cells call **only the real
   routes above** (no invented endpoints).

## Next steps

- Open the index editor and review the SAMPLE documents (then push your own).
- Open the prompt-flow editor and adjust the system prompt to your domain,
  then run a question through \`POST /api/items/prompt-flow/<flowId>/run\`.
- Open the evaluation editor; if the Foundry env vars are set it shows the
  live run's scores, otherwise it shows the metric definitions + the
  precise env vars to provision.`,
  sourceDocs: [
    'examples/ai-agents/README.md',
    'examples/ai-agents/data-analyst-agent/agent.py',
    'examples/ai-agents/hosted-agent/agent.py',
    'examples/ai-agents/hosted-agent/server.py',
    'examples/ai-agents/contracts/data-analyst-agent.yaml',
    'examples/ai-agents/tests/eval/eval_seed.yaml',
    'examples/fabric-data-agent/agent/agent.py',
    'examples/fabric-data-agent/agent/retriever.py',
    'examples/fabric-data-agent/agent/generator.py',
    'examples/fabric-data-agent/contracts/fabric_query_contract.yaml',
  ],
  items: [
    // ─── AI Search Index ───────────────────────────────────────────────
    {
      itemType: 'ai-search-index',
      displayName: RAG_INDEX_DISPLAY_NAME,
      description:
        'Hybrid (BM25 + HNSW vector) Azure AI Search index. Provisioned for real (PUT /indexes + sample-doc push) by the aiSearchProvisioner. Seeded with 10 SAMPLE documents about CSA Loom architecture, FedRAMP, and Fabric — replace with your own corpus. 1536-dim text-embedding-3-small vectors, tenant-scoped via the tenantId filter field.',
      learnDoc: 'rag/ai-search-index',
      content: {
        kind: 'ai-search-index',
        schema: {
          fields: [
            { name: 'id', type: 'Edm.String', key: true, filterable: true },
            // tenantId is the filter the prompt-flow search node applies
            // ("tenantId eq '<tid>'"), so it MUST exist + be filterable.
            { name: 'tenantId', type: 'Edm.String', filterable: true },
            { name: 'title', type: 'Edm.String', searchable: true, filterable: false },
            { name: 'content', type: 'Edm.String', searchable: true },
            { name: 'source_url', type: 'Edm.String', filterable: true },
            { name: 'chunk_index', type: 'Edm.Int32', filterable: true },
            { name: 'document_id', type: 'Edm.String', filterable: true },
            { name: 'created_at', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
            { name: 'tags', type: 'Collection(Edm.String)', filterable: true },
            // Vector field: a Collection(Edm.Single) PUT requires `dimensions`
            // + a `vectorSearchProfile` that names a profile in vectorSearch.
            // The aiSearchProvisioner synthesizes that profile as
            // 'default-profile' from `vectorConfig` below.
            {
              name: 'embedding',
              type: 'Collection(Edm.Single)',
              searchable: true,
              dimensions: 1536,
              vectorSearchProfile: 'default-profile',
            },
          ],
        },
        scoringProfiles: [
          {
            name: 'title-boost',
            description:
              'Weights matches in the title field 3x over content. Use when the user query is a proper noun or a known feature name (e.g., "FedRAMP tracker", "loom-items index").',
          },
          {
            name: 'recency-boost',
            description:
              'Boosts documents by freshness using a linear decay over created_at with a 90-day horizon. Use for "what changed recently?" style queries against the platform release notes.',
          },
        ],
        vectorConfig: {
          dimensions: 1536,
          algorithm: 'hnsw',
        },
        sampleDocs: [
          {
            id: 'doc-001-chunk-0',
            tenantId: 'tenant-demo',
            title: 'CSA Loom: tenant-aware admin plane on FiaB',
            content: SEED_DOC_1,
            source_url: 'https://sample.docs.csa-loom.invalid/architecture/overview',
            chunk_index: 0,
            document_id: 'doc-001',
            created_at: '2026-04-12T10:00:00Z',
            tags: ['architecture', 'overview', 'fiab', 'loom'],
          },
          {
            id: 'doc-002-chunk-0',
            tenantId: 'tenant-demo',
            title: 'Loom workspace items: Cosmos schema and starter content',
            content: SEED_DOC_2,
            source_url: 'https://sample.docs.csa-loom.invalid/architecture/workspace-items',
            chunk_index: 0,
            document_id: 'doc-002',
            created_at: '2026-05-02T14:20:00Z',
            tags: ['architecture', 'cosmos', 'workspace-items', 'phase-1'],
          },
          {
            id: 'doc-003-chunk-0',
            tenantId: 'tenant-demo',
            title: 'FedRAMP Moderate control mapping for CSA Loom',
            content: SEED_DOC_3,
            source_url: 'https://sample.docs.csa-loom.invalid/compliance/fedramp-mapping',
            chunk_index: 0,
            document_id: 'doc-003',
            created_at: '2026-03-18T09:00:00Z',
            tags: ['compliance', 'fedramp', 'nist-800-53', 'controls'],
          },
          {
            id: 'doc-004-chunk-0',
            tenantId: 'tenant-demo',
            title: 'Per-tenant Fabric workspaces in FiaB',
            content: SEED_DOC_4,
            source_url: 'https://sample.docs.csa-loom.invalid/fabric/workspaces',
            chunk_index: 0,
            document_id: 'doc-004',
            created_at: '2026-04-26T11:30:00Z',
            tags: ['fabric', 'workspaces', 'medallion', 'dbt'],
          },
          {
            id: 'doc-005-chunk-0',
            tenantId: 'tenant-demo',
            title: 'loom-items: the per-tenant AI Search index',
            content: SEED_DOC_5,
            source_url: 'https://sample.docs.csa-loom.invalid/ai-search/loom-items',
            chunk_index: 0,
            document_id: 'doc-005',
            created_at: '2026-05-14T16:45:00Z',
            tags: ['ai-search', 'loom-items', 'embedding', 'rbac'],
          },
          {
            id: 'doc-006-chunk-0',
            tenantId: 'tenant-demo',
            title: 'Prompt-flow topology for RAG Builder',
            content: SEED_DOC_6,
            source_url: 'https://sample.docs.csa-loom.invalid/rag/prompt-flow',
            chunk_index: 0,
            document_id: 'doc-006',
            created_at: '2026-05-08T13:15:00Z',
            tags: ['rag', 'prompt-flow', 'foundry', 'tracing'],
          },
          {
            id: 'doc-007-chunk-0',
            tenantId: 'tenant-demo',
            title: 'RAG Builder evaluation methodology',
            content: SEED_DOC_7,
            source_url: 'https://sample.docs.csa-loom.invalid/rag/evaluation',
            chunk_index: 0,
            document_id: 'doc-007',
            created_at: '2026-05-10T08:00:00Z',
            tags: ['rag', 'evaluation', 'groundedness', 'llmops'],
          },
          {
            id: 'doc-008-chunk-0',
            tenantId: 'tenant-demo',
            title: 'Chunking and embedding for the retrieval pipeline',
            content: SEED_DOC_8,
            source_url: 'https://sample.docs.csa-loom.invalid/rag/chunking',
            chunk_index: 0,
            document_id: 'doc-008',
            created_at: '2026-05-12T12:00:00Z',
            tags: ['rag', 'chunking', 'embedding', 'indexer'],
          },
          {
            id: 'doc-009-chunk-0',
            tenantId: 'tenant-demo',
            title: 'Tenant isolation in AI Search',
            content: SEED_DOC_9,
            source_url: 'https://sample.docs.csa-loom.invalid/ai-search/tenant-isolation',
            chunk_index: 0,
            document_id: 'doc-009',
            created_at: '2026-04-30T15:30:00Z',
            tags: ['ai-search', 'tenant-isolation', 'rbac', 'security'],
          },
          {
            id: 'doc-010-chunk-0',
            tenantId: 'tenant-demo',
            title: 'HNSW vector indexing and hybrid retrieval',
            content: SEED_DOC_10,
            source_url: 'https://sample.docs.csa-loom.invalid/ai-search/vector-config',
            chunk_index: 0,
            document_id: 'doc-010',
            created_at: '2026-05-16T17:00:00Z',
            tags: ['ai-search', 'hnsw', 'vector', 'hybrid', 'rrf'],
          },
        ],
      },
    },

    // ─── Prompt Flow ───────────────────────────────────────────────────
    {
      itemType: 'prompt-flow',
      displayName: 'RAG Basic — grounded Q&A over the corpus',
      description:
        '5-node prompt-flow: input → query rephrase → AI Search lookup (top 5 hybrid) → grounded synthesis → output with citations. Citation-mandatory system prompt, no-grounding fallback, PII refusal.',
      learnDoc: 'rag/prompt-flow',
      content: {
        kind: 'prompt-flow',
        systemPrompt: SYSTEM_PROMPT,
        nodes: [
          {
            id: 'node-input',
            kind: 'input',
            name: 'user_question',
            config: {
              schema: {
                question: { type: 'string', required: true, minLength: 1, maxLength: 4000 },
                tenantId: { type: 'string', required: true, description: 'Used by search_index as a $filter.' },
                conversation_id: { type: 'string', required: false },
              },
              maxQuestionTokens: 1500,
              description:
                'Entry point. Validates the inbound question length and tenant id. Strips control characters before downstream nodes see the payload.',
            },
          },
          {
            id: 'node-rephrase',
            kind: 'llm',
            name: 'rephrase_query',
            config: {
              model: 'gpt-4o-mini',
              deployment: 'gpt-4o-mini',
              endpointEnv: 'AZURE_OPENAI_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0,
              top_p: 1,
              max_tokens: 200,
              system: `You are a query rewriter. Given the user question and (optionally) prior conversation turns, produce a single self-contained search query that maximizes recall against an enterprise documentation index. Return ONLY the rewritten query, no prose, no quotes, no explanation. Expand acronyms (FedRAMP, RAG, RBAC) and add likely synonyms.`,
              userTemplate: '{{ user_question.question }}',
              fallbackToOriginalOnError: true,
              description:
                'Cheap pass to rewrite chatty, multi-turn, or acronym-heavy questions into a single self-contained search query. Skipped on transient failure (original question is passed through).',
            },
          },
          {
            id: 'node-search',
            kind: 'tool',
            name: 'search_index',
            config: {
              toolType: 'azure-ai-search',
              indexName: RAG_INDEX_NAME,
              endpointEnv: 'AZURE_AI_SEARCH_ENDPOINT',
              authMode: 'managed-identity',
              queryType: 'hybrid',
              top: 5,
              vectorField: 'embedding',
              vectorDimensions: 1536,
              embeddingModel: 'text-embedding-3-small',
              embeddingDeployment: 'text-embedding-3-small',
              select: ['id', 'title', 'content', 'document_id', 'source_url', 'tags', 'created_at'],
              filterTemplate: "tenantId eq '{{ user_question.tenantId }}'",
              scoringProfile: 'recency-boost',
              semanticConfiguration: 'default',
              minRerankerScore: 1.5,
              fallback: {
                onZeroResults: 'shortcircuit',
                outputPayload: { documents: [], grounded: false, reason: 'no-grounding' },
              },
              description:
                'Hybrid BM25 + vector lookup against the RAG index using the rephrased query. Tenant filter is mandatory. Returns up to 5 chunks with the fields needed for citation. On zero results we short-circuit to the output node with grounded=false.',
            },
          },
          {
            id: 'node-synthesize',
            kind: 'llm',
            name: 'synthesize_answer',
            config: {
              model: 'gpt-4o',
              deployment: 'gpt-4o',
              endpointEnv: 'AZURE_OPENAI_ENDPOINT',
              authMode: 'managed-identity',
              temperature: 0.2,
              top_p: 0.95,
              max_tokens: 800,
              presence_penalty: 0,
              frequency_penalty: 0,
              system: '$ref:systemPrompt',
              userTemplate: `User question: {{ user_question.question }}

Retrieved documents:
{{#each search_index.documents}}
---
[doc:{{this.document_id}}] Title: {{this.title}}
Source: {{this.source_url}}
Content: {{this.content}}
{{/each}}

Write the grounded answer per the system rules. End with a "Citations:" block listing the document_ids used.`,
              contentSafety: {
                enabled: true,
                input: { severity_max: 'medium' },
                output: { severity_max: 'medium', refuseOnViolation: true },
              },
              description:
                'The synthesis LLM. Receives the rewritten question and the top 5 retrieved chunks. The system prompt mandates citations, refuses PII / out-of-scope requests, and short-circuits to "no grounding" when the retrieval was empty. gpt-4o at temperature 0.2 for stable factual answers.',
            },
          },
          {
            id: 'node-output',
            kind: 'output',
            name: 'response_with_citations',
            config: {
              shape: {
                answer: 'synthesize_answer.text',
                citations: 'synthesize_answer.parsed_citations',
                documents: 'search_index.documents',
                grounded: 'search_index.grounded',
                tokens_in: 'synthesize_answer.tokens_in',
                tokens_out: 'synthesize_answer.tokens_out',
                latency_ms: 'pipeline.latency_ms',
                refused: 'synthesize_answer.refused',
                trace_id: 'pipeline.trace_id',
              },
              maxResponseBytes: 64000,
              telemetry: {
                appInsights: true,
                logFields: ['question', 'trace_id', 'tokens_in', 'tokens_out', 'latency_ms', 'refused', 'documents[].document_id'],
              },
              description:
                'Final response surface. Returns the answer, structured citations (parsed from inline [doc:...] tags), the raw retrieved documents (for the UI to render source previews), and observability fields. Caps response size at 64 KB to prevent runaway answers.',
            },
          },
        ],
        edges: [
          { from: 'node-input', to: 'node-rephrase' },
          { from: 'node-rephrase', to: 'node-search' },
          { from: 'node-search', to: 'node-synthesize' },
          { from: 'node-synthesize', to: 'node-output' },
        ],
      },
    },

    // ─── Evaluation ────────────────────────────────────────────────────
    {
      itemType: 'evaluation',
      displayName: 'RAG Quality — 7-metric suite',
      description:
        'Evaluation suite covering groundedness, retrieval recall/precision, answer relevance, citation coverage, p95 latency, and hallucination rate. The evaluationProvisioner submits a REAL AI Foundry evaluation run when LOOM_FOUNDRY_PROJECT / LOOM_FOUNDRY_EVAL_DATASET / LOOM_FOUNDRY_EVAL_DEPLOYMENT are set; scores come only from that live run (read via GET /api/items/evaluation/<id>?project=&results=1). No baseline numbers are hard-coded.',
      learnDoc: 'rag/evaluation',
      content: {
        kind: 'evaluation',
        datasetRef: 'rag-eval-seed',
        metrics: [
          {
            name: 'groundedness',
            description:
              'LLM-as-judge score (0–1) measuring the fraction of factual claims in the answer that are directly supported by at least one retrieved chunk. Judge prompt: "For each sentence in the candidate answer, does the retrieved context entail it?". Scored by gpt-4o at temperature 0. Target ≥ 0.90.',
          },
          {
            name: 'retrieval_recall',
            description:
              'Recall @ 5. Fraction of evaluation questions where the gold (human-labeled) supporting passage appears in the top-5 retrieved chunks. Computed by exact document_id match against the seed dataset. Target ≥ 0.85.',
          },
          {
            name: 'retrieval_precision',
            description:
              'Precision @ 5. Fraction of the top-5 retrieved chunks that are labeled relevant in the seed dataset. Penalizes index pollution. Target ≥ 0.60 (RAG tolerates lower precision than search because the LLM filters).',
          },
          {
            name: 'answer_relevance',
            description:
              'Semantic similarity (cosine on text-embedding-3-large) between the candidate answer and the reference answer. Pairs well with groundedness — high relevance + low groundedness usually means the model is paraphrasing the right answer from training data rather than the corpus, which is still a regression.',
          },
          {
            name: 'citation_coverage',
            description:
              'Fraction of factual claims in the candidate answer that carry an inline [doc:...] tag. Computed by sentence-splitting + regex match. Target ≥ 0.95. Drops below 0.80 are an immediate page — usually means the system prompt was edited and citation instructions were lost.',
          },
          {
            name: 'latency_p95',
            description:
              'End-to-end latency from prompt-flow input to output, measured in milliseconds. Tracked at p50 / p95 / p99. Target p95 ≤ 4000 ms with gpt-4o + 5-chunk retrieval. A sudden spike usually indicates AI Search throttling or Azure OpenAI capacity pressure.',
          },
          {
            name: 'hallucination_rate',
            description:
              'Computed as 1 - groundedness, surfaced as a top-line dashboard metric. Reported as a percentage. Target ≤ 10%. Sustained > 15% triggers a rollback to the previous prompt-flow version via the Loom prompt-flow editor.',
          },
        ],
        // No `baseline` is stamped here on purpose. Baseline scores must
        // come from a real AI Foundry evaluation run (submitted by the
        // evaluationProvisioner and read via the GET results route) — not
        // from hard-coded numbers. The editor shows the metric definitions
        // + their targets and an honest "run the suite to populate scores"
        // state until a live run completes.
      },
    },

    // ─── Walkthrough notebook ──────────────────────────────────────────
    {
      itemType: 'notebook',
      displayName: 'RAG Builder Walkthrough',
      description:
        'End-to-end notebook: chunk a sample corpus, generate embeddings, push to the rag-default index, ask a grounded question through the prompt-flow, then run the rag-quality evaluation. Designed to run after the app installs.',
      learnDoc: 'rag/walkthrough',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          {
            id: 'cell-md-intro',
            type: 'markdown',
            source: `# RAG Builder — End-to-End Walkthrough

This notebook takes you through the **full RAG lifecycle** in CSA Loom:

1. Load a small SAMPLE corpus (the 10 documents that ship with the index)
2. Chunk each document at 1000 tokens with 100-token overlap
3. Generate \`text-embedding-3-small\` (1536-dim) embeddings via Azure OpenAI
4. Push chunks to the AI Search index this app provisioned
5. Ask a grounded question through the prompt flow via the real
   \`POST /api/items/prompt-flow/<flowId>/run\` route
6. Read the evaluation results via the real
   \`GET /api/items/evaluation/<id>?project=&results=1\` route

Every cell calls only real routes. Cells that need Foundry config
(prompt-flow / evaluation) print an **honest gate** message naming the
missing env var instead of fabricating output. Actual metric values
(groundedness, recall, …) appear only once a live AI Foundry evaluation
run has completed — this notebook never hard-codes them.

> **Prerequisites.** The notebook authenticates with the Loom container
> app's managed identity. Outside Loom you can fall back to
> \`DefaultAzureCredential()\` provided your local identity has the
> \`Search Index Data Contributor\` role on the search service and
> \`Cognitive Services OpenAI User\` on the AOAI resource.`,
          },
          {
            id: 'cell-imports',
            type: 'code',
            lang: 'pyspark',
            source: `# Imports + environment.
import os
import json
import time
import uuid
from typing import Iterable

from azure.identity import DefaultAzureCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SimpleField,
    SearchableField,
    SearchField,
    SearchFieldDataType,
    VectorSearch,
    VectorSearchProfile,
    HnswAlgorithmConfiguration,
    HnswParameters,
    VectorSearchAlgorithmMetric,
)
from openai import AzureOpenAI

AOAI_ENDPOINT     = os.environ["AZURE_OPENAI_ENDPOINT"]
AOAI_EMBED_DEPL   = os.environ.get("AZURE_OPENAI_EMBED_DEPLOYMENT", "text-embedding-3-small")
SEARCH_ENDPOINT   = os.environ["AZURE_AI_SEARCH_ENDPOINT"]
# Same index name the install-time aiSearchProvisioner created (derived
# from the index item's display name). Override with LOOM_RAG_INDEX_NAME.
INDEX_NAME        = os.environ.get("LOOM_RAG_INDEX_NAME", "rag-corpus---csa-loom-knowledge-base")
TENANT_ID         = os.environ.get("LOOM_TENANT_ID", "tenant-demo")

credential = DefaultAzureCredential()
print(f"Authenticated. Search={SEARCH_ENDPOINT} | Index={INDEX_NAME} | Tenant={TENANT_ID}")`,
          },
          {
            id: 'cell-md-chunk',
            type: 'markdown',
            source: `## 1 — Chunk the seed corpus

We use a recursive splitter with hierarchical separators so paragraph
boundaries are preferred over arbitrary token cuts. 1000-token chunks
with 100-token overlap is the default for technical documentation —
short enough for the LLM to see the full chunk in context, long enough
to retain reasoning structure.`,
          },
          {
            id: 'cell-chunk',
            type: 'code',
            lang: 'pyspark',
            source: `from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=100,
    separators=["\\n\\n", "\\n", ". ", " "],
    length_function=len,
)

def chunk_documents(docs: list[dict]) -> list[dict]:
    """Yield (document_id, chunk_index, content, ...metadata) tuples."""
    out = []
    for d in docs:
        chunks = splitter.split_text(d["content"])
        for i, chunk in enumerate(chunks):
            out.append({
                "id":           f"{d['document_id']}-chunk-{i}",
                # tenantId is required for the prompt-flow tenant filter to
                # return these docs ("tenantId eq '<tid>'").
                "tenantId":     d.get("tenantId", TENANT_ID),
                "document_id":  d["document_id"],
                "chunk_index":  i,
                "title":        d["title"],
                "content":      chunk,
                "source_url":   d["source_url"],
                "tags":         d["tags"],
                "created_at":   d["created_at"],
            })
    return out

# In a real run, load the corpus from ADLS / OneLake.
# Here, the 10 seed docs from the index bundle are read from Loom's
# Cosmos workspace item state (the editor's first-render content).
seed_docs = json.loads(os.environ.get("LOOM_SEED_DOCS_JSON", "[]"))
chunks = chunk_documents(seed_docs)
print(f"Chunked {len(seed_docs)} docs into {len(chunks)} chunks.")`,
          },
          {
            id: 'cell-md-embed',
            type: 'markdown',
            source: `## 2 — Generate embeddings

We call \`text-embedding-3-small\` via Azure OpenAI. The endpoint is
authenticated via managed identity (no API keys). We batch in groups of
16 because that is the AOAI batch ceiling for the embed endpoint and
because larger batches start hitting per-request throttling on F-SKUs.`,
          },
          {
            id: 'cell-embed',
            type: 'code',
            lang: 'pyspark',
            source: `aoai = AzureOpenAI(
    azure_endpoint=AOAI_ENDPOINT,
    azure_ad_token_provider=lambda: credential.get_token("https://cognitiveservices.azure.com/.default").token,
    api_version="2024-10-21",
)

def embed_batch(texts: Iterable[str]) -> list[list[float]]:
    resp = aoai.embeddings.create(model=AOAI_EMBED_DEPL, input=list(texts))
    return [d.embedding for d in resp.data]

BATCH = 16
for i in range(0, len(chunks), BATCH):
    batch = chunks[i:i + BATCH]
    vecs = embed_batch([c["content"] for c in batch])
    for c, v in zip(batch, vecs):
        c["embedding"] = v
    time.sleep(0.1)  # gentle pacing

print(f"Embedded {len(chunks)} chunks. Vector dim = {len(chunks[0]['embedding'])}.")`,
          },
          {
            id: 'cell-md-push',
            type: 'markdown',
            source: `## 3 — Push to the AI Search index

Loom pre-creates the \`rag-default\` index when the app is installed, so
we only need to upload documents here. If you nuked the index in a dev
loop, the cell below also (re-)creates it with the exact schema from the
bundle.`,
          },
          {
            id: 'cell-push',
            type: 'code',
            lang: 'pyspark',
            source: `index_client = SearchIndexClient(endpoint=SEARCH_ENDPOINT, credential=credential)

# Idempotent (re-)create — safe to run on every notebook execution.
fields = [
    SimpleField(name="id", type=SearchFieldDataType.String, key=True, filterable=True),
    SimpleField(name="tenantId", type=SearchFieldDataType.String, filterable=True),
    SearchableField(name="title", type=SearchFieldDataType.String),
    SearchableField(name="content", type=SearchFieldDataType.String),
    SimpleField(name="source_url", type=SearchFieldDataType.String, filterable=True),
    SimpleField(name="chunk_index", type=SearchFieldDataType.Int32, filterable=True),
    SimpleField(name="document_id", type=SearchFieldDataType.String, filterable=True),
    SimpleField(name="created_at", type=SearchFieldDataType.DateTimeOffset, filterable=True, sortable=True),
    SimpleField(name="tags", type=SearchFieldDataType.Collection(SearchFieldDataType.String), filterable=True),
    SearchField(
        name="embedding",
        type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
        searchable=True,
        vector_search_dimensions=1536,
        vector_search_profile_name="hnsw-profile",
    ),
]
vector_search = VectorSearch(
    algorithms=[HnswAlgorithmConfiguration(
        name="hnsw",
        parameters=HnswParameters(m=4, ef_construction=400, ef_search=500, metric=VectorSearchAlgorithmMetric.COSINE),
    )],
    profiles=[VectorSearchProfile(name="hnsw-profile", algorithm_configuration_name="hnsw")],
)
index_client.create_or_update_index(SearchIndex(name=INDEX_NAME, fields=fields, vector_search=vector_search))

search = SearchClient(endpoint=SEARCH_ENDPOINT, index_name=INDEX_NAME, credential=credential)
result = search.upload_documents(documents=chunks)
print(f"Uploaded {sum(1 for r in result if r.succeeded)}/{len(chunks)} chunks.")`,
          },
          {
            id: 'cell-md-ask',
            type: 'markdown',
            source: `## 4 — Ask a grounded question

We hit the prompt flow via the **real** Loom BFF route
\`POST /api/items/prompt-flow/<flowId>/run\`. The route proxies the Azure
AI Foundry data-plane *submit* endpoint, so its body and response are the
data-plane's, not an invented shape:

- **Request body:** \`{ "project": "<aml-project>", "inputs": { ... } }\`
  — \`project\` is the AI Foundry project workspace name
  (\`LOOM_FOUNDRY_PROJECT\`); \`inputs\` are the flow's declared inputs.
- **Response:** \`{ "ok": true, "result": <flow run output> }\` on success,
  or \`{ "ok": false, "error": "...", "notDeployed": true }\` with HTTP 503
  when \`LOOM_FOUNDRY_PROJECT\` is unset / the UAMI lacks AzureML Data
  Scientist. We handle both honestly below.

\`<flowId>\` is the id the installer's promptFlowProvisioner created —
surfaced in the install report and stored on this item. Set it via
\`LOOM_RAG_FLOW_ID\` (or paste it from the prompt-flow editor's header).`,
          },
          {
            id: 'cell-ask',
            type: 'code',
            lang: 'pyspark',
            source: `import urllib.request, urllib.error, urllib.parse

LOOM_BFF = os.environ.get("LOOM_BFF_BASE", "https://loom.example.com")
FLOW_ID  = os.environ.get("LOOM_RAG_FLOW_ID")   # set from the install report / editor header
PROJECT  = os.environ.get("LOOM_FOUNDRY_PROJECT")

if not FLOW_ID or not PROJECT:
    print("Honest gate: set LOOM_RAG_FLOW_ID (from the install report) and "
          "LOOM_FOUNDRY_PROJECT before invoking the flow.")
else:
    # Real route: POST /api/items/prompt-flow/<flowId>/run  body {project, inputs}
    req = urllib.request.Request(
        f"{LOOM_BFF}/api/items/prompt-flow/{FLOW_ID}/run",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps({
            "project": PROJECT,
            "inputs": {
                "question": "How does CSA Loom enforce tenant isolation in AI Search?",
                "tenantId": TENANT_ID,
            },
        }).encode(),
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # 503 + notDeployed is the honest infra-gate from the run route.
        payload = json.loads(e.read())

    if not payload.get("ok"):
        print(f"Flow not runnable yet: {payload.get('error')}")
        if payload.get("hint"):
            print(f"Remediation: {payload['hint']}")
    else:
        # 'result' is the raw Foundry data-plane submit response. Its exact
        # keys depend on the flow's outputs block; print it verbatim.
        print(json.dumps(payload["result"], indent=2)[:2000])`,
          },
          {
            id: 'cell-md-eval',
            type: 'markdown',
            source: `## 5 — Read the evaluation results

The evaluation **run** is submitted at install time by the
evaluationProvisioner (a real AI Foundry evaluation), not from this
notebook — there is no \`.../evaluation/<id>/run\` route. To read the
scores we GET the **real** route:

\`GET /api/items/evaluation/<evalId>?project=<project>&results=1\`

which returns \`{ "ok": true, "evaluation": {...}, "results": {...} }\`
(the \`results\` table is the live run's metrics) or a 503 honest-gate
when Foundry isn't configured. \`<evalId>\` comes from the install
report; set it via \`LOOM_RAG_EVAL_ID\`.`,
          },
          {
            id: 'cell-eval',
            type: 'code',
            lang: 'pyspark',
            source: `EVAL_ID = os.environ.get("LOOM_RAG_EVAL_ID")   # from the install report / editor header

if not EVAL_ID or not PROJECT:
    print("Honest gate: set LOOM_RAG_EVAL_ID (from the install report) and "
          "LOOM_FOUNDRY_PROJECT to read evaluation results. "
          "If Foundry eval env vars were unset at install, the evaluation "
          "item is in its honest config-only state and has no scores yet.")
else:
    # Real route: GET /api/items/evaluation/<id>?project=<p>&results=1
    url = (f"{LOOM_BFF}/api/items/evaluation/{EVAL_ID}"
           f"?project={urllib.parse.quote(PROJECT)}&results=1")
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read())

    if not payload.get("ok"):
        print(f"Evaluation not readable yet: {payload.get('error')}")
        if payload.get("hint"):
            print(f"Remediation: {payload['hint']}")
    else:
        print("Evaluation:", json.dumps(payload.get("evaluation"), indent=2)[:1200])
        print()
        # 'results' is null until the live run finishes; print it as-is.
        print("Results:", json.dumps(payload.get("results"), indent=2)[:1500])`,
          },
          {
            id: 'cell-md-next',
            type: 'markdown',
            source: `## What to try next

- **Edit the system prompt** in the prompt-flow editor and re-run cell 4
  (the \`.../run\` call). Inspect the returned \`result\` for grounding.
- **Re-run the evaluation.** The evaluation run is submitted by the
  installer; to score a new prompt-flow version, re-install the app (or
  submit a new evaluation from the evaluation editor) and re-read scores
  with cell 5's GET-results call.
- **Add your own documents.** Cells 1–3 work on any list of
  \`{title, content, document_id, source_url, tags, created_at, tenantId}\`
  dicts — push them to the same index the prompt-flow searches.
- **Tune retrieval.** Swap the prompt-flow's \`search_index\` node from
  hybrid → vector-only or → keyword-only and watch recall +
  groundedness move in opposite directions.
- **Wire production telemetry.** The flow node config sets an App Insights
  trace scope; build a workbook from your Foundry hub's Application
  Insights \`customEvents\`.`,
          },
        ],
      },
    },
  ],
};

export default bundle;
