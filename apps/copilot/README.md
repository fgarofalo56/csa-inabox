# CSA Copilot (CSA-0008)

Grounded question-answering service for the CSA-in-a-Box platform.

## Status

**Phase 0-1 shipped** (2026-04-20). This delivery covers the corpus
indexer and the grounding-with-citations agent. Phases 2-5 remain
**out of scope** for this release — see the Roadmap section below.

## Architecture

Copilot is built as six phases, only two of which are implemented today.

| Phase | Name                            | Status    |
|-------|---------------------------------|-----------|
| 0     | Corpus Indexer                  | Shipped   |
| 1     | Grounding + Citations           | Shipped   |
| 2     | Tool registry + agent loop      | Shipped (CSA-0100) |
| 3     | Skill catalog                   | Deferred  |
| 4     | Gated execute broker            | Shipped (CSA-0102) |
| 5     | Four surfaces (Web/CLI/MCP/API) | Deferred  |
| 6     | LLMOps / evals                  | Deferred  |

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

## Tool registry (CSA-0100)

The Phase-2 tool catalogue lives in `apps/copilot/tools/`. A `ToolRegistry`
is an append-only, name-keyed catalogue of typed `Tool` objects. Every
tool declares a category (`read` or `execute`), typed Pydantic
`input_model` / `output_model`, and an async `__call__`. Read tools
run freely; execute tools are gated by the confirmation broker.

Shipped read tools:

- `search_corpus` — vector retrieval over the indexed corpus (reuses
  the Phase-1 retriever + embedder).
- `walk_decision_tree` — walks YAML trees under `decision-trees/`.
- `read_repo_file` — bounded read under an allowlisted subset of the
  repo (`docs/adr`, `docs/decisions`, `docs/migrations`, ...).
- `validate_gate_dry_run` — invokes a `dev-loop/gates/validate-*.ps1`
  script in `-WhatIf` mode with `COPILOT_DRY_RUN=1`. Skips cleanly
  when PowerShell is not installed.

Shipped execute tools (broker-gated):

- `run_alembic_upgrade` — runs an injected alembic runner. Tests pass
  a fake runner so no real database is touched.
- `publish_draft_adr` — promotes `docs/adr/drafts/*.md` into
  `docs/adr/`. All path handling is rooted under `repo_root`.

List the catalogue from the CLI:

```bash
python -m apps.copilot.cli tools list
```

Build a registry programmatically:

```python
from apps.copilot.tools import ToolRegistry
from apps.copilot.tools.readonly import ReadRepoFileTool

registry = ToolRegistry()
registry.register(ReadRepoFileTool(repo_root=Path.cwd()))
print([s.name for s in registry.list_tools()])
```

## Confirmation broker (CSA-0102)

Execute-class tools only run after the `ConfirmationBroker` has
issued and verified an opaque signed token. Tokens are:

- **Signed** — HMAC via `itsdangerous.URLSafeSerializer` under a salt.
- **Scoped** — bound to `tool_name`, `scope`, and a SHA-256 hash of
  the canonical JSON input. Replaying the token against a different
  tool or payload fails verification.
- **TTL-bound** — `broker_token_ttl_seconds` (default 600).
- **Single-use** — once `verify` succeeds the token id is consumed.
- **Four-eyes optional** — when `broker_require_four_eyes=true`, the
  approver principal must differ from the caller principal.

Every lifecycle transition (`request`, `approve`, `deny`, `used`,
`rejected`, `expired`) emits a `BrokerAuditEvent` chained via SHA-256.
The chain reuses the CSA-0016 hash primitive so tamper-evidence is
identical to the platform audit logger. The broker writes to
`csa.audit.broker` so SIEM routing stays independent of general
platform audit traffic.

```python
from apps.copilot.broker import (
    ConfirmationBroker, ConfirmationRequest,
)
from apps.copilot.broker.broker import compute_input_hash
from apps.copilot.config import CopilotSettings

settings = CopilotSettings(broker_signing_key="...")  # non-empty
broker = ConfirmationBroker(settings)
req = ConfirmationRequest(
    request_id="req-1",
    tool_name="publish_draft_adr",
    caller_principal="alice@example.com",
    scope="dev",
    input_hash=compute_input_hash({"draft_name": "0042-demo.md"}),
)
await broker.request(req)
token = await broker.approve(req.request_id, "bob@example.com")
# Token is now ready to be handed to the tool.
```

