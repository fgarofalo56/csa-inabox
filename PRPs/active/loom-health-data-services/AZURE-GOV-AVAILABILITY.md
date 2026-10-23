# LHDS — Azure Government availability, audit scope and substitutes

Source of every cell: `research/azure-gov-availability.md` (retrieved
2026-10-22 from Microsoft Learn directly; the Microsoft Learn MCP tools were
not registered in the session). Audit-scope ticks come from Microsoft's
"services by audit scope" tables (Gov table last updated February 2026). A
tick means the service is inside Microsoft's authorization boundary; it never
means a customer solution is authorized. Cells marked **UNVERIFIED** could not
be read from a fetched page; the research file names the page or command that
closes each one (the interactive "Products available by region" page is
client-rendered and could not be fetched; `az provider show -n <RP>` in a Gov
subscription via a GitHub Actions run is the W0 closure for all of them).

Column key: Comm = Commercial; Gov = US Gov Arizona/Texas/Virginia; DoD = US
DoD Central/East; FH = FedRAMP High (Gov); IL4; IL5 = DoD IL5 Workload
Isolation PA in US Gov regions.

## 1. Matrix (services LHDS proposes)

| Service | Comm | Gov | DoD | FH | IL4 | IL5 | LHDS use | If missing: substitute |
|---|---|---|---|---|---|---|---|---|
| AKS | yes | yes | UNVERIFIED | yes | yes | yes (CMK, dedicated/isolated node sizes) | Stamp compute (ADR-009) | — |
| Azure Container Apps | yes | yes (VA/TX cited; AZ unverified) | UNVERIFIED | yes | **no** | **no** | Control plane only in Commercial/GCC-High (existing Loom pattern) | AKS at IL5/DoD (new W1-3 work: `containerPlatform` is `containerApps` in every param file incl. `il5.bicepparam:121`, W0 receipt section 7) |
| Container Registry | yes | yes (`azurecr.us`) | UNVERIFIED | yes | yes | yes (CMK) | Images per cloud | — |
| PostgreSQL Flexible Server | yes | yes (all 3; zone-redundant HA and geo-backup in Virginia only; Intel v3/v4 only listed) | yes (IL5 list) | yes | yes | yes (CMK text covers Single Server; Flexible CMK guidance UNVERIFIED) | FHIR, DICOM metadata, terminology, MPI, audit index | — ; SSD v2 and v5 SKUs in Gov UNVERIFIED (W0) |
| Cosmos DB for PostgreSQL (Citus) | yes (retiring) | **no** | no | — | — | — | not used | Stamps + per-tenant DBs (ADR-003); Elastic Clusters re-evaluated when a Gov row appears |
| Cosmos DB NoSQL | yes | yes | yes | yes | yes | yes | Control-plane registries (existing Loom) | — |
| Azure SQL / Hyperscale | yes | yes | yes | yes | yes | yes | not used (engines are PostgreSQL) | — |
| Blob Storage / ADLS Gen2 | yes | yes | yes | yes | yes | yes (CMK before content) | Pixel data (flat namespace), audit (immutable), export staging, lakehouse sink (ADLS) | Archive tier has its own Gov audit row (no IL6); cold tier, WORM and object replication Gov availability UNVERIFIED |
| Event Hubs | yes | yes | yes | yes | yes | yes (CMK) | Outbox stream, device ingest | Premium/Dedicated SKU in Gov UNVERIFIED -> Standard with more TUs |
| Service Bus | yes | yes | yes | yes | yes | yes (CMK) | Work queues | — |
| Event Grid | yes | yes | yes | yes | yes | yes | Optional event publish (AHDS shape) | — |
| Key Vault | yes | yes | yes | yes | yes | yes | Per-tenant CMK, secrets | — |
| Managed HSM | yes | yes (endpoint exists) | UNVERIFIED | **no separate Gov audit row** | — | — | Optional at IL5 (D15) | Key Vault Premium HSM-backed |
| Front Door Std/Premium | yes | partial (GA in AZ and TX; VA not named; Private Link page lists VA too) | yes (IL5 list) | yes | yes | yes | Global edge (optional) | Application Gateway WAF v2 per stamp (default) |
| Application Gateway + WAF v2 | yes | yes | yes | yes | yes | yes | Stamp ingress | — |
| API Management (classic) | yes | yes | yes | yes | yes | yes | Tenant router (ADR-006) | v2 tiers: **no Gov regions** -> classic Premium (existing Loom `apimSku` param) |
| Azure Cache for Redis / Managed Redis | retiring (no new caches from 2026-04; retire 2028-09) | same | — | yes | yes | yes | **not used** | In-cluster Valkey (BSD-3) (ADR-004) |
| Azure Monitor / Log Analytics / App Insights | yes | yes | yes | yes | yes | yes (CMK for IL5 customer logs) | Observability | Private Link for Monitor listed public regions only -> AMPLS in Gov UNVERIFIED |
| Microsoft Sentinel | yes | yes (feature gaps listed in research) | UNVERIFIED | yes | yes | yes | SIEM rules | — |
| Defender for Cloud (Containers, Storage, DBs, KV) | yes | yes | UNVERIFIED | yes | yes | yes | Posture, runtime | Defender for AI Services / App Service not in Gov (not needed) |
| Private Link | yes | yes | yes | yes | yes | yes | Everything | — |
| Azure Batch | yes | yes | yes | yes | yes | yes (user-subscription mode + KV) | **not used** (jobs run on AKS, ADR-009) | — |
| Azure Functions | yes | yes | yes | yes | yes | yes | not used by stamps | — |
| Entra ID (Gov) | yes | yes (`login.microsoftonline.us`; CA, PIM, Workload Identities; B2B only Gov<->Gov tenants that support it) | yes | yes | yes | yes | Identity (ADR-010) | External ID gaps -> D13 |
| Azure OpenAI (Gov) | yes | yes (usgovarizona, usgovvirginia only; model list in research) | UNVERIFIED | yes | yes | yes (CMK) | Optional Copilot features only | None required |
| **Azure Health Data Services** | yes | **no** (region table commercial-only; Gov audit table has only Azure API for FHIR, deprecated 2026-09-30) | no | — | — | — | **Model only** | LHDS itself |
| Azure AI Search | yes | yes | UNVERIFIED | yes | yes | yes | Optional index over de-identified sink text | — |
| Data Factory / Synapse / Databricks | yes | yes / yes / partial (AZ, VA; Unity Catalog in Gov a 2026 rollout) | — | yes | yes | yes | Existing Loom analytics, not LHDS core | Loom Unity + Trino (existing) |
| Azure Backup / Site Recovery | yes | yes | yes | yes | yes | yes | Blob vaulted backup; PG uses native backups | — |
| Managed Grafana | yes | yes (enterprise plugins no) | UNVERIFIED | yes | yes | **no** | Dashboards | Log Analytics workbooks at IL5 |
| Azure Load Testing | yes | GA US Gov Virginia (2024-04, research section B) | UNVERIFIED | yes | no | no | Load runs (Commercial + Gov VA) | AKS-hosted Locust job |
| Azure Chaos Studio | yes | **no evidence** (no Gov regions, no audit row) | no | — | — | — | — | Chaos Mesh on AKS |
| DNS Private Resolver | yes | UNVERIFIED (DNS row in scope) | — | yes | yes | yes | Hybrid DNS | — |
| Azure Firewall | yes | yes | yes | yes | yes | yes | Egress control | — |
| Confidential VMs | yes | yes (GA 2026-03-11; regions unnamed) | UNVERIFIED | yes | yes | yes | Optional node pools (D26) | — |
| Elastic SAN | yes | UNVERIFIED (no audit row) | — | — | — | — | not used | — |

