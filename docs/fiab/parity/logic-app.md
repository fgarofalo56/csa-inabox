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
- Editor: `apps/fiab-console/lib/editors/logic-app-editor.tsx` — four tabs
  (Designer / Parameters / Runs / Code view), a trigger picker, Run trigger, and
  a Monaco WDL surface with Save. The Designer tab hosts the REAL visual canvas.
- Designer canvas: `apps/fiab-console/lib/components/logic-app/workflow-designer-canvas.tsx`.
- Model: `apps/fiab-console/lib/logic-app/wdl-model.ts` (lossless WDL ⇄ graph),
  `operation-catalog.ts` (the palette), `auto-bind.ts` (provision + self-heal).
- Catalog: `apps/fiab-console/lib/catalog/item-types/data-factory.ts`
  (`slug: 'logic-app'`, `restType: 'Microsoft.Logic/workflows'`).
- BFF: `app/api/items/logic-app/[id]/route.ts` (get built-out from the live
  resource or stamped state; PUT upserts to ARM when bound + persists to Cosmos),
  `…/[id]/run/route.ts` (fire the manual trigger + poll run status),
  `…/[id]/runs/route.ts` (run list + per-run action detail),
  `app/api/monitor/logic-app-callback/route.ts`.

**Backend reality check.** GET AUTO-BINDS first: it creates the backing
`Microsoft.Logic/workflows` resource — named identically to the Loom item — when
it does not exist, and re-creates/re-targets it when the workflow was deleted or
the estate moved. It then returns the LIVE definition. Save PUTs to ARM
(`create-or-update`) and reports a failure rather than silently degrading to a
local-only write. Run trigger fires the real manual trigger and polls run
history; the Runs tab reads `GET runs` and `GET runs/{name}/actions`. The only
non-functional states are honest gates: missing deployment coordinates (an env
gate with an inline Fix-it, registry id `svc-logic-apps`) or a missing
**Logic App Contributor** RBAC grant. No mocks.

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
| 13 | Honest gate when the deployment lacks Logic Apps coordinates | ⚠️ honest-gate | shared `<HonestGate gateId="svc-logic-apps">` with an inline **Fix it** wizard (G2); RBAC/ARM gates stay a MessageBar naming the exact role |
| 14 | **Visual drag-and-drop designer** (add/reorder actions on a canvas) | ✅ built | `lib/components/logic-app/workflow-designer-canvas.tsx` — React Flow + shared `canvas-node-kit`; drag from the palette, drop, connect; every mutation rewrites WDL through `lib/logic-app/wdl-model` |
| 15 | **Operation palette** grouped by category (triggers / HTTP / data / control / variables) | ✅ built | `lib/logic-app/operation-catalog.ts` — 18 real WDL operations, each with a valid template + typed inspector fields |
| 16 | **Run history list + per-action drill-down** | ✅ built | `GET …/[id]/runs` → `Microsoft.Logic/workflows/{n}/runs`; click a run → `runs/{n}/actions` (status, duration, retry count, error) |
| 17 | **Step inspector** with typed controls per operation (no hand-written JSON) | ✅ built | docked inspector renders `OperationField[]` (select / number / text / textarea / json) writing straight into `inputs.*` or the WDL body |
| 18 | **Connect steps into `runAfter` dependencies** incl. non-Succeeded statuses | ✅ built | canvas edges ⇄ `runAfter`; `Failed`/`TimedOut`/`Skipped` edges render labelled + amber |
| 19 | **Rename a step**, rewriting every reference | ✅ built | `renameNode` rewrites all `runAfter` keys; de-duplicates against existing names |
| 20 | **Delete a step** without orphaning the tail | ✅ built | `removeNode` bridges predecessors → successors |
| 21 | Cycle prevention on connect | ✅ built | `wouldCycle` rejects the edge before it reaches ARM |
| 22 | **Pre-run validation** (missing trigger, unknown `runAfter` target, untyped op) | ✅ built | `validateGraph` → inspector issue list + red node dots; surfaced after touch/save-attempt so a new item opens clean |
| 23 | Undo / redo, align / distribute, auto-layout, zoom rail, shortcut sheet | ✅ built | shared `CanvasPowerToolbar` + `CanvasRightRail` + `CanvasShortcutDialog` (`ux-baseline.md`) |
| 24 | Resizable palette / canvas / inspector panes, persisted | ✅ built | shared `SplitPane` with `storageKey` (G3) |
| 25 | Canvas layout persisted across sessions | ✅ built | node positions round-trip in `definition.metadata.loomDesignerLayout` |
| 26 | Guided first-run ("add a trigger") | ✅ built | shared `EmptyState` launcher over the empty canvas with the two built-in triggers as one-click actions |
| 27 | **Code view** ⇄ designer round-trip preserving unknown operations | ✅ built | `wdl-model` preserves every unmodelled key verbatim (`raw`), so a portal-authored managed-connector step survives a Loom save untouched |
| 28 | **Connector picker / connection auth** (managed API connections) | ❌ MISSING | an `ApiConnection` operation additionally needs a `Microsoft.Web/connections` resource + a per-connector OAuth consent flow; edit such steps in Code view — Loom preserves them exactly |
| 29 | Expression builder / dynamic content picker | ❌ MISSING | WDL expressions are typed into the inspector's fields |
| 30 | Enable/disable workflow, versions, resubmit a past run | ❌ MISSING | not surfaced |

