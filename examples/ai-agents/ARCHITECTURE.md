# Architecture — AI Agents on Azure

> **Status:** Three production-shaped agent patterns. Single agent and multi-agent run anywhere Python runs (laptop, Container Apps, AKS). Hosted agent deploys to Azure AI Foundry Agent Service.

## High-level

```mermaid
flowchart TB
    subgraph Identity[Identity]
        MI[Managed Identity<br/>or DefaultAzureCredential]
    end

    subgraph Compute[Compute Surface]
        Local[Local script<br/>data-analyst-agent<br/>multi-agent-governance]
        ACA[Azure Container Apps<br/>hosted-agent]
        Foundry[Azure AI Foundry<br/>Agent Service<br/>hosted-agent option B]
    end

    subgraph AzureAI[Azure AI Services]
        AOAI[Azure OpenAI<br/>gpt-4o-mini / gpt-4o / o1]
        Search[AI Search<br/>vector + keyword]
        ContentSafety[Content Safety<br/>input + output filters]
    end

    subgraph Data[Data Plane]
        Purview[Purview catalog]
        ADLS[ADLS Gen2<br/>gold tables]
        Synapse[Synapse SQL<br/>or Fabric SQL endpoint]
    end

    subgraph Observability[Observability]
        AppInsights[Application Insights<br/>distributed traces]
        LA[Log Analytics<br/>structured logs]
    end

    subgraph Secrets[Secrets]
        KV[Key Vault]
    end

    User[User] --> Local
    User --> ACA
    User --> Foundry

    Local --> MI
    ACA --> MI
    Foundry --> MI

    MI -. token .-> AOAI
    MI -. token .-> Search
    MI -. token .-> Purview
    MI -. token .-> ADLS
    MI -. secret ref .-> KV

    Local -- prompt --> ContentSafety
    ContentSafety -- approved --> AOAI
    AOAI -- response --> ContentSafety
    ContentSafety -- approved --> Local

    Local -- search --> Search
    Local -- catalog query --> Purview
    Local -- gold query --> Synapse
    Synapse --> ADLS

    Local -. spans + logs .-> AppInsights
    ACA -. spans + logs .-> AppInsights
    Foundry -. spans + logs .-> AppInsights
    AppInsights --> LA
```

## Pattern 1 — Single agent (`data-analyst-agent/`)

```mermaid
sequenceDiagram
    participant U as User
    participant A as ChatCompletionAgent
    participant DQ as DataQueryPlugin
    participant QP as QualityPlugin
    participant AOAI as AzureOpenAI

    U->>A: "Find revenue tables for Q1 2026"
    A->>AOAI: chat completion + tools
    AOAI-->>A: tool_call: search_catalog("revenue", "Q1 2026")
    A->>DQ: search_catalog(...)
    DQ-->>A: 3 matching products
    A->>AOAI: tool result + continue
    AOAI-->>A: tool_call: assess_quality("gold.finance.revenue_q1")
    A->>QP: assess_quality(...)
    QP-->>A: passes 47/47 expectations
    A->>AOAI: tool result + continue
    AOAI-->>A: final answer with citations
    A-->>U: "Found gold.finance.revenue_q1 (v2.3, quality OK)..."
```

**Topology**: 1 agent + 2 plugins, all in one process. 5 round-trips to AOAI (1 entry + 2 tool calls + 2 follow-ups) for a typical question.

## Pattern 2 — Multi-agent governance (`multi-agent-governance/`)

```mermaid
sequenceDiagram
    participant U as User
    participant Mgr as RoundRobinManager
    participant DA as DataAnalyst
    participant QR as QualityReviewer
    participant GO as GovernanceOfficer
    participant AOAI as AzureOpenAI

    U->>Mgr: Review gold.finance.revenue_summary
    loop max 6 turns
        Mgr->>DA: investigate
        DA->>AOAI: chat (with tools)
        AOAI-->>DA: schema + lineage report
        DA-->>Mgr: report
        Mgr->>QR: quality check
        QR->>AOAI: chat (with tools)
        AOAI-->>QR: GE results
        QR-->>Mgr: report
        Mgr->>GO: render verdict
        GO->>AOAI: chat
        AOAI-->>GO: APPROVED / REJECTED + reasons
        GO-->>Mgr: verdict
    end
    Mgr-->>U: full transcript + final verdict
```

**Topology**: 3 agents collaborating via in-process orchestrator. Each agent has its own tool surface; manager drives turn-taking. 12-20 AOAI calls per review.

## Pattern 3 — Hosted agent (`hosted-agent/`)

Two deployment options:

### Option A — Container Apps + Workload Identity

