# Fabric Data Agent — Read-Only Grounded Q&A over Microsoft Fabric Lakehouse

> **Status:** Reference pattern. Production-deployable on **Azure Commercial** today; **pre-GA in Azure Government** (use the streaming-spine alternative documented below until Fabric reaches Gov GA).

A minimal, contract-governed, **read-only** AI agent that answers natural-language questions over a registered set of Fabric Lakehouse tables via the Lakehouse SQL endpoint and Azure OpenAI.

## What you get

| Component | Path | Purpose |
|----------|------|---------|
| Agent orchestrator | `agent/agent.py` | Wires retriever + generator + answer formatter |
| Retriever | `agent/retriever.py` | Schema-aware SQL generation, **read-only enforcement** (rejects anything that is not a bare `SELECT`/`WITH`), row cap |
| Generator | `agent/generator.py` | Azure OpenAI grounded answer with mandatory citation back to query results |
| Config | `agent/config.py` | Endpoint + auth + table-allow-list configuration (no secrets in code) |
| Data contract | `contracts/fabric_query_contract.yaml` | Schema + classification + scope guard for the agent's request/response surface |
| IaC | `deploy/bicep/main.bicep` | Fabric capacity + lakehouse + workspace identity + AOAI + Key Vault wiring |
| Sample data | `sample_data/` | Synthetic tables for end-to-end testing without a real Fabric workspace |
| Gov note | `GOV_NOTE.md` | What to do today if you must deploy on Azure Government |
| Tests | `agent/tests/` | Unit tests for retriever, generator, agent orchestration |

## Why this exists

A read-only "ask the lakehouse a question" surface is the most-requested AI pattern across our enterprise customer conversations. The dangerous version of this writes ad-hoc SQL with full credentials. **This version**:

1. Refuses any SQL statement that isn't a bare `SELECT`/`WITH` — enforced before execution
2. Caps result row count to prevent accidental table dumps
3. Requires the LLM to cite the result rows it used (no answer without grounding)
4. Restricts table access to an allow-list defined in `config.py`
5. Emits a contract-governed response (`contracts/fabric_query_contract.yaml`) that can be validated in CI

The **scope guard** logic in `retriever.py` is the part most worth lifting into your own code if you build a similar surface against a different SQL endpoint.

## Quickstart (Azure Commercial, ~30 min)

### Prerequisites

- Azure Commercial subscription with **Fabric capacity SKU available** (F2 minimum for dev)
- Azure OpenAI resource with `gpt-4o-mini` (or newer) deployed
- `az cli` 2.60+, `python` 3.11+, `pytest`

### Deploy infra

```bash
cd examples/fabric-data-agent

# Fill in deploy/params.dev.json with your Fabric workspace name + AOAI endpoint
az deployment sub create \
  --location eastus \
  --template-file deploy/bicep/main.bicep \
  --parameters @deploy/params.dev.json
```

### Load sample data

```bash
# Upload sample_data/*.parquet into the Fabric lakehouse via OneLake CLI or
# the Fabric portal. Tables: customers, orders, products, regions.
```

### Run the agent locally

```bash
# Set env (use Key Vault refs in prod)
export FABRIC_WORKSPACE_ID="<workspace-guid>"
export FABRIC_LAKEHOUSE_NAME="csa_demo"
export AZURE_OPENAI_ENDPOINT="https://<aoai>.openai.azure.com/"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o-mini"

python -m agent.agent \
  --question "What were total sales by region last quarter, and which region had the highest growth vs the prior quarter?"
```

Sample output:

```
Q: What were total sales by region last quarter, and which region had
   the highest growth vs the prior quarter?

SQL  (read-only check passed, row cap = 1000):
  WITH q AS (
    SELECT region_id,
           SUM(order_total) AS sales,
           DATE_TRUNC('quarter', order_date) AS qtr
    FROM csa_demo.orders
    GROUP BY region_id, DATE_TRUNC('quarter', order_date)
  )
  SELECT region_id, qtr, sales,
         LAG(sales) OVER (PARTITION BY region_id ORDER BY qtr) AS prior_sales
  FROM q
  WHERE qtr >= DATE_TRUNC('quarter', CURRENT_DATE) - INTERVAL '6 months'
  ORDER BY region_id, qtr;

A: Last quarter (Q1 2026), total sales were:
   - Northeast: $4.2M  (▲ 18% vs Q4)   ← highest growth
   - South:     $3.8M  (▲  6%)
   - Midwest:   $3.1M  (▲  2%)
   - West:      $5.6M  (▼  4%)

   Source rows: orders.region_id = {1,2,3,4}, qtr in {2025-Q4, 2026-Q1}.
   8 rows scanned. See attached SQL for the full query.
```

