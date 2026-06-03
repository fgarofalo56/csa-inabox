# Multi-Subscription Deployment Guide

## Overview

CSA Loom supports two distinct deployment topologies:

### Single-Subscription (Default)
Admin Plane + DLZ + all 21 deploy-planner services (Postgres, MySQL, Redis, Functions, etc.) deploy into ONE subscription. Simple, low-ops footprint. Ideal for dev/test or single-tenant analytics teams.

**Resource layout:**
- `rg-csa-loom-admin-<region>` — Hub VNet, Console, MCP server, Copilot orchestrator
- `rg-csa-loom-dlz-single-<region>` — Lakehouse, Databricks, Synapse, ADX, Cosmos, + all deploy-planner services

### Multi-Subscription (New)
Admin Plane in a HUB subscription; one or more DLZ spokes in OTHER subscriptions (per domain). Deploy-planner services skip (each spoke team brings their own tenant-isolated instances). Recommended for federal multi-tenant environments.

**Resource layout:**
- Hub subscription: `rg-csa-loom-admin-<region>` — Shared governance, console, networking
- Spoke 1: `rg-csa-loom-dlz-mission-ops-<region>` — Mission Ops DLZ, no shared services
- Spoke 2: `rg-csa-loom-dlz-finance-<region>` — Finance DLZ, no shared services
- Network: Hub-spoke peering, shared private DNS zones, centralized logging

---

## Setup Wizard: Single-Sub vs Multi-Sub

### Single-Subscription Workflow

1. **Boundary**: Select cloud (Commercial, GCC, GCC-High, IL5)
2. **Mode**: Choose "Single subscription"
3. **Subscription & region**: Pick the subscription + region
4. **Domain name**: Name the DLZ (e.g., "finance")
5. **Capacity sizing**: Choose F-SKU equivalence (F2–F512)
6. **Review & deploy**: Confirm, then run the `az deployment sub create` command

Result: Everything deploys into the selected subscription. Post-deploy, run:
```bash
bash scripts/csa-loom/post-deploy-bootstrap.sh
```

---

### Multi-Subscription Workflow: Route A (Wire New)

Deploy a fresh DLZ into a spoke subscription.

1. **Boundary**: Select cloud (GCC-High / IL5 recommended for federal)
2. **Mode**: Choose "Multi-subscription"
3. **Multi-sub choice**: Select "Wire new DLZ"
4. **Subscriptions & region**: 
   - Pick the **hub subscription** (where Admin Plane lands)
   - Pick the **spoke subscription** (where DLZ lands — must be different)
   - Pick the shared **region**
5. **Domain name**: Name the spoke DLZ (e.g., "mission-ops")
6. **Capacity sizing**: Choose F-SKU for the DLZ
7. **Review & deploy**: Confirm, then:
   - Pre-create the DLZ RG in the spoke: `az group create --name rg-csa-loom-dlz-mission-ops-<region> --location <region> --subscription <spoke-sub-id>`
   - Run the `az deployment sub create` command (routed from hub subscription)
   - Run post-deploy scripts:
     ```bash
     bash scripts/csa-loom/grant-navigator-rbac.sh SUB=<hub-sub> DLZ_RG=rg-csa-loom-dlz-mission-ops-<region>
     bash scripts/csa-loom/patch-navigator-env.sh SUB=<hub-sub> DLZ_RG=rg-csa-loom-dlz-mission-ops-<region>
     ```

Result: Admin Plane in hub, fresh DLZ in spoke, navigators auto-wired.

---

### Multi-Subscription Workflow: Route B (Wire Existing)

Reuse a DLZ that's already deployed in another subscription. No re-deployment, no downtime.

1. **Boundary**: Select cloud
2. **Mode**: Choose "Multi-subscription"
3. **Multi-sub choice**: Select "Wire existing DLZ"
4. **Hub subscription & region**: Pick where the Admin Plane is
5. **Review & deploy**: The wizard discovers existing DLZs in your tenant, shows a checklist, and wires them:
   - Grants Console UAMI navigator roles on each DLZ RG
   - Discovers services (Cosmos, Event Hubs, ADX, etc.)
   - Patches environment variables into the loom-console Container App

Result: Existing DLZ now visible in navigators, no pods redeployed (except console for env-var update).

---

## Bicep: Topology Implementation

### Single-Sub (deploymentMode = 'single-sub')

**main.bicep lines 370–414:**
```bicep
resource singleDlzRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deploymentMode == 'single-sub') {
  name: 'rg-csa-loom-dlz-single-${location}'
  location: location
  tags: complianceTags
}

module singleDlz 'modules/landing-zone/main.bicep' = if (deploymentMode == 'single-sub') {
  name: 'dlz-single'
  scope: singleDlzRg
  params: {
    domainName: 'default'
    ...
  }
}
```

**Deploy-planner modules gate on `deploymentMode == 'single-sub'`:**
- Lines 458, 469, 480, etc.: Each module conditionally deploys
- Result: All 21 services (Postgres, MySQL, Redis, Functions, etc.) provision in the DLZ RG

### Multi-Sub (deploymentMode = 'multi-sub')

**main.bicep lines 419–430:**
```bicep
@batchSize(1)
module dlz 'modules/landing-zone/main.bicep' = [for (subId, i) in dlzSubscriptionIds: if (deploymentMode == 'multi-sub') {
  name: 'dlz-${i}'
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
  params: {
    domainName: dlzDomainNames[i]
    ...
  }
}]
```

**Deploy-planner modules skip** (conditional skips):
- Line 458: `if (deploymentMode == 'single-sub' && postgresEnabled)` → No Postgres in multi-sub
- All 21 deploy-planner modules follow the same pattern
- Result: Only lakehouse + core DLZ data plane deploys; no shared services