New settings for the broker:

| Variable                              | Default                | Purpose                                          |
|---------------------------------------|------------------------|--------------------------------------------------|
| `COPILOT_BROKER_SIGNING_KEY`          | (empty = broker off)   | HMAC signing key. Empty = no tokens can be minted. |
| `COPILOT_BROKER_TOKEN_TTL_SECONDS`    | `600`                  | Token validity window.                            |
| `COPILOT_BROKER_REQUIRE_FOUR_EYES`    | `false`                | Enforce approver != caller.                       |
| `COPILOT_BROKER_TOKEN_SALT`           | `csa.copilot.broker.v1`| Salt bound to signing key; rotate to invalidate.  |

## Agent loop (`CopilotAgentLoop`)

`apps/copilot/agent_loop.py` ships the CSA-0100 plan/act surface.
The loop takes an injectable `Planner` (whose `plan` coroutine
returns a list of `PlannedStep` instructions), a `ToolRegistry`, and
a `ConfirmationBroker`. Every run returns an `AgentTrace` recording
every step, the tool output, the token id (if any), and the
terminal status. Refusals and failures become trace steps — the
trace is the single source of truth for what happened during the
run.

The CLI `ask --with-tools` flag surfaces the loop but requires a
planner wiring that is deferred to Phase 3; today it returns exit
code `3` with a clear message.

## Roadmap (deferred)

These phases remain out of scope for this release:

- **Phase 3 — Skill catalog.** Declarative descriptions of operational
  skills (e.g. "rotate a secret", "create a new data domain") keyed
  by doc references.
- **Phase 5 — Four surfaces.** Web UI, persistent CLI daemon, MCP
  server, and a FastAPI route so other services can call the agent.
- **Phase 6 — LLMOps.** Golden-answer regression suite, response
  evals, prompt-version tracking, and telemetry dashboards.

## Production hardening (post-Phase-1)

Four gaps flagged during the Phase 0-1 ship review have now been
closed. Every feature is off-by-default friendly — existing call
sites behave unchanged unless they opt in.

### 1. Orphan cleanup on re-index

The indexer now detects chunks that were previously emitted for a
scanned `source_path` but were NOT re-emitted during the current run
(i.e. the source file was shortened or deleted) and deletes them in
batch. The count surfaces on `IndexReport.chunks_deleted`.

Idempotency is preserved: re-running the indexer on an unchanged
corpus produces `chunks_deleted == 0`.

```python
settings = CopilotSettings(orphan_cleanup_enabled=True)  # default
```

Set `COPILOT_ORPHAN_CLEANUP_ENABLED=false` to restore the pre-
hardening behaviour (no deletes).

The cleanup only touches chunks whose `source_path` was visited by
the current run; unrelated entries in the index are never considered.
For vector store implementations that do not support the
`list_ids_by_source_paths` + `delete_documents` protocol (e.g.
stripped-down test fakes), cleanup is skipped with a warning log —
never a crash.

### 2. Streaming responses in `ask`

`CopilotAgent.ask_stream(question)` returns an `AsyncIterator` of
`AnswerChunk` events:

| Event kind | Payload               | Meaning                                         |
|------------|-----------------------|-------------------------------------------------|
| `status`   | `str`                 | lifecycle (`retrieve-start`, `generate-start`, `refused:<reason>`) |
| `token`    | `str`                 | one LLM delta                                   |
| `citation` | `Citation`            | one verified citation                           |
| `done`     | `AnswerResponse`      | terminal event carrying the full DTO            |

Low-coverage refusal fires early: it emits a `status` with
`refused:no_coverage` followed by a `done`, and the LLM is NEVER
invoked. Citation-verification failure refuses after the deltas have
been streamed but still terminates with `done(AnswerResponse(refused=True))`.

CLI:

```bash
# Stream tokens; status lines go to stderr, tokens to stdout.
python -m apps.copilot.cli ask "Why Bicep?" --stream

# JSON-lines over the streaming protocol (one event per line).
python -m apps.copilot.cli ask "Why Bicep?" --stream --json
```