### Run the tests

```bash
cd examples/fabric-data-agent
pytest -q
```

## Read-only enforcement — the part worth copying

The retriever rejects any SQL that isn't a bare read. This is the minimum bar for a "let users talk to the warehouse" surface:

```python
# agent/retriever.py (excerpt — see source for full impl)

_ALLOWED_LEADING = ("select", "with")
_FORBIDDEN_TOKENS = (
    "insert", "update", "delete", "merge", "drop", "alter",
    "create", "truncate", "grant", "revoke", "copy", "exec",
    "execute", "call", ";--", "/*", "*/",
)

def _is_read_only(sql: str) -> bool:
    s = sql.strip().lower()
    if not s.startswith(_ALLOWED_LEADING):
        return False
    # No multi-statement (we strip trailing ; but reject any embedded ;)
    s_no_trailing = s.rstrip(";").strip()
    if ";" in s_no_trailing:
        return False
    return not any(tok in s_no_trailing for tok in _FORBIDDEN_TOKENS)
```

This is **defense in depth** — the workspace identity itself should also have read-only RBAC on the lakehouse. Never rely on the in-process check alone in production.

## Data contract

Every request/response is governed by `contracts/fabric_query_contract.yaml`:

- `classification: unrestricted` — for sensitive lakehouses, change to `confidential` and require additional auth claims
- `pii: false` — declares this surface does not return PII; CI validators flag any column that smells like PII
- `schema.primary_key: [request_id]` — every Q&A round-trip is traceable
- `read_only: true` (in the `policy` block) — the agent will not even attempt non-read SQL

The contract is consumed by `csa_platform/governance/contracts/contract_validator.py` in CI.

## Production checklist

Before exposing this to real users:

- [ ] Workspace identity has **read-only** Fabric RBAC (not just the in-process guard)
- [ ] AOAI endpoint behind Private Endpoint, Key Vault references for the key
- [ ] `FABRIC_TABLE_ALLOW_LIST` config narrowed to only the tables the agent should see
- [ ] Row cap (`MAX_RESULT_ROWS`) set conservatively (default 1,000; tune per table)
- [ ] Rate limiter in front (see [ADR 0021](../../adr/0021-two-rate-limiters-not-duplicates.md))
- [ ] Application Insights logging enabled with the `request_id` correlation key
- [ ] Output content filter on the AOAI deployment (Azure AI Content Safety)
- [ ] Eval suite per quarter using `apps/copilot/evals/` framework as a template

## Azure Government note

Fabric is **pre-GA in Azure Gov** (as of writing). Use the **streaming spine alternative** documented in [`GOV_NOTE.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/examples/fabric-data-agent/GOV_NOTE.md):

| Layer | Commercial (this example) | Gov alternative (today) |
|-------|--------------------------|-------------------------|
| Storage | Fabric Lakehouse / OneLake | ADLS Gen2 + Delta |
| SQL endpoint | Lakehouse SQL endpoint | Synapse Serverless SQL or Databricks SQL |
| LLM | Azure OpenAI (Commercial) | Azure OpenAI (Gov, IL4 / IL5) |
| Agent code | unchanged | unchanged (swap `_load_fabric_client` for a DB-API 2.0 connection) |

The agent's read-only guard, generator, and orchestrator are **fully portable** — only the connection layer changes.

## Related docs

- [Tutorial 06 — AI Analytics with Azure AI Foundry](../../tutorials/06-ai-analytics-foundry/README.md)
- [Tutorial 09 — GraphRAG Knowledge Graphs](../../tutorials/09-graphrag-knowledge/README.md)
- [Patterns — LLMOps & Evaluation](../../patterns/llmops-evaluation.md)
- [ADR 0010 — Fabric as Strategic Target](../../adr/0010-fabric-strategic-target.md)
- [ADR 0017 — RAG Service Layer](../../adr/0017-rag-service-layer.md)
- [Use Case — Unified Analytics on Fabric](../../use-cases/fabric-unified-analytics.md)
- [Compliance — FedRAMP Moderate](../../compliance/fedramp-moderate.md)
