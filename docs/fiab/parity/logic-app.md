# logic-app — parity with the Azure Logic Apps (Consumption) designer + code view

> Parity audit per `.claude/rules/ui-parity.md` + `.claude/rules/no-vaporware.md`.
> Graded conservatively. (Logic Apps is a native Azure service, not a Fabric
> object, so there is no Fabric-dependency concern — it's Azure-native by
> definition.)

**What this is.** An **Azure Logic Apps (Consumption)** workflow defined in the
Workflow Definition Language (WDL): a trigger (Request, Recurrence) followed by
actions (HTTP, ApiConnection, Compose, ParseJson, Query, Select, If/Switch,
Response), deployed as a `Microsoft.Logic/workflows` resource and run via its
trigger. In Loom's Data Factory category, it is the low-code automation item.

**Source UI (grounded in Microsoft Learn, not memory):**
- WDL schema: https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema
- Logic Apps designer overview: https://learn.microsoft.com/azure/logic-apps/quickstart-create-example-consumption-workflow
- Trigger a run / run history: https://learn.microsoft.com/azure/logic-apps/monitor-workflows-collect-diagnostic-data
- Parameters in workflow definitions: https://learn.microsoft.com/azure/logic-apps/logic-apps-azure-resource-manager-templates-overview
- REST — `Microsoft.Logic/workflows` get / create-or-update / trigger: https://learn.microsoft.com/rest/api/logic/workflows

**Loom surface:**
- Editor: `apps/fiab-console/lib/editors/logic-app-editor.tsx` — three tabs
  (Designer / Parameters / Code view), a trigger picker, Run trigger, and a
  Monaco WDL authoring surface with Save.
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'logic-app'`, `restType: 'Microsoft.Logic/workflows'`).
- BFF: `app/api/items/logic-app/[id]/route.ts` (get built-out from the live
  resource or stamped state; PUT upserts to ARM when bound + persists to Cosmos),
  `…/[id]/run/route.ts` (fire the manual trigger + poll run status),
  `app/api/monitor/logic-app-callback/route.ts`.

**Backend reality check.** GET reads the real `Microsoft.Logic/workflows`
resource when bound, else the installed WDL definition (never empty). Save PUTs
to ARM (`create-or-update`) when the workflow is bound and always persists to
Cosmos. Run trigger fires the real manual trigger and polls run history; when no
live resource is bound it returns an **honest gate** naming `LOOM_LOGIC_SUB` /
`LOOM_LOGIC_RG` / `LOOM_LOGIC_LOCATION` + the **Logic App Contributor** role
(per `no-vaporware.md`). No mocks.

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · honest-gate ⚠️ · MISSING ❌

| # | Azure Logic Apps designer capability | Loom | Where / backend |
|---|---|---|---|
| 1 | Open a workflow built-out from its definition (never empty) | ✅ built | `GET …/logic-app/[id]` (live ARM or stamped state) |
| 2 | **Designer view** — trigger → actions in execution order | ✅ built | flow of connected cards; `orderActions` topological sort |
| 3 | Show trigger type + config (Recurrence schedule, Request method) | ✅ built | `summarizeConfig` per node |
| 4 | Show action type + key inputs (HTTP method/uri, retry, statusCode…) | ✅ built | `summarizeConfig` per node |
| 5 | **Branch / control actions** (If/Switch) with sub-actions | ✅ built | nested `FlowBody` (if-true / else / case) |
| 6 | `runAfter` dependency labels | ✅ built | "after: …" caption per node |
| 7 | **Parameters view** — WDL params (type/default/description) + deploy values | ✅ built | Parameters tab table |
| 8 | Workflow **outputs** | ✅ built | Parameters tab outputs blob |
| 9 | **Code view** — full WDL JSON | ✅ built | Monaco JSON editor |
| 10 | **Edit WDL + Save** (deploy) | ✅ built | edit → `PUT …/logic-app/[id]` (ARM when bound, Cosmos always) |
| 11 | **Run trigger** (manual run) | ✅ built | `POST …/[id]/run` fires trigger + polls status |
| 12 | Multi-trigger picker | ✅ built | Dropdown appears when >1 trigger |
| 13 | Honest gate when not deployed to ARM | ⚠️ honest-gate | MessageBar names LOOM_LOGIC_* + Logic App Contributor |
| 14 | **Visual drag-and-drop designer** (add/reorder actions on a canvas) | ❌ MISSING | Designer is read-only flow; authoring is via the WDL Code view |
| 15 | **Connector picker / connection auth** (managed API connections) | ❌ MISSING | edit `ApiConnection` JSON directly; no connection gallery |
| 16 | **Run history list + per-action inputs/outputs drill-down** | ⚠️ partial | last run status + steps; no full history grid with per-action IO |
| 17 | Expression builder / dynamic content picker | ❌ MISSING | WDL expressions typed in Code view |
| 18 | Enable/disable, versions, resubmit a past run | ❌ MISSING | not surfaced |

**Grade: B−.** Read (Designer + Parameters), author (Code view + Save to ARM),
and Run (real trigger with honest gate) are all real and complete. The parity
gap is the **visual drag-drop designer + connector gallery + full run-history
drill-down** — the Code view is the authoring surface instead of a canvas. These
are tracked parity gaps, not vaporware: every button calls a real backend or
shows an honest gate.
