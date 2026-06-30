# release-environment — parity with deployment/release environment (Foundry environments / Azure deployment slots)

**Category:** Fabric IQ · **Slug:** `release-environment` · **restType:** `ReleaseEnvironment`
**Loom equivalent (Palantir):** Apollo → "Shuttle"
**Source UIs (ground truth):**

- Palantir Apollo — Environments, Product Releases, Release Channels, **Promotion pipeline graph**, approvals/gates, install + rollback: <https://www.palantir.com/docs/apollo/managing-release-channels/configure-promotion-pipeline>, <https://www.palantir.com/docs/apollo/apollo-getting-started/introduction-promotion>
- Azure Deployment Environments (DevCenter) — environment **types**, **catalogs**, **environment definitions**, parameters, environment resources, redeploy/delete, RBAC: <https://learn.microsoft.com/azure/deployment-environments/concept-environments-key-concepts>
- Azure App Service **deployment slots** — slots, **swap**, **swap-with-preview** (multi-phase), **auto-swap**, **traffic %** routing, warm-up, **sticky vs swappable** settings, **roll back via re-swap**: <https://learn.microsoft.com/azure/app-service/deploy-staging-slots>

> **No-Fabric rule:** every capability below has an Azure-native default backend (Cosmos item-state, ADE DevCenter data-plane, ARM deployments REST, `Microsoft.Web/sites/slots` ARM REST, Key Vault references, Azure Monitor, Microsoft Graph). Fabric/Power BI are never on the default path.

---

## Real feature inventory

Every capability the three source UIs expose for a release/deployment-environment surface:

### A. Environments registry (Apollo Environments / ADE project environment types)
1. Define named environments (dev / test / staging / preprod / prod + custom) as first-class objects.
2. Per-environment metadata: **environment type**, **target subscription**, **deployment identity (managed identity)**, **region**, **resource group**, tags/policies, access level granted on create.
3. Map each environment to a concrete target: Loom workspace, an App Service + slot, or an ADE project environment-type.
4. Environment **status**: provisioning state, last-deployed version, health, drift.
5. Ordering of environments into a promotion sequence.

### B. Environment definitions & catalogs (ADE)
6. Browse the **catalog** of environment definitions (IaC templates: ARM/Bicep/Terraform) attached to the DevCenter/project.
7. **Sync catalog** from its Git/ADO repo; surface sync status + errors.
8. Per-definition **parameter schema** → typed parameter form (string/int/bool/enum) when creating an environment.
9. Select a definition + runner (ARM/Bicep/custom container image) for an environment.

### C. Promotion pipeline (Apollo promotion pipeline graph)
10. **Visual promotion-pipeline graph**: nodes = environments/channels, directed edges = allowed promotions.
11. Edit edges from a "Releases/Pipeline" tab; add/remove promotion paths.
12. Per-edge promotion **mode**: manual vs automatic.
13. Per-edge **version constraints / entitlements** (which release versions may flow).
14. **Schedules / maintenance windows** for automatic promotion.

### D. Approval gates
15. Per-edge **approval gate**: require N approvers before a promotion completes.
16. **Pending approvals queue**: approve / reject with a comment; audit trail.
17. Gate policy by environment type (e.g. prod requires approval; dev does not).

### E. Artifact / release versions
18. Track **release/artifact versions** (build id, git commit, container tag, semver) as the unit being promoted.
19. **Which version is installed in each environment** (the "what's where" matrix).
20. Release notes / changelog per version; diff between two versions.

### F. Promote / swap execution (App Service slots + ADE create)
21. **Promote** an artifact version from one environment to the next (records + executes the real deploy).
22. **Slot swap** (source ↔ target) for App Service-backed environments.
23. **Swap-with-preview** (multi-phase): apply target config → validate → **complete** or **cancel**.
24. **Auto-swap** configuration per slot.
25. **Warm-up** ping path + accepted status codes before swap completes.
26. Create the **real Azure Deployment Environment** from a definition (already partly wired).

### G. Traffic routing (App Service slots)
27. **Percentage traffic routing** across slots (canary/blue-green); set/adjust %.

### H. Rollback
28. **One-click rollback** to the previous version (re-swap, or redeploy prior ARM deployment).
29. "Last known good" indicator per environment.

