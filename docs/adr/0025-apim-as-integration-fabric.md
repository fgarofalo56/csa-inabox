---
status: accepted
date: 2026-05-15
deciders: csa-inabox platform team
consulted: data platform team, AI engineering, integration architects, security
informed: customer-facing field, partner ecosystem, federal mission accounts
---

# ADR 0025 — Azure API Management as the Integration Fabric

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


## Context

Customer architectures evaluating Microsoft as the strategic platform for an API-first, multi-model, zero-move AI ecosystem need a clear answer to two recurring questions:

1. **"What is the seam that connects everything — Azure-native services, AWS, GCP, on-prem mission systems, partner data fabrics, sovereign LLM gateways, M365 / Graph / Dataverse, and external agencies — into one governed, identity-grounded, observable platform?"**
2. **"Why is Microsoft's answer materially better than MuleSoft Anypoint Platform and AWS API Gateway + the surrounding AWS integration stack?"**

This decision documents the position taken across the CSA-in-a-Box reference architecture, whitepaper, comparisons, use cases, best practices, and guides under the "API-First Data Strategy" pillar.

The candidates considered:

| Candidate | Pros | Cons |
|---|---|---|
| **Azure API Management** | One product covers REST / GraphQL / WebSocket / gRPC / SOAP; native Entra integration; native LLM policies; built-in developer portal; FedRAMP High; self-hosted gateway for hybrid; OpenAPI-native; Premium v2 with AZ-resilience; included observability | Developer portal UX lags Anypoint Exchange in very large estates; transformation DSL less expressive than DataWeave for the rare complex case |
| **MuleSoft Anypoint Platform** | Anypoint Exchange is best-in-class for asset discovery; DataWeave is expressive; CloudHub is fully managed | Per-core licensing typically 4–8x Azure cost; premium connectors individually licensed; no native LLM gateway features; no native M365 / Graph / Dataverse / Copilot Studio integration; no native MCP support |
| **AWS API Gateway + adjacents** | Mature; deep AWS integration; pay-per-call shape | No native LLM gateway features; Lambda authorizer tax; no built-in developer portal; multi-cloud backends are second-class; no productivity-surface reach (M365 / Copilot has no AWS analogue) |
| **Build-your-own gateway (Kong / Envoy / NGINX)** | Open-source; flexible | All of the above policies and observability are now engineering work; identity, governance, lifecycle become per-team responsibility; no enterprise SLA |

## Decision

**Azure API Management is the integration fabric** for the API-First Data Strategy pillar.

Specifically:

1. Every customer-facing API in the reference architecture flows through APIM. Internal APIs default to APIM as well, with intentional exceptions only where latency budgets make it impossible.
2. APIM is the **single seam** between consumers (apps, agents, partners, M365 surfaces) and backends (Azure-native data, AWS data, GCP data, on-prem, SaaS, sovereign LLM gateways, partner data fabrics).
3. APIM hosts the LLM policy set (`llm-token-limit`, `llm-semantic-cache-*`, `llm-content-safety`, `llm-emit-token-metric`, multi-region backend pools with circuit breakers) for every AI workload.
4. APIM is the recommended pattern for fronting Model Context Protocol (MCP) servers, with one APIM-fronted endpoint per MCP domain.
5. APIM Self-Hosted Gateway is the recommended pattern for edge / sovereign / partner-cloud / on-prem reach where the data plane must stay inside a boundary.
6. APIM is registered as a Purview catalog source so APIs participate in the unified governance plane alongside data and AI artifacts.

## Consequences

### What this enables

- **One identity model** end-to-end. Entra-issued tokens validated at one gateway. Conditional Access, PIM, and CAE apply universally.
- **One observability surface.** App Insights + Log Analytics + KQL for every API, every consumer, every backend.
- **One cost model.** Per-subscription token budgets and chargeback dimensions emitted at the gateway, regardless of backend.
- **One governance plane.** Purview catalogs APIs alongside data and AI artifacts. Sensitivity labels propagate through the chain.
- **Multi-cloud reach by default.** APIM treats any HTTPS backend as a first-class citizen. OneLake shortcuts + APIM façades cover cross-cloud data access without movement.
- **Strangler-fig migration paths.** Existing MuleSoft and AWS API Gateway deployments can co-exist for the life of current contracts; new APIs route through APIM; old APIs retire on a customer-controlled timeline.
- **First-class LLM workload support.** Token budgets, semantic caching, content safety, model routing, and chargeback telemetry are native APIM policies, not engineering work.

### What this constrains

