# CSA Copilot (CSA-0008)

Grounded question-answering service for the CSA-in-a-Box platform.

## Status

**Phase 0-1 shipped** (2026-04-20). This delivery covers the corpus
indexer and the grounding-with-citations agent. Phases 2-5 remain
**out of scope** for this release — see the Roadmap section below.

## Architecture

Copilot is built as six phases, only two of which are implemented today.

| Phase | Name                          | Status    |
|-------|-------------------------------|-----------|
| 0     | Corpus Indexer                | Shipped   |
| 1     | Grounding + Citations         | Shipped   |
| 2     | Decision-tree walker          | Deferred  |
| 3     | Skill catalog                 | Deferred  |
| 4     | Gated execute broker          | Deferred  |
| 5     | Four surfaces (Web/CLI/MCP/API) | Deferred |
| 6     | LLMOps / evals                | Deferred  |

```
                    apps/copilot/
 question ---+
             |
             v
      +----------------+       +-------------------------+
      |  CopilotAgent  | <---> |  PydanticAIGenerator    |
      |   ask(q)       |       |  (Azure OpenAI chat)    |
      +-------+--------+       +-------------------------+
              |
              | retrieve top-k
              v
      +----------------+       +-------------------------+
      |  VectorStore   | <---- |  EmbeddingGenerator     |
      |  (AI Search)   |       |  (text-embedding-3-L)   |
      +-------+--------+       +-------------------------+
              ^
              |
      +----------------+
      | CorpusIndexer  |
      | (Phase 0)      |
      +----------------+
              ^
              |
     docs/ | examples/ | ADRs | runbooks | compliance | migrations
```

The indexer and agent share the primitives in
`csa_platform.ai_integration.rag.pipeline` (chunker, embedder, vector
store). The agent layers a refusal contract, citation verification,
and a PydanticAI-generated structured response on top.

## Install

The Copilot code lives in the new top-level `apps/` package and its
runtime dependencies (`pydantic-ai`, `pydantic-settings`,
`openai`, `azure-search-documents`, etc.) are exposed via the `copilot`
extra on the root package:

```bash
pip install -e ".[copilot]"
```

If you're already running with the `platform` extra, most deps are
already present — only `pydantic-ai` needs to be added. `copilot`
extras include both transitive deps and `platform`.

## Usage

### Ingest the corpus

```bash
# Default roots (docs/, examples/, ARCHITECTURE.md, README.md, ...)
python -m apps.copilot.cli ingest

# Custom roots
python -m apps.copilot.cli ingest --root docs/adr --root docs/runbooks

# Dry run — walk + chunk only, no Azure calls
python -m apps.copilot.cli ingest --root docs --dry-run --json
```

Output (JSON mode):

```json
{
  "files_scanned": 42,
  "chunks_indexed": 318,
  "chunks_skipped": 0,
  "bytes_embedded": 195872,
  "elapsed_seconds": 12.4,
  "doc_type_counts": {
    "adr": 18,
    "overview": 92,
    "runbook": 44,
    "example": 164
  }
}
```

### Ask a question

```bash
python -m apps.copilot.cli ask \
  "Why does csa-in-a-box prefer Bicep over ARM?" \
  --show-citations
```

Sample output:

```
Bicep is preferred because it is more readable than raw ARM JSON [1]
and modules can be shared across domain projects [1]. ADR 0001 also
notes that Bicep deploys reliably in Azure Government [2].

--- Citations ---
[1] docs/adr/0001-use-bicep.md  (sim=0.88)
    We adopt Bicep over ARM JSON for readability...
[2] docs/adr/0001-use-bicep.md  (sim=0.74)
    Modules are shared across domains...

(groundedness=0.88)
```

If coverage is below the configured threshold, Copilot **refuses**:

```
REFUSED (no_coverage): I don't have enough grounded context from the
CSA-in-a-Box documentation to answer that reliably. ...
```

Exit codes:
- `0` — normal answer
- `2` — clean refusal (low coverage or citation verification failure)
- `1` — crash / unexpected error

## Configuration

All settings read from environment variables prefixed `COPILOT_`.