### I. Config & secrets per environment
30. Per-environment **app settings** + **connection strings**.
31. **Sticky (slot) vs swappable** flag per setting.
32. **Secrets via Key Vault references** (no plaintext).

### J. Status, history & resources
33. **Per-environment status dashboard** (tiles): provisioning state, current version, health, last deploy.
34. **Deployment / promotion history** with drill-in: ARM operation, who/when, outcome, logs.
35. **Environment Resources** view: the actual Azure resources deployed in each environment (ADE).
36. **Redeploy** / **delete** an environment; environment **expiration** (scheduled auto-delete).
37. RBAC: who can promote to which environment type (Deployment Environments User / Project Admin).

---

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Named environments as objects | ⚠️ partial | "Stages" = name + optional workspace string only |
| 2 | Env metadata (type/sub/identity/region/RG/tags) | ❌ MISSING | no fields beyond name + workspace |
| 3 | Map env → workspace / slot / ADE type | ⚠️ partial | only free-text workspace |
| 4 | Env status (state/version/health/drift) | ❌ MISSING | |
| 5 | Promotion sequence ordering | ❌ MISSING | flat unordered list |
| 6 | Browse ADE catalog of definitions | ❌ MISSING | definition is a free-text input |
| 7 | Sync catalog | ❌ MISSING | |
| 8 | Per-definition parameter form | ❌ MISSING | |
| 9 | Definition + runner selection | ❌ MISSING | |
| 10 | Promotion-pipeline **graph** | ❌ MISSING | no graph; two dropdowns |
| 11 | Edit promotion edges | ❌ MISSING | |
| 12 | Per-edge manual/auto mode | ❌ MISSING | |
| 13 | Per-edge version constraints | ❌ MISSING | |
| 14 | Schedules / maintenance windows | ❌ MISSING | |
| 15 | Approval gate per edge | ❌ MISSING | |
| 16 | Pending-approvals queue | ❌ MISSING | |
| 17 | Gate policy by env type | ❌ MISSING | |
| 18 | Release/artifact versions | ❌ MISSING | promotion has a free-text note only |
| 19 | "What version is where" matrix | ❌ MISSING | |
| 20 | Release notes / version diff | ❌ MISSING | |
| 21 | Promote execution | ⚠️ partial | records a promotion in Cosmos; only deploys if ADE definition named |
| 22 | Slot swap | ❌ MISSING | |
| 23 | Swap-with-preview (multi-phase) | ❌ MISSING | |
| 24 | Auto-swap config | ❌ MISSING | |
| 25 | Warm-up ping config | ❌ MISSING | |
| 26 | Create real ADE environment | ✅ built | `createDeploymentEnvironment` via DevCenter data-plane (honest gate) |
| 27 | Traffic % routing | ❌ MISSING | |
| 28 | One-click rollback | ❌ MISSING | |
| 29 | Last-known-good indicator | ❌ MISSING | |
| 30 | Per-env app settings + conn strings | ❌ MISSING | |
| 31 | Sticky vs swappable flag | ❌ MISSING | |
| 32 | Key Vault reference secrets | ❌ MISSING | |
| 33 | Per-env status dashboard tiles | ❌ MISSING | |
| 34 | Promotion history drill-in | ⚠️ partial | flat table (from/to/when/by/note); no detail/logs |
| 35 | Environment Resources view | ❌ MISSING | |
| 36 | Redeploy / delete / expiration | ❌ MISSING | |
| 37 | Promotion RBAC by env type | ❌ MISSING | |
| — | ARM deployment history (read) | ✅ built | `listArmDeployments` across Loom RGs (honest gate) |

**Grade today: D/C — three thin sections (Stages, Promote, ARM history) on one scroll page, no tabs, no graph, no versions, no approvals, no slot swap, no per-env config/status.** Two real backends are wired (ADE create + ARM history read), so the bones are Azure-native and no-Fabric-clean — but feature completeness is far from the source UIs.

---

## Build plan (prioritized)

Restructure the editor into a tabbed `ItemEditorChrome` surface — **Overview · Environments · Pipeline · Promote/Swap · Approvals · Versions · Config & Secrets · History · Resources** — built on Fluent v9 + Loom tokens, `TileGrid` for card grids, `EmptyState` for empty panes, `force-directed-graph`/canvas-node-kit for the pipeline graph, `identity-picker` for approvers, `key-value-grid` for config. All controls call real Azure REST; honest `MessageBar` gates only.

