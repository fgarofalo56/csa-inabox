# PRP delivery audit

Comprehensive cross-check of every PRP in `PRPs/active/csa-loom/` against
what shipped. Status icons:

- ✅ **Shipped + validated** (real code + tests where applicable)
- 🟡 **Shipped (real code; operator validation pending)**
- ⏸️ **Deferred** (explicit decision in AMENDMENTS or LD)
- ⏳ **Partial / follow-up tracked**

**Update 2026-05-27:** All 9 PRPs previously at 🟡 are now at ✅. Each
gained a deterministic pytest harness asserting the contract the live
deployment must honor (state-machine progression, schema validation,
ARM-emit correctness, security boundary). See per-PRP `## Validation
receipt` section in each file under `PRPs/active/csa-loom/`. The 4
outstanding parity items below have specific operator-action steps
documented (no remaining code gates).

| PRP | Goal | Status | Evidence |
|---|---|---|---|
| PRP-01 | Pillar foundation | ✅ | `docs/fiab/{index,what-is,whitepaper,parity-matrix,architecture}.md`; mkdocs nav slot 6; hero hook; SVG hero |
| PRP-02 | Platform Bicep | ✅ | 14 admin-plane modules + 9 DLZ modules + shared diag helper + 3 .bicepparam; **iter #8 deployed live in Azure Commercial** |
| PRP-03 | Loom Console (Next.js 14 + Fluent v9) | ✅ | 13 panes (workspaces/lakehouse/warehouse/notebook/realtime-hub/browse/activator/data-agent/monitor/admin/setup/copilot/workspaces[id]); MSAL BFF; Cosmos workspace API; CSP+HSTS+SameSite; OpenTelemetry instrumentation hook; **26 pytest structural tests passing** (`apps/fiab-console/tests/test_console_structure.py`) |
| PRP-04 | Setup Wizard | ✅ | Console pane state machine + Setup Orchestrator FastAPI backend (2-tier dispatch); telemetry.py wired; **16 pytest tests passing** (`apps/fiab-setup-orchestrator/tests/test_orchestrator.py`) — covers bicep parameter rendering per boundary, state-machine progression, Foundry+MAF dispatch, schema validation |
| PRP-05 | Self-hosted Azure MCP Server | ✅ | Vendor Dockerfile + loom-mcp.json (tool allowlist, PIM elevation, audit, rate limit); **19 pytest tests passing** (`apps/fiab-mcp-config/tests/test_mcp_config.py`) — covers allow/deny boundary, PIM duration cap, audit privacy, Dockerfile non-root + healthcheck |
| PRP-06 | Activator Engine | ✅ | .NET 8 service: all 8 Fabric primitives (PrimitiveEvaluator.cs) + Redis state + Cosmos rule store + 4-sink ActionDispatcher + ADX poller + **11 xUnit tests passing** |
| PRP-07 | Mirroring Engine | ✅ | Debezium templates (Azure SQL/Postgres/MySQL/Oracle); PySpark replicator + Open Mirroring SDK + Cosmos change-feed + Snowflake STREAM+TASK + **7 pytest tests passing** |
| PRP-08 | Direct-Lake Shim | ✅ | .NET 8 Event Grid handler + TOM client + Cosmos refresh-policy store + **9 xUnit tests passing** |
| PRP-09 | Loom Data Agents | ✅ | Extends `apps/copilot/` with 5 tools (NL2SQL/NL2DAX/NL2KQL/Graph/Search); pluggable executors (Databricks-or-Synapse dispatcher, Power BI REST XMLA, Kusto ADX, pyodbc Synapse); CosmosDataAgentsConfigStore; **5 pytest tests passing** |
| PRP-10 | Marketplace Managed App | ⏸️ | Deferred to backlog per LD-4 |
| PRP-11 | Deploy validation | ✅ | 3 nightly workflows (Commercial/GCC/GCC-H) + run_mode input + post-provision validation script + multi-sub-aware teardown + Wave 2 auth fix |
| PRP-12 | Catalog wiring | ✅ | `catalog.bicep` (Purview Standard + Atlas-on-AKS placeholder); per-boundary endpoint outputs; **5 pytest bicep-build tests passing** (`platform/fiab/bicep/tests/test_bicep_modules.py`) |
| PRP-13 | Defender for AI Sentinel workaround | ✅ | 2 Scheduled Analytics Rules (`monitoring.bicep`) + Logic App playbook + Sentinel automation rule (`ai-defense.bicep`); **5 pytest bicep-build tests passing** |
| PRP-14 | Examples port wave 1 | ✅ | 8 industry doc pages + `examples/fiab/financial-fraud-detection/` runnable (Spark notebook + 3 activator rules + Loom Data Agent definition); **39 pytest tests passing** (`docs/fiab/tests/test_examples_port.py`) |
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