- **Developer portal UX delta with Anypoint Exchange.** For estates with thousands of APIs and asset-discovery requirements, customers may need to ship a Backstage instance in front of APIM + Purview catalogs. This is documented and the cost delta funds the engineering work.
- **DataWeave-class transformation requires a multi-product story on Azure.** APIM policies cover simple-to-moderate transformations; Logic Apps integration accounts cover B2B / EDI; dbt covers tabular; Functions cover code-first. The architectural discipline of picking the right tool per shape is required.
- **APIM Premium v2 cost floor.** Premium v2 is capacity-priced; a minimal production deployment is several thousand dollars per month. Consumption tier is the right choice for dev/test and ephemeral environments. The Premium v2 floor is justified for production by the policy capabilities and reliability profile.
- **CloudHub-style "fully managed" is partially recreated.** APIM is managed at the control plane; self-hosted gateway is customer-managed at the data plane. Logic Apps Standard, Functions Premium, and Container Apps are managed compute options. The aggregate is managed in spirit; the deployment-model choice is customer-controlled.

### What this displaces

| Displaced product | When | How |
|---|---|---|
| MuleSoft API Manager | New AI workloads first; broader migration over 12–24 months | Strangler-fig per the [MuleSoft displacement playbook](../comparison/azure-vs-mulesoft.md) |
| AWS API Gateway (for new workloads, especially AI) | New AI workloads on Azure; existing AWS workloads retained where appropriate | Co-existence pattern; AWS data accessed via OneLake shortcuts and APIM façades — no data movement required |
| Anypoint MQ (for messaging) | New eventing / streaming workloads | Event Hubs (high-throughput streaming) + Service Bus (transactional queues) + Event Grid (event routing) — three products covering the three distinct workloads |
| Anypoint Composer (for business automation) | New workflow automation | Power Automate + Copilot Studio + Power Apps |
| AWS Cognito (for identity, in workloads touching M365 / Entra) | Whenever Entra-grounded identity is needed | Federation or replacement |
| Anypoint Monitoring (for observability) | All Azure-hosted workloads | App Insights + Log Analytics included |
| Lambda authorizers (for auth) | New AWS-fronted workloads moving to APIM | In-process APIM policies replace Lambda authorizers |

### Operational obligations

The decision creates ongoing operational obligations the platform team owns:

1. **APIM Premium v2 health.** Capacity, autoscale, AZ posture, multi-region failover.
2. **Policy library curation.** Versioning, linting, change review for policy fragments shipped across APIs.
3. **Developer portal maintenance.** Branding, OpenAPI freshness, subscription self-service flow.
4. **Self-hosted gateway lifecycle.** Container updates, configuration sync, edge-deployment automation.
5. **Purview catalog hygiene.** API registrations, lineage updates, classification reviews.
6. **CI/CD discipline.** Bicep / ARM as source of truth for APIM configuration; portal-authored revisions captured back to repo.
7. **Cost dashboards.** Per-subscription chargeback flowing to FinOps.
8. **Operational playbook.** Rate-limit incidents, backend ejections, auth failures, token-budget exhaustion.

These obligations are documented in the [APIM Universal Gateway guide](../guides/apim-universal-gateway.md) and the [APIM + MCP guide](../guides/apim-mcp-layered-orchestration.md).

## Alternatives rejected

- **MuleSoft Anypoint as primary.** Rejected on cost, lack of native LLM gateway features, and weak M365 / Copilot / GitHub integration. MuleSoft Anypoint Exchange's UX edge does not offset the structural gaps.
- **AWS API Gateway as primary (for Azure-anchored customers).** Rejected on the AI-gateway gap, the Lambda authorizer tax, the absence of native developer portal, and the cross-cloud back-end second-classness.
- **Build-your-own on Kong / Envoy / NGINX.** Rejected. Building APIM-equivalent functionality (auth, rate limit, semantic cache, content safety, token budget, chargeback, developer portal, lifecycle) is a multi-quarter engineering effort with no enterprise SLA at the end.
- **No gateway — direct backend access with Entra.** Rejected. Cross-cutting concerns multiply per backend; observability fragments; rate-limit / cost governance becomes per-team responsibility; agent workloads have no central enforcement point.

## Related material

- [Whitepaper — API-first data strategy on Azure](../research/api-first-data-strategy-whitepaper.md)
- [Comparison — Azure vs MuleSoft Anypoint Platform](../comparison/azure-vs-mulesoft.md)
- [Comparison — Azure vs AWS API stack](../comparison/azure-vs-aws-api-stack.md)
- [Reference architecture — API-first multi-model ecosystem](../reference-architecture/api-first-multi-model-ecosystem.md)
- [Guide — APIM as the universal API gateway](../guides/apim-universal-gateway.md)
- [Guide — APIM + MCP layered orchestration](../guides/apim-mcp-layered-orchestration.md)
- [Guide — Zero-trust API governance for federal mission environments](../guides/zero-trust-api-governance-federal.md)
- [Best practice — API-first data strategy](../best-practices/api-first-data-strategy.md)
- [Best practice — Multi-model AI orchestration](../best-practices/multi-model-ai-orchestration.md)
- [Solution Store — Azure API-first accelerators](../solution-store/index.md)
