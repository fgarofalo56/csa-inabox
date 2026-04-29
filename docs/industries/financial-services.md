# Industry — Financial Services

> **Scope:** Banking, capital markets, insurance, wealth management. Heavy regulator presence, high data volumes, low-latency requirements, fraud as a constant adversary.

## Top scenarios

| Scenario                                      | Pattern                                  | Latency          | Reference                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real-time fraud detection**                 | Streaming + ML scoring + write-back      | sub-100ms        | [Tutorial 05 — Streaming Lambda](../tutorials/05-streaming-lambda/README.md), [Use Case — Anomaly Detection](../use-cases/realtime-intelligence-anomaly-detection.md) |
| **AML transaction monitoring**                | Batch + graph + alert workflow           | minutes-hours    | [Example — ML Lifecycle](../examples/ml-lifecycle.md) (loan default → adapt for AML)                                                                                  |
| **Customer 360**                              | Medallion gold + reverse-ETL + Power BI  | minutes          | [Reference Arch — Data Flow](../reference-architecture/data-flow-medallion.md)                                                                                        |
| **Risk modeling (FRTB, IFRS 9)**              | Spark + Monte Carlo + result persistence | overnight        | [Tutorial 06 — AI Foundry](../tutorials/06-ai-analytics-foundry/README.md)                                                                                            |
| **Regulatory reporting (BCBS 239, MiFID II)** | dbt models + audit trail + signing       | daily            | [Best Practices — Data Governance](../best-practices/data-governance.md)                                                                                              |
| **Algorithmic trading research**              | Tick data + backtesting + ML             | research / batch | [Example — Streaming](../examples/streaming.md) (adapt)                                                                                                               |
| **Insurance claims AI triage**                | RAG + agents + claims-system integration | seconds          | [Tutorial 08 — RAG](../tutorials/08-rag-vector-search/README.md), [Tutorial 07 — Agents](../tutorials/07-agents-foundry-sk/README.md)                                 |
| **Customer GenAI (chat, doc Q&A)**            | RAG + grounding + content safety         | seconds          | [Example — AI Agents](../examples/ai-agents.md), [Example — Fabric Data Agent](../examples/fabric-data-agent.md)                                                      |

## Regulatory landscape

| Framework                                  | Where in CSA-in-a-Box                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **SOC 2 Type II**                          | [Compliance — SOC 2](../compliance/soc2-type2.md)                                                              |
| **PCI-DSS v4.0** (if handling card data)   | [Compliance — PCI-DSS](../compliance/pci-dss-v4.md)                                                            |
| **GDPR / CCPA**                            | [Compliance — GDPR](../compliance/gdpr-privacy.md)                                                             |
| **SOX** (public companies)                 | Same controls as SOC 2 + financial-reporting evidence                                                          |
| **GLBA** (US banks)                        | [Compliance — NIST 800-53](../compliance/nist-800-53-rev5.md) covers most                                      |
| **Basel III / FRTB** (capital adequacy)    | Out of scope for platform; the **risk model results** must be reproducible (use dbt + git)                     |
| **MiFID II** (EU markets)                  | Transaction reporting + best-execution evidence — capture in bronze, report from gold                          |
| **DORA** (EU operational resilience, 2025) | Heavy overlap with [DR.md](../DR.md) + [Runbooks](../runbooks/data-pipeline-failure.md); also third-party risk |

## Reference architecture variations

- **Tier-1 isolation**: separate DLZ subscription per LOB (retail / commercial / investment); shared DMLZ for governance
- **Sub-100ms inference**: Azure ML real-time endpoint behind a Premium APIM; deploy ONNX models to a dedicated GPU SKU
- **Tick data**: Event Hubs → Azure Data Explorer (Eventhouse in Fabric) for sub-second queries on TB+/day
- **Lineage for regulators**: Purview + dbt docs is the source of record for "where did this number come from?"

## Why the standard CSA-in-a-Box pattern works for FSI

- Medallion + dbt = **reproducible regulatory reports**
- Bronze immutability = **audit trail**
- Federated identity + PIM = **separation of duties** (CC6.x in SOC 2; SOX-relevant)
- Defender for Cloud + Sentinel = **continuous monitoring** (DORA, NYDFS Part 500)
- AOAI + content filters = **safe customer GenAI**

## What's specific to FSI

- **Latency**: real-time fraud scoring needs sub-100ms; standard batch dbt won't work. Use ML real-time endpoint + Cosmos for state.
- **Right of explanation** (EU AI Act, FCRA in US): every adverse decision must be explainable. Use **SHAP / LIME** in your training pipeline; log feature contributions per inference.
- **Model risk management** (SR 11-7, OCC 2011-12): formal model lifecycle — registration, validation, monitoring, retirement. Wrap MLflow + Azure ML Model Registry in a governance workflow.
- **Tick / market data** is the most expensive data category in any FSI platform. Azure Data Explorer / Fabric Eventhouse is purpose-built; don't try to use Synapse SQL for sub-second queries on TB-scale tick data.

## Getting started

1. Read [Reference Architecture — Hub-Spoke](../reference-architecture/hub-spoke-topology.md) and [Identity & Secrets Flow](../reference-architecture/identity-secrets-flow.md)
2. Pick a starting scenario from the table above
3. Walk the most-relevant tutorial end-to-end in dev
4. Adapt the closest [example](../examples/index.md) — usually `ml-lifecycle` or `cybersecurity` is the closest fit for FSI patterns
5. Review [Compliance — SOC 2](../compliance/soc2-type2.md) and your specific regulator's framework
6. Engage your model risk management team **before** deploying any ML model that drives a customer decision

## Related

- [Use Case — Real-Time Anomaly Detection](../use-cases/realtime-intelligence-anomaly-detection.md)
- [Use Case — Casino & Gaming Analytics](../use-cases/casino-gaming-analytics.md) (fraud patterns transfer to FSI)
- [Patterns — LLMOps & Evaluation](../patterns/llmops-evaluation.md)
- [Patterns — Streaming & CDC](../patterns/streaming-cdc.md)
