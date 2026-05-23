# Battlecard — CSA Loom vs Microsoft Fabric Commercial

One-page reference for sellers facing the question: *"Why would I
recommend Loom instead of Microsoft Fabric Commercial?"*

## Headline

**You don't choose between them. You choose the right one per
audit boundary.**

- Commercial customers: pick Fabric (managed SaaS simplicity)
- Federal / Gov customers blocked from Fabric: pick Loom
- Hybrid customers: pick **both** (see [Hybrid topology](../use-cases/hybrid-topology.md))

## Side-by-side comparison

| Dimension | Microsoft Fabric Commercial | CSA Loom |
|---|---|---|
| **Cloud availability** | Azure Commercial GA; Gov `Forecasted` (no public date) | Azure Commercial + GCC + GCC-High + IL5 (v1.1) |
| **Audit boundary coverage** | FedRAMP High + DoD IL2 (Azure public) | FedRAMP High + IL4 + IL5; ITAR-eligible in GCC-H |
| **Deployment model** | SaaS-only (Microsoft-managed) | Customer-tenant deployable; customer owns ops |
| **Catalog** | OneLake + Purview integrated | UC managed + Purview overlay (Commercial); Purview primary (Gov-IL4); Atlas-on-AKS (IL5) |
| **Direct Lake** | Sub-second on Delta — unique | Premium Import + warm-cache materializer (5-30s) — honest gap |
| **Mirroring** | First-party zero-ETL | OSS Debezium + Spark + Delta MERGE; same publisher contract; honest UX gap |
| **Compute** | F-SKU capacity unit | Databricks + Synapse Serverless + ADX combined |
| **Pricing** | F-SKU + overage | Pay-as-you-go via customer's Azure sub; Loom IP free in v1; Marketplace + pricing deferred |
| **Forward-migration story** | n/a (you're already in Fabric) | OneLake shortcut zero-copy; 1:1 mapping for every primary primitive |
| **Operating surface** | Single SaaS plane | Multi-service (Console abstracts; but Console + parity services + per-engine UIs exist) |
| **Innovation cadence** | Microsoft pace | Microsoft pace + Loom team patches |
| **Best when** | Commercial; want managed SaaS | Gov tenant; need Fabric experience today; have Power BI Premium investment |

## Decision tree

```
Are you on Azure Government / blocked from Fabric Commercial?
├── Yes → CSA Loom
│   ├── Already on Azure Gov today → deploy Loom in your boundary
│   ├── On Commercial Azure with M365 GCC → use Loom in GCC mode (no Direct Lake)
│   └── Need IL5 → Loom v1.1
└── No, I'm on Commercial Azure
    ├── Want managed SaaS simplicity → Microsoft Fabric (no Loom)
    ├── Want Bicep-everything + parity-service flexibility → Loom in Commercial (rare)
    └── Hybrid Gov + Commercial → Loom in Gov + Fabric in Commercial (most common federal pattern)
```

## When to lead with Fabric

- Customer is on Azure Commercial
- No federal / sovereignty constraints
- Power BI is central to their delivery
- Values managed-SaaS simplicity (one CU pool, one workspace plane)
- Doesn't need fine-grained Bicep / per-resource control

## When to lead with Loom

- Customer is on Azure Gov (or migrating to Azure Gov)
- ITAR / CMMC L2/L3 requirements (GCC-H)
- IL5 audit scope (Loom v1.1)
- Has existing Synapse / Databricks investment to evolve, not replace
- Wants `publicNetworkAccess = disabled` everywhere via Bicep
- Per-DLZ subscription isolation requirement (multi-domain federal)

## When to lead with BOTH

- Customer has both Commercial + Gov estates
- Pattern: Fabric in Commercial for public datasets + cross-agency
  analytics + exec Power BI dashboards; Loom in Gov for CUI / classified
- Cross-cloud B2B bridges identity; cross-cloud APIM brokers
  data calls
- See [Hybrid topology use case](../use-cases/hybrid-topology.md)

## Common objections answered

### "Why would I deploy Loom in Commercial when Fabric is GA there?"

You typically wouldn't. Loom in Commercial is for:
- Customers building Hybrid topology (Fabric Commercial + Loom Gov,
  with Loom Commercial as the dev/test mirror)
- Customers who want per-resource Bicep control above SaaS-managed
  simplicity

For most Commercial-only customers: pick Fabric.

### "Loom can't match Direct Lake's sub-second freshness"

Correct. The warm-cache materializer delivers 5-30 s, which is
acceptable for most analytical workloads but doesn't match Fabric's
sub-second. Honest about this in [Direct Lake parity workload page](../workloads/direct-lake-parity.md).
If your workload requires sub-second freshness, wait for Fabric Gov
GA.

### "Loom + Fabric is double the cost"

Not necessarily. Hybrid customers typically:
- Keep low-volume / public datasets in Fabric Commercial (cheap)
- Run high-volume / classified workloads in Loom Gov (own Azure
  consumption)
- Cross-cloud data movement is minimal (mostly read-side via OneLake
  shortcut)

## Per-customer-segment guidance

| Segment | Lead with |
|---|---|
| Federal civilian agency | Loom (GCC-H / IL4) |
| DoD component | Loom (GCC-H / IL4 v1; IL5 v1.1) |
| Defense industrial base (CMMC L2/L3) | Loom (GCC-H) |
| State / local government | Loom (GCC) or Loom (GCC-H if STIG-aligned) |
| Healthcare (HIPAA, regional / federal) | Loom (GCC-H) or Fabric Commercial if no Gov constraint |
| Financial services (regional banks, regulated) | Loom (Commercial) only if specific sovereignty need; usually Fabric |
| Federal contractor (ITAR) | Loom (GCC-H) — Fabric not ITAR-eligible |
| Pure Commercial customer | Fabric — not Loom |

## Related

- [Pitch deck](pitch-deck.md)
- [Seller playbook](seller-playbook.md) — objection handling detail
- [Hybrid topology use case](../use-cases/hybrid-topology.md)
- [Per-boundary feature matrix](../compliance/feature-boundary-matrix.md)
