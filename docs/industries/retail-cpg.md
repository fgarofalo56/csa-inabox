# Industry — Retail & CPG

> **Scope:** Brick-and-mortar retail, e-commerce, omnichannel, consumer packaged goods. Customer experience as competitive advantage, demand volatility, supply-chain complexity, payment data sensitivity.

## Top scenarios

| Scenario                      | Pattern                                                         | Latency    | Reference                                                                                                            |
| ----------------------------- | --------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| **Customer 360**              | Multi-source identity resolution + medallion gold + reverse-ETL | minutes    | [Reference Arch — Data Flow](../reference-architecture/data-flow-medallion.md)                                       |
| **Real-time recommendation**  | Feature store + online inference + click feedback loop          | sub-100ms  | [Example — ML Lifecycle](../examples/ml-lifecycle.md) (adapt)                                                        |
| **Demand forecasting**        | Sales + weather + promotions + ML                               | daily      | [Example — ML Lifecycle](../examples/ml-lifecycle.md)                                                                |
| **Inventory optimization**    | Real-time stock + demand forecast + replenishment               | hours      | [Tutorial 11 — Data API Builder](../tutorials/11-data-api-builder/README.md) for serving                             |
| **Pricing optimization**      | Competitive scrape + elasticity model + scenario eval           | daily      | [Use Case — Anomaly Detection](../use-cases/realtime-intelligence-anomaly-detection.md) (similar streaming patterns) |
| **Fraud / chargeback**        | Transaction streaming + ML scoring                              | sub-second | [Industries — Financial Services](financial-services.md)                                                             |
| **Conversational commerce**   | RAG + product catalog + checkout integration                    | seconds    | [Tutorial 08 — RAG](../tutorials/08-rag-vector-search/README.md), [Example — AI Agents](../examples/ai-agents.md)    |
| **Marketing attribution**     | Touchpoint ingest + multi-touch model                           | daily      | [Tutorial 02 — Data Governance](../tutorials/02-data-governance/README.md)                                           |
| **Loyalty / personalization** | CDP + ML segments + activation channels                         | minutes    | [Tutorial 11 — Data API Builder](../tutorials/11-data-api-builder/README.md)                                         |

## Regulatory landscape

| Framework                                         | Where in CSA-in-a-Box                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **PCI-DSS v4.0** (any payment data)               | [Compliance — PCI-DSS](../compliance/pci-dss-v4.md) — strongly recommend tokenization at the edge |
| **GDPR** (EU customers)                           | [Compliance — GDPR](../compliance/gdpr-privacy.md)                                                |
| **CCPA / CPRA** (California)                      | Same patterns as GDPR; "do not sell" preference + DSR handling                                    |
| **SOC 2 Type II**                                 | [Compliance — SOC 2](../compliance/soc2-type2.md) — table stakes for B2B SaaS commerce            |
| **State privacy laws** (VA, CO, CT, UT, TX, etc.) | Mostly track GDPR principles; one consent management platform usually serves all                  |
| **COPPA** (under-13 users)                        | If applicable, age-gate at signup; segregate child accounts                                       |

## Reference architecture variations

- **CDP layer**: customer 360 in gold + segment exports to activation channels (Marketo, Braze, Salesforce, Meta Ads). [Tutorial 11 — Data API Builder](../tutorials/11-data-api-builder/README.md) provides the REST/GraphQL surface.
- **Edge POS integration**: tokenize payment at the POS device; analytics receives only token + last-4 + transaction context. Keeps PCI scope at the edge.
- **Conversational commerce**: AOAI + product catalog as RAG corpus. Add **Azure AI Content Safety** before sending model output to customers — never let an LLM make a price commitment without a guard.
- **Headless commerce**: gold tables expose product / inventory / pricing via DAB → consumed by storefronts (Next.js, mobile apps) via GraphQL.

## Why the standard CSA-in-a-Box pattern works for retail

- Medallion + Purview = **catalog of customer attributes** with classification (PII / sensitive)
- dbt = **reproducible CDP** (no more "the customer count differs between Marketing and Finance")
- AOAI + AI Search + Content Safety = **safe customer-facing GenAI**
- Data API Builder = **headless commerce data layer** without bespoke API code
- Power Apps + Power BI = **store-manager and merchandiser apps** without app-dev cycles

## What's specific to retail / CPG

- **Identity resolution is the hardest data problem.** Customers have multiple emails, devices, household memberships, loyalty accounts, in-store interactions. Build identity resolution as a **first-class silver-layer asset**, not as a one-off.
- **Demand volatility is brutal.** Forecast accuracy matters more than model sophistication; ensemble simple models + external signals (weather, holidays, social) usually beats one complex model.
- **PCI scope minimization is everything.** Tokenize at the POS / payment gateway; never let raw PAN reach analytics. See [Compliance — PCI-DSS](../compliance/pci-dss-v4.md).
- **Real-time matters at checkout, not for analytics.** Recommendation, fraud scoring, dynamic pricing — sub-100ms or it doesn't get used. Other analytics can be batch.
- **Promotions are messy.** Promo lift modeling is the most-mistaken analytics in retail; almost everyone over-attributes lift to promos. Use causal inference (DML, synthetic control) for promo eval.

## Getting started

1. Read [Reference Architecture — Data Flow](../reference-architecture/data-flow-medallion.md)
2. Pick **one** scenario from the top list — most retailers benefit most from Customer 360 first
3. Walk [Tutorial 02 — Data Governance](../tutorials/02-data-governance/README.md) so customer data is properly classified before you build anything
4. Adapt [Example — Commerce](../examples/commerce.md) (federal commerce stats but the data patterns transfer)
5. Layer [Example — Data API Builder](../examples/data-api-builder.md) for the headless commerce surface
6. **Before** rolling out customer-facing GenAI: review [Patterns — LLMOps & Evaluation](../patterns/llmops-evaluation.md)

## Related

- [Industries — Financial Services](financial-services.md) — fraud + payment patterns transfer
- [Industries — Telco](telco.md) — churn + customer experience patterns transfer
- [Use Case — Casino & Gaming Analytics](../use-cases/casino-gaming-analytics.md) — customer LTV + fraud patterns transfer
- [Patterns — LLMOps & Evaluation](../patterns/llmops-evaluation.md)
- [Patterns — Power BI & Fabric Roadmap](../patterns/power-bi-fabric-roadmap.md)
