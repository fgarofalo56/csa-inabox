# Financial Fraud Detection on CSA Loom

Real-time credit-card transaction stream → fraud-detection ML
scoring → high-risk transactions trigger alerts to investigators
via Activator → analysts query historical fraud patterns via Data
Agent.

## What you'll build

```
Source: Cosmos DB (live transactions ledger)
    ↓ Loom Mirroring Engine (CDC)
Bronze: raw_transactions Delta table
    ↓ Databricks Spark Structured Streaming
Silver: enriched_transactions (with feature engineering for ML)
    ↓ Databricks ML model scoring
Gold: scored_transactions (with fraud_score 0-1)
    ↓ Loom Activator Engine
Real-time alert: fraud_score > 0.9 → Teams to investigators
    ↓ Investigator response → annotate + feedback loop
    ↓ Power BI: fraud-trend dashboards (Direct-Lake-Shim refresh)
    ↓ Loom Data Agent: NL Q&A for historical fraud patterns
```

## Components

| Loom capability | Used for |
|---|---|
| Mirroring Engine | CDC from Cosmos transactions |
| Databricks notebook | Feature engineering + ML scoring |
| Databricks MLflow | Model versioning + serving |
| ADX | Real-time scored transaction stream |
| Loom Activator Engine | Threshold alert (fraud_score > 0.9 sustained) |
| Power BI semantic model | Fraud-trend BI |
| Loom Data Agent | Analyst NL Q&A |

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Databricks Model Serving for inference |
| GCC | Same |
| GCC-High / IL4 | Azure ML managed endpoints or AKS-MLflow (no Databricks Model Serving in Gov) |
| IL5 (v1.1) | Same as IL4 + Atlas catalog + HSM-CMK |

## Federal applicability

A federal financial-services agency (Treasury, IRS, USPS, etc.) that
monitors transaction streams for fraudulent activity uses this
pattern in GCC-High under FedRAMP High + DoD IL4 audit boundary.
HIPAA BAA covers if PHI-adjacent (rare for transaction fraud).

## Sample Activator rule

```json
{
  "name": "High fraud-score alert",
  "dataSource": {
    "type": "adx-kql",
    "query": "ScoredTransactions | where ts > ago(15m) | summarize avg(fraud_score) by transaction_id, bin(ts, 1m)",
    "splitColumn": "transaction_id",
    "cadenceMinutes": 1
  },
  "rules": [{
    "expression": {
      "operator": "andStays",
      "left": {"operator": "isAbove", "attribute": "avg_fraud_score", "threshold": 0.9},
      "durationMinutes": 2
    },
    "actions": [
      {"type": "teams-message", "channel": "#fraud-investigators",
       "template": "Transaction {transaction_id} fraud_score {avg_fraud_score} for 2+ min"},
      {"type": "databricks-job", "jobId": "fraud-investigation-trigger"}
    ]
  }]
}
```

## Cost (F32 GCC-H baseline for production scale)

~$8,500/mo:
- Power BI Premium F32: $4,200
- Databricks Premium classic + ML: $2,500
- ADX cluster: $800
- ADLS Gen2: $300
- AOAI (Data Agent + ML feature enrichment): $500
- Misc: $200

## Source code

[`examples/fiab-financial-fraud-detection/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-financial-fraud-detection)

## Forward migration

Standard Loom forward path (OneLake shortcut for Delta tables; dbt
+ KQL port unchanged). The ML model + MLflow registry exports
portably.

## Related

- [Data Activator parity workload](../workloads/data-activator-parity.md)
- [Mirroring parity workload](../workloads/mirroring-parity.md)
- [Tutorial 04 — Activator rules](../tutorials/04-activator-rules.md)
- Existing source: [`examples/financial-fraud-detection/`](../../examples/financial-fraud-detection.md)
