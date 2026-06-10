# CoE Charter — template

The Center of Excellence charter is the durable artifact a customer keeps after
the workshop. It records how the team governs, names, secures, sizes, funds, and
operates CSA Loom. Fill each section during the **Day 5** charter workshop.

!!! tip "How to use"
    Copy this page into the customer's repo/wiki and replace every `<…>`
    placeholder. The facilitator co-authors Section headers live; the customer
    owns the content.

## 1. Mission & scope

- **CoE mission statement:** `<one paragraph — why this analytics platform exists>`
- **In scope:** `<workloads, domains, agencies/business units>`
- **Out of scope (v1):** `<deferred items, e.g., IL5 content if v1.1>`
- **Success metrics:** `<e.g., time-to-onboard a domain, # workloads live, cost per workload>`

## 2. Governance model

- **Decision rights:** `<who approves new DLZs, capacity changes, catalog policy>`
- **Domain ownership:** `<domain steward responsibilities>`
- **Federation policy:** `<cross-domain data-product sharing rules>`
- **Catalog policy:** `<Purview-primary (Gov) | UC-managed primary (Commercial); classification scheme>`
- **Review cadence:** `<architecture review board frequency>`

## 3. Naming & tagging standards

| Object | Convention | Example |
|---|---|---|
| DLZ / workspace | `<convention>` | `dlz-<domain>-<env>` |
| Storage account | `<convention>` | `<…>` |
| Delta table (medallion) | `<bronze\|silver\|gold>.<entity>` | `gold.device_hourly` |
| Tags (required) | `<domain, classification, owner, cost-center>` | `<…>` |

## 4. RBAC & identity

- **Loom Admins group:** `<Entra group object ID>`
- **Domain steward role mapping:** `<role → group>`
- **Workspace identity model:** `<managed identities; identity passthrough>`
- **Privileged-access policy:** `<JIT, approval workflow>`

## 5. Capacity & sizing

- **Boundary:** `<Commercial | GCC | GCC-High | IL5 (v1.1)>`
- **Capacity SKU baseline:** `<e.g., F8>` (see
  [cost breakdown](../../operations/cost.md) and the Bicep-derived sample on the
  [solution-store page](../../../solution-store/csa-loom/index.md#cost-bicep-derived))
- **Scale triggers:** `<when to scale up/down compute, warehouse, ADX>`
- **Warehouse backend:** `<Synapse dedicated pool | Databricks SQL (Photon)>`

## 6. Cost management

- **Subscription / cost-center mapping:** `<per-DLZ billing>`
- **Budgets + alerts:** `<thresholds per DLZ>`
- **Showback/chargeback model:** `<how cost is allocated to domains>`
- **Cost-review cadence:** `<monthly via Monitor → Cost rollup>`

## 7. Operations runbook references

- **Monitoring:** `<dashboards, on-call, alert routing to Teams>`
- **DR posture:** `<RTO/RPO from the Day-5 drill; redundancy settings>`
- **Patching/upgrade:** `<Loom version policy; image-tag roll process>`
- **Incident response:** `<sev definitions, escalation>`

## 8. Compliance mapping

- **Framework(s):** `<FedRAMP/IL | HIPAA/SOC 2/PCI/GDPR/FDA Part 11>`
- **Control evidence sources:** `<diagnostics, resource inventory, catalog tags>`
- **ATO / audit owner:** `<name/role>`
- **v1.1-gated items:** `<e.g., CNSSI 1253 mapping when IL5 ships>`

## 9. Forward-migration plan

- **Target:** `<Fabric Gov (Forecasted — planning) | Fabric Commercial (GA — live)>`
- **Table inventory:** `<from fiab-migrate snapshot>`
- **Shortcut/port strategy:** `<OneLake shortcuts; dbt + KQL port unchanged>`
- **Trigger:** `<when the boundary GAs / business decision to migrate>`

## 10. Sign-off

| Role | Name | Date |
|---|---|---|
| Exec sponsor | `<…>` | `<…>` |
| Platform lead | `<…>` | `<…>` |
| Security/compliance | `<…>` | `<…>` |

## Related

- [Day 5 — Operate & Govern](../5-day-federal-coe/day-5-operate.md)
- [Readiness checklist](readiness-checklist.md) · [Post-survey](post-survey.md)
