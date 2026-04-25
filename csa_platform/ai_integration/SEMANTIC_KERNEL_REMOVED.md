# Semantic Kernel integration -- removed

The `csa_platform.ai_integration.semantic_kernel` subpackage was removed
on 2026-04-24 because it had been broken since the initial CSA Platform
Expansion commit (`948791e`, PR #83) and had **zero working imports**
on a standard install:

- `memory/ai_search_memory.py` imported `MemoryStore` from
  `semantic_kernel.memory` -- removed in SK >= 1.0.
- `orchestration/multi_agent.py` imported `GroupChat` from
  `semantic_kernel.agents` -- removed in SK >= 1.0.
- `plugins/{purview,kusto}.py` hard-imported `azure.kusto.data` and
  `azure.purview.catalog`, neither of which is in any extras_require
  group of this repo.

Net effect: `from csa_platform.ai_integration import semantic_kernel`
raised `ImportError` 100% of the time. The Feature Status Matrix in
the root README.md correctly labelled the subpackage as `Stub`.

## What replaced it

Nothing yet. AI orchestration in the platform now flows through:

- `csa_platform.ai_integration.rag` -- production RAG service
  (Azure OpenAI + AI Search) with full tests
- `csa_platform.ai_integration.graphrag` -- GraphRAG over Cosmos DB
  Gremlin (`Stub`, but tests cover the loader + graph store)
- `portal/shared/api/routers/ai.py` -- AI router with provider routing
  (Foundry / OpenAI / demo-stub fallback)

## Recovering the original code

If you want to resurrect the SK integration, check out the file tree
from the last commit that contained it:

```
git show 2aa39b2:csa_platform/ai_integration/semantic_kernel/__init__.py
git checkout 2aa39b2 -- csa_platform/ai_integration/semantic_kernel/
```

Then plan to:

1. Pin `semantic-kernel>=1.0,<2.0` in `pyproject.toml` extras.
2. Rewrite the memory module against `semantic_kernel.connectors.memory`.
3. Replace `GroupChat` with the current `AgentGroupChat` API.
4. Move `azure-kusto-data` and `azure-purview-catalog` into a new
   optional extra (e.g., `[ai-plugins]`) and gate the plugin imports
   on it.
5. Add tests under `csa_platform/ai_integration/semantic_kernel/tests/`
   that actually import the modules. Use `importlib.util.find_spec`
   to skip cleanly when the extras aren't installed.

## Why a tombstone instead of moving to `_legacy/`?

Two reasons:

- The code did not work, so there is nothing to "preserve" in a
  runnable form. Resurrection requires a rewrite either way.
- Keeping a non-functional subpackage in the main package tree
  advertises a feature that does not exist, which is the same kind of
  honesty issue the Feature Status Matrix was added to fix.