---

## Navigator Environment Wiring

### Post-Deploy Scripts (Idempotent)

#### grant-navigator-rbac.sh
Grants the Console UAMI the roles needed to read/manage each service:
- Event Hubs: Data Owner + Contributor
- Cosmos: DocumentDB Account Contributor + Cosmos DB Built-in Data Contributor
- ADX: AllDatabasesAdmin principal-assignment
- AI Search: Service Contributor + Index Data Contributor
- AOAI: Cognitive Services Contributor
- DLZ RG: Reader (for ARM list)

**Usage:**
```bash
bash scripts/csa-loom/grant-navigator-rbac.sh SUB=<hub-sub> ADMIN_RG=rg-csa-loom-admin-<region> DLZ_RG=<dlz-rg>
```

#### patch-navigator-env.sh
Discovery + environment-variable patching. Honors reuse-first logic:
1. Check if service is EXISTING_* override → use that
2. Else discover in DLZ or admin RG
3. Else leave unset (navigator shows honest gate)

Patches the loom-console Container App with a single `az containerapp update --set-env-vars` merge.

**Usage:**
```bash
bash scripts/csa-loom/patch-navigator-env.sh SUB=<hub-sub> ADMIN_RG=rg-csa-loom-admin-<region> DLZ_RG=<dlz-rg>
```

---

## Deployment: dlzSubscriptionIds + dlzDomainNames Pairing

The Bicep accepts two arrays that pair 1:1:

```bicep
param dlzSubscriptionIds array = []  // ['<spoke-sub-1-guid>', '<spoke-sub-2-guid>']
param dlzDomainNames array = []       // ['mission-ops', 'finance']
```

In bicep, the loop matches them:
```bicep
[for (subId, i) in dlzSubscriptionIds: {
  scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')
}]
```

### Example: Two Spokes

**Bicep call:**
```bash
az deployment sub create \
  --subscription <hub-sub> \
  -f platform/fiab/bicep/main.bicep \
  -p <boundary>.bicepparam \
  -p boundary=GCC-High deploymentMode=multi-sub \
  -p dlzSubscriptionIds="['<spoke-1-guid>', '<spoke-2-guid>']" \
  -p dlzDomainNames="['mission-ops', 'finance']" \
  -p capacitySku=F8
```

**Pre-deploy requirement:**
Operator must pre-create the RGs in each spoke:
```bash
az group create --name rg-csa-loom-dlz-mission-ops-<region> --location <region> --subscription <spoke-1-guid>
az group create --name rg-csa-loom-dlz-finance-<region> --location <region> --subscription <spoke-2-guid>
```

**Post-deploy:**
Wire navigators for each DLZ:
```bash
bash scripts/csa-loom/grant-navigator-rbac.sh SUB=<hub> DLZ_RG=rg-csa-loom-dlz-mission-ops-<region>
bash scripts/csa-loom/patch-navigator-env.sh SUB=<hub> DLZ_RG=rg-csa-loom-dlz-mission-ops-<region>

bash scripts/csa-loom/grant-navigator-rbac.sh SUB=<hub> DLZ_RG=rg-csa-loom-dlz-finance-<region>
bash scripts/csa-loom/patch-navigator-env.sh SUB=<hub> DLZ_RG=rg-csa-loom-dlz-finance-<region>
```

---

## Boundary-Specific Defaults

Both single-sub and multi-sub use the same per-boundary .bicepparam files. The setup wizard routes based on boundary:

| Boundary | File | deploymentMode | Notes |
|----------|------|-----------------|-------|
| Commercial | commercial-full.bicepparam | single-sub | Defaults: all 21 deploy-planner services on |
| GCC | gcc.bicepparam | single-sub | Defaults: all 21 deploy-planner services on |
| GCC-High | gcc-high.bicepparam | multi-sub (default) | Defaults: dlzSubscriptionIds=[], dlzDomainNames=[] (empty) |
| IL5 | il5.bicepparam | multi-sub (default) | Defaults: dlzSubscriptionIds=[], dlzDomainNames=[] (empty), CMK+HSM required |

---

## Troubleshooting

### Multi-Sub Wire-Existing: Navigator Still Gated
After running `patch-navigator-env.sh`, the navigator may show an honest gate for 30–60 seconds while:
1. The loom-console Container App revision updates (env vars merge)
2. The pod restarts and discovers the patched env vars
3. The service discoverer queries the real resources

Wait, then refresh the Console.

### DLZ RG Pre-Creation: "ResourceGroupNotFound"
In multi-sub wire-new, you must pre-create the DLZ RG in the spoke subscription:
```bash
az group create --name rg-csa-loom-dlz-<domain>-<region> --location <region> --subscription <spoke-sub>
```

The bicep will NOT create it (subscription-scoped ARM deployments cannot create RGs in remote subscriptions).

### RBAC Grant Fails: "Your request has been throttled or you lack permissions"
Ensure the identity running the post-deploy scripts has **Contributor** on both the admin RG and the DLZ RG. Additionally, RBAC changes may take 60+ seconds to propagate in AAD.

### Wire-Existing: Services Not Discovered
Check that:
1. The DLZ RG name matches exactly: `rg-csa-loom-dlz-<domain>-<region>`
2. The services are deployed (check with `az cosmosdb list -g <dlz-rg>`)
3. Run `patch-navigator-env.sh` with verbose output to debug: redirect stderr to see the `az` queries

---

## Learn More

- [Bring-Your-Own Services](./bring-your-own-services.md) — Reuse existing resources across DLZs
- [RBAC & Network Setup](./network-and-rbac.md) — Deep dive into hub-spoke peering and private DNS
- [Post-Deploy Bootstrap](./post-deploy-bootstrap.md) — Full list of bootstrap tasks
