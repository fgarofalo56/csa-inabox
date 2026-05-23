# PRP delivery audit

Comprehensive cross-check of every PRP in `PRPs/active/csa-loom/` against
what shipped. Status icons:

- ✅ **Shipped + validated** (real code + tests where applicable)
- 🟡 **Shipped (real code; operator validation pending)**
- ⏸️ **Deferred** (explicit decision in AMENDMENTS or LD)
- ⏳ **Partial / follow-up tracked**

| PRP | Goal | Status | Evidence |
|---|---|---|---|
| PRP-01 | Pillar foundation | ✅ | `docs/fiab/{index,what-is,whitepaper,parity-matrix,architecture}.md`; mkdocs nav slot 6; hero hook; SVG hero |
| PRP-02 | Platform Bicep | ✅ | 14 admin-plane modules + 9 DLZ modules + shared diag helper + 3 .bicepparam; **iter #8 deployed live in Azure Commercial** |
| PRP-03 | Loom Console (Next.js 14 + Fluent v9) | 🟡 | 8 panes (workspaces/lakehouse/warehouse/notebook/semantic-model/activator/data-agent/setup-wizard); MSAL BFF; Cosmos workspace API; CSP+HSTS+SameSite; OpenTelemetry instrumentation hook |
| PRP-04 | Setup Wizard | 🟡 | Console pane state machine + Setup Orchestrator FastAPI backend (2-tier dispatch); telemetry.py wired |
| PRP-05 | Self-hosted Azure MCP Server | 🟡 | Vendor Dockerfile + loom-mcp.json (tool allowlist, PIM elevation, audit, rate limit) |
| PRP-06 | Activator Engine | ✅ | .NET 8 service: all 8 Fabric primitives (PrimitiveEvaluator.cs) + Redis state + Cosmos rule store + 4-sink ActionDispatcher + ADX poller + **10 xUnit tests passing** |
| PRP-07 | Mirroring Engine | 🟡 | Debezium templates (Azure SQL/Postgres/MySQL/Oracle); PySpark replicator + Open Mirroring SDK + Cosmos change-feed + Snowflake STREAM+TASK + **7 pytest tests passing** |
| PRP-08 | Direct-Lake Shim | 🟡 | .NET 8 Event Grid handler + TOM client + Cosmos refresh-policy store + **8 xUnit tests passing** |
| PRP-09 | Loom Data Agents | 🟡 | Extends `apps/copilot/` with 5 tools (NL2SQL/NL2DAX/NL2KQL/Graph/Search); pluggable executors (Databricks-or-Synapse dispatcher, Power BI REST XMLA, Kusto ADX, pyodbc Synapse); CosmosDataAgentsConfigStore; **5 pytest tests passing** |
| PRP-10 | Marketplace Managed App | ⏸️ | Deferred to backlog per LD-4 |
| PRP-11 | Deploy validation | ✅ | 3 nightly workflows (Commercial/GCC/GCC-H) + run_mode input + post-provision validation script + multi-sub-aware teardown + Wave 2 auth fix |
| PRP-12 | Catalog wiring | 🟡 | `catalog.bicep` (Purview Standard + Atlas-on-AKS placeholder); per-boundary endpoint outputs |
| PRP-13 | Defender for AI Sentinel workaround | 🟡 | 2 Scheduled Analytics Rules (`monitoring.bicep`) + Logic App playbook + Sentinel automation rule (`ai-defense.bicep`) |
| PRP-14 | Examples port wave 1 | 🟡 | 8 industry doc pages + `examples/fiab/financial-fraud-detection/` runnable (Spark notebook + 3 activator rules + Loom Data Agent definition) |
| PRP-15 | Workload docs | ✅ | 11 workload-parity pages under `docs/fiab/workloads/` |
| PRP-16 | Deployment docs | ✅ | 9 pages under `docs/fiab/deployment/` |
| PRP-17 | Operations docs | ✅ | 7 ops pages + 14 runbooks under `docs/fiab/runbooks/` |
| PRP-18 | Compliance docs | ✅ | 11 pages: FedRAMP High, SRG IL4/IL5/IL6 maps, ATO, NIST 800-53 r5, audit, MS partner |
| PRP-19 | ADRs | ✅ | 12 ADRs (fiab-0001..fiab-0012 + README) |
| PRP-20 | Tutorials | ✅ | 8 tutorials under `docs/fiab/tutorials/` |
| PRP-21 | Marketing kit | ✅ | 7 marketing pages: pitch deck, seller playbook, demo script, battlecard, one-pager, video plan, federal pitch + brand legal review package |
| PRP-22 | Workshops | ✅ | 3 workshop pages including 5-day Federal CoE + 5-day Commercial CoE |
| PRP-23 | Use cases | ✅ | 5 use-case pages |
| PRP-24 | Cross-link updates | ✅ | `docs/fabric-in-gov-cloud.md` Option 3a callout; `docs/index.md` tip; ADR-0010 addendum; `docs/solution-store/` grid card |
| PRP-25 | Solution-store entry | ✅ | `docs/solution-store/csa-loom/index.md` |

