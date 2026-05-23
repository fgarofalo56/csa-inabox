# CSA Loom — Architecture Decision Records

These ADRs capture the durable rationale behind every CSA Loom
architectural choice. Each ADR follows the existing csa-inabox ADR
template (Status, Context, Decision, Consequences, Alternatives,
References).

Numbering uses the `fiab-NNNN` series to keep them clearly separated
from the parent csa-inabox `NNNN` series (which uses the same
numbering style but for the broader project).

| # | ADR | Status | Locked decision ref |
|---|---|---|---|
| fiab-0001 | [Fabric feature scope](0001-fabric-feature-scope.md) | Accepted | LD-3 |
| fiab-0002 | [Hybrid compute (Databricks + Synapse Serverless + ADX)](0002-compute-hybrid.md) | Accepted | LD-2 |
| fiab-0003 | [Catalog layering — UC managed + Purview overlay; Purview-primary in Gov; Atlas in IL5](0003-catalog-layering.md) | Accepted | LD-8 |
| fiab-0004 | [Direct Lake parity via Premium Import + warm-cache materializer](0004-direct-lake-parity.md) | Accepted | LD-7 |
| fiab-0005 | [Activator engine on ADX + NRules + Redis](0005-activator-engine.md) | Accepted | — |
| fiab-0006 | [Mirroring engine via Debezium + Spark Structured Streaming + Delta MERGE](0006-mirroring-engine.md) | Accepted | LD-9 |
| fiab-0007 | [Console framework — Next.js + Fluent UI v9 + MSAL BFF](0007-console-framework.md) | Accepted | LD-5 |
| fiab-0008 | [Deployment shape — two-tier (azd + Deploy-to-Azure); Marketplace deferred](0008-deployment-shape.md) | Accepted | LD-4 |
| fiab-0009 | [Copilot orchestration — Foundry Agent Service in Commercial; MAF + AOAI in Gov](0009-copilot-orchestration.md) | Accepted | — |
| fiab-0010 | [Container host — Container Apps in Commercial/GCC; AKS in GCC-High/IL5](0010-container-host.md) | Accepted | — |
| fiab-0011 | [Tenancy model — DMZ + DLZ + workspace-as-data-product](0011-tenancy-model.md) | Accepted | LD-6 |
| fiab-0012 | [Forward migration — OneLake shortcut + hybrid topology first-class](0012-forward-migration.md) | Accepted | LD-13 |

## How CSA Loom ADRs relate to the parent csa-inabox ADRs

The parent csa-inabox ADRs (`docs/adr/0001..0026`) document the
broader project's choices: ADF + dbt over Airflow, Databricks over OSS
Spark, Delta Lake over Iceberg, Bicep over Terraform, Purview over
Atlas, etc.

CSA Loom **inherits all of those** as a baseline. The fiab-NNNN ADRs
above add the Loom-specific decisions on top — primarily the brand
split, the Console framework, the two-track catalog, the Direct Lake
parity strategy, and the deployment shape.

Where a Loom ADR refines or supersedes a parent ADR for the Loom
context (e.g. `fiab-0008` deployment shape vs ADR-0023 release-please
patterns), the Loom ADR cites the parent ADR and explains the
delta.

## Template

When adding a new ADR (post-v1):

```markdown
# fiab-NNNN: <Title>

**Status:** Proposed | Accepted | Superseded by fiab-MMMM
**Date:** YYYY-MM-DD
**Locked decision ref:** LD-N (if applicable)

## Context

<What's the problem we're solving? What forces / constraints apply?>

## Decision

<What did we decide? Be specific.>

## Consequences

### Positive
- ...

### Negative
- ...

### Neutral
- ...

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| ... | ... |

## References

- PRD: `temp/fiab-prd/...`
- Amendments: `temp/fiab-prd/AMENDMENTS.md` §AN
- Research: `temp/fiab-research/...`
- External: links to MS Learn / GitHub / blogs
```
