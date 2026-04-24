# Monitoring — Alerts and Dashboards


This directory contains the operational monitoring infrastructure for CSA-in-a-Box,
including Azure Monitor alert rules (Bicep) and Grafana dashboard definitions.

## Table of Contents

- [Structure](#-structure)
- [Getting Started](#-getting-started)
- [Alert Categories](#-alert-categories)
- [Related Documentation](#-related-documentation)

---

## 📁 Structure

```text
monitoring/
├── alerts/                       # Azure Monitor alert rules (Bicep)
│   ├── main.bicep                # Orchestrator — deploys all alert modules
│   ├── action-group.bicep        # Notification action groups (email, webhook, Teams)
│   ├── budget-alerts.bicep       # Cost management alerts
│   ├── data-quality-alerts.bicep # Data quality SLA violations
│   ├── databricks-alerts.bicep   # Databricks cluster and job health
│   ├── keyvault-alerts.bicep     # Key Vault access and expiry alerts
│   ├── pipeline-alerts.bicep     # ADF / Synapse pipeline failure alerts
│   ├── storage-alerts.bicep      # Storage capacity and latency alerts
│   ├── params.dev.json           # Dev environment parameters
│   └── params.prod.json          # Production parameters
└── grafana/
    └── dashboards/
        ├── data_quality.json     # Data quality metrics dashboard
        ├── infrastructure.json   # Infrastructure health dashboard
        └── pipeline_health.json  # Pipeline execution dashboard
```

---

## 🚀 Getting Started

1. Deploy alerts to dev:
   ```bash
   az deployment group create -g rg-monitoring --template-file alerts/main.bicep --parameters alerts/params.dev.json
   ```
2. Import Grafana dashboards from `grafana/dashboards/*.json` into your Grafana instance
3. Review `alerts/action-group.bicep` to configure notification targets

---

## 📊 Alert Categories

| Module | What It Monitors |
|--------|-----------------|
| `budget-alerts` | Azure spend thresholds per subscription |
| `data-quality-alerts` | SLA violations on data freshness, completeness, accuracy |
| `databricks-alerts` | Cluster failures, long-running jobs, idle clusters |
| `keyvault-alerts` | Secret/certificate expiry, unauthorized access attempts |
| `pipeline-alerts` | ADF/Synapse pipeline failures, duration anomalies |
| `storage-alerts` | ADLS Gen2 capacity thresholds, latency spikes |

---

## 🔗 Related Documentation

- [Architecture](../docs/ARCHITECTURE.md) — System architecture reference
- [Troubleshooting](../docs/TROUBLESHOOTING.md) — Common issues and resolution
- [Cost Management](../docs/COST_MANAGEMENT.md) — Cost optimization strategies
