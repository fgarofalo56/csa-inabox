# data-product-instance — parity with a composed data product (Fabric data product / solution accelerator)

Source UI: Loom-native — closest Azure/Fabric analogues are the Fabric/Purview
**data product** (a governed bundle of data items) and an Azure **solution
accelerator** deployment view. There is no single 1:1 Azure portal screen; this
editor is the *instance* half of the Loom template → instance model
(`DataProductTemplateEditor` spawns, `DataProductInstanceEditor` deploys +
monitors).

Azure-native backend (no Fabric): each component is a real Loom item
(lakehouse → ADLS, adf-pipeline → ARM, kql → ADX, index → AI Search, …). The
instance provisions every component through the **shared Phase-2 provisioning
engine** — the same engine the install wizard uses — against real Azure
backends. No Fabric capacity is required.

## Capability inventory (data-product / accelerator instance)

1. **Instance overview** — display name, source template, component count.
2. **Components list** — each spawned underlying item (type + link to open it).
3. **Provision / deploy all** — deploy every component to its real Azure backend
   in one action; per-component deploy status.
4. **Deploy status per component** — Deployed / Skipped / Needs config
   (remediation) / Failed.
5. **Health** — is each component alive / stale / missing.
6. **Partial-failure reporting** from instantiation.
7. Navigate into any component's own editor.

## Loom coverage

| Capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Instance overview** (name, template, count) | ✅ built — left panel + header | `GET /api/items/data-product-instance/[id]` |
| **Components table** (display name, item type, link to open) | ✅ built — table with per-row link to `/items/{slug}/{itemId}` | instance `state.components` |
| **Provision all** → deploy to real Azure | ✅ built — Home → Provision all (ribbon + left panel + empty-state CTA) | `POST /api/items/data-product-instance/[id]/provision` → `runProvisioning` (shared Phase-2 engine, `deploy:true`, `mode:'shared'`) |
| **Per-component deploy status** (Deployed/Skipped/Needs config/Failed) | ✅ built — Deploy column badges from `provisionReport.steps` | persisted `state.provisionReport` |
| **Health check** (OK / Stale / Missing / Unknown) | ✅ built — Home → Health; per-component badge from `updatedAt` | `GET /api/cosmos-items/{slug}/{itemId}` per component |
| **Partial-failure surface** from instantiation | ✅ built — warning MessageBar listing `state.errors` | instance state |
| Navigate into a component editor | ✅ built — component name links to its own item page | per-item routes |
| Spawn a new instance from a curated template | ✅ built — sibling `DataProductTemplateEditor` (component checklist, est. cost, next-steps) → instantiate + navigate | `POST /api/items/data-product-template/[slug]/instantiate` |
| Honest infra gates on a component (e.g. dedicated pool, Event Hubs) | ⚠️ honest-gate — `status:'remediation'` rows surfaced as "Needs config" badges (not faked as deployed) | provisioning engine |
| Empty instance (no components) | ✅ built — `EmptyState` → "Browse templates" CTA | n/a |

Zero ❌. Deploy + health reflect real Azure state via the shared provisioning
engine and per-item Cosmos reads — nothing is faked; remediation is shown
honestly (per `no-vaporware.md`).

## Backend per control

- Load instance: `GET /api/items/data-product-instance/[id]` (owned-item CRUD).
- List / create instances: `/api/items/data-product-instance` (GET/POST).
- Provision all: `POST /api/items/data-product-instance/[id]/provision` → `runProvisioning(session, dpi:<id>, workspaceId, components, {deploy:true, mode:'shared'})`; persists `state.provisionReport` + `provisionedAt`.
- Per-component health: `GET /api/cosmos-items/{slug}/{itemId}` (404 → Missing).
- Instantiate from template: `POST /api/items/data-product-template/[slug]/instantiate`.
