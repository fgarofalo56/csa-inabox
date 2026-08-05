# Loom first deploy — operator runbook

Step-by-step for an operator standing up CSA Loom in a new
subscription for the first time. Assumes you have:

- Owner on the target subscription (or Contributor + User Access
  Administrator)
- Ability to create an Entra group + service principal in the tenant
- Decision authority on shared services (Purview, AI Foundry Hub)

Total wall time: roughly 60-90 minutes including provision +
verification.

## Phase 1 — secrets bootstrap (10 min)

Follow [Secrets bootstrap per boundary](secrets-bootstrap.md). You
need the deploy SP + admin group object ID + 5 GitHub secrets per
boundary.

Verify by dispatching the workflow in `whatif-only` mode (no spend):

```bash
gh workflow run deploy-fiab-commercial -f run_mode=whatif-only
gh run watch $(gh run list --workflow deploy-fiab-commercial --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected: green run in under 1 minute. If red, see [Deploy failure
runbook](deploy-failure.md).

## Phase 2 — tenant-state decisions (5 min, async-bounded)

Walk these checklists BEFORE any real provisioning:

### Purview

See [Purview tenant-existing-account reuse](purview-tenant-reuse.md).
The default is **per boundary**, not global: `true` in
`commercial.bicepparam`, `commercial-full.bicepparam` (via
`LOOM_PURVIEW_ENABLED`), `gcc.bicepparam` and `tenant-dmlz.bicepparam`;
`false` in `gcc-high.bicepparam` (reuse the tenant Enterprise Purview) and
`il5.bicepparam` (Atlas on AKS instead). Decide:

- [ ] Greenfield tenant → leave `true` (or flip it on for GCC-High)
- [ ] Existing Purview → **adopt it**: set `EXISTING_PURVIEW` (+ `_RG`, `_SUB`)
      **and** `purviewEnabled=false`. Only one Enterprise Purview is allowed per
      tenant; setting `EXISTING_PURVIEW` alone does **not** suppress creation and
      the deploy fails `EnterpriseTenantAlreadyExists`. See
      [Brownfield deployment](../deployment/brownfield.md)
- [ ] Region has no Purview (e.g. `centralus`) → `purviewEnabled=false`; the
      Loom catalog falls back to its Azure-native backend

### AI Foundry Hub

Loom creates one Hub per Admin Plane. If your tenant already has a
designated AI Foundry Hub:

- [ ] Reuse → set `foundryPortalEnabled = false` (uses Azure ML
      classic Workspace instead; Loom Data Agents still work)
- [ ] Create new → keep default

### Capacity SKU

Drives Databricks cluster size + ADX SKU + Power BI capacity. F8 is
the recommended starting point for production; F2/F4 for dev/test.

```bicep
param capacitySku = 'F8'   // F2 / F4 / F8 / F32 / F64 / F128 / F512
```

### Multi-sub vs single-sub

- **single-sub** (default) — Admin Plane + DLZ in same sub. Right
  for most starts.
- **multi-sub** — One Admin Plane sub + one sub per DLZ. Required
  when DLZs have different audit boundaries (e.g., one DLZ for
  finance under SOX, another for HR under different controls).

```bicep
param deploymentMode = 'single-sub'   // or 'multi-sub'
```

For multi-sub, pre-create the DLZ RGs in the target subs:

```bash
scripts/csa-loom/bootstrap-dlz-rgs.sh eastus2 \
  "<sub-id-1>,<sub-id-2>" \
  "finance,procurement"
```

## Phase 3 — full provision (30-60 min)

> **This workflow is a CI validation lane by default, not the customer install
> path.** `keep_resources` defaults to **false**, and in `run_mode=full` the
> teardown step then fires on success — it enumerates `rg-csa-loom-*` across the
> subscription and deletes every match, purging Key Vaults and Cognitive
> Services accounts. `deploy_apps_enabled` also defaults to **false**, so
> without it no Container Apps are created and there is no Console to open.
>
> **For a real install, follow [Greenfield deployment](../deployment/greenfield.md)**
> — the three-phase `az deployment sub create` path. Use the dispatch below only
> when you want the workflow to drive it, and only with both overrides set.

Once decisions are locked, dispatch the full deploy:

```bash
gh workflow run deploy-fiab-commercial \
  -f run_mode=full \
  -f keep_resources=true \
  -f deploy_apps_enabled=true