When the underlying LLM backend does not support streaming, the agent
falls back to `generate()` and synthesises a single `token` event so
the contract is preserved.

### 3. Semantic reranker

`CopilotAgent._retrieve` now asks Azure AI Search for semantic
ranking by default (`query_type=semantic`,
`semantic_configuration_name=<COPILOT_SEMANTIC_CONFIG_NAME>`). Raw
reranker scores surface on `Citation.reranker_score` (0-4 range).

Graceful fallback: if the index lacks a semantic configuration and the
first call raises, the agent logs a `copilot.agent.semantic_reranker_fallback`
warning and retries with `use_semantic_reranker=False` so the answer
still ships.

```python
settings = CopilotSettings(
    use_semantic_reranker=True,       # default
    semantic_config_name="default",  # default
)
```

Disable with `COPILOT_USE_SEMANTIC_RERANKER=false` to restore pure
vector + hybrid text retrieval.

### 4. Multi-turn conversation history

```python
agent = CopilotAgent.from_settings(settings)
handle = await agent.start_conversation()
r1 = await agent.ask_in_conversation(handle, "What is Bicep?")
r2 = await agent.ask_in_conversation(handle, "How does it differ from ARM?")
await agent.reset_conversation(handle)
```

- Handles are opaque `ConversationHandle(conversation_id=UUID)`.
- History is bounded by `conversation_max_turns` (default 8) and
  `conversation_max_history_tokens` (default 2000). Oldest turns are
  trimmed silently when exceeded.
- The `ConversationSummarizer` condenses prior turns into a
  `Q:`/`A:` transcript that is prepended to the embedding query and
  hybrid text query on subsequent retrievals. It does NOT call the
  LLM — summaries must never introduce facts that did not come from
  the corpus.
- Storage backends:
  - `COPILOT_CONVERSATION_STORE=memory` (default) —
    `InMemoryConversationStore`.
  - `COPILOT_CONVERSATION_STORE=redis` +
    `COPILOT_CONVERSATION_REDIS_URL=redis://...` —
    `RedisConversationStore` (lazy-imports `redis.asyncio`).

  The Protocol shape mirrors `portal/shared/api/services/session_store.py`
  so production deployments can reuse a single Redis cluster for both
  BFF sessions and Copilot conversations.

CLI (interactive REPL):

```bash
python -m apps.copilot.cli chat
you> What is Bicep?
copilot> Azure's IaC DSL... [1]
you> How does it differ from ARM?
copilot> It's more readable and composable... [2]
you> /reset
[conversation reset]
you> /exit
```

`chat` streams tokens by default. Pass `--no-stream` to block until the
full reply is ready.

### New configuration surface

| Variable                                   | Default                 | Purpose                                          |
|--------------------------------------------|-------------------------|--------------------------------------------------|
| `COPILOT_ORPHAN_CLEANUP_ENABLED`           | `true`                  | Delete stale chunks whose sources were scanned.  |
| `COPILOT_USE_SEMANTIC_RERANKER`            | `true`                  | Request Azure Search semantic ranker.            |
| `COPILOT_SEMANTIC_CONFIG_NAME`             | `default`               | Semantic configuration name on the index.        |
| `COPILOT_CONVERSATION_MAX_TURNS`           | `8`                     | Maximum retained turns per conversation.         |
| `COPILOT_CONVERSATION_MAX_HISTORY_TOKENS`  | `2000`                  | Token budget for the condensed history.          |
| `COPILOT_CONVERSATION_STORE`               | `memory`                | `memory` or `redis`.                             |
| `COPILOT_CONVERSATION_REDIS_URL`           | (empty)                 | Required when `conversation_store=redis`.        |

### Typed errors

- `OrphanCleanupError` — fatal backend failure during orphan cleanup.
- `StreamingNotSupportedError` — reserved; raised when streaming is
  explicitly required but the backend cannot provide it.
- `ConversationNotFoundError` — unknown `ConversationHandle`.
- `ConversationHistoryLimitExceededError` — reserved for opt-in
  `raise_on_trim` integrations.

## Remaining known gaps

- **LLMOps.** No automated evaluation; grounding and citation
  contracts are the only quality gates. Planned for Phase 6.