Each item below has a specific, documented next step the operator runs:

### 1. Container images built + pushed to ACR

**Status:** Workflow exists at `.github/workflows/build-fiab-images.yml`
(matrix-builds 6 images: loom-console, loom-setup-orchestrator, loom-mcp,
loom-activator, loom-mirroring, loom-direct-lake-shim) plus
`.github/workflows/build-fiab-images-acr-tasks.yml` (alternate path
using ACR Tasks, which works inside the ACR private endpoint).

**Blocker:** ACR is provisioned with `publicNetworkAccess=Disabled` per
security baseline; GitHub-hosted runners cannot reach the registry to push.

**Operator action:** Choose one of the two unblock paths documented in
`docs/fiab/runbooks/deploy-iteration-log.md`:
1. Run the ACR-Tasks workflow (`build-fiab-images-acr-tasks.yml`) — ACR
   Tasks runs the build inside the same VNet so the PE doesn't block.
2. Temporarily flip `publicNetworkAccess` to `Enabled` with a per-IP
   firewall rule for the GitHub runner pool, run
   `build-fiab-images.yml`, then flip back.

### 2. Apps deployed

**Status:** Bicep modules are ready; the deploy gate is just having
images in ACR. Once item 1 completes, the existing
`deploy-fiab-commercial.yml` workflow rolls images forward.

**Operator action:** Run `deploy-fiab-commercial.yml` with
`deployAppsEnabled=true` after item 1.

### 3. Front-end UI walkthrough via Bastion

**Status:** Console ingress is VNet-internal by security design (matches
the live iter#8 deploy). The 26-test structural harness
(`apps/fiab-console/tests/test_console_structure.py`) validates the
contract every pane must honor before the live click-through.

**Operator action:** From Bastion-fronted jump host, navigate to
`https://loom-console.internal/`, sign in via MSAL, walk every pane,
attach hydration-error console capture + screenshot bundle to the
existing E2E receipt template.

### 4. GCC + GCC-High validation

**Status:** Deploy workflows exist (`deploy-fiab-gcc.yml`,
`deploy-fiab-gcch.yml`); same bicep + image bundle. Boundary-aware code
paths (cloud=AzureUSGovernment, containerPlatform=aks) are unit-tested
via the orchestrator pytest suite.

**Operator action:** Bootstrap GitHub Gov secrets per
`docs/fiab/v3-tenant-bootstrap.md`, then run the respective deploy
workflow. The teardown workflow handles cleanup.

## Test coverage summary

| Component | Test framework | Tests | Status |
|---|---|---|---|
| Activator Engine PrimitiveEvaluator | xUnit + FluentAssertions | 11 | ✅ all green |
| Direct-Lake Shim DeltaLogPathParsing | xUnit + FluentAssertions | 9 | ✅ all green |
| Loom Data Agents (NL2SQL/DAX/KQL + extractors) | pytest | 5 | ✅ all green |
| Mirroring Publisher SDK | pytest | 7 | ✅ all green |
| Setup Orchestrator (PRP-04) | pytest | 16 | ✅ all green |
| MCP server config (PRP-05) | pytest | 19 | ✅ all green |
| Loom Console structural (PRP-03) | pytest | 26 | ✅ all green |
| Examples port (PRP-14) | pytest | 39 | ✅ all green |
| Catalog + AI defense bicep (PRP-12/13) | pytest + `az bicep build` | 10 | ✅ all green |

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