**Grade: A−.** The visual designer (row 14) and full run history (row 16) —
previously the two headline gaps — are built on the real service: the canvas
edits Workflow Definition Language, `Save` is `PUT Microsoft.Logic/workflows`,
`Run trigger` is `POST triggers/{n}/run`, and the Runs tab is `GET runs` /
`GET runs/{n}/actions`. Creating a Loom workflow item now PROVISIONS AND BINDS
its backing workflow automatically, named after the item, and re-binds itself
when the workflow is deleted or the estate moves (`auto-bind-by-default.md`) —
there is no "bind me first" form anywhere in the surface.

The three remaining ❌ are deliberate and disclosed, not vaporware: managed
connectors (row 28) need a second Azure resource plus per-connector tenant
consent, so faking a gallery would be worse than preserving the operations
verbatim and saying so in the inspector.

### The gate that could never be satisfied (#2954)

Before this work the provisioner resolved its region from
`LOOM_LOGIC_LOCATION || LOOM_AZURE_LOCATION`. **Neither variable is set by any
bicep module in this repo** — the admin plane stamps `LOOM_LOCATION`
(`modules/admin-plane/main.bicep`). `logicAppArmMissing()` therefore returned a
non-empty array in *every* real deployment, so the provisioner short-circuited to
`status:'remediation'` before issuing a single ARM call, and the run route always
answered "not backed by a live Azure Logic App". No Loom deployment had ever
created a Logic App workflow, and the remediation text named variables nothing
consumes — following it exactly still failed. `LOOM_LOCATION` is now in the
resolution chain (explicit `LOOM_LOGIC_*` overrides still win) and
`lib/install/provisioners/__tests__/logic-app-coords.test.ts` pins it against the
REAL module rather than a mock.

### The second blocker, found on the live estate

Verifying the fix against the running commercial deployment surfaced a second
dead end. The deployed Console's `LOOM_DLZ_RG` names
`rg-csa-loom-dlz-default-centralus` — **a resource group that does not exist in
that subscription** (the estate runs single-RG out of `LOOM_ADMIN_RG`). So even
with the region resolved, the first `PUT Microsoft.Logic/workflows` returns
`ResourceGroupNotFound` and the user hits a wall on create.

Per `auto-bind-by-default.md` that is the platform's to fix, so auto-bind now
retries once against `LOOM_ADMIN_RG` (a group every deploy creates, and where the
platform already runs its own Consumption workflow) and persists the binding to
wherever the workflow actually landed. The retry is narrow on purpose: only on a
404 whose body is `ResourceGroupNotFound`, only when the admin RG is a DIFFERENT
group, and never more than once.