| Variable                                    | Default                        | Purpose                                         |
|---------------------------------------------|--------------------------------|-------------------------------------------------|
| `COPILOT_AZURE_OPENAI_ENDPOINT`             | (empty)                        | Azure OpenAI resource URL                       |
| `COPILOT_AZURE_OPENAI_API_KEY`              | (empty)                        | API key; leave blank to use AAD                 |
| `COPILOT_AZURE_OPENAI_USE_AAD`              | `false`                        | Force AAD auth even if a key is present         |
| `COPILOT_AZURE_OPENAI_API_VERSION`          | `2024-06-01`                   | Azure OpenAI API version                        |
| `COPILOT_AZURE_OPENAI_CHAT_DEPLOYMENT`      | `gpt-4o`                       | Chat model deployment                           |
| `COPILOT_AZURE_OPENAI_EMBED_DEPLOYMENT`     | `text-embedding-3-large`       | Embedding model deployment                      |
| `COPILOT_AZURE_OPENAI_EMBED_DIMENSIONS`     | `3072`                         | Embedding vector length                         |
| `COPILOT_AZURE_SEARCH_ENDPOINT`             | (empty)                        | Azure AI Search endpoint                        |
| `COPILOT_AZURE_SEARCH_API_KEY`              | (empty)                        | Search admin key; leave blank for AAD           |
| `COPILOT_AZURE_SEARCH_USE_AAD`              | `false`                        | Force AAD for Search                            |
| `COPILOT_AZURE_SEARCH_INDEX_NAME`           | `csa-copilot-corpus`           | Target index name                               |
| `COPILOT_TOP_K`                             | `6`                            | Chunks retrieved per question                   |
| `COPILOT_MIN_GROUNDING_SIMILARITY`          | `0.45`                         | Per-chunk threshold for coverage                |
| `COPILOT_MIN_GROUNDED_CHUNKS`               | `1`                            | Min chunks above threshold to avoid refusal     |
| `COPILOT_MAX_CITATION_VERIFICATION_RETRIES` | `1`                            | Regenerations after a citation contract failure |
| `COPILOT_REFUSAL_MESSAGE`                   | (long default)                 | Message returned when refusing                  |
| `COPILOT_CHUNK_SIZE`                        | `600`                          | Chunk size in characters                        |
| `COPILOT_CHUNK_OVERLAP`                     | `80`                           | Chunk overlap in characters                     |
| `COPILOT_MIN_CHUNK_LENGTH`                  | `50`                           | Drop tiny chunks smaller than this              |
| `COPILOT_CORPUS_ROOTS`                      | `docs,docs/adr,...`            | JSON/CSV list of repo-relative roots            |
| `COPILOT_CORPUS_FILE_EXTENSIONS`            | `.md`                          | Extensions considered documentation             |

`CopilotSettings` is a frozen Pydantic v2 model — mutate by
constructing a new instance, not by editing fields.

## Testing

```bash
python -m pytest apps/copilot/tests/ -v
```

Tests run entirely offline. The embedder, retriever, and LLM are all
replaced with in-memory stubs — no Azure credentials, no network calls.

Additional gates:

```bash
ruff check apps/copilot/
mypy apps/copilot/ --ignore-missing-imports
```

## Roadmap (deferred)

These phases are intentionally **not** shipped in this release:

- **Phase 2 — Decision-tree walker.** Given a question like "Should I
  use ADF or Synapse Pipelines?", walk the decision-tree definitions
  under `decision-trees/` and surface the matching path.
- **Phase 3 — Skill catalog.** Declarative descriptions of operational
  skills (e.g. "rotate a secret", "create a new data domain") keyed
  by doc references.
- **Phase 4 — Gated execute broker.** Safely execute skills behind a
  human-approval gate with full audit logging.
- **Phase 5 — Four surfaces.** Web UI, persistent CLI daemon, MCP
  server, and a FastAPI route so other services can call the agent.
- **Phase 6 — LLMOps.** Golden-answer regression suite, response
  evals, prompt-version tracking, and telemetry dashboards.

## Known gaps

- **Orphan cleanup on re-index.** The indexer adds new chunks and
  no-ops on unchanged content, but it does not currently delete
  chunks whose source file was removed or shortened. A follow-up
  pass will scan the index and prune orphans.
- **Hybrid search tuning.** Retrieval currently uses pure vector
  search with default hybrid text query; semantic reranker is not yet
  enabled by the Copilot agent path (the underlying `VectorStore`
  supports it).
- **Multi-turn conversation.** The agent is single-turn — no
  conversation history is persisted. Planned for Phase 5.
- **Streaming.** Answers are returned as complete strings, not
  streamed tokens. The CLI blocks until the full answer is ready.
- **LLMOps.** No automated evaluation; grounding and citation
  contracts are the only quality gates.
