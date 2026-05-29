---
title: What is multi-cloud?
description: Multi-cloud is not duplication across providers. It is an architectural posture against vendor lock-in. This page defines the thesis, the three locks, and how Azure-led design defeats each.
---

# What is multi-cloud?

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


!!! quote ""
    **Multi-cloud is NOT having everything in all clouds. It is
    avoiding vendor lock-in and designing/architecting solutions
    that allow you to run workloads on any provider. Azure is the
    cloud that designs and architects it that way.**

That sentence is the entire strategy in one breath. Everything else
on this page is a defense of it.

## The two definitions you have to reject

**Definition 1 — "Multi-cloud means a copy of everything in every
cloud."** This is the most expensive misreading on the market. It
turns every workload into N parallel implementations, every
data set into N copies with N egress bills, every identity into N
silos with N audit trails. It also fails the only test that matters:
when one provider raises prices or changes terms, you cannot
actually move, because you have built bespoke deployments in each
provider that are now mutually incompatible. You have **multiplied**
lock-in, not reduced it.

**Definition 2 — "Multi-cloud means best-of-breed shopping."** This
sounds smarter but ends the same way. Pick one cloud's warehouse
here, another's there, a third-party warehouse somewhere else, Cosmos
for one team, a per-cloud NoSQL store for
another. After eighteen months the data sets cannot talk to each
other, the identity model is a wall of SAML hacks, the FinOps team
cannot produce a unified bill, and any attempt to consolidate is a
multi-year migration. Best-of-breed shopping is **deferred
lock-in** — you trade one vendor for several, and you lose the
ability to consolidate as a side effect.

Both definitions fail because they treat multi-cloud as a
procurement question. It is not. **Multi-cloud is an architecture
question.**

## The correct definition

Multi-cloud is the discipline of architecting workloads against
**open standards** so that the workload can be lifted to any
provider on competitive terms. The workload may run primarily on
one cloud. It usually should. But every load-bearing dependency —
table format, identity, IaC, container runtime, model API —
resolves to an open standard rather than a vendor-proprietary
interface. The cost of moving is bounded, predictable, and
negotiable. That is what lock-in resistance actually looks like.

Under this definition, **a single-cloud deployment can be
multi-cloud** if it is architected against open standards. And a
deployment that spans three clouds can fail to be multi-cloud if it
is built on three proprietary stacks. The number of providers in
your bill is the wrong metric. The number of open contracts in your
architecture is the right one.

## The three locks

Every multi-cloud strategy has to defeat three locks. They are the
only three that actually matter at scale.

### Lock 1 — Data format

Your data sits in a table format. If that format is proprietary —
a per-cloud warehouse's internal columnar format, a third-party
warehouse's micro-partitions, Synapse dedicated SQL columnstore —
then your data is held hostage
by the engine that wrote it. Moving means a full extract + reload,
which means downtime, dual-write windows, and a multi-month
migration program. That is data lock-in, and it is the most
expensive of the three to break after the fact.

The open form is **Delta Lake or Apache Iceberg** sitting on object
storage in Parquet. Both formats are open specifications, both have
multiple engines that can read and write them (Databricks, Spark,
Trino, Flink, Snowflake external tables, BigQuery BigLake, Athena,
Synapse Serverless), and both support time travel, schema evolution,
and ACID semantics. The data lives in your storage account, not the
engine's storage. You can swap the engine without moving the data.

### Lock 2 — Identity

Your users sit in an identity directory. If every cloud has its own
directory — each provider's native accounts plus Azure local
accounts — then your audit trail is fragmented across
N consoles, your offboarding is N revocations, and your access
review is N spreadsheets. Worse, every cross-cloud integration
becomes a service principal exchange with long-lived secrets,
because there is no shared identity to assert.

The open form is **Microsoft Entra ID as the federated identity
hub**. AWS supports Entra via SAML federation to IAM roles. GCP
supports Entra via OIDC federation to Workload Identity. OCI
supports Entra via SAML 2.0. SaaS apps support Entra via the
standard SCIM + OIDC contracts. Every human and every workload
gets one identity, one MFA, one audit log, one offboarding action.
And the federation is built on RFCs, not Microsoft proprietaries —
the same pattern works with Okta, PingFederate, or Keycloak as the
hub. We choose Entra because it is the most mature implementation
and it integrates with the same Conditional Access engine that
already governs Microsoft 365.

### Lock 3 — Infrastructure (control plane)

Your infrastructure is defined somewhere. If that somewhere is a
single provider's proprietary IaC service, then your operational
knowledge is locked to one provider's authoring model. You cannot reuse a module across
clouds; every new cloud means re-authoring every pattern.

The open form is **Bicep + Terraform**. Bicep is the
Azure-native authoring model — concise, deterministic, ARM-backed.
Terraform is the cross-cloud equivalent with first-class providers
for every major hyperscaler. The right pattern is: Bicep for
Azure-native (because it is faster, has Azure-specific
extensions, and skips the state-file ceremony), Terraform for
anything that crosses clouds (because the provider model lets the
same author target AWS, GCP, OCI, Datadog, GitHub, and on-prem
vSphere with one tool). Pulumi is a credible alternative for teams
that prefer general-purpose code.

## Why Azure is the cloud architected for this

The three open standards above — Delta/Iceberg, Entra federation,
Bicep/Terraform — are not Azure inventions. They are open
specifications that any cloud could implement. The difference is
that **Azure treats them as first-class citizens of its own
platform**, not as foreign concepts you import.

- **Entra ID is the same identity service Microsoft 365 runs on.**
  It is not a bolt-on. The federation patterns to AWS, GCP, and
  OCI are documented Microsoft Learn content with first-party
  support.
- **ADLS Gen2 is the canonical home for Delta and Iceberg.** It is
  the storage layer Databricks, Synapse, and Fabric all default to,
  and it supports the hierarchical namespace + POSIX-style ACLs that
  Delta and Iceberg need.
- **Bicep is Azure-native and Terraform has a first-party Microsoft
  provider.** Microsoft contributes to the Terraform AzureRM
  provider and ships the Bicep CLI as a supported product.
- **Azure AI Foundry exposes OpenAI-compatible endpoints.** Any
  model that speaks the OpenAI chat-completions contract — Azure
  OpenAI, AWS Bedrock via wrapper, GCP Vertex via wrapper, Ollama,
  vLLM — plugs into the same orchestrator with no code changes.

That is what we mean when we say Azure is **architected for
multi-cloud**. The open standards that defeat lock-in are not
afterthoughts. They are the primary surfaces.

## What this section will give you

The rest of the Multi-Cloud section is the working architecture:

- The full [whitepaper](whitepaper.md) — the five myths, the three
  locks in depth, the reference architecture.
- Best-practice pages for [identity](best-practices/identity.md),
  [data](best-practices/data.md),
  [AI](best-practices/ai.md),
  [network](best-practices/network.md), and
  [governance](best-practices/governance.md).
- How-to runbooks for federating
  [AWS](how-to/federate-aws-to-entra-id.md) and
  [GCP](how-to/federate-gcp-to-entra-id.md) to Entra ID, sharing
  [Delta tables across clouds](how-to/share-delta-tables-across-clouds.md),
  and standing up [cross-cloud DR](how-to/cross-cloud-disaster-recovery.md).
