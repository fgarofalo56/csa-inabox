# Healthcare Clinical Analytics on CSA Loom

HIPAA-scoped patient encounter + clinical-outcome analytics. Deploys
into GCC-High for VHA / IHS / HHS-aligned workloads or Commercial
for non-federal hospitals + health systems.

## What you'll build

```
Source: Electronic Health Record (EHR) system — Azure SQL or
        on-prem SQL Server via SHIR
    ↓ Loom Mirroring Engine (CDC)
Bronze: raw_encounters, raw_patients, raw_diagnoses, raw_orders
    ↓ Databricks Spark — de-identification + cleansing
Silver: deid_encounters (per HIPAA Safe Harbor or Expert
        Determination), labeled with sensitivity tag PHI-Restricted
    ↓ dbt models
Gold: dim_patient (de-identified), fact_encounter, fact_diagnosis
    ↓ Loom Direct-Lake-Shim
Power BI Premium semantic model (clinical dashboards)
    ↓ Loom Data Agent (per-clinical-role)
        - "physician-agent": full access; clinical decision support
        - "researcher-agent": de-identified only; cohort analysis
        - "analyst-agent": aggregate only; quality reporting
```

## Components

| Loom capability | Used for |
|---|---|
| Mirroring Engine | EHR CDC (Azure SQL or SQL Server 2016+ via SHIR) |
| Databricks notebook | De-identification + clinical-data cleansing |
| Purview / UC | Sensitivity-label propagation (PHI-Restricted) |
| Power BI Premium semantic model | Clinical dashboards |
| Loom Data Agents (per role) | NL Q&A scoped by clinical role |

## HIPAA compliance

Per [HIPAA Security Rule extension](../compliance/hipaa-security-rule-fiab.md):

- HIPAA BAA via Microsoft Product Terms (covers Azure Commercial +
  Azure Gov)
- PHI columns marked with `PHI-Restricted` sensitivity label via
  Purview
- RLS at engine layer (per-physician access by department / unit)
- CLS for sensitive fields (SSN, MRN visible only to authorized roles)
- Per-clinical-role Data Agents with explicit sensitivity policy
- Sentinel rules detect anomalous PHI access patterns
- 6-year audit log retention per HIPAA

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Most flexible; full feature set |
| GCC | M365 GCC tenant for federal healthcare; P-SKU Power BI |
| GCC-High / IL4 | VHA / federal health agencies with strict CUI handling |
| IL5 (v1.1) | Rare — classified healthcare workloads only |

## Sample Data Agent config (physician-agent)

```json
{
  "name": "Clinical Decision Support Agent",
  "instructions": "You assist physicians in their clinical workflow. ALWAYS verify the caller is in the Physicians Entra group before discussing PHI. Cite all queries. Never disclose patient data outside the requesting physician's assigned patient panel.",
  "dataSources": [
    {"type": "lakehouse", "lakehouse": "clinical-gold",
     "sensitivityPolicy": {"requireAuth": true,
                           "blockOnLabels": ["Restricted-Research-Only"],
                           "minSensitivity": "Internal"}}
  ],
  "exampleQueries": [
    {"question": "Show recent labs for patient {pid}",
     "language": "SQL",
     "query": "SELECT * FROM fact_lab_result WHERE patient_id = '{pid}' ORDER BY result_dt DESC LIMIT 50"}
  ]
}
```

## Cost (F32 GCC-H baseline for mid-size health system)

~$9,000/mo:
- Power BI Premium F32: $4,200
- Databricks Premium classic: $2,000
- Synapse Serverless: $50
- ADLS Gen2 (deid + raw): $400
- AOAI (Data Agent — multiple roles): $800
- Purview (FedRAMP H + IL4): $400
- Misc + Sentinel + LAW: $1,150

## Source code

[`examples/fiab-healthcare-clinical/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-healthcare-clinical)

## Forward migration

Standard. PHI sensitivity labels propagate to Fabric Purview
automatically.

## Related

- [HIPAA compliance extension](../compliance/hipaa-security-rule-fiab.md)
- [Sovereign AI Agents use case](../use-cases/sovereign-ai-agents.md)
- Existing source: [`examples/healthcare-clinical/`](../../examples/healthcare-clinical.md), [`tribal-health/`](../../examples/tribal-health.md)
