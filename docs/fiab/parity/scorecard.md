# scorecard — parity with Fabric Scorecard (Power BI Metrics)

**Source UI:**
- Power BI Metrics / Scorecards (goals) — https://learn.microsoft.com/power-bi/create-reports/service-goals-introduction
- Goals hub + check-ins — https://learn.microsoft.com/power-bi/create-reports/service-goals-create
- Fabric Scorecards REST (preview) — https://learn.microsoft.com/rest/api/power-bi/scorecards

**Loom surface:** `apps/fiab-console/lib/editors/phase3-editors.tsx` → `ScorecardEditor` (line 10334)
**BFF routes:** `app/api/items/scorecard/route.ts` (list) · `app/api/items/scorecard/[id]/route.ts` (detail + check-in)
**Client:** `apps/fiab-console/lib/azure/powerbi-client.ts` → `listScorecards` / `getScorecard` / `listScorecardGoals` / `addScorecardGoalValue`
**Azure-native fallback:** `app/api/items/scorecard/_lib/pbi-content-fallback.ts` → `listContentBackedItems` / `scorecardGoalsFromContent` (Loom bundle-template OKRs from Cosmos `state.content`)

---

## Fabric/Power BI feature inventory

| # | Capability (real Power BI / Fabric UI) | Where in Power BI |
| --- | --- | --- |
| 1 | List scorecards in a workspace | Workspace content list → Scorecards |
| 2 | View goals + current / target values | Scorecard → Goals table |
| 3 | Manual check-in — record a goal value (+ optional target, note, date) | Goal row → Add value / Check in |
| 4 | Scorecard authoring (new goals, connect to report visuals, hierarchy, status rules, owners) | Power BI Web metrics designer |
| 5 | Open in Power BI / copy link | More options |

---

## Loom coverage

Legend: ✅ built (full 1:1 + real backend) · ⚠️ honest-gate (full surface renders + Fluent MessageBar) · ❌ MISSING

| # | Capability | State | Notes |
| --- | --- | --- | --- |
| 1 | List scorecards | ✅ built | Left tree + workspace picker → `GET /api/items/scorecard?workspaceId=…` → `listScorecards()` (Fabric REST). **Azure-native default:** bundle-installed scorecards (`loom:` ids) carry OKRs in Cosmos `state.content` and are merged in via `listContentBackedItems()`, so the editor renders even when no live Fabric scorecard exists. Auto-selects the first scorecard. |
| 2 | Goals + current/target | ✅ built | Goals table (current, target, status) → `GET /api/items/scorecard/[id]` → `getScorecard()` + `listScorecardGoals()`; bundle items resolve via `scorecardGoalsFromContent()`. |
| 3 | Manual goal-value check-in | ✅ built | Inline **Add value** dialog (value + optional target + note) → `POST /api/items/scorecard/[id]` → `addScorecardGoalValue()` (Fabric REST). A bundle-template scorecard that is not yet live in Fabric returns an honest **409 `scorecard_template_not_live`** (no silent 404) telling the operator to create it in Fabric first. |
| 4 | Scorecard authoring (goals / connections / hierarchy / status rules) | ⚠️ honest-gate | The editor renders the full surface (list + goals + check-in) plus an `intent="info"` MessageBar: *"Scorecard authoring … lives in Power BI Web."* with an **Open in Power BI** CTA. Fabric scorecards REST is preview and has no public authoring surface — disclosed, not faked. |
| 5 | Open in Power BI / copy link | ✅ built | Ribbon + toolbar **Open in Power BI** → `window.open(app.powerbi.com/groups/{ws}/scorecards/{id})`. |

**Zero ❌.** Every row is built ✅ against real Fabric/Cosmos backends, or the one honest-gate ⚠️ (preview-only authoring) that still renders the full surface — no dead buttons, no stub banners, no mock arrays.

---

## Backend per control

| Control | Backend |
| --- | --- |
| Scorecard list (tree) | `GET /api/items/scorecard?workspaceId=…` → `listScorecards()` → Fabric `GET /v1.0/myorg/groups/{ws}/scorecards` **+** `listContentBackedItems()` (Cosmos `state.content` OKR templates) |
| Goals table | `GET /api/items/scorecard/[id]?workspaceId=…` → `getScorecard()` + `listScorecardGoals()` → Fabric `GET .../scorecards/{id}` + `.../scorecards/{id}/goals` (bundle items → `scorecardGoalsFromContent()`) |
| Add value (check-in) | `POST /api/items/scorecard/[id]` `{goalId,value,targetValue?,noteText?,goalValueDate?}` → `addScorecardGoalValue()` → Fabric `POST .../scorecards/{id}/goals/{goalId}/goalValues`; bundle template → honest **409 `scorecard_template_not_live`** |
| Open in Power BI | client `window.open` to `app.powerbi.com/groups/{ws}/scorecards/{id}` |

Auth: Console UAMI via `ManagedIdentityCredential` chained with `DefaultAzureCredential`. Live-Fabric scorecard calls need the UAMI authorized for Fabric APIs + workspace membership; on 401/403 the underlying error surfaces verbatim. The bundle-template (Cosmos) path needs no Fabric access — it is the Azure-native default per `no-fabric-dependency.md`.

---

## Per-cloud notes

Live Fabric scorecards are a **Fabric** surface (`api.fabric.microsoft.com` / preview Power BI metrics REST). The **Loom bundle-template OKR path is Azure-native** (Cosmos `state.content`) and works in every cloud with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

| Cloud | Live Fabric scorecards | Loom bundle-template OKRs (Cosmos) |
| --- | --- | --- |
| Commercial | ✅ Fabric / Power BI metrics REST | ✅ Cosmos `state.content` |
| GCC | ❌ **Fabric / Power BI Metrics not available in GCC** — list returns the honest error only when there are no bundle entries; with bundle entries the editor still renders | ✅ Cosmos `state.content` |
| GCC-High / IL4 | ✅ Fabric available | ✅ Cosmos `state.content` |
| DoD / IL5 | ✅ Fabric available | ✅ Cosmos `state.content` |

In GCC the editor never dead-ends: bundle-installed scorecards render their OKR goals from Cosmos, and the live-Fabric list error is surfaced precisely (no silent empty surface), consistent with `no-fabric-dependency.md`.

---

Grade: A — list, goals, manual check-in, and open-in-PBI are all real backend (Fabric REST + Cosmos OKR fallback); preview-only authoring is the single honest-gate. Zero ❌, zero stub banners.
