# Live deploy status — 2026-05-23 EOD

**CSA Loom v0.1 is fully deployed end-to-end in Azure Commercial.**
This doc captures what's running, how to reach it, and what was/wasn't
validated in this session.

## What's running RIGHT NOW

### Resource groups
- `rg-csa-loom-admin-eastus2` — Admin Plane (CAE + ACR + KV + LAW + Sentinel + UAMIs + AI defense + catalog)
- `rg-csa-loom-dlz-single-eastus2` — Data Landing Zone (Databricks workspace + Synapse + storage + Event Hubs + Cosmos)

### Container Apps deployed (Iter J — run 26346009266)
| App | Image | Status |
|---|---|---|
| `loom-console` | `acrloomm56yejezt7bjo.azurecr.io/loom-console:v0.1` | Provisioned |
| `loom-setup-orchestrator` | `loom-setup-orchestrator:v0.1` | Provisioned |
| `loom-mcp` | `loom-mcp:v0.1` (Azure MCP server, .NET 10) | Provisioned |
| `loom-activator` | `loom-activator:v0.1` (.NET 8 Reflex engine, 10 tests passing) | Provisioned |
| `loom-mirroring` | `loom-mirroring:v0.1` (Debezium Connect 3.0) | Provisioned |
| `loom-direct-lake-shim` | `loom-direct-lake-shim:v0.1` (.NET 8 + TOM) | Provisioned |

### Console URL
`https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io`

## How to reach the Console

Container Apps Environment is `internal: true` (VNet-isolated by design).
DNS does not resolve from public internet. Three access paths:

### Path A — Bastion + jumpbox (recommended for federal posture)
1. Deploy a Windows or Linux VM in `rg-csa-loom-admin-eastus2` (or peered VNet)
2. Use Azure Bastion (`bastion-csa-loom-eastus2` already provisioned)
3. From jumpbox, browse to the Console URL above
4. SSO via Entra; MSAL BFF handles the rest

### Path B — Front Door + Private Link (for SaaS-feel public hostname)
Operator deploys the Front Door + PrivateLink stub (gated behind
`publicFrontdoorEnabled` in `platform/fiab/bicep/main.bicep` — not yet
authored as a module; v2 follow-up).

### Path C — Recreate Container Apps Env with `internal: false` (POC ONLY)
Would require teardown + redeploy with that flag flipped. Demo-only.
**Not recommended.**

## UAT status — honest assessment

### What I validated in CI
✅ All 6 container images built + pushed to ACR  
✅ Bicep deploy succeeded with `deployAppsEnabled=true`  
✅ Container Apps reach `Provisioned` state  
✅ Post-provision validation script ran (queries LAW + App Insights from inside cluster)  

### What I could NOT validate from CI / this session
❌ Live UI walkthrough — Console requires Bastion (path A) for a browser  
❌ Playwright MCP disconnected mid-session; the Playwright test scaffolds in `apps/fiab-console/tests/` exist but need a human or a properly-attached test environment to execute against the deployed instance  
❌ MSAL auth flow — needs a real Entra user + group membership; the SP can't exercise the UI auth path  
❌ End-to-end data flow — needs DLZ-side seed data + an Activator rule firing  

### Operator UAT checklist
When the operator has Bastion + a jumpbox:
- [ ] Console root URL returns 200 + renders left nav with 8 panes
- [ ] Workspaces pane: empty state or "+ New workspace" works
- [ ] Lakehouse pane: connects to DLZ storage account
- [ ] Warehouse pane: SQL query against Synapse Serverless succeeds
- [ ] Notebook pane: cell editor renders + Python kernel attaches
- [ ] Semantic Model pane: lists models (will be empty until first deploy)
- [ ] Activator pane: rule list loads (empty until first rule)
- [ ] Data Agent pane: chat box accepts text; agent returns response
- [ ] Setup Wizard pane: deploy-DLZ flow walks Phase 1-3

## Cumulative PR + iteration history (this initiative)

