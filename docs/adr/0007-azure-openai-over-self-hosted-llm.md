---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0007 — Azure OpenAI over self-hosted LLM for AI integration

## Context and Problem Statement

The platform exposes AI-integration patterns (RAG over catalog metadata,
text-to-SQL, enrichment pipelines) through the `csa_platform.ai_integration`
module. Federal customers need a model endpoint that is FedRAMP-authorized,
data-residency-correct, and integrable with the platform's Entra ID +
Private Endpoint pattern. We must pick a default model serving path before
the AI module stabilizes.

## Decision Drivers

- **FedRAMP High authorization** of the inference endpoint in Azure
  Government.
- **Data residency and contractual non-training guarantees** — customer
  data in prompts must not be used to train upstream models.
- **Private Endpoint support** for network isolation — no public egress
  to an inference API.
- **Capability frontier** — access to current-generation models (GPT-4o /
  4.1 class and embeddings) without customer-owned GPU capacity planning.
- **Composability** — the model choice should not lock application code to
  a single SDK; prefer OpenAI-compatible interfaces.

## Considered Options

1. **Azure OpenAI Service (chosen)** — Managed, FedRAMP High in Azure Gov,
   Private Endpoints, OpenAI SDK-compatible, content filtering built in.
2. **Self-hosted open-weights model on Azure ML / AKS** (Llama 3,
   Mistral, Phi-3) — Full control, no per-token cost, but customer-owned
   GPU fleet and weights lifecycle.
3. **Anthropic / Google / third-party LLM APIs via Azure AI Studio** —
   Model diversity, but mixed Gov availability and separate authorizations.
4. **On-device / CPU-only small models** (Phi-3 mini, DistilBERT-class) —
   Zero infra cost, but quality floor is too low for production RAG.

## Decision Outcome

Chosen: **Option 1 — Azure OpenAI Service** as the default model endpoint,
accessed through an OpenAI-compatible client so application code can be
re-pointed at a self-hosted endpoint (Option 2) if a tenant requires it.

## Consequences

- Positive: FedRAMP High + DoD IL4/IL5 authorization path in Azure Gov.
- Positive: Private Endpoint support removes public-internet egress from
  the threat model.
- Positive: Entra ID authentication with managed-identity support — no
  long-lived API keys.
- Positive: Content filtering and jailbreak detection are built into the
  service — one less thing to implement.
- Positive: OpenAI SDK-compatible surface keeps application code portable.
- Negative: Per-token cost; token budgets are a live FinOps concern
  (tracked in `docs/COST_MANAGEMENT.md`).
- Negative: Model versions are Microsoft-controlled — deprecation windows
  are short and require active version management.
- Negative: Quota + capacity commitments (PTUs) are a procurement process
  for bursty workloads.
- Neutral: Self-hosted open-weights models remain a supported alternate
  via Azure ML, behind the same SDK shape.

## Pros and Cons of the Options

### Option 1 — Azure OpenAI Service

- Pros: FedRAMP High; Private Endpoints; Entra ID auth; content filtering;
  frontier-class models; OpenAI SDK-compatible.
- Cons: Per-token cost; model deprecation churn; quota management.

### Option 2 — Self-hosted open-weights on Azure ML / AKS

- Pros: No per-token cost at scale; full control over model version and
  weights; model fine-tuning is fully in-tenant.
- Cons: Customer-owned GPU fleet; patching, autoscaling, and observability
  are customer responsibilities; capability gap vs. frontier models.

### Option 3 — Third-party LLM APIs (Anthropic, Google)

- Pros: Model diversity; strong capabilities; some have competitive
  non-training guarantees.
- Cons: Separate FedRAMP authorizations; different auth models; additional
  vendor procurement.

### Option 4 — On-device small models

- Pros: Zero infra cost; offline-capable; trivial data residency.
- Cons: Quality floor too low for production RAG and text-to-SQL on
  non-trivial schemas.

## Validation

We will know this decision is right if:

- RAG + text-to-SQL use cases meet accuracy targets using Azure OpenAI
  models without needing a self-hosted fallback.
- Per-tenant monthly inference cost stays within the FinOps envelope set
  in `docs/COST_MANAGEMENT.md`.
- If token cost or model deprecation churn exceeds acceptable thresholds,
  activate the self-hosted fallback path (Option 2) for bulk workloads.

## References

- Decision tree:
  [RAG vs. Fine-tune vs. Agents](../decisions/rag-vs-finetune-vs-agents.md)
- Related code: `csa_platform/ai_integration/`,
  `csa_platform/ai_integration/rag/`,
  `csa_platform/ai_integration/model_serving/`,
  `csa_platform/ai_integration/enrichment/`
- Framework controls: NIST 800-53 **AC-4** (information flow enforcement
  via Private Endpoints), **SC-7** (boundary protection), **SC-8**
  (TLS in transit), **SI-4** (content filtering / monitoring), **AU-2**
  (audit of prompt + completion metadata — not content). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