## 2. Consequences for the design (already applied)

1. **Stamps on AKS in every cloud** (Container Apps lacks IL4/IL5) — ADR-009.
2. **No Citus / no managed Redis / no managed OpenSearch** in Gov -> per-tenant
   PostgreSQL databases + stamps, in-cluster Valkey, PostgreSQL-only search —
   ADR-003, ADR-004, ADR-008.
3. **Front Door is optional**; App Gateway WAF v2 per stamp is the default
   edge in every cloud.
4. **APIM classic Premium** for routing (Loom already parameterises `apimSku`).
5. **Zone-redundant PostgreSQL HA and geo-redundant backup only in US Gov
   Virginia** -> Virginia is the default Gov primary; the alternate-region
   stamp (Texas or Arizona) uses read replicas + Blob object replication for DR.
6. **Region pairing in Gov is UNVERIFIED on Learn** -> the stamp record names
   its alternate region explicitly.
7. **IL5 = workload isolation**: CMK everywhere (on by default), dedicated/
   isolated node sizes as a bicep param, so IL5 is a param set, not a redesign.
8. **DoD**: the repo's `boundary` enum and params have no DoD entry
   (`platform/fiab/bicep/main.bicep:20`); LHDS inherits this gap and records it
   as D3 (supported-in-code only once the enum exists; never claimed exercised).

## 3. Boundary statement (quoted in the research file)

Azure Government holds FedRAMP High P-ATO and DoD IL2/IL4/IL5 PAs for the US
Gov regions; IL5 in US Gov regions requires extra configuration ("workload
isolation"); "You are responsible for designing and deploying your
applications to meet DoD IL5 compliance requirements." LHDS therefore produces
the evidence pack in `SECURITY-AND-COMPLIANCE.md` section 16 and claims no
authorization.

## 4. Endpoint suffixes used by the stamp bicep (from the Compare page)

ARM `management.usgovcloudapi.net`; login `login.microsoftonline.us`; storage
`*.core.usgovcloudapi.net`; Key Vault `vault.usgovcloudapi.net`; Managed HSM
`managedhsm.usgovcloudapi.net`; PostgreSQL `postgres.database.usgovcloudapi.net`;
ACR `azurecr.us`; Event Hubs / Service Bus `servicebus.usgovcloudapi.net`; APIM
`azure-api.us`; Log Analytics `api.loganalytics.us`; Azure OpenAI `openai.azure.us`.
All resolved through `apps/fiab-console/lib/azure/cloud-endpoints.ts` and the
bicep `environment` param; none hard-coded in LHDS code.

## 5. What W0 closes

Every UNVERIFIED cell above via one Gov Actions run executing
`az provider show -n Microsoft.{ContainerService,DBforPostgreSQL,Storage,EventHub,
ApiManagement,KeyVault,Cdn,Network,LoadTestService,App} --query
"resourceTypes[].{t:resourceType,l:locations}"` and `az account list-locations`
(pairing), plus a PostgreSQL create-blade SKU/SSD v2 probe (`az postgres
flexible-server list-skus --location usgovvirginia`). The receipt goes in
`W0-RECEIPT.md` and this file is updated from it.
