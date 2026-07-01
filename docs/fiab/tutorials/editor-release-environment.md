# Tutorial: Release environment editor

> CSA Loom `release-environment` editor — **Shuttle**, the Azure-native
> equivalent of Palantir **Apollo**: promotion / release orchestration across
> workspaces, built on **Azure Resource Manager** deployment history and **Azure
> Deployment Environments**. **No Microsoft Fabric required.**

## What it is

Apollo orchestrates promotion of artifacts across environments. Shuttle models
**dev → test → prod** stages over Loom workspaces, surfaces real **Azure Resource
Manager** deployment history for each stage, and — when a **DevCenter** project is
configured — provisions catalog-driven **Azure Deployment Environments** (Bicep).
It builds on the existing deployment-pipelines ARM + git backend; no Fabric.

## When to use it

- You run the same Loom solution across multiple environments and need a
  governed record of what version is installed where.
- You want promotion between stages tracked with an auditable history (who
  promoted what, when, to which environment).
- You want per-stage environments provisioned from a Bicep catalog through Azure
  Deployment Environments.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Release environment** (Fabric IQ).
   The editor opens at `/items/release-environment/<id>`.
2. **Define stages.** Use **Add environment** to add each stage and choose its
   **type** — **Loom workspace**, **App Service + slot**, or **Deployment env** —
   and map it to the backing resource group.
3. **Order the pipeline.** Use **Add edge** to connect stages into a promotion
   path (for example dev → test → prod).
4. **Register versions.** Use **Add version** to record a build — build number,
   commit, container tag, and notes — so each promotion references a concrete
   artifact.
5. **Review ARM history.** Inspect the real **Azure Resource Manager**
   deployments across the Loom resource groups (name, resource group, state,
   timestamp) for each stage.
6. **Provision environments (optional).** When `LOOM_DEVCENTER_PROJECT` is set,
   pick a catalog environment definition (Bicep) to provision per stage via Azure
   Deployment Environments.
7. **Promote.** Pick a **from** and **to** stage and click **Promote** (or **Run**
   a slot swap for App Service targets). Loom records the promotion and the
   environment it targeted.

## The Azure backend it rides on

- **Deployment history:** **Azure Resource Manager** deployments per resource
  group.
- **Environment provisioning (optional):** **Azure Deployment Environments** via a
  **DevCenter** project (`LOOM_DEVCENTER_PROJECT`).
- **App Service targets:** deployment-slot swaps for slot-based promotion.

## No Fabric required

Shuttle orchestrates over Loom workspaces and real Azure (ARM + Deployment
Environments + App Service). No Fabric capacity or workspace is used; a missing
DevCenter project simply hides the provisioning step and leaves ARM history and
promotion tracking fully functional.

## Learn more

- Azure Deployment Environments:
  <https://learn.microsoft.com/azure/deployment-environments/overview-what-is-azure-deployment-environments>
- ARM deployment history:
  <https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-history>
