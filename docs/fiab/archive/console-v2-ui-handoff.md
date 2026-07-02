# Console v2 UI handoff brief

Date: 2026-05-24
Status: in-flight, next session takes over UI expansion

## Live URLs (validated GREEN end-to-end this session)

- **Front Door Premium (public)**: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/`
- **App Gateway v2 + WAF (public)**: `http://loom-m56yejezt7bjo.eastus2.cloudapp.azure.com/`
- **Internal env FQDN**: `https://loom-console.delightfulmoss-96202bfd.eastus2.azurecontainerapps.io/` (via jumpbox or peered VNet)
- **VPN Gateway**: provisioned in `rg-csa-loom-admin-eastus2`
- **Jumpbox**: `loom-uat-jumpbox` in `rg-csa-loom-dlz-single-eastus2` (AAD-SSH, Playwright pre-installed)

## Resource IDs

- Sub: `<YOUR_DLZ_SUBSCRIPTION_ID>`
- Admin Plane RG: `rg-csa-loom-admin-eastus2`
- DLZ RG: `rg-csa-loom-dlz-single-eastus2`
- ACR: `acrloomm56yejezt7bjo` (private endpoint)
- ACA env: `cae-csa-loom-eastus2` (internal, static IP `10.0.2.85`, default domain `delightfulmoss-96202bfd.eastus2.azurecontainerapps.io`)
- Container Apps: `loom-console`, `loom-mcp`, `loom-setup-orchestrator`, `loom-activator`, `loom-mirroring`, `loom-direct-lake-shim` (all on `v0.7`)
- Console revision: `loom-console--0000008` (Healthy, traffic 100%, external ingress)
- Front Door profile: `fd-loom-m56yejezt7bjo`

## What Console has TODAY (don't rebuild)

8 routes under `apps/fiab-console/app/`:
`/`, `/lakehouse`, `/warehouse`, `/notebook`, `/semantic-model`, `/activator`, `/data-agent`, `/setup`

Each uses Fluent UI v9. Pane code is at `apps/fiab-console/lib/panes/*.tsx`.

BFF API routes all return 200:
`/api/workspaces`, `/api/health`, `/api/lakehouse/tables`, `/api/warehouse/query`, `/api/notebook/execute`, `/api/data-agent/chat`, `/api/setup/deploy`

Left nav was already refactored to top-level Fabric-style entries (commit `84f890ce`): Home / Workspaces / Browse / OneLake catalog / Monitor / Real-Time hub / Data agent / Copilot / Workload hub / Deployment / Admin portal / Setup. **No pages exist for the new entries** - clicking them 404s. Build them.

## Fabric inventory (source: MS Learn Fabric REST API item definitions list)

Use `microsoft_docs_search` + `microsoft_docs_fetch` to verify; here's the snapshot as of 2026-05-24:

| Workload | Item types |
|---|---|
| Data Engineering | Lakehouse, Notebook, Spark job definition, Environment |
| Data Factory | Data pipeline, Dataflow Gen2, Copy job, Mirrored database, Mirrored catalog, dbt job, Mounted Data Factory |
| Data Warehouse | Warehouse, SQL analytics endpoint |
| Databases | SQL Database |
| Real-Time Intelligence | Eventhouse, KQL database, KQL queryset, KQL dashboard, Eventstream, Event schema set, Activator (Reflex) |
| Data Science | ML model, ML experiment |
| Fabric IQ (preview) | Graph model, Ontology, Plan, Maps |
| Power BI | Semantic model, Report, Dashboard, Paginated report, Scorecard |
| APIs | GraphQL API, User data function, Variable library |

### Cross-cutting surfaces Loom is missing

- **OneLake catalog** (governance, discovery, lineage)
- **Monitor hub** (per-item run history)
- **Real-Time hub** (event source discovery + subscriptions)
- **Workload hub** ("more workloads")
- **Admin portal** (tenant settings, capacity admin, security, audit, usage)
- **Deployment pipelines** (dev/test/prod promotion)
- **Git integration** (Azure DevOps / GitHub sync)
- **Workspaces** as root nav primitive (Fabric organizes around workspaces)
- **+ New item dialog** showing all ~40 item types categorized by workload
- **Sharing + permissions + sensitivity labels** per item
- **Copilot** embedded in every editor
- **Sign in / sign out** with Entra (currently mocked - no MSAL flow)

## What does NOT work

- Login / sign out (no MSAL flow wired)
- Real item creation (everything stub)
- Admin center
- Pipelines / dataflows / Power BI surfaces
- ETL/ELT UX (Notebook + Warehouse query box are placeholders)
- Sharing / permissions / sensitivity labels
- Deployment pipelines / Git integration
- Per-item editors (Notebook editor is a single textarea; real Fabric notebook = cells + outputs + kernel state)

## Tooling gotchas (read before starting)

1. **Write tool intermittently fails on large content** with `required parameter file_path is missing`. Workaround: write small files (~1KB), expand with `Edit`.
2. **Bash heredocs truncate** on Windows MSYS for the same reason. Same workaround.
3. **GHA Docker layer cache** reuses old layers even when source changes. Bump `apps/fiab-console/.build-marker` each iteration.
4. **Bicep redeploy flips Console ingress to `internal`** because `app-deployments.bicep` defaults `external: false`. After any Bicep redeploy: `az containerapp ingress update -g rg-csa-loom-admin-eastus2 -n loom-console --type external`.
5. **ACA probes**: Bicep adds liveness + readiness probes at `/api/health`. Workers need that route OR probes stripped via REST PUT (pattern in commit `02f603e5`).
6. **Front Door PE approval**: not auto-approved. After FD redeploy: `az rest PUT` on the ACA env's `privateEndpointConnections` (see this session's log for URI).

## Deploy + UAT loop

```
# 1. Make changes on the branch
git checkout access-patterns-vpn-agw-fd

# 2. Bump cache-bust marker
date +%s > apps/fiab-console/.build-marker

# 3. Commit + push
git add ... && git commit -m "..." && git push

# 4. Trigger build (tag bumps each iteration)
gh workflow run full-app-deploy-commercial --ref access-patterns-vpn-agw-fd \
  -f tag=v0.X -f skip_build=false -f enable_apps_after=false

# 5. Wait ~6-8 min; bump container
az containerapp update -g rg-csa-loom-admin-eastus2 -n loom-console \
  --image acrloomm56yejezt7bjo.azurecr.io/loom-console:v0.X

# 6. If Bicep ran: flip ingress back external
az containerapp ingress update -g rg-csa-loom-admin-eastus2 -n loom-console --type external

# 7. Run Playwright e2e from laptop
cd temp/uat-pw
node e2e.mjs https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net
```

E2E script lives at `apps/fiab-console/tests/uat-fd.mjs` (also at `temp/uat-pw/e2e.mjs` with the more thorough version that captures API calls + clicks first button per pane).