```mermaid
flowchart LR
    subgraph User
        Caller[API caller<br/>BFF / Teams bot / cron]
    end

    subgraph ACA[Azure Container Apps env]
        App[hosted-agent container<br/>FastAPI :8000<br/>workload identity]
    end

    subgraph Az[Azure]
        AOAI[Azure OpenAI]
        AppI[Application Insights]
        KV[Key Vault]
    end

    Caller -- POST /agent/invoke --> App
    App -. MI token .-> AOAI
    App -. KV ref .-> KV
    App -. spans .-> AppI
    App -- response --> Caller
```

### Option B — Foundry Agent Service

```mermaid
flowchart LR
    Caller[API caller] --> Foundry[Azure AI Foundry<br/>Agent Service]
    Foundry --> Container[hosted-agent container<br/>from ACR]
    Container -. uses .-> AOAI[Azure OpenAI<br/>via Foundry connection]
    Foundry -. built-in .-> Eval[Eval suite]
    Foundry -. built-in .-> CS[Content Safety]
    Foundry -. built-in .-> Tracing[Tracing → AppInsights]
```

Foundry Agent Service adds eval + content safety + tracing without extra code, at the cost of region/Gov availability (check current GA status).

## Identity & secrets flow

| Resource | Auth |
|----------|------|
| Azure OpenAI | Managed identity → `Cognitive Services OpenAI User` role on the AOAI resource |
| AI Search | Managed identity → `Search Index Data Reader` |
| Purview | Managed identity → `Purview Reader` (or finer-grained collection role) |
| ADLS / Synapse | Managed identity → `Storage Blob Data Reader` + Synapse workspace role |
| Key Vault | Managed identity → `Key Vault Secrets User` (only for genuine secrets — no cleartext keys for AOAI when MI works) |

No API keys are stored in container env vars when the platform supports MI (it always does for Azure-native services in this stack).

## Observability contract

Every agent invocation emits:

| Telemetry | Sink | Required attributes |
|-----------|------|---------------------|
| Trace span `agent.invoke` | App Insights | `agent.name`, `agent.pattern`, `request_id`, `user_id_hash`, `tokens_in`, `tokens_out`, `tools_called` (array), `cost_usd_estimate` |
| Trace span `agent.tool_call` (per tool) | App Insights | `tool.name`, `tool.duration_ms`, `tool.success` |
| Log event `agent.refusal` (when AOAI refuses) | Log Analytics | `request_id`, `reason`, `severity` |
| Log event `agent.eval_failure` (CI eval suite) | Log Analytics | `eval_id`, `expected`, `actual`, `score` |

Dashboards live in `deploy/observability/` (planned alongside future PRs).

## Cost model (USD, ballpark)

| Component | Pricing | Typical agent (per 1K invocations) |
|-----------|---------|-----------------------------------|
| AOAI gpt-4o-mini input | $0.15 / 1M tokens | ~5K tokens × 1K = 5M = $0.75 |
| AOAI gpt-4o-mini output | $0.60 / 1M tokens | ~1K tokens × 1K = 1M = $0.60 |
| Container Apps consumption | per vCPU-sec + req | ~$0.10–0.50 |
| App Insights ingestion | $2.30 / GB | depends on log volume |
| **Total** | | **~$1.50 / 1K invocations** for the single-agent pattern |

Multi-agent governance is ~5× more expensive (more turns, larger context). Hosted agent on Foundry Agent Service adds platform fee per inference.

## Security boundaries

```mermaid
flowchart TB
    subgraph Trust[Trust boundary]
        AzureBound[Azure tenant<br/>private endpoints<br/>NSG egress to AOAI only]
    end

    Internet[Internet caller]
    Internet -- TLS 1.2+ --> APIM[APIM gateway<br/>JWT validation<br/>rate limit]
    APIM -- mTLS or VNet --> Trust
    Trust -- managed identity --> AOAI[AOAI<br/>private endpoint]
```

The agent containers themselves are **not internet-exposed**. APIM (or Front Door) terminates TLS, validates JWT from Entra, applies rate limits, then forwards to the agent VNet over private connectivity.

## Production hardening checklist

See [README — Production hardening](README.md#production-hardening-checklist).

## Related

- [README](README.md) — usage and pattern selection
- [`deploy/bicep/main.bicep`](deploy/bicep/main.bicep) — IaC
- [`contracts/`](contracts/) — agent input/output data contracts
- [`tests/eval/`](tests/eval/) — eval seeds for CI
- [Patterns — LLMOps & Evaluation](../../docs/patterns/llmops-evaluation.md)
- [Reference Architecture — Identity & Secrets](../../docs/reference-architecture/identity-secrets-flow.md)
- [ADR 0007 — Azure OpenAI over self-hosted LLM](../../docs/adr/0007-azure-openai-over-self-hosted-llm.md)
- [ADR 0017 — RAG service layer](../../docs/adr/0017-rag-service-layer.md)
