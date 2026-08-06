# CSA Loom — Overnight Autonomous PRP (phased)

**Goal:** finish every remaining committed ask for CSA Loom to A+ — guided,
no-vaporware, no-Fabric-dependency, live-verified — across one ~8-hour autonomous
harness run. Each task = one focused PR through the full dev loop (implement →
`tsc`/`next build` → PR → admin-merge → console auto-rolls → live-verify), then
update `.harness/state.json` + `.harness/session-notes.md` and move to the next
highest `task_order` TODO.

**Operator exclusions:** do NOT build #17 image-gen (MAI-Image-2.5/-Flash).

**Read first every session:** `.harness/config.json` (live IDs, merge gotchas,
build/test gates), the memory files (`csa_loom_2026_06_04_monitor_cost.md`,
`csa_loom_governance_buildassist.md`), and `.claude/rules/*.md` (BLOCKING:
no-vaporware, no-fabric-dependency, ui-parity, loom-design-standards,
loom-no-freeform-config, docs-source-of-truth, no-questions-in-product).

**Definition of done per task:** real backend (or honest Fluent MessageBar gate
naming the exact env var/role/resource); Azure-native default (Fabric opt-in
only); guided UI (no raw JSON except 1:1 ADF expression builders); Fluent v9 +
Loom tokens; `tsc` clean on touched files; PR merged to main; console rolled;
the surface clicked/verified live OR an honest gate shown; docs updated.

---

## Phase 0 — Hygiene + live baseline  (task_order 99)
Establish a clean, verified starting point.
- Confirm `git status` clean on `main`, HEAD pushed. Zero open PRs except any
  in-flight from this run. Prune merged remote branches:
  `for b in $(git branch -r --merged origin/main | grep -E 'origin/(feat|fix)/loom-' | sed 's# *origin/##'); do git push origin --delete "$b"; done` (skip `main`).
- Close any remaining stale issues; keep #655 (folded into Phase 5).
- Confirm the live console runs the latest `main`: check the most recent
  `loom-roll-and-validate` run is green for HEAD; if not, trigger a roll and wait.
- Smoke-test (minted-session probe or browser) the surfaces shipped 2026-06-04/05:
  Monitor (Logs KQL library, Diagnostics tab, Cost multi-sub), data-agent tools
  panel, Copilot usage line + build-assist, Governance Access-policy + Classifications.
- AC: clean repo, 0 stragglers, live = HEAD, baseline surfaces respond.

## Phase 1 — Setup / Deploy wizard  (#15 / PRP-04)  (task_order 90)
The Setup wizard is still a pane-stub printing `az`. Make deployment real + guided.
1. **Server-side deploy trigger** — the wizard's "Deploy" action calls a BFF route
   that triggers the real deploy (dispatch the existing GitHub deploy workflow via
   `gh`/Actions API, or a deployed orchestrator), streaming status back. No `az`
   printout. Honest gate if the deploy identity/token isn't configured.
2. **`deploy-dlz` permission** — add a Feature-Permission capability `deploy-dlz`
   (Admin default, owner-delegable, same pattern as existing feature-permissions);
   gate the wizard's deploy action behind it.
3. **Capacity-sizing clarity** — a guided panel explaining F-SKU ↔ Databricks DBU /
   ADX SKU / Synapse-Spark vCore equivalency; pick a tier → see the mapped Azure
   resources + rough cost. Grounded in Microsoft Learn.
4. **WYSIWYG deploy/Git/infra wizards** on the Deployment page (guided forms, no JSON).
- AC: from the console, an admin runs a real (or honest-gated) deploy; capacity
  tiers are explained; non-admins are gated.

## Phase 2 — MCP tool server  (#19 / PRP-05)  (task_order 84)
Functions-hosted MCP tool server + "Connect MCP tools" agent panel.
1. Deploy an Azure Functions-hosted MCP server exposing a vetted subset of Loom
   tools (reuse the orchestrator tool registry) over the MCP protocol; bicep module
   + env wiring; honest gate if not provisioned.
2. A "Connect MCP tools" panel in the data-agent / Copilot config: register an MCP
   server (URL + KV secretRef), list its tools, enable/disable — the agent loop
   already supports external MCP tools (`reg` MCP shim); surface it in UI.
- AC: register an MCP server in the panel, its tools appear, the Copilot can call one.

## Phase 3 — Data-agent query execution  (#36 remainder)  (task_order 78)
Make the grounded data agent EXECUTE its generated query, not just suggest it.
1. After `chatGrounded` produces a per-source query, for sources Loom can execute
   (warehouse→synapse-sql-client, lakehouse→OPENROWSET, kql→kusto-client, semantic→
   tabular), run it read-only under the caller's identity, capture result rows.
2. Re-prompt the model with the real rows to produce a grounded answer; attach the
   executed rows + row count to the `tools` metadata (the 🛠 panel shows results).
3. Honest gate per source when the backend isn't reachable. No mocks.
- AC: ask a question over the sales warehouse → the agent runs SQL, answers from
  real rows, the tools panel shows the rows.

## Phase 4 — Governance finish  (#16)  (task_order 72)
1. **Insights redesign** (`/governance/insights`) — real content + sortable modern
   UI: compliance/ownership coverage, classification coverage %, endorsement trends,
   policy-effectiveness, audit feed — all from live Cosmos/Purview, no sample data.
