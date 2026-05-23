# Example: Financial Fraud Detection on CSA Loom

End-to-end runnable example demonstrating the CSA Loom stack against a
synthetic real-time payments fraud scenario.

## What this example shows

1. **Mirror** — synthetic transactions land in Azure SQL DB; the
   Loom Mirroring Engine CDC-replicates them into a Delta lakehouse
2. **Stream** — Spark Structured Streaming + Event Hubs continuously
   scores transactions with a pretrained gradient-boosted model
3. **Activate** — Loom Activator Engine watches the score stream; when
   per-merchant fraud-score MA crosses 0.75 for 5 minutes, it dispatches
   a Teams alert to the fraud-ops channel
4. **Investigate** — analysts open the Loom Data Agent and ask
   *"Which merchants saw a fraud-score spike in the last hour and what
   was the dollar volume?"* — the agent generates SQL against the
   silver layer and renders results

## Files

- `infra/main.bicep` — deploys the synthetic source SQL DB + the
  pre-configured mirror + the Spark job + the activator rule + the
  data-agent definition. Reuses `platform/fiab/bicep/` modules.
- `data/seed.sql` — schema + 1M synthetic transactions
- `notebooks/score_transactions.py` — Spark Structured Streaming job
- `models/fraud_v1.pkl` — pretrained gradient boost classifier
- `agent/finance-fraud-agent.json` — Loom Data Agent definition (CSA
  Loom Data Agents config format)
- `activator/rules.json` — activator rule definitions

## Run

```bash
# 1. Provision (requires a deployed CSA Loom Admin Plane)
cd examples/fiab/financial-fraud-detection/infra
az deployment group create -g rg-csa-loom-example -f main.bicep

# 2. Seed source data
sqlcmd -S "${SOURCE_SQL}" -d FraudExample -i ../data/seed.sql

# 3. Submit the Spark job
databricks bundle deploy --profile loom
databricks jobs run-now --job-name csa-loom-fraud-scoring

# 4. Open the Loom Console → Activator pane → import rules.json
# 5. Open the Loom Console → Data Agent pane → import finance-fraud-agent.json
# 6. Ask the agent a question
```

## Honest caveats

- **Model** is a deliberately simple gradient boost on synthetic data
  — not a real production fraud model. Substitute your own model.
- **Latency** — end-to-end (transaction landing → activator fire) is
  typically 45-90 seconds. Sub-second requires the Direct Lake
  on OneLake path that CSA Loom doesn't deliver (see
  [Direct Lake parity gap](../../../docs/fiab/workloads/direct-lake-parity.md)).
- **GCC** can run this example except for the Power BI semantic model
  step (no F-SKU in GCC; use DirectQuery fallback instead).

## Related

- [PRP-14 — examples port wave 1](../../../PRPs/active/csa-loom/PRP-14-examples-port-wave1.md)
- [Financial fraud use case docs](../../../docs/fiab/examples/financial-fraud-detection.md)
