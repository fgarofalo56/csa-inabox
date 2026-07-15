# Usage & chargeback admin page

> **Surface:** `/admin/usage-chargeback`
> **Backends:** Azure Cost Management (spend) + Azure Monitor (utilization)

The **Usage & chargeback** page is the Azure-native 1:1 of the Microsoft Fabric
Capacity Metrics app. It unifies capacity utilization and chargeback across every
engine Loom orchestrates and normalizes them to a single **Loom Capacity Unit
(LCU)**, with a throttle / surge gauge so an operator can see, at a glance,
whether the deployment is running hot.

## What you can do

- **Unified capacity view** — real Azure Monitor utilization for ACA, Spark,
  Synapse, ADX and Cosmos, normalized to one LCU scale.
- **Chargeback overlay** — real Azure Cost Management spend joined onto the same
  view so cost and utilization sit side by side.
- **Throttle / surge gauge** — reflects the FGC-25 surge-protection state
  (utilization vs. the capacity-level rejection threshold) so an admin knows when
  admission control is shaping load.

## Backend

| Control | Backend |
|---|---|
| Utilization | Azure Monitor metrics per engine (`monitor-client`) |
| Spend | Azure Cost Management query API |
| LCU normalization | Loom-native LCU model over the raw engine units |
| Surge gauge | FGC-25 `capacity-guardrails` policy (Cosmos, PK `/tenantId`) |

## RBAC & honest gates

Runs as the Console UAMI with **Monitoring Reader** + **Cost Management Reader**.
Any engine that isn't provisioned drops out with an honest gate rather than a
fabricated LCU figure.

## Related

- [Capacity & compute](capacity.md) — per-service utilization & guardrails.
- [Chargeback report](chargeback.md) — per-domain spend attribution.
- [Scale by SKU](scaling.md)
