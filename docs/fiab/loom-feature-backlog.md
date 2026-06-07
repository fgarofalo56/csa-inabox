# CSA Loom — feature backlog / PRP (program plan)

Living backlog the agent executes autonomously, in order, each with a full dev
loop (implement → `tsc`/tests → PR → deploy → live-verify). Status legend:
`TODO` · `WIP` · `PR #n` · `MERGED` · `LIVE`.

> Mechanism note: background agent fan-out is rate-limited in this environment
> and worktree isolation breaks the build (node_modules isn't committed), so
> features are executed **sequentially in the shared tree** with per-feature
> typecheck + focused PRs. Revisit Workflow fan-out when the rate limit clears.

## Wave 0 — shipped this session (LIVE)
Databricks-job notebook import · Synapse LRO/debug · catalog (#599-601) ·
pipeline canvas dock + dynamic-content builder + typed activity forms (#605) ·
app-install folder target + Fabric-gate clarity (#608) · admin responsive +
collapsible icon nav (#607) · **az acr build deploy fix (#609)** · bootstrap-admin
params + 403 message (#610) · Network→Admin + all-PE hosts file (#611).

## Wave 1 — AI surfaces + quick canvas (bounded)
1. **Data-agent run** (#13) — resolve the Foundry assistant id (`asst_…`) instead
   of passing the agent name; list/create assistant, run against its id. AC: typing
   "hi" to `loom-data-concierge` returns a reply, no 400.
2. **Copilot orchestrator** (#14) — orchestrator must read the admin-configured
   Foundry endpoint/deployment/key (precedence over stale env); fix "Azure OpenAI
   not reachable". Add end-user copy describing what the orchestrator does. AC:
   Copilot answers a prompt on the live console.
3. **Deploy-planner canvas** (#10) — fixed canvas height + collapsible/expandable
   Azure-service categories in the left palette; expand/collapse must not resize
   the canvas. AC: page fits viewport; categories toggle.

## Wave 2 — lakehouse made real (medium)
4. **Lakehouse interactivity** (#12) — on install, materialize each declared Delta
   table's sample rows as real Parquet under `Tables/<name>/` and register bundle
   shortcuts into the `lakehouse-shortcuts` container. Editor: click table → SQL
   pre-fills a runnable serverless OPENROWSET; preview works; shortcut state no
   longer contradictory; bundle tree right-click → Preview/Query/Open. AC: open a
   lakehouse, preview a table, run its SQL, see registered shortcuts.

## Wave 3 — setup/deploy program
5. **Setup-orchestrator deploy path** (#15) — make the wizard actually deploy
   (server-side trigger or deployed orchestrator) instead of printing `az`.
6. **deploy-dlz permissioning** (#15) — Feature-Permission capability `deploy-dlz`,
   Admin-only default, owner-delegable. Gate the wizard's deploy action.
7. **Capacity-sizing clarity + deployment page WYSIWYG** (#15) — explain F-SKU ↔
   Databricks/ADX/Synapse-Spark equivalency; add guided wizards for deployment
   pipelines / Git integration / infra on the Deployment page.

## Wave 4 — governance overhaul (large; sub-PRs) (#16)
8. Automate Purview UAMI **data-plane role grant** via bicep `deploymentScript`
   (root-collection metadata-policy: Data Curator/Source Admin/Collection Admin);
   fix wrong bicep path in gate messages. Fixes scan/sources "Not authorized".
9. **Data Catalog** — click object → full metadata (owner, certified, classifications),
   request-access, open-in-native; right-click → that object's lineage.
10. **Lineage** — per-selected-object graph (not one giant graph).
11. **Classifications + sensitivity labels admin** — create classifications + custom
    regex scan rules; add/apply/configure sensitivity labels (cards, modern UI).
12. **Scan & sources** — full source-registration + scan-setup UI w/ advanced options.
13. **Access policy wizard** — kind dropdown; scope = selectable dropdowns; rule =
    step-by-step wizard per type (DLP masking / RLS / retention / access).
14. **Insights redesign** — modern sortable UI + real content: compliance reports,
    ownership coverage, endorsement trends, effectiveness/auditing.
15. **Purview portal page** — Web-3.0 cleanup + icons/graphics.

## Wave 5 — Monitor command center (large) (M1-M5)
16. Diagnostic settings → Log Analytics + Defender plans ON by default (bicep, admin
    toggle); KQL telemetry/audit/perf visuals; costing + predictive budgeting; alert
    builder wizard; Defender security view; severity/RG filter dropdowns.

## Wave 6 — remaining
17. **Browse** (#5) — color-coded type icons/logos, category filtering, advanced
    sort + group-by, KPI header; clarify Browse-vs-Workspaces. (Browse = everything
    across the tenant; Workspaces = workspace inventory.)
18. **Image models** (#17) — register `MAI-Image-2.5` / `-Flash`
    (dml-ai-eastus-sandbox.services.ai.azure.com) in admin Foundry model config;
    add an image-gen surface only if intended.

## Standing rules
- No-vaporware (real backend or honest Fluent gate); no scaffold claims without
  live verification; docs-as-source-of-truth per batch; never bake side-convo /
  my clarifying questions into the product UI ([[no-questions-in-product]]).

## 2026-06-06 batch (operator live stress-test + harness drain)

Shipped + live (console 34/34 GREEN throughout):

**Thread / Weave fabric** — PR5 *Build a Power BI model*, PR3 *Publish as an API*,
PR4 *edge graph + Lineage* (`/thread`), shared `warehouse-tables` discovery.
Weave is mounted in the universal editor chrome (every data item).

**Governance** — Purview page web-3.0; access-policy enforcement extended to
**warehouse (Synapse SQL role)** + **KQL (ADX database role)** with symmetric
revoke; Data Catalog **detail drawer + request-access + lineage**; OneLake item
panel shows **real Azure-native** endorsement/sensitivity/classifications (killed
the static Purview gate); **Purview auto-onboard + auto-classify** on item create
(Atlas entity + classification tags, idempotent typedefs); Unified Catalog
**OneLake source → Azure-native Loom workspaces** (Fabric opt-in only); **lineage
focus** (`?focusId=` scopes to the selected object).

**A+ edges** — Managed Instance editor real schema reads over the PE; **Azure SQL
mirroring Azure-native** (sp_change_feed CDC, no Fabric gate) + Unified-editor
Mirroring tab; **Power BI Deployment Pipelines** navigator; **PostgreSQL
in-database query** (pg + Entra token).

**Connections + mirroring** — **Loom Connections** (Key Vault-backed creds, 5
auth methods) [[connections]]; **mirrored-database create wizard** (web-3.0,
per-source, consumes Connections).

**UI** — task-018 sweep: catalog / classifications / sensitivity / scans /
policies / data-quality / domains tables → sortable `LoomDataTable`.

**Ops/CI** — Cost Management Reader + Monitoring Contributor + KV Secrets Officer
+ Purview Data Curator granted live (+ bootstrap scripts); Bicep Lint job timeout
15→30m; app-install gateway-timeout honest message; Copilot build-assist tool fixes.

### Still open
- "Self-Modification Pipeline" promote error — needs the surface/URL to locate.
- Mirroring backend: feed KV connection creds into the live mirror (Fabric
  connection/gateway-limited; needs the no-Fabric mirroring reframe or live verify).
- Purview scan-based discovery (register sources + scan runs) — beyond per-item tagging.
- Live-Azure tasks: install all 21 use-case apps, scale-by-SKU verify, RTI ADX seeding.