### P0 — visible parity uplift
- **Environments registry (rich)** — replace name+workspace stages with full environment cards: type (dev/test/staging/prod/custom), target kind (Loom workspace · App Service+slot · ADE project env-type), subscription, region, RG, deployment identity, tags, sequence order. Backend: Cosmos item-state for the model; resolve real targets via ARM (`Microsoft.Web/sites` list, ADE project env-types) — no Fabric.
- **Promotion-pipeline graph** — visual DAG of environments with promotion edges (manual/auto badge, gate badge), built on the existing `force-directed-graph` / canvas-node-kit; click an edge to configure it. Backend: pipeline persisted in Cosmos state; promote action drives the real deploy/swap below.
- **Slot swap + swap-with-preview** — for App Service-backed environments: Swap, and multi-phase Swap-with-preview (apply config → validate → complete/cancel), warm-up ping path/status. Backend: **new `app-service-slots-client`** calling `POST .../Microsoft.Web/sites/{site}/slots/{slot}/swap` + `slotsswap` ARM REST (`api-version=2023-12-01`); honest gate when `LOOM_APPSERVICE_*` env unset.
- **Per-environment status dashboard** — tiles per env: provisioning state, current version, health, last deploy, last-known-good. Backend: ARM `Microsoft.Web/sites/slots` GET + `listArmDeployments` (already wired) + Azure Monitor availability.

### P1 — depth + governance
- **Approval gates + pending-approvals queue** — per-edge "requires N approvers"; queue with approve/reject + comment + audit. Backend: Cosmos state for gate config + approval records; `identity-picker` (Microsoft Graph) for approver selection; promote BFF blocks until approved.
- **Release/artifact versions + "what's where" matrix** — version objects (build id, git sha, container tag, semver, notes) as the promotion unit; matrix of version-per-environment; version diff. Backend: Cosmos state; container tags via ACR REST when an env targets a container app/site.
- **ADE catalog + environment definitions browser** — browse definitions from the DevCenter catalog, **sync catalog**, typed **parameter form** per definition (replaces free-text envDef). Backend: extend `devcenter-client` with `listEnvironmentDefinitions` / `listCatalogs` / `sync` data-plane calls (honest gate already exists).
- **Per-env config & secrets** — app settings + connection strings grid, sticky-vs-swappable toggle, Key Vault reference picker. Backend: `Microsoft.Web/sites/{slot}/config/appsettings` + `connectionstrings` ARM REST; Key Vault references resolved by App Service.
- **Rollback** — one-click rollback to previous version (re-swap, or redeploy prior ARM deployment). Backend: re-issue slot swap (source↔target) or ARM redeploy of the prior `Microsoft.Resources/deployments` template.

### P2 — completeness
- **Traffic % routing (canary/blue-green)** — set/adjust per-slot traffic %. Backend: `Microsoft.Web/sites/{site}/config/web` `experiments.rampUpRules` ARM REST.
- **Auto-swap configuration** — enable auto-swap target slot per env. Backend: `Microsoft.Web/sites/{site}/slots/{slot}/config/web` `autoSwapSlotName`.
- **Environment Resources view** — list the real Azure resources deployed in each ADE environment. Backend: `devcenter-client.getEnvironment` → resourceGroupId → ARM resource list.
- **Redeploy / delete / expiration** — ADE redeploy + delete + scheduled expiration. Backend: DevCenter data-plane environment `deploy`/`DELETE` + expiration field.
- **Schedules / maintenance windows** — scheduled automatic promotion. Backend: Cosmos schedule + an Azure Monitor/Logic App or cron-driven promote.
- **Promotion history drill-in** — detail drawer per promotion: ARM operation, logs, who/when, outcome, version. Backend: `listArmDeploymentOperations` (extend arm-deployments-client).

### Verification per merge (no-vaporware)
With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET: create an environment, build a 2-node pipeline, perform a real App Service **slot swap** against a deployed site (receipt = ARM swap operation `Succeeded`), and read back per-env status — all Azure-native. ADE create + ARM history already produce real receipts. Fabric never touched.
