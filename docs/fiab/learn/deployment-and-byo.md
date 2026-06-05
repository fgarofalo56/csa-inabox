# Deployment & BYO (bring-your-own)

CSA Loom is **reuse-first**: every backing Azure service can either be **reused**
from a resource that already exists in any subscription/resource group, or
**provisioned new** by the deploy — controlled per-service via parameters,
environment variables, or the live-wiring scripts. This guide covers the
push-button deploy and the bring-your-own (BYO) model.

## When to use which path

| Path | Use when |
|---|---|
| **Provision new** | Greenfield: let the deploy stand up every backing service. |
| **Reuse existing (BYO)** | You already run AI Search / APIM / Purview / Cosmos / Databricks etc. and want Loom to wire to them rather than duplicate. |
| **Honest gate** | A service isn't deployed yet — the navigator renders a `MessageBar` naming the exact config to set, never a fake. |

## Quick start (provision new)

The fastest happy path is `git clone` → working Console URL in ~60 minutes on
Azure Commercial. In outline (full steps in [Quick Start](../deployment/quickstart.md)):

1. **Clone + authenticate** — `git clone`, `az login`, `azd auth login`, set the
   subscription.
2. **Create the Loom Admins Entra group** and add yourself; note its object ID.
3. **`azd init -t .`** — choose environment name, region, **Boundary**
   (Commercial / GCC / GCC-High), deployment mode, capacity SKU, and paste the
   admin group ID.
4. **Deploy** — `az deployment sub create -f platform/fiab/bicep/main.bicep -p
   platform/fiab/bicep/params/commercial-full.bicepparam` (or `azd up`).
5. **Post-deploy bootstrap** runs RBAC + tenant wiring; open the Console URL.

For Gov, use [GCC-High deployment](../deployment/gcc-high.md) instead.

## Bring-your-own (BYO) — three states per service

For each backing service:

| State | How | Result |
|---|---|---|
| **Reuse existing** | set `EXISTING_<SVC>` (+ `_RG` / `_SUB`) | the provision module is skipped; the Console wires to the existing resource |
| **Provision new** | leave `EXISTING_<SVC>` empty + the `*Enabled` flag `true` | a new resource is deployed and wired |
| **Honest gate** | leave both empty / flag `false` | the navigator shows a `MessageBar` naming the missing config |

Reuse is resolved at three idempotent layers: **deploy time** (the bicepparam
reads `EXISTING_*`), **post-deploy RBAC** (`grant-navigator-rbac.sh` grants the
Console UAMI the per-resource roles), and **live env**
(`patch-navigator-env.sh` patches the running `loom-console` container app for
already-deployed environments that can't re-run `main.bicep`).

### Discover what already exists

```bash
# Read-only inventory across every subscription the signed-in principal sees,
# with ready-to-source EXISTING_* exports for each reusable resource.
bash scripts/csa-loom/discover-services.sh
```

### Example: reuse AI Search, provision the rest

```bash
export EXISTING_AI_SEARCH_SERVICE=my-shared-search
export EXISTING_AI_SEARCH_RG=rg-shared-ai
az deployment sub create -f platform/fiab/bicep/main.bicep \
  -p platform/fiab/bicep/params/commercial-full.bicepparam
# then, post-deploy:
EXISTING_AI_SEARCH_SERVICE=my-shared-search EXISTING_AI_SEARCH_RG=rg-shared-ai \
  bash scripts/csa-loom/grant-navigator-rbac.sh
```

The four admin-plane services (AI Search, APIM, ADX, Foundry) gate their
provisioning module on `empty(existing<Svc>)`, so naming an existing one never
deploys a duplicate. See the [BYO reference](../bring-your-own-services.md) for
the per-service env-var / role table (Purview, Cosmos, Event Hubs, Databricks,
Synapse/ADF, Azure SQL).

## No-drift rule

What runs in the live deployment and what bicep deploys from scratch must match.
A fresh `az deployment sub create … + bootstrap` must produce a Loom with the
same feature set as the live one — drift is itself a defect.

## Learn more

- **MS Learn — [Azure Developer CLI (azd) overview](https://learn.microsoft.com/azure/developer/azure-developer-cli/overview)**
- MS Learn — [What is Bicep?](https://learn.microsoft.com/azure/azure-resource-manager/bicep/overview)
- MS Learn — [Azure Government documentation](https://learn.microsoft.com/azure/azure-government/)
- Loom — [Quick Start](../deployment/quickstart.md) · [GCC-High deployment](../deployment/gcc-high.md) · [Bring-your-own services](../bring-your-own-services.md)