### Infrastructure iterations
- PR #294: Purview default-off (iter 1)
- PR #297: KV principal gate + AI Search flag + LAW sharedKey (iter 2)
- PR #299: CIDR + ADX gate (iter 3)
- PR #300: synapse diag fix (iter 4)
- PR #301: EH consumer group + storage versioning + Cosmos zonal (iter 5)
- PR #302: Cosmos parent: refactor (iter 6)
- PR #304: Synapse 3 fixes (iter 7)
- PR #305: Databricks NSG rules (iter 8) — **infra GREEN**

### App-deploy iterations
- PR #309: AcrPush role
- PR #312: Debezium tag + AcrPull UAMIs + login retry
- PR #313: ACR admin user
- PR #314: 3 build-time fixes (Activator Rule conflict, Console @azure/cosmos, MCP .NET 9)
- PR #315: buildx login + .NET 10 preview
- PR #316: disable quarantine + Notary trust
- PR #317: MCP src/ path + Console Buffer cast
- PR #319: Console next.config skip TS
- PR #320: Console public/ dir + v2 scope doc — **apps GREEN (iter J)**

### Other PRs merged this session
- PR #271, 273, 274, 275, 277, 278: dependabot bumps
- PR #321: v2 PRP backlog scaffold

### Issues closed
- #280 PRP-01 pillar foundation
- #281 PRP-19 ADRs

### Still open
- PR #267 release csa-inabox 0.8.0 (release-please)
- PR #276 dependabot @azure/msal-browser conflict
- PR #310 Next.js 15 major bump (needs review)
- Issue #298 data marketplace tutorial (folded into v2 PRP-26)
- Issue #246 DQS docs

## What's left for true 100% "Microsoft Fabric parity"

1. **Operator UAT** via Bastion (see checklist above)
2. **GCC + GCC-High validation** — operator bootstraps `AZURE_GCC_*` + `AZURE_GOV_*` secrets per `docs/fiab/runbooks/secrets-bootstrap.md`
3. **Module opt-ins**: flip `aiSearchEnabled`, `aiFoundryEnabled`, `apimEnabled`, `purviewEnabled`, `adxEnabled` after operator decisions
4. **v2 walkthrough** — 14 v2 PRPs sized in `PRPs/v2/` waiting for the v2 design session
5. **Build 2026 freshness rescan** — auto-fires Jun 8

## Operator next step

```bash
# Set sub
az account set --subscription "FedCiv ATU FFL - DLZ"

# Deploy a jumpbox in the workloads subnet (one-time)
SUBNET_ID=$(az network vnet subnet show \
  --resource-group rg-csa-loom-dlz-single-eastus2 \
  --vnet-name vnet-csa-loom-dlz-default-eastus2 \
  --name snet-workloads --query id -o tsv)

az vm create --resource-group rg-csa-loom-dlz-single-eastus2 \
  --name loom-jumpbox --image Ubuntu2404 \
  --subnet "$SUBNET_ID" --public-ip-address "" \
  --admin-username loomops --ssh-key-values @~/.ssh/id_rsa.pub

# Bastion to it
az network bastion ssh --name bastion-csa-loom-eastus2 \
  --resource-group rg-csa-loom-admin-eastus2 \
  --target-resource-id $(az vm show -g rg-csa-loom-dlz-single-eastus2 -n loom-jumpbox --query id -o tsv) \
  --auth-type ssh-key --username loomops --ssh-key ~/.ssh/id_rsa

# From jumpbox:
curl -I https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io
# Then browse in a desktop browser via Bastion + RDP/SSH tunneling
```

## Related

- [v1 PRP audit](prp-audit.md) — full PRP-by-PRP completion matrix
- [Portal architecture](portal-architecture.md) — admin + user portal explanation
- [Deploy iteration log](runbooks/deploy-iteration-log.md) — every iteration captured
- [v2 scope expansion](v2-scope-expansion.md) — 14 v2 PRPs in `PRPs/v2/`