2. **Purview portal page** (`/governance/purview`) — web-3.0 cleanup, icons/graphics,
   honest embed/gate.
3. **Non-ADLS access-policy enforcement** — extend `access-policy-client` to enforce
   `warehouse`/`kql` scopes (Synapse SQL GRANT / ADX `.add database ... role`),
   removing the honest-gate for those once wired.
4. **Data Catalog object detail** — click an asset → full metadata (owner, certified,
   classifications), request-access action, open-in-native, right-click → that
   object's lineage.
- AC: insights shows real numbers; a warehouse access policy actually GRANTs;
  catalog object opens a detail + lineage.

## Phase 5 — A+ edges + deferred-v3 punch-list  (#34, #37)  (task_order 60)
Clear the 11 disclosed `deferred to v3` gaps + C-grade edges. Replace each honest
deferral with a real Azure-native implementation (or keep the gate only if it's a
genuine infra requirement, per no-vaporware):
- `fabric-item-types.ts` (×6) — TDS-via-Private-Endpoint reads: implement via the
  synapse-sql / warehouse TDS client over the PE (Azure-native), not a Fabric dep.
- `azure-sql-client.ts` / `azure-sql-editors.ts` — Azure SQL mirroring: replace the
  Fabric-mirror-REST gate with Azure-native CDC/Synapse-Link (no-fabric).
- `powerbi-tree.tsx` / `powerplatform-tree.tsx` (×3) — build the follow-up navigator
  groups + import/export instead of maker-portal hand-off.
- `geo-editors.tsx` (×2) / `graph-editors.tsx` — wire the deferred actions.
- C-grade edges: postgres query driver (`postgres-flexible-server` query route),
  geo-pipeline ADF params, mounted-adf preview.
- #655 — auto-mount attached lakehouses into the notebook Spark session (abfss preamble).
- AC: zero `deferred to v3` strings remain that aren't a genuine infra gate; each
  edge runs a real backend.

## Phase 6 — Light/dark theme full sweep  (#27)  (task_order 48)
Every page readable in both themes (not just the started subset). Audit each
route under `apps/fiab-console/app/**/page.tsx` + panes/editors for hardcoded
colors / low-contrast; replace with Loom tokens + the theme-aware `--loom-*` vars
(see globals.css). Verify in both themes.
- AC: toggle dark/light on every page — no unreadable text, no broken contrast.

## Phase 7 — Web-3.0 beautify pass  (#37 beautify)  (task_order 40)
Page-by-page visual polish per `csa_loom_ui_overhaul_backlog`: cards not smushed
tables, spacing, type-icons/color, sortable/resizable/filterable tables, tile+list
views, modern headers. Do the highest-traffic pages first (Home, Browse, item
editors, Monitor, Governance). Use the existing LoomDataTable + UI primitives.
- AC: each touched page looks modern + matches loom-design-standards; no regressions.

## Phase 8 — Live-verify sweeps  (#3, #29, #25)  (task_order 30)
1. **#3** — install all 21 use-case apps via the BFF install path; fix every
   provisioner failure (dedicated-pool SQL, validation race, missing sibling
   kql-database for fedramp-tracker / finops-cost). Each app → working or honest gate.
2. **#29** — verify EVERY resource in Admin → Scale-by-SKU actually scales
   (Databricks REST auth, ADX, Synapse pool, AI-Search immutable-SKU honest error,
   APIM 409-transitioning). Fix or honest-gate each.
3. **#25** — RTI Real-Time dashboard: app install must CREATE + SEED the ADX tables
   its tiles query (no "table not found"). Seed via kusto-client on install.
- AC: 21/21 apps install green-or-gated; scale works/gated per resource; RTI tiles
  render with seeded data.

## Phase 9 — Docs + backlog + memory sync  (task_order 12)
Per docs-source-of-truth: update `docs/fiab/**` for every feature batch this run;
refresh `docs/fiab/loom-feature-backlog.md` statuses; add/refresh per-surface
parity docs in `docs/fiab/parity/`; update the Learn popups. Update the memory
files with the run's outcomes.
- AC: docs match shipped reality; backlog reflects DONE/LIVE; parity docs current.

---

## Standing per-task checklist (every task)
- [ ] Branch off fresh `origin/main`; one focused concern.
- [ ] Real backend or honest Fluent MessageBar gate (no mocks, no `return []`).
- [ ] Azure-native default; Fabric/Power BI opt-in only.
- [ ] Guided UI (no raw JSON config); Fluent v9 + Loom tokens.
- [ ] `tsc --noEmit` clean on touched files (ignore pre-existing makeStyles-px).
- [ ] PR opened; merged `--squash --admin` (update-branch if BEHIND; wait for `next build`).
- [ ] Console rolled; surface clicked/verified live OR honest gate confirmed.
- [ ] Docs updated; `.harness/state.json` task → done; session-notes appended; commit.

## Clarifications needed (flag, don't guess)
If a phase needs an operator decision (e.g., a tenant-admin one-time grant, a
support-ticket-gated preview, a destructive action), set the task status to
`blocked`, write the exact ask in `.harness/session-notes.md`, and move to the
next TODO — never fake it.
