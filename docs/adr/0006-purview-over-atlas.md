---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0006 — Microsoft Purview over Apache Atlas for data catalog and lineage

## Context and Problem Statement

Federal customers require a data catalog that carries classification,
sensitivity labels, glossary terms, and end-to-end lineage from source to
consumption. The catalog must integrate with Microsoft Information
Protection (MIP) labels, propagate classifications to downstream stores,
and produce evidence for ATO (NIST 800-53 CA-7, AC-3, AU-6). We must pick
a single catalog system that is operational on day one in Azure Government.

## Decision Drivers

- **Azure Government availability** with FedRAMP High.
- **MIP sensitivity label propagation** across storage, dataflows, and
  Power BI.
- **Lineage coverage** for ADF activities, dbt models, Databricks Unity
  Catalog, and SQL Server/Synapse sources without writing custom bridges.
- **RBAC integration** with Entra ID and the platform's existing persona
  model (`governance/rbac/`).
- **Operational burden** — prefer managed PaaS so customers do not run
  Atlas + Solr + HBase themselves.

## Considered Options

1. **Microsoft Purview (chosen)** — Managed PaaS, Gov-GA, native Azure
   scanners, MIP integration, Unity Catalog federation.
2. **Apache Atlas** — Open-source, extensible type system, HDFS-era
   heritage, requires customer-run Solr + HBase or equivalent.
3. **DataHub (Acryl)** — Modern open-source catalog, plugin-rich, but
   smaller Azure ecosystem and no MIP integration.
4. **Collibra** — Enterprise catalog with strong business-glossary story,
   but third-party procurement + no native Azure Gov deployment.

## Considered but out of scope

- **Unity Catalog as the only catalog** — we use Unity Catalog inside the
  Databricks blast radius (ADR-0002) but federate it into Purview so
  non-Databricks consumers (SQL, Power BI, Fabric) see the same lineage.

## Decision Outcome

Chosen: **Option 1 — Microsoft Purview** as the platform catalog, with
Unity Catalog federated in and dbt emitting OpenLineage events through
the Purview connector.

## Consequences

- Positive: Managed PaaS in Azure Gov; FedRAMP High inheritance.
- Positive: Native scanners cover ADLS, SQL, Synapse, Power BI, and Unity
  Catalog — lineage "just works" for the core stack.
- Positive: MIP label propagation is first-class; sensitivity follows the
  data across the medallion.
- Positive: Entra-ID-native RBAC fits the existing persona model.
- Negative: Open-source catalog extensibility is weaker than Atlas or
  DataHub — custom type definitions are possible but less ergonomic.
- Negative: Scanner cadence and capacity units are a real cost line; we
  manage scanner scope explicitly (domain-level, not tenant-level).
- Negative: Vendor lock-in to the Microsoft governance stack; if a tenant
  requires a neutral catalog, we pair Purview with DataHub exports rather
  than replacing it.
- Neutral: Does not preclude Fabric Purview migration — Fabric Purview is
  a superset and our metadata moves forward with us.

## Pros and Cons of the Options

### Option 1 — Microsoft Purview
- Pros: Gov-GA PaaS; MIP integration; native Azure scanners; Unity Catalog
  federation; Entra-ID RBAC; Fabric-ready.
- Cons: Weaker custom-type ergonomics; scanner-unit cost; ecosystem
  tightly coupled to Microsoft.

### Option 2 — Apache Atlas
- Pros: Open-source; extensible type system; field-proven at scale at
  Hortonworks-era customers.
- Cons: Customer-run Solr/HBase; no managed Azure offering; no MIP
  integration; contributor pool aging.

### Option 3 — DataHub (Acryl)
- Pros: Modern architecture; strong plugin ecosystem; vibrant community;
  SaaS option via Acryl.
- Cons: Smaller Azure ecosystem; no MIP story; third-party SaaS
  procurement adds FedRAMP burden.

### Option 4 — Collibra
- Pros: Best-in-class business glossary and stewardship workflows.
- Cons: Third-party SaaS; no Gov-GA deployment; significant licensing
  cost; not Azure-native.

## Validation

We will know this decision is right if:
- Purview lineage covers ADF + dbt + Unity Catalog flows in every vertical
  example within one sprint of onboarding.
- MIP labels applied in Purview appear on downstream Power BI datasets
  without manual relabeling.
- If scanner cost exceeds 10% of storage cost at any tenant, revisit
  scanner scope and cadence (not the catalog choice).

## References

- Decision tree: n/a (catalog choice is cross-cutting; see architecture
  matrix)
- Related code: `deploy/bicep/DMLZ/` (Purview provisioning),
  `governance/compliance/nist-800-53-rev5.yaml` (control mappings
  referencing Purview evidence), `docs/PLATFORM_SERVICES.md` (catalog
  narrative)
- Framework controls: NIST 800-53 **CA-7** (continuous monitoring via
  Purview scan schedules), **AC-3** (catalog-level access enforcement),
  **AU-6** (audit record review via Purview lineage), **SI-12** (information
  management and retention). See `governance/compliance/nist-800-53-rev5.yaml`.
- HIPAA Security Rule: §164.312(b) (audit controls) — satisfied by
  Purview lineage records for PHI-tagged tables. See
  `governance/compliance/hipaa-security-rule.yaml`.
- Discussion: CSA-0087
