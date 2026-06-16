# Federal Use Cases for CSA Loom

CSA Loom is designed first for federal and sovereignty-constrained
customers. This page describes the patterns and the pre-built app
bundles that ship with Loom for common federal scenarios.

## Who it is for

| Segment | Why Loom |
|---|---|
| Federal civilian agencies (FedRAMP High / GCC-H / IL4) | Fabric is Forecasted in your boundary; Loom is available today in your existing Azure Gov tenant |
| DoD components (IL4 / IL5) | Same — IL5 support lands in Loom v1.1 |
| State and local government (StateRAMP / CJIS) | StateRAMP and CJIS-aligned audit baselines; same Bicep deploys into Azure Gov |
| Federal contractors (CMMC L2/L3, ITAR) | GCC-High deploys carry ITAR-eligible Azure Gov regions |
| IC / sensitive compartmented programs | IL5 path (v1.1); Apache Atlas on AKS replaces Purview for IL5 catalog |

## Sovereign cloud deployment

All Loom workloads run in your Azure Government tenant with no
commercial-cloud dependencies on the default code path. Key
sovereignty controls:

- **All PaaS with `publicNetworkAccess = disabled`** and private
  endpoints for every service (ADLS, Key Vault, AOAI, Databricks,
  Purview, ADX, AI Search, ACR, Cosmos).
- **Customer-Managed Keys (CMK)** on ADLS Gen2 + HSM (double encryption
  in IL5 `.bicepparam`).
- **AI inference stays in-boundary** — Azure OpenAI Gov endpoint
  (`openai.azure.us`) for GCC-H/IL4; DoD IL5 uses the same Gov
  catalog (gpt-4o, gpt-4.1, o3-mini available in usgovvirginia /
  usgovarizona).
- **OpenAI Batch API and Content Safety are not available in Gov.**
  Loom uses Presidio (self-hosted) for PII scrubbing at IL4+.
- **Per-boundary `.bicepparam` files** — one file per boundary
  (Commercial, GCC-H, IL5), so there is no risk of deploying the
  wrong service tier into the wrong boundary.

## Federal app bundles

Loom ships the following pre-built app bundles targeting federal
scenarios. Install any of them from the Console → App Library.

### FedRAMP Compliance Tracker

`apps/fiab-console/lib/apps/content-bundles/app-fedramp-tracker.ts`

Continuous NIST 800-53 Rev 5 control scorecard across 13 control
families (AC, AU, AT, CM, CP, IA, IR, MP, RA, SA, SC, SI, SR) with
FedRAMP Moderate or High baselines (`LOOM_FEDRAMP_BASELINE=high`).
Backed by a medallion cyber pipeline:

- **Bronze** — `stg_sentinel_alerts` (raw Sentinel alert ingest)
- **Silver** — `fct_security_alerts`, `dim_mitre_techniques` (MITRE
  ATT&CK enrichment)
- **Gold** — `rpt_compliance_posture`, `rpt_threat_landscape`
- **KQL dashboard** over ADX — alert volume, MITRE technique
  distribution, MTTD, top-risk users, live compliance posture

Useful for any federal ATO boundary: wire the bronze ingest to your
live Sentinel workspace and replace the sample mid-ATO values with
real evidence from your CMDB.

### Federal Data Mesh

`apps/fiab-console/lib/apps/content-bundles/app-federal-data-mesh.ts`

A federal department running multiple agencies as autonomous domains
(per-DLZ subscriptions), each publishing data products to a central
Marketplace under Department-CIO governance. Ships with:

- Cross-Domain Marketplace data product with four sample agency
  products (CUI, Restricted-PHI, CUI-NSS classifications).
- Delta Sharing notebook automating the producer-approves →
  grant-created → consumer-catalog-adapter-syncs-in-5-min flow.
- Federated Access Register warehouse (T-SQL / Synapse Dedicated)
  tracking the request → approve(90-day window) → grant lifecycle.
- FederationAudit KQL database (ADX) for cross-DLZ access events,
  per-domain cost rollup, and Sentinel label-violation detections.
- Department CIO Federation & Cost KQL dashboard.
- AI Search index powering Marketplace discovery by name, domain,
  classification, and endorsement.

See [Data Mesh on Azure with CSA Loom](data-mesh-on-azure.md) for
setup instructions.

### Multi-Agency Onboarding

`apps/fiab-console/lib/apps/content-bundles/app-multi-agency-onboarding.ts`

