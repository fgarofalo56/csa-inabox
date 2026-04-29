# Industry — Telecommunications

> **Scope:** Wireless carriers, cable / wireline, MVNOs, telecom equipment vendors. Massive subscriber bases, network telemetry at unprecedented scale, churn + customer experience as core KPIs, regulated CPNI.

## Top scenarios

| Scenario                                           | Pattern                                  | Latency         | Reference                                                                                                                                          |
| -------------------------------------------------- | ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network analytics** (5G/4G QoS, capacity)        | Streaming + Eventhouse + ML for anomaly  | seconds-minutes | [Use Case — Anomaly Detection](../use-cases/realtime-intelligence-anomaly-detection.md), [Tutorial 05](../tutorials/05-streaming-lambda/README.md) |
| **Subscriber churn prediction**                    | CDR + usage + interactions + ML          | daily           | [Example — ML Lifecycle](../examples/ml-lifecycle.md)                                                                                              |
| **Fraud detection** (subscription, IRSF, SIM swap) | Streaming + graph + ML                   | seconds         | [Industries — Financial Services](financial-services.md) (similar patterns)                                                                        |
| **Customer experience (NPS, CSAT)**                | Multi-channel ingest + sentiment + ML    | hours           | [Tutorial 08 — RAG](../tutorials/08-rag-vector-search/README.md) for support-call analytics                                                        |
| **Network planning + capacity**                    | Historical traffic + ML + scenario eval  | weeks           | [Tutorial 06 — AI Foundry](../tutorials/06-ai-analytics-foundry/README.md)                                                                         |
| **Customer GenAI** (support, billing)              | RAG + agents + content safety            | seconds         | [Example — AI Agents](../examples/ai-agents.md)                                                                                                    |
| **OSS/BSS modernization**                          | Mainframe / legacy → ADF / Synapse / DAB | varies          | [Migration — Hadoop / Hive](../migrations/hadoop-hive.md), [Migration — Teradata](../migrations/teradata.md)                                       |
| **Field worker GenAI** (cell tower maintenance)    | RAG over asset/manual corpus + mobile    | seconds         | [Industries — Energy & Utilities](energy-utilities.md) (similar pattern)                                                                           |

## Regulatory landscape

| Framework                                                       | Where in CSA-in-a-Box                                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **CPNI** (US Customer Proprietary Network Information)          | Restricted use of subscriber call/usage data; classification + access controls in [Compliance — NIST](../compliance/nist-800-53-rev5.md) |
| **GDPR** (EU subscribers)                                       | [Compliance — GDPR](../compliance/gdpr-privacy.md)                                                                                       |
| **CALEA** (US lawful intercept)                                 | Out of scope for analytics platform; affects network elements                                                                            |
| **CCPA / CPRA + state privacy**                                 | Same patterns as GDPR                                                                                                                    |
| **PCI-DSS** (recurring billing)                                 | [Compliance — PCI-DSS](../compliance/pci-dss-v4.md) — minimize via tokenization                                                          |
| **NIS2 / TSA Pipeline-equivalent for telco** (EU + emerging US) | Operational resilience, breach reporting                                                                                                 |

## Reference architecture variations

- **CDR ingest scale** is the single hardest part of telco analytics: 100M subscribers × dozens of CDRs/day = billions of records/day. Plan with **Fabric Eventhouse / ADX** for the streaming gold; Synapse / Databricks for batch silver/gold.
- **Network telemetry** (5G slice metrics, RAN counters): dedicated **time-series database** (ADX) — never try to put this in Synapse SQL.
- **Customer 360** in telco includes call/SMS/data usage, billing, support interactions, network experience. Identity resolution is straightforward (one MSISDN per SIM) but data volume is large.
- **CPNI partition**: customer call/usage data has tighter access controls than other customer data. Implement a separate **silver-PII** schema with explicit RBAC.

## Why the standard CSA-in-a-Box pattern works for telco

- Medallion + dbt = **reproducible regulator + investor reports** (FCC Form 477, ARPU/churn/EBITDA breakdowns)
- Event Hubs + Eventhouse / ADX = **CDR + RAN telemetry at scale**
- Azure ML + MLflow = **churn / fraud / recommendation models** with proper governance
- AOAI + AI Search + Content Safety = **safe customer-facing GenAI** for support / billing
- Purview + classification = **CPNI controls** with auditable access

## What's specific to telco

- **CDR scale is the operational reality.** A mid-size telco generates more rows in a day than a typical retailer generates in a year. Design every silver/gold table with partitioning + Z-order from day 1.
- **Network telemetry vs business analytics are different platforms.** Network ops needs sub-second visibility on RAN; business analytics needs daily/weekly aggregates. Don't try to make one platform serve both.
- **Churn modeling is a solved problem; activation is harder.** Predicting churn is easy; _intervening_ (offer, retention call, channel choice) is where value is captured. Model the intervention, not just the prediction.
- **Fraud (IRSF, subscription, SIM swap) is real-time.** Loss happens within minutes of fraud onset. Streaming + ML scoring + auto-block is the architecture.
- **Customer GenAI is the highest-ROI 2025/2026 use case.** Telco support volume + cost is enormous; even modest deflection rates pay for the platform many times over. Content Safety + grounding are non-negotiable.
- **CPNI is your audit hot button.** US carriers get FCC fines for CPNI violations. Use Purview classifications + dedicated security groups + access reviews quarterly.

## Getting started

1. Read [Reference Architecture — Data Flow](../reference-architecture/data-flow-medallion.md)
2. Pick a scale-tested time-series store — **Fabric Eventhouse** or **Azure Data Explorer** — before anything else
3. Walk [Tutorial 05 — Streaming Lambda](../tutorials/05-streaming-lambda/README.md) end-to-end
4. Adapt [Example — IoT Streaming](../examples/iot-streaming.md) for CDR shape, or [Example — Cybersecurity](../examples/cybersecurity.md) for network anomaly patterns
5. Pilot **one** churn model end-to-end using [Example — ML Lifecycle](../examples/ml-lifecycle.md) as the template
6. **Before** customer-facing GenAI: review [Patterns — LLMOps & Evaluation](../patterns/llmops-evaluation.md) and [Compliance — GDPR](../compliance/gdpr-privacy.md)

## Related

- [Industries — Financial Services](financial-services.md) — fraud + customer 360 patterns transfer
- [Industries — Retail & CPG](retail-cpg.md) — churn + customer 360 patterns transfer
- [Use Case — Anomaly Detection](../use-cases/realtime-intelligence-anomaly-detection.md)
- [Patterns — Streaming & CDC](../patterns/streaming-cdc.md)
- [Patterns — LLMOps & Evaluation](../patterns/llmops-evaluation.md)
- Azure for telecom: https://www.microsoft.com/industry/telecommunications
