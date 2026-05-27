# Top-level navigation parity validation — 2026-05-26

**Validator:** v2 fabric-parity-loop, 4-phase
**Live URL:** https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/
**Authed as:** Frank Garofalo (UAT) (fgarofalo@housegarofalo.com)
**Scope:** 15 top-level navigation pages
**Method:** Playwright shell capture + Loom API probe + source-code parity walk

## Summary table

| # | Route | Grade | Top gap |
|---|---|---|---|
| 1 | `/` Home | **B+** | URL-redirect thrash when default tab exists; missing Recent Workspaces; no contextual help pane |
| 2 | `/workspaces` list | **B** | No filter/search bar; no card overflow menu (Endorse/Pin/Delete/Share); item cards minimal vs Fabric |
| 3 | `/workspaces/[id]` detail | **B** | Item cards missing sensitivity/endorsement/owner; no per-workspace filter; settings drawer parity needs deeper audit |
| 4 | `/browse` | **C+** | Missing Favorites + Shared-with-me + My-data tabs; no filter; effectively a duplicate of Home Recent |
| 5 | `/onelake` OneLake catalog | **B** | No endorsement / sensitivity / owner per card; no "Copy OneLake path"; type-chip filter missing |
| 6 | `/api-marketplace` | **C+** | Re-skin of OneLake catalog; missing marketplace UX (featured / categories / pricing / Subscribe) |
| 7a | `/governance` (main) | **B** | Real activity feed (good); but duplicates `/monitor` exactly |
| 7b-i | `/governance/{catalog,classifications,insights,lineage,policies,scans,sensitivity}` | **D — VAPORWARE** | 7 sub-pages render hardcoded sample arrays (fake users alice/bob/eve, fake metrics 88% / 23% / 17, fake lineage nodes). Direct violation of `.claude/rules/no-vaporware.md`. |
| 7g | `/governance/purview` | **C** | Honest config-form + preview-placeholder (acceptable per no-vaporware) |
| 8 | `/monitor` | **C** | Same component as `/governance`; missing runs table (pipeline / notebook / dataflow runs with status/duration/error) which is the actual Fabric Monitor hub feature |
| 9 | `/realtime-hub` | **C+** | Thin filter of OneLake catalog; missing 28-source connector wizard, Microsoft/External/Fabric tab grouping, per-stream live state |
| 10 | `/data-agent` | **C** | Labeled "Legacy stub" in subtitle (honest), but chat UI looks functional while backend is a stub returning "Data Agent is online but not yet wired". No MessageBar warning user. |
| 11 | `/copilot` | **A-** | Real SSE streaming, real AOAI orchestrator, 32 tools registered, honest 503 gate when AOAI absent. The highest-quality top-level surface. |
| 12 | `/workload-hub` + `/workloads` | **B** | Real workloads-catalog with CSA-branded entries; missing per-workload landing page + tab strip + per-workload Create button |
| 13 | `/deployment-pipelines` | **D — Conceptual vaporware** | Title promises Dev→Test→Prod stage promotion (Fabric's actual Deployment Pipelines feature). Actually shows a flat list of execution pipelines. Misleading branding without underlying feature. |
| 14 | `/setup` Setup wizard | **D — Vaporware deploy progress** | Wizard inputs are real (state machine + Bicep params), but Deploy step animates 6 fake stages on 600ms timers; backend `/api/setup/deploy` is a stub returning fake deployment IDs. No honest MessageBar. |
| 15 | `/learn` | **B+** | 80+ item types covered with hand-authored content + Create + MS docs links. Static (appropriate). Missing filter + category grouping. |

## Grade distribution

- A or A+: 0
- A-: 1 (`/copilot`)
- B+ or B: 6 (`/`, `/workspaces`, `/workspaces/[id]`, `/onelake`, `/workload-hub`, `/learn`, plus `/governance` main)
- C+ or C: 4 (`/browse`, `/api-marketplace`, `/monitor`, `/data-agent`, `/governance/purview`)
- D: 3 surfaces / 9 routes (`/governance/*` sub-pages × 7, `/deployment-pipelines`, `/setup` deploy step)
- F: 0

## Vaporware audit findings

Per `.claude/rules/no-vaporware.md`, these surfaces VIOLATE the rule and should be remediated:

1. **`/governance/catalog`** — Hardcoded `ASSETS` array of 8 fake data assets with fake owners (alice, bob, eve, carl, devops, sap-team) and fake classifications. NOT connected to any real catalog backend.
2. **`/governance/classifications`** — Hardcoded `BUILT_IN` + `CUSTOM` arrays with fake hit counts (e.g., "IP Address (v4): 65,002 hits"). NOT connected to any real classifier service.
3. **`/governance/insights`** — Hardcoded metric cards (88% / 23% / 17 / 38/38). NOT calculated from any real data.
4. **`/governance/lineage`** — Static SVG of hardcoded `NODES` + `EDGES` arrays. NOT a real lineage graph.
5. **`/governance/policies`** — Hardcoded `DLP` + `MASKING` + `RLS` arrays. NOT connected to any real policy engine.
6. **`/governance/scans`** — Hardcoded `SOURCES` + `RECENT_SCANS` arrays (e.g., "archive-bucket / Amazon S3 / VNet IR / Failed"). NOT connected to Purview scans.
7. **`/governance/sensitivity`** — Hardcoded `LABELS` + `POLICIES` arrays. NOT connected to MIP/Purview labels.
8. **`/deployment-pipelines`** — Title/subtitle promise Fabric's Deployment Pipelines feature (Dev→Test→Prod stage promotion). UI is a flat item list. Misleading.
9. **`/setup` deploy progress** — Wizard animates 6 fake stages with 600ms sleeps. Backend stub returns fake `deploymentId`.

These 9 surfaces should either be **rebuilt with real backends** or **gated with honest Fluent MessageBars** explaining what infrastructure is required (per the rule's "Honest config-only state" exemption).

## What's good

- The **Loom Copilot** orchestrator (`/copilot`) is genuinely impressive: 32 tools, SSE streaming, real AOAI integration, honest 503 gates.
- **Tab persistence** is server-side (Cosmos) and survives reload — exceeds Fabric's 10-tab limit.
- The **`+ New item` dialog** (Fabric-style 2-pane workload picker) is real and reused consistently across surfaces.
- The **activity feed** (`/governance` main + `/monitor`) draws from real Cosmos and shows real user activity.
- The **OneLake catalog** + **Workspaces list** + **Real-Time hub** + **Deployment pipelines** (as item list) + **API marketplace** are all real Cosmos-backed lists — they just need richer per-item metadata (endorsement, sensitivity, owner) to reach A grade.
- **Learn** library has good hand-authored content across 80+ item types.
- **Setup wizard** state machine + Bicep param generation is real — only the deploy step is a stub.

## What's needed to push the whole nav to A grade

1. **Delete the 7 hardcoded governance sub-page arrays.** Replace with either real Purview API calls (gated behind `/governance/purview` config) or honest MessageBars + Cosmos-backed empty states.
2. **Rebrand or rebuild `/deployment-pipelines`.** Either ship the real Dev→Test→Prod stage promotion feature or rename the page to "Pipelines" and remove the "Promote items" subtitle.
3. **Replace `/setup` simulated progress** with an honest "copy this Bicep + run this command" MessageBar.
4. **Diverge `/monitor` from `/governance`** by adding a real runs table.
5. **Enrich item cards** across `/workspaces/[id]`, `/onelake`, `/realtime-hub`, `/api-marketplace` with sensitivity / endorsement / owner badges + per-card overflow menu.
6. **Add filter inputs** + sort headers + view toggles to every list surface.
7. **Fix `/` → last-tab URL thrash** so Home tab navigation doesn't bounce.

## Per-page gap docs

- `docs/fiab/parity-gap/page-home.md`
- `docs/fiab/parity-gap/page-workspaces.md`
- `docs/fiab/parity-gap/page-workspaces-id.md`
- `docs/fiab/parity-gap/page-browse.md`
- `docs/fiab/parity-gap/page-onelake.md`
- `docs/fiab/parity-gap/page-api-marketplace.md`
- `docs/fiab/parity-gap/page-governance.md`
- `docs/fiab/parity-gap/page-monitor.md`
- `docs/fiab/parity-gap/page-realtime-hub.md`
- `docs/fiab/parity-gap/page-data-agent.md`
- `docs/fiab/parity-gap/page-copilot.md`
- `docs/fiab/parity-gap/page-workload-hub.md`
- `docs/fiab/parity-gap/page-deployment-pipelines.md`
- `docs/fiab/parity-gap/page-setup.md`
- `docs/fiab/parity-gap/page-learn.md`

## Methodology notes

- Validation used Playwright MCP against the live Loom URL.
- Fabric reference comparisons were grounded in Microsoft Learn docs (auth-gated portal screenshots not captured because the Playwright session lacked MSAL credentials).
- All Loom routes were probed for live data via `/api/*` endpoints during an authed window — observed 200 responses on `/api/items/recent`, `/api/apps-catalog`, `/api/workspaces`, `/api/activity`, `/api/items/by-type`, `/api/workloads-catalog`, `/api/copilot/tools`, `/api/copilot/sessions`.
- Page rendering was confirmed via accessibility-tree snapshots + innerText extraction.
- Source-code review was used to verify backend wiring (real `useQuery` vs hardcoded arrays vs stubs) — this caught the 7 governance vaporware surfaces.
- The `/auth/sign-in` MSAL flow was not completed because the Playwright session cannot accept the user's password (per privacy rules), but the user's pre-existing Loom session cookie was honored on initial page loads and provided real data for the spot-check.