# Watch — provisioning takes ~25-45 minutes for first run
RUN_ID=$(gh run list --workflow deploy-fiab-commercial --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --exit-status
```

> `deploy_apps_enabled=true` only works when the app images already exist in the
> deployment's ACR. On a from-scratch subscription the ACR is created empty —
> run the image phase first
> ([Greenfield, phase 2](../deployment/greenfield.md#phase-2-build-the-images-and-bring-the-apps-up-1525-min)).
>
> If the target subscription already holds a Loom hub, add
> `-f allow_existing_hub=true` to reconcile it rather than being rejected by the
> topology guard.

What this provisions:
- Admin Plane RG with all 12 sub-modules (network, identity, KV,
  monitoring, ACR, container platform, AI Search, AI Foundry Hub,
  APIM, catalog, AI defense, app deployments)
- Single-sub DLZ RG with all 7 sub-modules (network, storage,
  Databricks, Synapse, Event Hubs, ADX database, Cosmos)
- Container Apps for every app — **only when `deploy_apps_enabled=true`**
- Smoke test executes against the live apps
- Teardown on success — **unless `keep_resources=true`**

## Phase 4 — verification (15 min)

After provisioning succeeds:

### Open Loom Console

```bash
# Get the Console URL from azd output
CONSOLE_URL=$(az deployment sub show \
  --name csa-loom-ci-$RUN_ID \
  --query "properties.outputs.consoleUrl.value" -o tsv)
echo "$CONSOLE_URL"
```

Walk through every pane:
- [ ] Workspaces — at least the default workspace shows
- [ ] Lakehouse — bronze/silver/gold containers visible
- [ ] Warehouse — sample T-SQL query returns
- [ ] Notebook — empty notebook opens; new cell saves
- [ ] Semantic Model — refresh policy table loads
- [ ] Activator — example rule list loads
- [ ] Data Agent — chat returns a clarifying question to a basic prompt
- [ ] Setup Wizard — opens to intro step

### Check telemetry flowing

```bash
LAW_NAME="law-csa-loom-eastus2"
RG="rg-csa-loom-admin-eastus2"

az monitor log-analytics query \
  --workspace "$(az monitor log-analytics workspace show --resource-group $RG --workspace-name $LAW_NAME --query customerId -o tsv)" \
  --analytics-query "AppRequests | where TimeGenerated > ago(15m) | summarize count() by AppRoleName" \
  -o table
```

Expected: rows for every deployed service (`loom-console`,
`loom-orchestrator`, `loom-mcp`, etc.).

### Check audit logs landing

Wait 10 minutes after first user action, then query per [Synapse
audit query pack](synapse-audit-query-pack.md) and [Loom LAW
monitoring + alert pack](loom-law-monitoring.md).

## Phase 5 — operational handoff

After verification:

- [ ] Add the admin group to PIM-for-Groups for JIT Contributor
      elevation (used by Loom Setup Wizard for DLZ creation)
- [ ] Configure the Teams webhook secret (`ops-teams-webhook` in
      Key Vault) for AI defense playbook + Activator dispatch
- [ ] Schedule cost reports per [LAW monitoring](loom-law-monitoring.md)
      Cost monitoring section
- [ ] Run the workshop in [5-day Federal CoE](../workshops/5-day-federal-coe/index.md)
      with operators

## Backout

If the first deploy is going badly and you want to start over:

```bash
# Teardown script (or wait for the workflow's automatic teardown)
RG="rg-csa-loom-admin-eastus2" \
  bash .github/scripts/fiab-teardown.sh

# Verify all Loom RGs are gone
az group list --query "[?starts_with(name, 'rg-csa-loom-')].name" -o tsv
```

The teardown script purges Key Vaults + Managed HSMs before RG
delete, so subsequent runs don't collide on soft-deleted names.

## Related

- [Secrets bootstrap](secrets-bootstrap.md)
- [Purview tenant reuse](purview-tenant-reuse.md)
- [Deploy failure](deploy-failure.md)
- [Loom LAW monitoring + alert pack](loom-law-monitoring.md)
- [DLZ onboard new domain](dlz-onboard-new-domain.md) — for adding
  subsequent DLZs after first deploy