## Engineering audit — what's deployed live (iter #8 success)

Live in Azure Commercial right now (kept per `keep_resources=true`):

- **Network**: Hub VNet + 7 subnets + Bastion Standard + Azure Firewall + 17 private DNS zones
- **Identity**: 7 UAMIs (console, mcp, orchestrator, copilot, activator, mirroring, direct-lake)
- **Security**: Key Vault Premium + private endpoint
- **Container platform**: ACR Premium + private endpoint + Container Apps Env (internal, zone-redundant)
- **Observability**: LAW + AppInsights + Sentinel + 2 AI threat-detection rules
- **AI defense**: Logic App playbook + Sentinel automation rule
- **DLZ network**: Spoke VNet + ADB-compliant NSG + auto-peer to hub
- **DLZ storage**: ADLS Gen2 with HNS + 5 containers + Event Grid system topic + blob/dfs PEs
- **DLZ Databricks**: Premium workspace, VNet-injected, public IP disabled
- **DLZ Synapse**: Serverless SQL pool, managed VNet with exfil prevention, SQL audit policy
- **DLZ Event Hubs**: Kafka surface, PE, auto-inflate
- **DLZ Cosmos DB**: 5 workload databases (mirroring/activator/direct-lake/data-agents/workspace-registry), PE, continuous backup

## Modules gated off (operator opts in per [first-deploy.md](runbooks/first-deploy.md))

| Flag | Reason | Operator opt-in step |
|---|---|---|
| `deployAppsEnabled` | Needs container images in ACR | Build images via ACR Tasks or one-time public-access window |
| `aiFoundryEnabled` | Storage-account strategy decision | Provide AML Hub storage; flip param |
| `apimEnabled` | 30+ min provision | Flip param when comfortable with provision time |
| `aiSearchEnabled` | eastus2 capacity intermittent | Try alternate region; flip param |
| `adxEnabled` | DLZ DB needs cluster pre-provisioned | Deploy admin-plane ADX cluster first |
| `purviewEnabled` | Tenant collision (iter #1) | Decide reuse vs new account (see [purview-tenant-reuse.md](runbooks/purview-tenant-reuse.md)) |
| `synapseRoleAssignmentUamiId` | Needs valid UAMI | Provide UAMI ID; deploy-script auto-runs |

## Outstanding for full Microsoft Fabric parity

- Container images built + pushed to ACR (image-build workflow exists; ACR private-endpoint blocks build runtime — operator picks unblock per [deploy-iteration-log.md](runbooks/deploy-iteration-log.md))
- Apps deployed (depends on images)
- Front-end UI walkthrough via Bastion (Console ingress is VNet-internal by security design)
- GCC + GCC-High validation (secrets bootstrap pending)

## Test coverage summary

| Component | Test framework | Tests | Status |
|---|---|---|---|
| Activator Engine PrimitiveEvaluator | xUnit + FluentAssertions | 10 | ✅ all green |
| Direct-Lake Shim DeltaLogPathParsing | xUnit + FluentAssertions | 8 | ✅ all green |
| Loom Data Agents (NL2SQL/DAX/KQL + extractors) | pytest | 5 | ✅ all green |
| Mirroring Publisher SDK | pytest | 7 | ✅ all green |

## Total cumulative output

| Surface | Count | Notes |
|---|---|---|
| Docs pages under `docs/fiab/` | 117 | Including this audit |
| PRPs | 25 (24 active + 1 README) | PRP-10 deferred |
| Research reports | 7 | `temp/fiab-research/01..07.md` |
| PRD sections + AMENDMENTS | 15 | `temp/fiab-prd/` |
| ADRs (Loom) | 12 | `docs/fiab/adr/0001..0012` |
| Bicep modules | 24 | 14 admin-plane + 9 DLZ + 1 shared |
| Apps with real code | 6 | console, setup-orchestrator, mcp-config, activator-engine, mirroring-engine, direct-lake-shim |
| Loom Data Agents tools | 5 | NL2SQL/NL2DAX/NL2KQL/GraphSearch/CustomSearch |
| GitHub workflows (deploy + build + teardown + freshness) | 7 | All wired |
| PRs merged this initiative | 15+ | See `git log` for v0.1 → Wave 1 → Wave 2 → Wave 3 → deploy iterations |
| Real Azure validations | 1 successful provision + 8 documented iteration cycles | iter #8 deployed live |