Operationalizes the Setup Wizard "Add Data Landing Zone" flow for
departments onboarding multiple agencies under one Entra tenant. Ships:

- DLZ Onboarding Registry warehouse — agency domain registry,
  subscriptions, VNet peering status, capacity SKUs, Domain-Steward
  groups, and onboarding task checklist.
- DLZ Onboarding Orchestrator notebook — real Microsoft Graph
  `privilegedAccess/group` eligibility-schedule calls for PIM-for-Groups,
  `az deployment sub create`, and Azure Resource Graph subscription /
  VNet peering inventory.
- DLZ Provision + Validate data pipeline — ARM Web activities, VNet
  peering, catalog-scan registration, and smoke-test steps.
- FederationGovernance lakehouse — cross-domain data products, Delta
  Sharing grants, catalog-scan registrations, and audit events in
  Delta tables.
- OnboardingTelemetry KQL database — deployment events, PIM
  activations, peering state, and smoke-test results.
- Multi-Agency Onboarding Cockpit (semantic model + report) for the
  Department CIO.
- DLZ Deployment Health Activator alert for stalled deploys or
  failed VNet peerings.

### Sovereign AI Agents

`apps/fiab-console/lib/apps/content-bundles/app-sovereign-ai-agents.ts`

A turnkey sovereign multi-agent governance workspace using Azure AI
Foundry Agent Service *Standard agent setup* — BYO Azure Storage,
BYO Cosmos DB, BYO AI Search, Customer-Managed Keys, and optional
BYO virtual network. All agent state (threads, files, vector stores)
stays in your tenant. Ships:

- A 6-node orchestrated governance-review prompt flow (DataAnalyst →
  QualityReviewer → GovernanceOfficer → verdict synthesis →
  human-in-the-loop gate).
- A BYO AI Search vector index backing the agents' grounding corpus.
- An agent-audit KQL database (ADX) with AgentReviews, AgentTurns,
  and ToolCalls tables and five compliance queries.
- Human-in-the-loop required for APPROVED verdicts; Content-Safety
  severity max Medium; read-only tool policy throughout.

Useful for IC and DoD scenarios where agent state must stay
on-premises or in-boundary with CMK encryption.

## Agriculture and civilian agency patterns

No USDA-specific app bundle ships in v1 — the product has not been
tailored to USDA's specific programs. However, the federal patterns
above directly apply to USDA-style scenarios:

- **Farm program data products** follow the Federal Data Mesh pattern:
  each state office or program area owns its DLZ; the national office
  is the Admin Plane; program-level data products (disbursements,
  commodity prices, land parcels) are published to the central
  Marketplace with CUI sensitivity labels.
- **FedRAMP compliance posture** for USDA mission systems maps to the
  FedRAMP Tracker app.
- **Multi-agency data sharing** across USDA sub-agencies or with USDA
  partners (e.g., Farm Service Agency ↔ Risk Management Agency) maps
  to the Federal Data Mesh cross-domain access flow.
- **Sovereign AI** for agricultural analytics (commodity forecasting,
  conservation eligibility) maps to the Sovereign AI Agents app with
  Azure OpenAI Gov in `usgovvirginia`.

If you are building a USDA-specific use case on Loom, start with
the Federal Data Mesh or Multi-Agency Onboarding app, adapt the
domain names and data product schemas to your program structure, and
raise a GitHub issue for a formal USDA content bundle if one is needed.

## Compliance and certification notes

- FedRAMP High ATO is a customer responsibility; Loom provides the
  infrastructure (NIST 800-53 control scorecard, Sentinel integration,
  Purview sensitivity labels, private endpoints, CMK, PIM-gated
  deployment) but does not ship a pre-built ATO package.
- Purview MIP sensitivity labels (Restricted-PII, Restricted-PHI,
  CUI, CUI-NSS) propagate from the catalog to Power BI reports and
  Excel/PowerPoint exports.
- IL5 catalog uses Apache Atlas on AKS (Purview is not in IL5 audit
  scope). Track IL5 GA in the [architecture doc](../architecture.md).

## Get started

- [Deploy Loom into your Gov tenant](../deployment/index.md)
- [Federal Data Mesh setup](data-mesh-on-azure.md)
- [Architecture — per-boundary dispatch matrix](../architecture.md#per-boundary-dispatch-matrix)
- [Governance — data residency](../governance/data-residency.md)
