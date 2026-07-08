# integration-runtime — parity with the ADF / Synapse Studio "Integration runtimes" (Manage hub)

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`
> + `.claude/rules/no-fabric-dependency.md`. Graded conservatively.

**What this is.** An **integration runtime (IR)** is the compute that ADF /
Synapse pipelines use for activity dispatch, data movement, SSIS execution, and
data-flow Spark runs. Like linked services it is a **sub-feature of ADF /
Synapse Studio**, managed in the **Manage hub → Integration runtimes** blade and
consumed by pipelines / linked services / data flows. CSA Loom surfaces it in
BOTH places:

- **As a first-class catalog item** (`integration-runtime`) with its own editor —
  the subject of this doc.
- **Inline** inside the pipeline / data-flow / linked-service surfaces
  (the same shared `IntegrationRuntimeManager` component).

**Source UI (grounded in Microsoft Learn, not memory):**
- IR concept (Azure / Self-Hosted / Azure-SSIS): https://learn.microsoft.com/azure/data-factory/concepts-integration-runtime
- Create a self-hosted IR (install keys / node registration): https://learn.microsoft.com/azure/data-factory/create-self-hosted-integration-runtime
- Create an Azure-SSIS IR: https://learn.microsoft.com/azure/data-factory/create-azure-ssis-integration-runtime-portal
- Manage hub: https://learn.microsoft.com/azure/data-factory/author-management-hub
- REST — `Microsoft.DataFactory/factories/integrationruntimes`: https://learn.microsoft.com/rest/api/datafactory/integration-runtimes

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/integration-runtime-editor.tsx` — a thin
  wrapper hosting the shared, sibling-owned `IntegrationRuntimeManager`
  (`lib/components/pipeline/integration-runtime-manager.tsx`) in **factory-scoped
  mode**, plus an Engine selector (ADF default / Synapse opt-in — Synapse hides
  Azure-SSIS, matching the real Synapse Manage hub).
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'integration-runtime'`, `restType: 'IntegrationRuntime'`).
- BFF: `app/api/adf/integration-runtimes/route.ts` (list/create + auth-keys +
  lifecycle); Synapse opt-in `app/api/synapse/integration-runtimes/route.ts`.

**Backend reality check.** All IR CRUD calls real ARM
(`Microsoft.DataFactory/factories/integrationruntimes`, via `adf-client`) on the
deployment-default factory — no mocks. Azure-native default; an unset factory
env (`LOOM_SUBSCRIPTION_ID` / `LOOM_DLZ_RG` / `LOOM_ADF_NAME`) returns a 503 that
the manager renders as an honest infra-gate while still showing the full surface.

---

## Azure/Fabric feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | ADF/Synapse Manage-hub capability | Loom | Where / backend |
|---|---|---|---|
| 1 | List IRs with **live status** (Online/Starting/Stopped) | ✅ built | `GET /api/adf/integration-runtimes` + status badge |
| 2 | Built-in `AutoResolveIntegrationRuntime` always present | ✅ built | always listed; not startable/stoppable/deletable |
| 3 | New IR → **type picker** (Azure / Self-Hosted / Azure-SSIS) | ✅ built | catalog type cards → wizard |
| 4 | Azure IR structured form (region / compute / cores) | ✅ built | structured form → ARM PUT (never JSON) |
| 5 | **Self-Hosted IR** create | ✅ built | ARM PUT `type: SelfHosted` |
| 6 | Reveal Self-Hosted **install / auth keys** | ✅ built | `authKey1/authKey2` via list-auth-keys route |
| 7 | **Azure-SSIS IR** create | ✅ built | ADF engine only (Synapse hides it, matching portal) |
| 8 | Start / Stop lifecycle (Self-Hosted / SSIS) | ✅ built | lifecycle route (`start`/`stop`) |
| 9 | Delete IR | ✅ built | lifecycle route (`delete`) |
| 10 | Engine switch — **Synapse workspace** IRs | ✅ built (opt-in) | Engine dropdown → `app/api/synapse/integration-runtimes` |
| 11 | Node view / concurrent-jobs / high-availability for Self-Hosted | ❌ MISSING | create + keys + status only; no per-node monitor grid |
| 12 | Azure-SSIS advanced (custom setup, VNet join, package store, catalog DB) | ❌ MISSING | basic SSIS create only |
| 13 | Managed VNet IR + managed private endpoints | ⚠️ partial | managed-VNet wiring lives in networking/bicep, not this blade |
| 14 | Link/share a Self-Hosted IR across factories | ❌ MISSING | not surfaced |

**Grade: B.** Type-pick → structured create → reveal keys → start/stop/delete on
real ARM covers the day-to-day Manage-hub IR workflow one-for-one. Gaps are the
deep Self-Hosted node monitor and full Azure-SSIS advanced config — real
capabilities, tracked, not stubbed.
