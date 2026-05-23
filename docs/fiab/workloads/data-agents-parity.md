# Data Agents parity

## What Fabric does

Data Agents (renamed from "AI Skills" in 2026) are NL-to-query agents
over Fabric items. GA at FabCon March 2026. Built on Azure OpenAI
Assistant APIs. Multi-tool NL→query over up to 5 sources per agent:

- NL2SQL for Lakehouse / Warehouse / SQL DB / Mirrored DB
- NL2DAX for Power BI semantic models
- NL2KQL for KQL DBs / Eventhouse (incl. UDFs)
- Microsoft Graph queries
- Custom AI Search index for unstructured grounding (Ignite 2025)

Read-only by design. Identity-passthrough: agent invocations execute
under the calling user's Entra identity, so RLS / CLS / object-level
security applies naturally.

Per-agent configuration: instructions, example queries (Q→SQL/DAX/KQL
pairs — heavily weighted by the LLM for shape-matching), verified
answers, field descriptions, sensitivity policy. Surfaceable as tools
in Foundry Agent Service agents.

## CSA Loom parity design — extends `apps/copilot/` + `azure-functions/copilot-chat/`

Per `temp/fiab-research/07-existing-repo-scope.md`, the csa-inabox
Copilot scaffold is **~70% there**. Reuse:
- PydanticAI agent (Loom Data Agents runtime)
- Azure Functions backend (security: rate limit, PII redaction,
  content safety, telemetry — all keep)
- AI Search vector index becomes per-agent grounding store

### New tools added

```python
class LoomDataAgent:
    @tool
    async def nl2sql(self, question: str, data_source_id: str, user_token: str) -> QueryResult:
        """Generate and execute SQL against a registered lakehouse / warehouse."""
        # Load schema from UC (Commercial) or Purview (Gov)
        # Load few-shot example Q/SQL pairs from Cosmos DB
        # Call AOAI with system prompt + grounding
        # Execute under user_token (OBO) against Databricks SQL Warehouse
        # or Synapse Serverless
        # Return rows + generated SQL as citation

    @tool
    async def nl2dax(self, question: str, semantic_model_id: str, user_token: str) -> QueryResult:
        """Generate and execute DAX against a Power BI semantic model via XMLA."""

    @tool
    async def nl2kql(self, question: str, adx_cluster: str, database: str, user_token: str) -> QueryResult:
        """Generate and execute KQL against an ADX database."""

    @tool
    async def graph_search(self, query: str, user_token: str) -> List[Entity]:
        """Microsoft Graph search (people, files, mails) — OBO."""

    @tool
    async def custom_search(self, query: str, search_index: str, user_token: str) -> List[Doc]:
        """Search a custom Azure AI Search index (PDFs, docs, etc.)."""
```

### Per-agent configuration (Cosmos DB schema)

Per PRP-09:

```json
{
  "id": "agent-finance-analyst",
  "workspaceId": "ws-001",
  "name": "Finance Analyst Agent",
  "description": "Answers questions about sales, expenses, and AR/AP",
  "instructions": "You are an expert at answering finance questions...",
  "dataSources": [
    {"type": "lakehouse", "id": "finance-lakehouse", "instructions": "..."},
    {"type": "semantic-model", "id": "finance-semantic-model", "instructions": "..."},
    {"type": "adx", "cluster": "adx-loom-eastus2", "database": "finance-events"}
  ],
  "exampleQueries": [
    {"question": "What were sales last quarter by region?", "language": "DAX", "query": "..."}
  ],
  "verifiedAnswers": [],
  "fieldDescriptions": {},
  "sensitivityPolicy": "Block agent on tables tagged 'PII-restricted'"
}
```

### Identity passthrough (OBO)

Per [ADR fiab-0009](../adr/0009-copilot-orchestration.md) and
[AMENDMENTS A15](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md): every tool
call carries the caller's Entra token. RLS / CLS / object-level
security apply naturally because the underlying engine (Databricks
SQL, Synapse Serverless, ADX, Power BI XMLA) honors caller identity.

### Foundry integration (Commercial only)

Published Loom Data Agents are surfaceable as **tools in Foundry
Agent Service agents** via the standard MCP-compatible endpoint
registration. One Foundry agent attaches one Loom Data Agent
(mirroring Fabric's current limitation). In Gov where Foundry isn't
GA, agents are callable via REST.

## Per-boundary behavior

| Boundary | NL2SQL | NL2DAX | NL2KQL | Foundry integration |
|---|---|---|---|---|
| Commercial | ✅ Databricks SQL Warehouse | ✅ Power BI XMLA | ✅ ADX | ✅ Foundry Agent Service |
| GCC | ✅ Databricks SQL Warehouse | ✅ Power BI XMLA | ✅ ADX | ✅ Foundry Agent Service |
| GCC-High / IL4 | ✅ Synapse Serverless | ✅ Power BI XMLA | ✅ ADX | ❌ MAF + AOAI direct only |
| IL5 (v1.1) | ✅ Synapse Serverless | ✅ Power BI XMLA | ✅ ADX | ❌ MAF + AOAI direct only |

## Honest gaps

- **NL2DAX maturity** — production NL2DAX is materially less mature
  than NL2SQL. Loom Data Agents ships NL2DAX but flags accuracy
  expectations in the agent's system prompt; v1.1 hardens with more
  training examples
- **"Prep for AI" semantic-model annotations** — Loom's equivalent
  (Cosmos DB store edited via Console) is functional but Fabric's UX
  is more polished; v1.1 invests
- **Foundry integration in Gov** — unavailable until Foundry Agent
  Service Gov-GAs

## Forward migration

Agent definitions export to JSON + Foundry Agent JSON formats; import
into Fabric Data Agents via the public REST API (preview at time of
writing). Example queries port 1:1.

## Related

- ADR: [fiab-0009 Copilot orchestration](../adr/0009-copilot-orchestration.md)
- Build PRP: PRP-09 (extends `apps/copilot/`)
- Tutorial: [Tutorial 05 — Data Agent over Lakehouse](../tutorials/05-data-agent.md)
- Console: [Loom Data Agents pane](../console/index.md)
- Memory: [[copilot-chat-two-backends]]
